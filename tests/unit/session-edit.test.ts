// P20: modelo de tempo com pausas, substituição durante o treino, edição e retomada de treinos finalizados.
// Regras puras + gravação transacional (fake-indexeddb). Dados fictícios.
import { beforeEach, describe, expect, it } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addRoutine, completeSession, getRotation, saveSessionGuarded, startSession } from '@/db/repo';
import { resumeCompletedSession, restoreSessionRevision, saveCompletedSessionEdit } from '@/db/sessionEdits';
import {
  MAX_SESSION_REVISIONS,
  MAX_TIMING_ENTRIES,
  addSet,
  appendExercise,
  applySwap,
  checkDuration,
  closeTiming,
  completeSet,
  correctExerciseIdentity,
  describeSessionChanges,
  effectiveDurationSec,
  finishSession,
  moveExercise,
  removeExercise,
  removeSet,
  resumeTiming,
  sessionExerciseFromTemplate,
  sessionVolume,
  setDone,
  swapPreview,
  timingIssues,
  updateSet,
  validateSessionEdit,
  revisionIssues,
  computeRecords,
} from '@/modules/training';
import type { ExerciseTemplate, Routine, SessionExercise, WorkoutSession } from '@/lib/types';
import { checkIntegrity } from '@/lib/integrity';
import { parseBackup } from '@/lib/backup';

const H = 3_600_000;
const T0 = new Date(2026, 9, 20, 18, 0, 0).getTime();

const tpl = (id: string, over: Partial<ExerciseTemplate> = {}): ExerciseTemplate => ({
  id,
  name: `Exercício ${id}`,
  muscleGroup: 'Peito',
  category: 'compound',
  equipment: 'barbell',
  sets: 3,
  repMin: 8,
  repMax: 12,
  restSec: 90,
  warmupSets: 0,
  ...over,
});

const BENCH = tpl('t-supino', { name: 'Supino reto', modality: 'resistance', catalogId: 'supino-reto-barra', catalogVersion: 1 });
const CURL = tpl('t-rosca', { name: 'Rosca direta', muscleGroup: 'Bíceps', category: 'isolation', modality: 'resistance' });
const RUN = tpl('t-esteira', { name: 'Esteira', muscleGroup: 'Cardio', equipment: 'machine', sets: 1, modality: 'cardio', distanceUnit: 'km' });

function routine(): Routine {
  return { id: 'r1', name: 'Rotina', workouts: [{ id: 'w1', label: 'A', name: 'Peito', exercises: [BENCH, CURL] }, { id: 'w2', label: 'B', name: 'Costas', exercises: [CURL] }], createdAt: T0, updatedAt: T0 };
}

let seq = 0;
const newId = () => `n${++seq}`;

/** Candidato vindo da biblioteca: exercício novo, sem templateId. */
const candidate = (t: ExerciseTemplate, history: WorkoutSession[] = [], last: null | undefined = undefined): SessionExercise =>
  sessionExerciseFromTemplate(t, history, { id: newId(), withTemplateId: false, ...(last === null ? { last: null } : {}) });

const ex = (s: WorkoutSession, name: string) => s.exercises.find((e) => e.name === name)!;

function doneAll(s: WorkoutSession, name: string, weight = 60, reps = 10): WorkoutSession {
  let out = s;
  for (const set of ex(s, name).sets) {
    out = updateSet(out, ex(out, name).id, set.id, { weight, reps });
    out = completeSet(out, ex(out, name).id, set.id, T0 + 60_000);
  }
  return out;
}

let dbn = 0;
beforeEach(async () => {
  setDb(new IronTrackDB(`p20-${++dbn}`));
  await db.open();
  seq = 0;
});

