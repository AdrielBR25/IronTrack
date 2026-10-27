import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IronTrackDB, db, getSettings, saveSettings, setDb } from '@/db/db';
import { addRoutine, completeSession, getActiveSession, getRotation, saveSession, startSession, skipNextWorkout } from '@/db/repo';
import { parseFicha } from '@/lib/routineSchema';
import { completeSet, nextPending, restAfter, updateSet } from '@/lib/session';
import { remainingMs, startRest } from '@/lib/restTimer';
import { exportBackup, parseBackup, restoreBackupMerge, restoreBackupReplace } from '@/lib/backup';
import { sessionVolume } from '@/lib/volume';
import type { Routine } from '@/lib/types';

const sample = readFileSync(resolve(process.cwd(), 'public/examples/ficha-abc-exemplo.json'), 'utf8');
let n = 0;

async function freshDb() {
  setDb(new IronTrackDB(`test-${++n}`));
  await db.open();
}

async function seed(): Promise<Routine> {
  const r = parseFicha(sample, { restCompoundSec: 150, restIsolationSec: 90 });
  if (!r.ok) throw new Error(r.errors.join());
  await addRoutine(r.value);
  return r.value;
}

beforeEach(freshDb);

describe('persistência (IndexedDB)', () => {
  it('configurações e rotinas sobrevivem a reabrir o banco', async () => {
    await saveSettings({ userName: 'Teste', weightStep: 5 });
    const r = await seed();
    const name = db.name;
    db.close();
    setDb(new IronTrackDB(name));
    await db.open();
    expect((await getSettings()).userName).toBe('Teste');
    expect((await getSettings()).weightStep).toBe(5);
    expect((await getSettings()).activeRoutineId).toBe(r.id);
    expect((await db.routines.get(r.id))?.workouts).toHaveLength(3);
  });
});

describe('recuperação de sessão interrompida', () => {
  it('treino em andamento, séries e descanso voltam após "fechar o app"', async () => {
    const r = await seed();
    let s = await startSession(r.id, r.workouts[0].id);
    const ex = s.exercises[0];
    const firstNormal = ex.sets.find((x) => x.type === 'normal')!;
    s = updateSet(s, ex.id, firstNormal.id, { weight: 60, reps: 9 });
    s = completeSet(s, ex.id, firstNormal.id, 1_000);
    const next = nextPending(s, ex.id)!;
    s = { ...s, rest: startRest(restAfter(s, { exerciseId: ex.id, setId: firstNormal.id }, next, { restWarmupSec: 60 }), 1_000, { nextLabel: 'x', exerciseId: next.exerciseId, setId: next.setId }) };
    await saveSession(s);

    const name = db.name;
    db.close();
    setDb(new IronTrackDB(name));
    await db.open();

    const back = await getActiveSession();
    expect(back?.id).toBe(s.id);
    const set = back!.exercises[0].sets.find((x) => x.id === firstNormal.id)!;
    expect(set).toMatchObject({ status: 'done', weight: 60, reps: 9 });
    expect(remainingMs(back!.rest!, 61_000)).toBe(90_000);
    // iniciar de novo devolve a mesma sessão em andamento, sem duplicar
    expect((await startSession(r.id, r.workouts[1].id)).id).toBe(s.id);
  });

  it('concluir avança a rotação A → B; pular avança mais um', async () => {
    const r = await seed();
    let s = await startSession(r.id, r.workouts[0].id);
    const ex = s.exercises[0];
    const set = ex.sets.find((x) => x.type === 'normal')!;
    s = completeSet(s, ex.id, set.id);
    const done = await completeSession(s);
    expect(done.status).toBe('completed');
    expect(done.advancedRotation).toBe(true);
    expect(sessionVolume(done)).toBe(50 * 10);
    expect((await getRotation(r.id)).nextIndex).toBe(1);
    await skipNextWorkout(r);
    expect((await getRotation(r.id)).nextIndex).toBe(2);
    expect(await getActiveSession()).toBeUndefined();
  });

  it('treino sem nenhuma série não avança a rotação', async () => {
    const r = await seed();
    const s = await startSession(r.id, r.workouts[0].id);
    const done = await completeSession(s);
    expect(done.advancedRotation).toBe(false);
    expect((await getRotation(r.id)).nextIndex).toBe(0);
  });

  it('pré-preenche com os valores da última sessão do mesmo exercício', async () => {
    const r = await seed();
    let s = await startSession(r.id, r.workouts[0].id);
    const ex = s.exercises[0];
    for (const set of ex.sets.filter((x) => x.type === 'normal')) {
      s = updateSet(s, ex.id, set.id, { weight: 62.5, reps: 7 });
      s = completeSet(s, ex.id, set.id);
    }
    await completeSession(s);
    const s2 = await startSession(r.id, r.workouts[0].id);
    const normal = s2.exercises[0].sets.filter((x) => x.type === 'normal');
    expect(normal.map((x) => [x.weight, x.reps])).toEqual([[62.5, 7], [62.5, 7], [62.5, 7]]);
    expect(normal[0].plannedWeight).toBe(50); // carga planejada da ficha
  });
});

