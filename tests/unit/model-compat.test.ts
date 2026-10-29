// Proteção de compatibilidade (P11): fotografia dos campos de modalidade fora do banco, detecção de regravação por
// um app antigo (simulado com uma conexão Dexie sem os ganchos deste app, como um app publicado antes do P10/P11),
// restauração confirmada, marca de capacidade e ausência de estado auxiliar nos backups. Dados fictícios.
import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addRoutine, acceptRoutineModel, deleteRoutine, restoreRoutineModel, saveRoutine } from '@/db/repo';
import { CAPABILITIES_KEY, MODEL_SNAPSHOT_KEY, baselineRoutineModels, checkModelCapability, readModelSnapshot } from '@/db/modelGuard';
import { BACKUP_SCHEMA_VERSION, exportBackup, parseBackup, restoreBackupReplace } from '@/lib/backup';
import { detectModelLoss, isNewerCapability, pickModelFields, restoreModelFields } from '@/modules/training';
import type { Routine } from '@/lib/types';
import { SET_TIMER_KEY } from '@/features/workout/setTimerStore';
import { modelRoutine, modelSession } from './modelFixtures';

let n = 0;
beforeEach(async () => {
  localStorage.clear();
  setDb(new IronTrackDB(`compat-${++n}`));
  await db.open();
});

/** "App antigo": mesma base, esquema v2, sem os ganchos do P11 e sem conhecer os campos de modalidade. */
async function oldApp() {
  const old = new Dexie(db.name);
  old.version(2).stores({
    settings: 'id',
    profiles: 'id',
    routines: 'id, updatedAt, profileId',
    sessions: 'id, status, startedAt, workoutId, routineId, profileId',
    rotations: 'routineId',
    overrides: '[routineId+date], routineId, date',
    bodyEntries: 'id, date, profileId',
    photos: 'id, entryId, profileId',
  });
  await old.open();
  return old;
}

/** Como o editor do P09 salva: monta o exercício só com os campos que conhece. */
function stripLikeOldEditor(r: Routine, now: number): Routine {
  return {
    ...r,
    updatedAt: now,
    workouts: r.workouts.map((w) => ({
      ...w,
      exercises: w.exercises.map(({ id, name, muscleGroup, category, equipment, sets, repMin, repMax, restSec, warmupSets, targetWeight, notes, substitutes }) => ({
        id,
        name,
        muscleGroup,
        category,
        equipment,
        sets,
        repMin,
        repMax,
        restSec,
        warmupSets,
        ...(targetWeight !== undefined ? { targetWeight } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(substitutes !== undefined ? { substitutes } : {}),
      })),
    })),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('fotografia dos campos gravados por este app', () => {
  it('criar, alterar e excluir rotinas atualiza a fotografia (depois do commit)', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    await settle();
    expect(readModelSnapshot()[r.id].updatedAt).toBe(r.updatedAt);
    expect(Object.keys(readModelSnapshot()[r.id].exercises)).toEqual(['prancha', 'corrida', 'afundo', 'barra', 'paralelas']);
    await saveRoutine({ ...r, name: 'Outra' });
    await settle();
    const stored = (await db.routines.get(r.id))!;
    expect(readModelSnapshot()[r.id].updatedAt).toBe(stored.updatedAt);
    await deleteRoutine(r.id);
    await settle();
    expect(readModelSnapshot()[r.id]).toBeUndefined();
  });

  it('transação desfeita não atualiza a fotografia', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    await settle();
    const before = readModelSnapshot();
    await expect(
      db.transaction('rw', db.routines, async () => {
        await db.routines.put({ ...r, updatedAt: r.updatedAt + 99, workouts: [] });
        throw new Error('falha simulada');
      }),
    ).rejects.toThrow('falha simulada');
    await settle();
    expect(readModelSnapshot()).toEqual(before);
    expect((await db.routines.get(r.id))!.workouts).toHaveLength(r.workouts.length);
  });

  it('a fotografia fica fora do banco: nenhum registro ganha campo novo', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    expect(await db.routines.get(r.id)).toEqual({ ...r, profileId: db.currentProfileId });
  });
});