async function startAndFinish(at = T0, end = T0 + H): Promise<WorkoutSession> {
  await addRoutine(routine());
  const s = await startSession('r1', 'w1');
  const started = { ...s, startedAt: at };
  await db.sessions.put(started);
  const worked = doneAll(started, 'Supino reto');
  const saved = await saveSessionGuarded(started, worked);
  return completeSession(saved.session!, 'ok', end);
}

describe('modelo de tempo (puro)', () => {
  const base = (over: Partial<WorkoutSession> = {}): WorkoutSession => ({
    id: 's', routineId: 'r1', workoutId: 'w1', workoutLabel: 'A', workoutName: 'Peito', status: 'active', startedAt: T0, exercises: [], updatedAt: T0, ...over,
  });

  it('treino nunca retomado: mesma duração de antes (relógio desde o início; concluído congelado)', () => {
    expect(effectiveDurationSec(base(), T0 + 90_000)).toBe(90);
    const done = finishSession(base(), T0 + H);
    expect(done.durationSec).toBe(3600);
    expect(done.timing).toBeUndefined();
    expect(effectiveDurationSec(done, T0 + 5 * H)).toBe(3600);
  });

  it('18:00 → 19:00 finalizado, retomado às 20:00: às 20:15 marca 1h15 (o intervalo finalizado não conta)', () => {
    const done = finishSession(base(), T0 + H);
    const resumed = resumeTiming(done, T0 + 2 * H);
    expect(resumed.status).toBe('active');
    expect(resumed.finishedAt).toBeUndefined();
    expect(resumed.startedAt).toBe(T0);
    expect(resumed.timing).toMatchObject({ accumulatedSec: 3600, activeSince: T0 + 2 * H, finishes: [T0 + H], resumes: [T0 + 2 * H] });
    expect(effectiveDurationSec(resumed, T0 + 2 * H)).toBe(3600);
    expect(effectiveDurationSec(resumed, T0 + 2.25 * H)).toBe(4500);
    const again = finishSession(resumed, T0 + 2.25 * H);
    expect(again.durationSec).toBe(4500);
    expect(again.finishedAt).toBe(T0 + 2.25 * H);
    expect(again.timing!.segments).toEqual([
      { start: T0, end: T0 + H },
      { start: T0 + 2 * H, end: T0 + 2.25 * H },
    ]);
    expect(effectiveDurationSec(again, T0 + 10 * H)).toBe(4500);
  });

  it('várias retomadas somam só os segmentos ativos', () => {
    let s = finishSession(base(), T0 + 600_000); // 10 min
    s = finishSession(resumeTiming(s, T0 + H), T0 + H + 300_000); // +5 min
    s = finishSession(resumeTiming(s, T0 + 3 * H), T0 + 3 * H + 120_000); // +2 min
    expect(s.durationSec).toBe(17 * 60);
    expect(s.timing!.resumes).toHaveLength(2);
    expect(s.timing!.finishes).toHaveLength(2);
  });

  it('relógio do aparelho voltando no tempo nunca gera duração negativa', () => {
    const resumed = resumeTiming(finishSession(base(), T0 + H), T0 + 2 * H);
    expect(effectiveDurationSec(resumed, T0)).toBe(3600);
    const { durationSec, timing } = closeTiming(resumed.timing!, T0);
    expect(durationSec).toBe(3600);
    expect(timing.segments.at(-1)!.end).toBeGreaterThanOrEqual(timing.segments.at(-1)!.start);
    expect(effectiveDurationSec(base({ startedAt: T0 + H }), T0)).toBe(0);
  });

  it('registro antigo sem durationSec usa os horários; limites de auditoria', () => {
    expect(effectiveDurationSec(base({ status: 'completed', finishedAt: T0 + 1800_000 }), T0 + 9 * H)).toBe(1800);
    let s = finishSession(base(), T0 + 1000);
    for (let i = 1; i <= MAX_TIMING_ENTRIES + 5; i++) s = finishSession(resumeTiming(s, T0 + i * 10_000), T0 + i * 10_000 + 1000);
    expect(s.timing!.resumes).toHaveLength(MAX_TIMING_ENTRIES);
    expect(s.timing!.segments).toHaveLength(MAX_TIMING_ENTRIES);
    expect(s.durationSec).toBe(MAX_TIMING_ENTRIES + 6);
    expect(timingIssues(s.timing)).toEqual([]);
  });

  it('não retoma treino ativo ou descartado; validação da duração e do formato', () => {
    expect(resumeTiming(base(), T0 + H)).toEqual(base());
    expect(checkDuration(-1).ok).toBe(false);
    expect(checkDuration(25 * 3600).ok).toBe(false);
    expect(checkDuration(3599.6)).toEqual({ ok: true, value: 3600 });
    expect(timingIssues({ accumulatedSec: -1, activeSince: 'x', segments: [{ start: 5, end: 1 }], finishes: [], resumes: null })).toHaveLength(4);
    expect(timingIssues(undefined)).toEqual([]);
  });
});

