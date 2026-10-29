import { db, getSettings, saveSettings } from './db';
import type { DayOverride, Routine, RotationState, Workout, WorkoutSession } from '@/lib/types';
import { uid } from '@/lib/utils';
import { buildSession, finishSession, indexAfter, mergeSessionEdits, normIndex, restoreModelFields, shouldAdvance, skipIndex, type RoutineModelLoss } from '@/modules/training';
import { rememberRoutineModel } from './modelGuard';

// Persistência do domínio de treinamento (rotinas, rotação e sessões). As regras ficam em
// src/modules/training; aqui só se coordena leitura, regra pura e gravação em transação.
// As funções de evolução corporal estão em ./body e são reexportadas no fim (compatibilidade).

// ---------- Rotinas ----------

export async function saveRoutine(r: Routine): Promise<void> {
  await db.routines.put({ ...r, updatedAt: Date.now() });
}

export async function addRoutine(r: Routine, makeActive = false): Promise<void> {
  await db.transaction('rw', db.routines, db.settings, db.rotations, async () => {
    await db.routines.put(r);
    await db.rotations.put({ routineId: r.id, nextIndex: 0, updatedAt: Date.now() });
    const s = await getSettings();
    if (makeActive || !s.activeRoutineId) await saveSettings({ activeRoutineId: r.id });
  });
}

export async function deleteRoutine(id: string): Promise<void> {
  await db.transaction('rw', db.routines, db.rotations, db.overrides, db.settings, async () => {
    await db.routines.delete(id);
    await db.rotations.delete(id);
    await db.overrides.where('routineId').equals(id).delete();
    const s = await getSettings();
    if (s.activeRoutineId === id) {
      const other = await db.routines.toCollection().first();
      await saveSettings({ activeRoutineId: other?.id ?? null });
    }
  });
}

export function cloneWorkout(w: Workout, label?: string): Workout {
  return {
    ...w,
    id: uid(),
    label: label ?? w.label,
    exercises: w.exercises.map((e) => ({ ...e, id: uid(), substitutes: e.substitutes ? [...e.substitutes] : undefined })),
  };
}

export async function duplicateRoutine(id: string): Promise<Routine | undefined> {
  const r = await db.routines.get(id);
  if (!r) return;
  const now = Date.now();
  const copy: Routine = { ...r, id: uid(), name: `${r.name} (cópia)`, createdAt: now, updatedAt: now, workouts: r.workouts.map((w) => cloneWorkout(w)) };
  await addRoutine(copy);
  return copy;
}

export async function setActiveRoutine(id: string) {
  await saveSettings({ activeRoutineId: id });
}

export async function getRoutine(id: string): Promise<Routine | undefined> {
  return db.routines.get(id);
}

// ---------- Rotação ----------

export async function getRotation(routineId: string): Promise<RotationState> {
  return (await db.rotations.get(routineId)) ?? { routineId, nextIndex: 0, updatedAt: 0 };
}

export async function setNextWorkout(routine: Routine, workoutId: string) {
  const idx = routine.workouts.findIndex((w) => w.id === workoutId);
  if (idx < 0) return;
  await db.rotations.put({ routineId: routine.id, nextIndex: idx, updatedAt: Date.now() });
}

export async function skipNextWorkout(routine: Routine) {
  const rot = await getRotation(routine.id);
  const order = routine.workouts.map((w) => w.id);
  await db.rotations.put({ routineId: routine.id, nextIndex: skipIndex(order, rot.nextIndex), updatedAt: Date.now() });
}

export async function setDayOverride(o: DayOverride) {
  await db.overrides.put(o);
}

export async function clearDayOverride(routineId: string, date: string) {
  await db.overrides.delete([routineId, date]);
}

// ---------- Sessões ----------

export async function getActiveSession(): Promise<WorkoutSession | undefined> {
  return db.sessions.where('status').equals('active').first();
}

