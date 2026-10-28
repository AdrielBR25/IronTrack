// Treino em andamento com várias abas e gravações concorrentes (P11): mescla em três vias, gravação protegida,
// conclusão de série sem duplicação, finalização idempotente, treino fechado em outra aba. Banco fake-indexeddb.
import { beforeEach, describe, expect, it } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addRoutine, completeSession, getRotation, markRestNotified, saveSessionGuarded, startSession, discardSession } from '@/db/repo';
import { addSet, completeSet, mergeSessionEdits, removeSet, startRest, updateSet } from '@/modules/training';
import type { WorkoutSession } from '@/lib/types';
import { modelRoutine } from './modelFixtures';

let n = 0;
beforeEach(async () => {
  setDb(new IronTrackDB(`conc-${++n}`));
  await db.open();
});

async function begin(): Promise<WorkoutSession> {
  const r = modelRoutine();
  await addRoutine(r);
  return startSession(r.id, r.workouts[0].id);
}

const exOf = (s: WorkoutSession, key: string) => s.exercises.find((e) => e.exerciseKey === key)!;
const setsOf = (s: WorkoutSession) => s.exercises.flatMap((e) => e.sets);
const bump = (s: WorkoutSession, t: number): WorkoutSession => ({ ...s, updatedAt: t });