describe('substituição durante o treino (pura)', () => {
  const active = (): WorkoutSession => {
    const s = { id: 's', routineId: 'r1', workoutId: 'w1', workoutLabel: 'A', workoutName: 'Peito', status: 'active' as const, startedAt: T0, updatedAt: T0, exercises: [sessionExerciseFromTemplate(BENCH, [], { id: 'e1' }), sessionExerciseFromTemplate(CURL, [], { id: 'e2' })] };
    return s;
  };
  const DB_PRESS = tpl('x', { name: 'Supino com halteres', equipment: 'dumbbell', modality: 'resistance', catalogId: 'supino-reto-halteres', catalogVersion: 1, sets: 4, repMin: 6, repMax: 8 });

  it('sem série feita: o novo ocupa a posição, mantém o plano compatível e não herda carga nem a identidade da ficha', () => {
    let s = active();
    s = updateSet(s, 'e1', s.exercises[0].sets[0].id, { weight: 80, edited: true });
    const c = candidate(DB_PRESS);
    const p = swapPreview(s, 'e1', c)!;
    expect(p.mode).toBe('replace');
    expect(p.doneWork).toBe(0);
    expect(p.nextSets).toBe(3);
    const { session: out, nextId } = applySwap(s, 'e1', c, newId, T0 + 1)!;
    expect(out.exercises.map((e) => e.id)).toEqual([nextId, 'e2']);
    const n = out.exercises[0];
    expect(n).toMatchObject({ name: 'Supino com halteres', substitutedFrom: 'Supino reto', catalogId: 'supino-reto-halteres', repMin: 8, repMax: 12, restSec: 90 });
    expect(n.templateId).toBeUndefined();
    expect(n.sets).toHaveLength(3);
    expect(n.sets.every((x) => x.weight === null && x.status === 'pending')).toBe(true);
  });

  it('com séries feitas: o atual guarda as feitas e é encerrado; o novo entra depois com as restantes; nada é convertido', () => {
    let s = active();
    const sets = s.exercises[0].sets;
    s = completeSet(updateSet(s, 'e1', sets[0].id, { weight: 80, reps: 10 }), 'e1', sets[0].id, T0 + 1000);
    const c = candidate(DB_PRESS);
    const p = swapPreview(s, 'e1', c)!;
    expect(p).toMatchObject({ mode: 'split', doneWork: 1, pendingWork: 2, nextSets: 2, doneLoads: [80] });
    const { session: out, nextId } = applySwap(s, 'e1', c, newId)!;
    const old = out.exercises[0];
    expect(old.id).toBe('e1');
    expect(old.templateId).toBe('t-supino');
    expect(old.sets).toEqual([expect.objectContaining({ status: 'done', weight: 80, reps: 10 })]);
    expect(old.replacedBy).toBe(nextId);
    const n = out.exercises[1];
    expect(n).toMatchObject({ id: nextId, replacesExerciseId: 'e1', substitutedFrom: 'Supino reto' });
    expect(n.sets).toHaveLength(2);
    expect(n.sets.every((x) => x.status === 'pending' && x.weight === null)).toBe(true);
    expect(out.exercises[2].id).toBe('e2');
    // Volume e recordes: as 80 kg ficam no supino com barra, nunca no substituto.
    expect(sessionVolume(out)).toBe(800);
  });

  it('troca entre modalidades não converte séries e lista as incompatibilidades', () => {
    let s = active();
    const sets = s.exercises[0].sets;
    s = completeSet(updateSet(s, 'e1', sets[0].id, { weight: 80, reps: 10 }), 'e1', sets[0].id);
    const p = swapPreview(s, 'e1', candidate(RUN))!;
    expect(p.incompatibilities.join(' ')).toMatch(/duração/);
    expect(p.incompatibilities.join(' ')).toMatch(/não registra repetições/);
    const { session: out } = applySwap(s, 'e1', candidate(RUN), newId)!;
    expect(out.exercises[1].sets.every((x) => x.reps === null && x.weight === null)).toBe(true);
    expect(out.exercises[0].sets[0]).toMatchObject({ weight: 80, reps: 10 });
  });

  it('descanso apontando para série que saiu passa a apontar para o novo exercício', () => {
    let s = active();
    const sets = s.exercises[0].sets;
    s = completeSet(s, 'e1', sets[0].id);
    s = { ...s, rest: { durationMs: 90_000, endsAt: T0 + 90_000, pausedRemainingMs: null, nextLabel: 'x', exerciseId: 'e1', setId: sets[1].id } };
    const { session: out, nextId } = applySwap(s, 'e1', candidate(DB_PRESS), newId)!;
    expect(out.rest).toMatchObject({ exerciseId: nextId, endsAt: T0 + 90_000 });
    expect(out.rest!.nextLabel).toMatch(/Supino com halteres · Série 1/);
  });

  it('candidato com o mesmo ID ou exercício inexistente: nada acontece', () => {
    const s = active();
    expect(swapPreview(s, 'nao-existe', candidate(DB_PRESS))).toBeNull();
    expect(applySwap(s, 'e1', { ...candidate(DB_PRESS), id: 'e1' }, newId)).toBeNull();
  });
});