export async function startSession(routineId: string, workoutId: string): Promise<WorkoutSession> {
  return db.transaction('rw', db.sessions, db.routines, async () => {
    const active = await db.sessions.where('status').equals('active').first();
    if (active) return active;
    const routine = await db.routines.get(routineId);
    const workout = routine?.workouts.find((w) => w.id === workoutId);
    if (!routine || !workout) throw new Error('Treino não encontrado');
    const history = await db.sessions.where('status').equals('completed').toArray();
    const s = buildSession(routine, workout, history);
    await db.sessions.put(s);
    return s;
  });
}

export async function saveSession(s: WorkoutSession) {
  await db.sessions.put({ ...s, updatedAt: Date.now() });
}

export type GuardedSaveResult =
  | { status: 'saved' | 'merged'; session: WorkoutSession; conflicts: string[] }
  | { status: 'closed'; session: null; conflicts: [] };

/**
 * Grava o treino em andamento sem sobrescrever em silêncio o que outra aba (ou o aviso de descanso) gravou
 * (P11, docs/CRONOMETROS_E_CONCORRENCIA.md §9). `base` é a versão do banco que a tela conhecia; `local`, o que ela
 * quer gravar. Na mesma transação de escrita (serializada pelo IndexedDB entre abas):
 * - treino ausente ou não mais ativo (finalizado/descartado em outra aba): nada é gravado (`closed`);
 * - banco igual à base: grava `local` (`saved`);
 * - banco mudou: mescla em três vias, prevalecendo o banco nos conflitos (`merged`).
 */
export async function saveSessionGuarded(base: WorkoutSession, local: WorkoutSession, now = Date.now()): Promise<GuardedSaveResult> {
  return db.transaction('rw', db.sessions, async () => {
    const fresh = await db.sessions.get(local.id);
    if (!fresh || fresh.status !== 'active') return { status: 'closed', session: null, conflicts: [] };
    const updatedAt = Math.max(now, fresh.updatedAt + 1, local.updatedAt);
    if (fresh.updatedAt === base.updatedAt) {
      const w = { ...local, updatedAt };
      await db.sessions.put(w);
      return { status: 'saved', session: w, conflicts: [] };
    }
    const { merged, conflicts } = mergeSessionEdits(base, local, fresh);
    const w = { ...merged, updatedAt };
    await db.sessions.put(w);
    return { status: 'merged', session: w, conflicts };
  });
}

/**
 * Conclui o treino e avança a rotação conforme a política configurada. Idempotente (P11): se o treino já foi
 * finalizado ou descartado (ex.: em outra aba), nada é gravado e a rotação não avança de novo.
 */
export async function completeSession(s: WorkoutSession, notes?: string, now = Date.now()): Promise<WorkoutSession> {
  return db.transaction('rw', [db.sessions, db.rotations, db.routines, db.settings], async () => {
    const existing = await db.sessions.get(s.id);
    if (existing && existing.status !== 'active') return existing;
    const settings = await getSettings();
    let done = finishSession(s, now, notes);
    // P20: um treino retomado já teve a rotação decidida na primeira finalização; finalizar de novo nunca a avança outra
    // vez (o registro mantém o que aconteceu na primeira vez). Correções manuais continuam em Treinos.
    const resumed = !!(existing ?? s).timing?.resumes.length;
    if (resumed) {
      done = { ...done, advancedRotation: !!(existing ?? s).advancedRotation };
      await db.sessions.put(done);
      return done;
    }
    const advance = shouldAdvance(done, settings.rotationPolicy, settings.rotationThreshold);
    const routine = await db.routines.get(s.routineId);
    if (advance && routine) {
      const order = routine.workouts.map((w) => w.id);
      const rot = await getRotation(routine.id);
      await db.rotations.put({ routineId: routine.id, nextIndex: indexAfter(order, s.workoutId, rot.nextIndex), updatedAt: now });
    }
    done = { ...done, advancedRotation: advance && !!routine };
    await db.sessions.put(done);
    return done;
  });
}