describe('app antigo regrava a rotina', () => {
  it('perda detectada, restaurada com confirmação, sem tocar em séries nem em outros campos', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    await db.sessions.put(modelSession('m1'));
    await settle();
    const old = await oldApp();
    const later = r.updatedAt + 60_000;
    await old.table('routines').put({ ...stripLikeOldEditor(r, later), profileId: db.currentProfileId, name: 'Renomeada no app antigo' });
    old.close();

    const routines = await db.routines.toArray();
    const losses = detectModelLoss(readModelSnapshot(), routines);
    expect(losses).toHaveLength(1);
    expect(losses[0].exercises.map((e) => e.exerciseId)).toEqual(['prancha', 'corrida', 'afundo', 'barra', 'paralelas']);
    expect(losses[0].exercises[0].missing).toEqual(pickModelFields(r.workouts[0].exercises.find((e) => e.id === 'prancha')!));

    expect(await restoreRoutineModel(losses[0])).toBe(true);
    await settle();
    const restored = (await db.routines.get(r.id))!;
    expect(restored.name).toBe('Renomeada no app antigo'); // a mudança do app antigo é mantida
    for (const e of r.workouts[0].exercises) expect(pickModelFields(restored.workouts[0].exercises.find((x) => x.id === e.id)!)).toEqual(pickModelFields(e));
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toEqual([]);
    expect(await db.sessions.get('m1')).toEqual({ ...modelSession('m1'), profileId: db.currentProfileId, exercises: (await db.sessions.get('m1'))!.exercises });
  });

  it('"Manter como está" aceita o estado atual sem restaurar', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    await settle();
    const old = await oldApp();
    await old.table('routines').put({ ...stripLikeOldEditor(r, r.updatedAt + 1), profileId: db.currentProfileId });
    old.close();
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toHaveLength(1);
    await acceptRoutineModel(r.id);
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toEqual([]);
    expect((await db.routines.get(r.id))!.workouts[0].exercises.find((e) => e.id === 'prancha')!.modality).toBeUndefined();
  });

  it('restaurar não age se a rotina mudou de novo desde a detecção', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    await settle();
    const old = await oldApp();
    await old.table('routines').put({ ...stripLikeOldEditor(r, r.updatedAt + 1), profileId: db.currentProfileId });
    const [loss] = detectModelLoss(readModelSnapshot(), await db.routines.toArray());
    await old.table('routines').put({ ...stripLikeOldEditor(r, r.updatedAt + 2), profileId: db.currentProfileId });
    old.close();
    expect(await restoreRoutineModel(loss)).toBe(false);
  });

  it('sem perda (app antigo não mexeu nos campos) ou exercício excluído: nenhum alerta', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    await settle();
    const old = await oldApp();
    await old.table('routines').put({ ...r, updatedAt: r.updatedAt + 5, name: 'Só renomeada', profileId: db.currentProfileId });
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toEqual([]);
    const without = { ...r, updatedAt: r.updatedAt + 6, workouts: [{ ...r.workouts[0], exercises: r.workouts[0].exercises.filter((e) => e.id !== 'prancha') }] };
    await old.table('routines').put({ ...without, profileId: db.currentProfileId });
    old.close();
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toEqual([]);
  });

  it('rotina criada antes deste app (sem fotografia): o primeiro estado visto vira a referência', async () => {
    const r = modelRoutine();
    const old = await oldApp();
    await old.table('routines').put({ ...r, profileId: db.currentProfileId });
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toEqual([]);
    baselineRoutineModels(await db.routines.toArray());
    await old.table('routines').put({ ...stripLikeOldEditor(r, r.updatedAt + 9), profileId: db.currentProfileId });
    old.close();
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toHaveLength(1);
  });

  it('restaurar nunca sobrescreve um valor presente', () => {
    const r = modelRoutine();
    const changed = structuredClone(r);
    changed.workouts[0].exercises[1] = { ...changed.workouts[0].exercises[1], modality: 'bodyweight' };
    const out = restoreModelFields(changed, {
      routineId: r.id,
      routineName: r.name,
      updatedAt: 0,
      exercises: [{ workoutId: r.workouts[0].id, exerciseId: 'prancha', name: 'Prancha', missing: { modality: 'timed', targetDurationSec: 45 } }],
    });
    expect(out.workouts[0].exercises[1]).toMatchObject({ modality: 'bodyweight', targetDurationSec: 45 });
  });
});

describe('marca de capacidade (app desatualizado)', () => {
  it('registra a capacidade atual e nunca a diminui; app mais velho que a marca é detectado', () => {
    expect(checkModelCapability()).toEqual({ newer: false, stored: null });
    expect(JSON.parse(localStorage.getItem(CAPABILITIES_KEY)!)).toEqual({ exerciseModel: 3 });
    localStorage.setItem(CAPABILITIES_KEY, JSON.stringify({ exerciseModel: 4, outro: true }));
    expect(checkModelCapability()).toEqual({ newer: true, stored: 4 });
    expect(JSON.parse(localStorage.getItem(CAPABILITIES_KEY)!)).toEqual({ exerciseModel: 4, outro: true });
    expect(isNewerCapability(3)).toBe(false);
    expect(isNewerCapability('9')).toBe(false);
    localStorage.setItem(CAPABILITIES_KEY, '{malformado');
    expect(checkModelCapability().newer).toBe(false);
  });
});

describe('backups continuam iguais', () => {
  it('nenhum estado auxiliar (fotografia, capacidade, cronômetro) entra no backup (v3, hoje v4); restaurar não gera alerta falso', async () => {
    const r = modelRoutine();
    await addRoutine(r);
    await db.sessions.put(modelSession('m1'));
    checkModelCapability();
    localStorage.setItem(SET_TIMER_KEY, JSON.stringify({ v: 1, sessionId: 's', exerciseId: 'e', setId: 'x', status: 'paused', accumulatedMs: 5000, segmentStartedAt: null, checkpointAt: 1, rev: 1 }));
    const b = await exportBackup();
    const text = JSON.stringify(b);
    expect(b.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    for (const k of [MODEL_SNAPSHOT_KEY, CAPABILITIES_KEY, SET_TIMER_KEY, 'accumulatedMs', 'appliedSec', 'checkpointAt']) expect(text).not.toContain(k);
    expect(b.data.routines[0]).toEqual({ ...r, profileId: db.currentProfileId });

    const parsed = parseBackup(text);
    if (!parsed.ok) throw new Error(parsed.errors.join());
    await restoreBackupReplace(parsed.value);
    await settle();
    expect(detectModelLoss(readModelSnapshot(), await db.routines.toArray())).toEqual([]);
    expect(localStorage.getItem(SET_TIMER_KEY)).not.toBeNull(); // estado transitório não é tocado pela restauração
  });
});