describe('edição do histórico (pura)', () => {
  const done = (): WorkoutSession =>
    finishSession(doneAll({ id: 's', routineId: 'r1', workoutId: 'w1', workoutLabel: 'A', workoutName: 'Peito', status: 'active', startedAt: T0, updatedAt: T0, exercises: [sessionExerciseFromTemplate(BENCH, [], { id: 'e1' })] }, 'Supino reto'), T0 + H);

  it('adicionar exercício esquecido: identidade nova, sem templateId e sem carga automática', () => {
    const s = done();
    const c = candidate(CURL, [s], null);
    const out = appendExercise(s, c, T0 + 2 * H, true);
    const added = out.exercises[1];
    expect(added.id).not.toBe('e1');
    expect(added.templateId).toBeUndefined();
    expect(added.addedAfterFinishAt).toBe(T0 + 2 * H);
    expect(added.sets.every((x) => x.weight === null && x.status === 'pending')).toBe(true);
    // Séries não marcadas como feitas ficam fora do volume.
    expect(sessionVolume(out)).toBe(sessionVolume(s));
    expect(appendExercise(out, c)).toBe(out);
  });

  it('corrigir identidade: mantém ID e séries, guarda a identidade anterior, tira templateId; recusa medidas diferentes', () => {
    const s = done();
    const target = candidate(tpl('y', { name: 'Supino inclinado', modality: 'resistance', catalogId: 'supino-inclinado-barra', catalogVersion: 1 }));
    const out = correctExerciseIdentity(s, 'e1', target, T0 + 3 * H);
    const e = out.exercises[0];
    expect(e).toMatchObject({ id: 'e1', name: 'Supino inclinado', exerciseKey: target.exerciseKey, catalogId: 'supino-inclinado-barra' });
    expect(e.templateId).toBeUndefined();
    expect(e.correctedFrom).toMatchObject({ name: 'Supino reto', templateId: 't-supino', catalogId: 'supino-reto-barra', at: T0 + 3 * H });
    expect(e.sets).toEqual(s.exercises[0].sets);
    // Segunda correção mantém a identidade ORIGINAL na auditoria.
    const again = correctExerciseIdentity(out, 'e1', candidate(BENCH), T0 + 4 * H);
    expect(again.exercises[0].correctedFrom!.name).toBe('Supino reto');
    expect(() => correctExerciseIdentity(s, 'e1', candidate(RUN))).toThrow(/registro é diferente/);
    // Recordes por nome (motor antigo) passam a ver o exercício corrigido.
    expect([...computeRecords([out]).keys()]).toEqual([target.exerciseKey]);
  });

  it('validação: carga e repetições inválidas, série sem duração em cardio, duração do treino', () => {
    let s = done();
    const set = s.exercises[0].sets[0];
    s = updateSet(s, 'e1', set.id, { reps: 0, weight: -5 });
    const issues = validateSessionEdit({ ...s, durationSec: -3 });
    expect(issues.map((i) => i.message).join(' ')).toMatch(/repetições/);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/Carga inválida/);
    expect(issues.map((i) => i.message).join(' ')).toMatch(/Duração do treino/);
    let c = appendExercise(done(), candidate(RUN, [], null));
    const run = c.exercises[1];
    c = setDone(c, run.id, run.sets[0].id, true);
    expect(validateSessionEdit(c).map((i) => i.message).join(' ')).toMatch(/duração ou a distância/);
    expect(validateSessionEdit({ ...done(), exercises: [] })[0].message).toMatch(/pelo menos um exercício/);
  });

  it('resumo das mudanças: séries, exercícios, ordem, duração e observações', () => {
    const s = appendExercise(done(), candidate(CURL, [], null));
    let e = updateSet(s, 'e1', s.exercises[0].sets[0].id, { weight: 70 });
    e = removeSet(e, 'e1', s.exercises[0].sets[1].id);
    e = addSet(e, 'e1');
    e = moveExercise(e, 'e1', 1);
    e = { ...e, durationSec: 3000, notes: 'corrigido' };
    const msgs = describeSessionChanges(s, e);
    expect(msgs).toEqual(expect.arrayContaining(['Supino reto: 1 série(s) adicionada(s), 1 série(s) removida(s), 1 série(s) alterada(s).', 'Ordem dos exercícios alterada.', 'Duração corrigida.', 'Observações alteradas.']));
    expect(describeSessionChanges(s, removeExercise(s, 'e1'))).toEqual(['Exercício removido: Supino reto.']);
    expect(moveExercise(s, 'e1', -1)).toBe(s);
  });

  it('revisões malformadas são detectadas', () => {
    expect(revisionIssues(undefined)).toEqual([]);
    expect(revisionIssues('x')).toHaveLength(1);
    expect(revisionIssues(Array.from({ length: MAX_SESSION_REVISIONS + 1 }, () => ({})))).toEqual(['mais revisões do que o limite']);
    expect(revisionIssues([{ revision: 1 }])).toEqual(['revisão em formato inválido']);
  });
});