describe('mescla em três vias (pura)', () => {
  it('mudanças em séries diferentes nas duas abas: as duas ficam', async () => {
    const base = await begin();
    const plank = exOf(base, 'prancha');
    const lunge = exOf(base, 'afundo');
    const local = bump(updateSet(base, plank.id, plank.sets[0].id, { durationSec: 52 }), base.updatedAt + 5);
    const fresh = bump(updateSet(base, lunge.id, lunge.sets[0].id, { side: 'esquerdo', reps: 9 }), base.updatedAt + 3);
    const { merged, conflicts } = mergeSessionEdits(base, local, fresh);
    expect(conflicts).toEqual([]);
    expect(exOf(merged, 'prancha').sets[0].durationSec).toBe(52);
    expect(exOf(merged, 'afundo').sets[0]).toMatchObject({ side: 'esquerdo', reps: 9 });
  });

  it('mesma série concluída nas duas abas: uma conclusão só, nenhuma série duplicada', async () => {
    const base = await begin();
    const plank = exOf(base, 'prancha');
    const a = completeSet(updateSet(base, plank.id, plank.sets[0].id, { durationSec: 40 }), plank.id, plank.sets[0].id, 1000);
    const b = completeSet(updateSet(base, plank.id, plank.sets[0].id, { durationSec: 41 }), plank.id, plank.sets[0].id, 2000);
    const { merged, conflicts } = mergeSessionEdits(base, b, a);
    expect(setsOf(merged)).toHaveLength(setsOf(base).length);
    expect(exOf(merged, 'prancha').sets[0]).toMatchObject({ status: 'done', durationSec: 40, completedAt: 1000 });
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it('tela desatualizada não volta a pendente uma série concluída na outra aba', async () => {
    const base = await begin();
    const plank = exOf(base, 'prancha');
    const fresh = completeSet(base, plank.id, plank.sets[0].id, 1000);
    // Esta aba (desatualizada) só mexeu na distância da corrida.
    const run = exOf(base, 'corrida');
    const local = updateSet(base, run.id, run.sets[0].id, { distance: 5200 });
    const { merged, conflicts } = mergeSessionEdits(base, local, fresh);
    expect(conflicts).toEqual([]);
    expect(exOf(merged, 'prancha').sets[0].status).toBe('done');
    expect(exOf(merged, 'corrida').sets[0].distance).toBe(5200);
  });

  it('série adicionada numa aba e removida (sem alteração) na outra; remoção de série alterada vira conflito', async () => {
    const base = await begin();
    const plank = exOf(base, 'prancha');
    const local = addSet(base, plank.id, 'normal');
    const fresh = removeSet(base, plank.id, plank.sets[2].id);
    const { merged } = mergeSessionEdits(base, local, fresh);
    const ids = exOf(merged, 'prancha').sets.map((s) => s.id);
    expect(ids).toHaveLength(plank.sets.length); // +1 −1
    expect(ids).not.toContain(plank.sets[2].id);
    expect(new Set(ids).size).toBe(ids.length);
    // Esta aba removeu a série 1, mas a outra a concluiu: a série fica (o banco prevalece) e o conflito é avisado.
    const done = completeSet(base, plank.id, plank.sets[0].id, 1);
    const r = mergeSessionEdits(base, removeSet(base, plank.id, plank.sets[0].id), done);
    expect(exOf(r.merged, 'prancha').sets[0].status).toBe('done');
    expect(r.conflicts).toHaveLength(1);
  });

  it('descanso iniciado nas duas abas: prevalece o do banco', async () => {
    const base = await begin();
    const r1 = startRest(60, 1000, { nextLabel: 'x', exerciseId: 'a', setId: 'b' });
    const r2 = startRest(90, 2000, { nextLabel: 'y', exerciseId: 'a', setId: 'c' });
    const { merged, conflicts } = mergeSessionEdits(base, { ...base, rest: r2 }, { ...base, rest: r1 });
    expect(merged.rest).toEqual(r1);
    expect(conflicts).toEqual(['rest']);
  });
});

describe('gravação protegida (saveSessionGuarded)', () => {
  it('sem concorrência grava como antes; com concorrência mescla e não sobrescreve', async () => {
    const base = await begin();
    const plank = exOf(base, 'prancha');
    const run = exOf(base, 'corrida');
    // Aba A grava primeiro.
    const a = await saveSessionGuarded(base, updateSet(base, plank.id, plank.sets[0].id, { durationSec: 45 }));
    expect(a.status).toBe('saved');
    // Aba B ainda está na versão `base`.
    const b = await saveSessionGuarded(base, updateSet(base, run.id, run.sets[0].id, { distance: 6000 }));
    expect(b.status).toBe('merged');
    const stored = (await db.sessions.get(base.id))!;
    expect(exOf(stored, 'prancha').sets[0].durationSec).toBe(45);
    expect(exOf(stored, 'corrida').sets[0].distance).toBe(6000);
    expect(stored.updatedAt).toBeGreaterThan(a.session!.updatedAt - 1);
  });

  it('o aviso de descanso (outra gravação) não é desfeito pela tela', async () => {
    const base = await begin();
    const withRest = { ...base, rest: startRest(30, Date.now() - 60_000, { nextLabel: 'x', exerciseId: 'a', setId: 'b' }) };
    const saved = await saveSessionGuarded(base, withRest);
    expect(await markRestNotified(base.id, withRest.rest.endsAt)).toBe(true);
    const plank = exOf(base, 'prancha');
    await saveSessionGuarded(saved.session!, updateSet(saved.session!, plank.id, plank.sets[1].id, { durationSec: 33 }));
    const stored = (await db.sessions.get(base.id))!;
    expect(stored.rest?.notified).toBe(true);
    expect(exOf(stored, 'prancha').sets[1].durationSec).toBe(33);
  });

  it('treino finalizado ou descartado em outra aba: nada é gravado (não ressuscita)', async () => {
    const base = await begin();
    const done = await completeSession(base, 'ok');
    const r = await saveSessionGuarded(base, { ...base, notes: 'tela velha' });
    expect(r.status).toBe('closed');
    expect((await db.sessions.get(base.id))!).toMatchObject({ status: 'completed', notes: 'ok' });
    expect(done.status).toBe('completed');
    await discardSession(base.id);
    expect((await saveSessionGuarded(base, base)).status).toBe('closed');
    expect(await db.sessions.get(base.id)).toBeUndefined();
  });

  it('finalizar duas vezes (duas abas) não avança a rotação duas vezes nem duplica o histórico', async () => {
    const base = await begin();
    const plank = exOf(base, 'prancha');
    const s = completeSet(updateSet(base, plank.id, plank.sets[0].id, { durationSec: 30 }), plank.id, plank.sets[0].id);
    await saveSessionGuarded(base, s);
    const first = await completeSession(s, 'aba 1');
    const rotAfterFirst = await getRotation(base.routineId);
    const second = await completeSession(s, 'aba 2');
    expect(second).toEqual(first);
    expect(await getRotation(base.routineId)).toEqual(rotAfterFirst);
    expect(await db.sessions.where('status').equals('completed').count()).toBe(1);
  });

  it('falha de gravação: a transação lança e o banco fica como estava', async () => {
    const base = await begin();
    const broken = { ...base, id: base.id, exercises: undefined as unknown as WorkoutSession['exercises'] };
    // `undefined` em exercises quebra a mescla (simula falha); o registro do banco não muda.
    const fresh = await db.sessions.get(base.id);
    await db.sessions.update(base.id, { updatedAt: base.updatedAt + 10 });
    await expect(saveSessionGuarded(base, broken)).rejects.toThrow();
    expect((await db.sessions.get(base.id))!.exercises).toEqual(fresh!.exercises);
  });
});