/**
 * Marca como avisado o descanso que termina em `endsAt`. Devolve false (sem gravar) se o
 * descanso já foi avisado ou mudou; assim o aviso dispara uma única vez, mesmo com várias abas.
 */
export async function markRestNotified(sessionId: string, endsAt: number, now = Date.now()): Promise<boolean> {
  return db.transaction('rw', db.sessions, async () => {
    const fresh = await db.sessions.get(sessionId);
    if (!fresh?.rest || fresh.rest.notified || fresh.rest.endsAt !== endsAt) return false;
    // A versão precisa avançar mesmo no mesmo milissegundo da gravação anterior: com `updatedAt` igual, a gravação
    // protegida seguinte acharia que nada mudou e desfaria o aviso (P12: corrige teste intermitente do P11).
    await db.sessions.update(sessionId, { 'rest.notified': true, updatedAt: Math.max(now, fresh.updatedAt + 1) } as never);
    return true;
  });
}

/** Devolve campos de modalidade removidos por um app antigo (só onde continuam ausentes). Confirmado pela pessoa. */
export async function restoreRoutineModel(loss: RoutineModelLoss): Promise<boolean> {
  return db.transaction('rw', db.routines, async () => {
    const r = await db.routines.get(loss.routineId);
    if (!r || r.updatedAt !== loss.updatedAt) return false;
    await db.routines.put({ ...restoreModelFields(r, loss), updatedAt: Date.now() });
    return true;
  });
}

/** Aceita o estado atual da rotina (a pessoa preferiu não restaurar): vira a nova referência. */
export async function acceptRoutineModel(routineId: string): Promise<void> {
  const r = await db.routines.get(routineId);
  if (r) rememberRoutineModel(r);
}

export async function discardSession(id: string) {
  await db.sessions.delete(id);
}

/** Exclui um treino do histórico. Se ele tinha avançado a rotação, não mexe nela (use a correção manual). */
export async function deleteSession(id: string) {
  await db.sessions.delete(id);
}

export async function updateSessionNotes(id: string, notes: string) {
  await db.sessions.update(id, { notes, updatedAt: Date.now() });
}

export async function completedSessions(): Promise<WorkoutSession[]> {
  return db.sessions.where('status').equals('completed').sortBy('startedAt');
}

/** Os `limit` treinos concluídos mais recentes (mais novo primeiro). Só leitura, pelo índice de data. */
export async function recentCompletedSessions(limit: number): Promise<WorkoutSession[]> {
  return db.sessions.orderBy('startedAt').reverse().filter((s) => s.status === 'completed').limit(limit).toArray();
}

/** Treinos concluídos iniciados a partir de `fromTs` (ms). Só leitura, pelo índice de data. */
export async function completedSessionsSince(fromTs: number): Promise<WorkoutSession[]> {
  return db.sessions.where('startedAt').aboveOrEqual(fromTs).filter((s) => s.status === 'completed').sortBy('startedAt');
}

export { normIndex };

/** Salva a rotina preservando qual treino é o próximo da rotação (ao reordenar/excluir treinos). */
export async function saveRoutineKeepPointer(next: Routine) {
  await db.transaction('rw', db.routines, db.rotations, async () => {
    const old = await db.routines.get(next.id);
    const rot = await getRotation(next.id);
    await db.routines.put({ ...next, updatedAt: Date.now() });
    if (!old) return;
    const nextId = old.workouts[normIndex(rot.nextIndex, old.workouts.length)]?.id;
    let idx = next.workouts.findIndex((w) => w.id === nextId);
    if (idx < 0) idx = normIndex(rot.nextIndex, next.workouts.length);
    if (idx !== rot.nextIndex) await db.rotations.put({ routineId: next.id, nextIndex: idx, updatedAt: Date.now() });
  });
}

/** @deprecated Compatibilidade: importe de '@/db/body'. */
export * from './body';