describe('gravação transacional (edição e retomada)', () => {
  it('salvar sem retomar: continua concluído, mesmo ID, duração congelada, revisão auditável; cancelar não grava nada', async () => {
    const done = await startAndFinish();
    const draft = updateSet(done, done.exercises[0].id, done.exercises[0].sets[0].id, { weight: 62.5 });
    // "Cancelar" = simplesmente não chamar a gravação: o banco continua igual.
    expect((await db.sessions.get(done.id))!.exercises[0].sets[0].weight).toBe(60);
    const r = await saveCompletedSessionEdit(done, draft, T0 + 3 * H);
    expect(r.status).toBe('saved');
    const stored = (await db.sessions.get(done.id))!;
    expect(stored).toMatchObject({ id: done.id, status: 'completed', durationSec: 3600, finishedAt: T0 + H, startedAt: T0, revision: 1, profileId: done.profileId });
    expect(stored.exercises[0].sets[0].weight).toBe(62.5);
    expect(stored.revisions![0]).toMatchObject({ revision: 1, kind: 'edit', summary: ['Supino reto: 1 série(s) alterada(s).'] });
    expect(stored.revisions![0].before.exercises[0].sets[0].weight).toBe(60);
    expect(await db.sessions.count()).toBe(1);
    // Nada mudou: não cria revisão.
    expect((await saveCompletedSessionEdit(stored, stored)).status).toBe('unchanged');
  });

  it('edição concorrente: a segunda aba não sobrescreve em silêncio', async () => {
    const done = await startAndFinish();
    const tabA = updateSet(done, done.exercises[0].id, done.exercises[0].sets[0].id, { weight: 61 });
    const tabB = updateSet(done, done.exercises[0].id, done.exercises[0].sets[1].id, { reps: 11 });
    expect((await saveCompletedSessionEdit(done, tabA, T0 + 3 * H)).status).toBe('saved');
    const r = await saveCompletedSessionEdit(done, tabB, T0 + 3 * H);
    expect(r).toMatchObject({ status: 'conflict', reason: 'changed' });
    const stored = (await db.sessions.get(done.id))!;
    expect(stored.exercises[0].sets[0].weight).toBe(61);
    expect(stored.exercises[0].sets[1].reps).toBe(10);
  });

  it('inválido não grava; treino excluído ou retomado em outra aba vira conflito', async () => {
    const done = await startAndFinish();
    const bad = updateSet(done, done.exercises[0].id, done.exercises[0].sets[0].id, { reps: 0 });
    expect((await saveCompletedSessionEdit(done, bad)).status).toBe('invalid');
    await resumeCompletedSession(done, null, T0 + 2 * H);
    expect(await saveCompletedSessionEdit(done, done)).toMatchObject({ status: 'conflict', reason: 'not-completed' });
    await db.sessions.delete(done.id);
    expect(await saveCompletedSessionEdit(done, done)).toMatchObject({ status: 'conflict', reason: 'missing' });
  });

  it('retomar: acumula a duração, um ativo por vez, segunda aba recebe "já ativo", finalizar de novo não avança a rotação outra vez', async () => {
    const done = await startAndFinish();
    expect(done.advancedRotation).toBe(true);
    const rot = await getRotation('r1');
    const r = await resumeCompletedSession(done, null, T0 + 2 * H);
    expect(r.status).toBe('resumed');
    if (r.status !== 'resumed') return;
    expect(effectiveDurationSec(r.session, T0 + 2.25 * H)).toBe(4500);
    expect(r.session.revisions!.at(-1)).toMatchObject({ kind: 'resume', summary: ['Treino retomado.'] });
    // Segunda aba, com a versão antiga: não cria outro cronômetro.
    expect((await resumeCompletedSession(done, null, T0 + 2 * H + 5000)).status).toBe('already-active');
    // Nova série e finalização.
    const curl = r.session.exercises.find((e) => e.name === 'Rosca direta')!;
    const withSet = completeSet(updateSet(r.session, curl.id, curl.sets[0].id, { weight: 20, reps: 12 }), curl.id, curl.sets[0].id, T0 + 2.1 * H);
    const saved = await saveSessionGuarded(r.session, withSet, T0 + 2.1 * H);
    const fin = await completeSession(saved.session!, 'ok', T0 + 2.25 * H);
    expect(fin).toMatchObject({ status: 'completed', durationSec: 4500, advancedRotation: true, finishedAt: T0 + 2.25 * H, startedAt: T0 });
    expect(await getRotation('r1')).toEqual(rot);
    expect(await db.sessions.count()).toBe(1);
  });

  it('não retoma com outro treino ativo; retomar com correções aplica as duas coisas na mesma transação', async () => {
    const done = await startAndFinish();
    const other = await startSession('r1', 'w2');
    expect(await resumeCompletedSession(done, null, T0 + 2 * H)).toMatchObject({ status: 'other-active', other: { id: other.id } });
    await db.sessions.delete(other.id);
    const draft = updateSet(done, done.exercises[0].id, done.exercises[0].sets[0].id, { weight: 65 });
    const r = await resumeCompletedSession(done, draft, T0 + 2 * H);
    expect(r.status).toBe('resumed');
    const stored = (await db.sessions.get(done.id))!;
    expect(stored.exercises[0].sets[0].weight).toBe(65);
    expect(stored.revisions!.at(-1)!.summary).toEqual(['Supino reto: 1 série(s) alterada(s).', 'Treino retomado.']);
  });

  it('restaurar uma revisão volta o conteúdo como nova revisão', async () => {
    const done = await startAndFinish();
    const draft = updateSet(done, done.exercises[0].id, done.exercises[0].sets[0].id, { weight: 99 });
    const r = await saveCompletedSessionEdit(done, draft, T0 + 3 * H);
    if (r.status !== 'saved') throw new Error('falhou');
    const back = await restoreSessionRevision(r.session, 1, T0 + 4 * H);
    expect(back.status).toBe('saved');
    const stored = (await db.sessions.get(done.id))!;
    expect(stored.exercises[0].sets[0].weight).toBe(60);
    expect(stored.revision).toBe(2);
    expect(stored.revisions!.map((x) => x.kind)).toEqual(['edit', 'restore']);
    expect(await restoreSessionRevision(r.session, 1)).toMatchObject({ status: 'conflict', reason: 'changed' });
  });

  it('limite de revisões por treino', async () => {
    let cur = await startAndFinish();
    for (let i = 0; i < MAX_SESSION_REVISIONS + 3; i++) {
      const r = await saveCompletedSessionEdit(cur, { ...cur, notes: `nota ${i}` }, T0 + (3 + i) * H);
      if (r.status !== 'saved') throw new Error(r.status);
      cur = r.session;
    }
    expect(cur.revision).toBe(MAX_SESSION_REVISIONS + 3);
    expect(cur.revisions).toHaveLength(MAX_SESSION_REVISIONS);
    expect(cur.revisions![0].revision).toBe(4);
  });

  it('backup e integridade: treino editado e retomado passa na verificação e volta igual', async () => {
    const done = await startAndFinish();
    const r = await resumeCompletedSession(done, null, T0 + 2 * H);
    if (r.status !== 'resumed') throw new Error(r.status);
    const fin = await completeSession(r.session, undefined, T0 + 2.5 * H);
    const { exportBackup } = await import('@/lib/backup');
    const file = await exportBackup();
    expect(file.schemaVersion).toBe(8);
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s = parsed.value.data.sessions.find((x) => x.id === fin.id)!;
    expect(s.timing).toEqual(fin.timing);
    expect(s.revisions).toEqual(fin.revisions);
    const report = checkIntegrity(parsed.value.data);
    expect(report.issues.filter((i) => i.code === 'INVALID_SESSION_TIMING' || i.code === 'INVALID_SESSION_REVISION')).toEqual([]);
    const broken = { ...parsed.value.data, sessions: [{ ...s, timing: { accumulatedSec: -1 }, revisions: 'x' }] } as never;
    const codes = checkIntegrity(broken).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['INVALID_SESSION_TIMING', 'INVALID_SESSION_REVISION']));
  });
});
