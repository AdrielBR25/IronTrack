import { db, getSettings, saveSettings } from './db';
import type { BodyEntry, DayOverride, ProgressPhoto, Routine, RotationState, Workout, WorkoutSession } from '@/lib/types';
import { uid } from '@/lib/utils';
import { buildSession, finishSession } from '@/lib/session';
import { indexAfter, normIndex, shouldAdvance, skipIndex } from '@/lib/rotation';

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

/** Conclui o treino e avança a rotação conforme a política configurada. */
export async function completeSession(s: WorkoutSession, notes?: string, now = Date.now()): Promise<WorkoutSession> {
  return db.transaction('rw', [db.sessions, db.rotations, db.routines, db.settings], async () => {
    const settings = await getSettings();
    let done = finishSession(s, now, notes);
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

// ---------- Corpo ----------

export async function saveBodyEntry(e: BodyEntry) {
  await db.bodyEntries.put(e);
}

/** Grava a avaliação e suas fotos juntas: ou tudo é salvo, ou nada (sem fotos órfãs ou faltando). */
export async function saveBodyEntryWithPhotos(e: BodyEntry, photoDataUrls: string[], now = Date.now()) {
  await db.transaction('rw', db.bodyEntries, db.photos, async () => {
    await db.bodyEntries.put(e);
    if (photoDataUrls.length) await db.photos.bulkAdd(photoDataUrls.map((dataUrl) => ({ id: uid(), entryId: e.id, dataUrl, createdAt: now })));
  });
}

export async function deleteBodyEntry(id: string) {
  await db.transaction('rw', db.bodyEntries, db.photos, async () => {
    await db.bodyEntries.delete(id);
    await db.photos.where('entryId').equals(id).delete();
  });
}

export async function addPhoto(p: ProgressPhoto) {
  await db.photos.put(p);
}

export async function deletePhoto(id: string) {
  await db.photos.delete(id);
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