describe('backup', () => {
  it('exporta, valida e restaura (substituir)', async () => {
    const r = await seed();
    const s = await startSession(r.id, r.workouts[0].id);
    await completeSession(completeSet(s, s.exercises[0].id, s.exercises[0].sets[1].id));
    await db.bodyEntries.put({ id: 'b1', date: '2026-10-01', weightKg: 80, createdAt: 1 });
    const file = await exportBackup();
    const text = JSON.stringify(file);

    await freshDb();
    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sum = await restoreBackupReplace(parsed.value);
    expect(sum).toMatchObject({ routines: 1, sessions: 1, bodyEntries: 1 });
    expect(await db.sessions.count()).toBe(1);
    expect((await getRotation(r.id)).nextIndex).toBe(1);
  });

  it('mesclar não duplica registros', async () => {
    await seed();
    const file = await exportBackup();
    const sum = await restoreBackupMerge(file);
    expect(sum.routines).toBe(0);
    expect(await db.routines.count()).toBe(1);
  });

  it('rejeita versões futuras e arquivos errados; migra v0', () => {
    const future = parseBackup(JSON.stringify({ app: 'irontrack', kind: 'backup', schemaVersion: 99, exportedAt: '', data: {} }));
    expect(!future.ok && future.errors[0]).toMatch(/versão mais nova/);
    const ficha = parseBackup(sample);
    expect(!ficha.ok && ficha.errors[0]).toMatch(/ficha de treino/);
    const v0 = parseBackup(JSON.stringify({ app: 'irontrack', routines: [], sessions: [] }));
    expect(v0.ok).toBe(true);
    const broken = parseBackup('nope');
    expect(!broken.ok && broken.errors[0]).toMatch(/JSON inválido/);
  });
});

describe('propagação de carga', () => {
  it('a carga concluída passa para as próximas séries não editadas', async () => {
    const { carryForwardWeight } = await import('@/lib/session');
    const r = await seed();
    let s = await startSession(r.id, r.workouts[0].id);
    const ex = s.exercises[0];
    const [n1, n2, n3] = ex.sets.filter((x) => x.type === 'normal');
    s = updateSet(s, ex.id, n3.id, { weight: 45, edited: true });
    s = updateSet(s, ex.id, n1.id, { weight: 55, edited: true });
    s = carryForwardWeight(completeSet(s, ex.id, n1.id), ex.id, n1.id);
    const sets = s.exercises[0].sets;
    expect(sets.find((x) => x.id === n2.id)!.weight).toBe(55);
    expect(sets.find((x) => x.id === n3.id)!.weight).toBe(45);
    expect(sets.find((x) => x.type === 'warmup')!.weight).toBe(25);
  });
});
