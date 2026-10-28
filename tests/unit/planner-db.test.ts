// Persistência do planejamento semanal (IronTrack 2.0 F01/P13): migração Dexie v3 → v4 (tabela `planEntries`),
// app anterior abrindo o banco novo, perfis isolados, revisões, concorrência entre abas, exclusão, rollback,
// integridade e ausência de escrita fora da tabela. Dados fictícios.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, IronTrackDB, clearLocalData, db, setDb } from '@/db/db';
import { createGoal } from '@/db/goals';
import { PlanConflictError, addPlanActivity, clearPlanException, listPlanEntries, removePlanEntry, setPlanMarker, updatePlanActivity } from '@/db/planner';
import { addRoutine, completeSession, startSession } from '@/db/repo';
import { checkLocalIntegrity, readSnapshot } from '@/lib/backup';
import { planForDate, slotFingerprint } from '@/modules/planner';
import { fields } from './goalFixtures';
import { entry, photo, rotation, routine, session, settings } from './fixtures';

const V1_STORES = {
  settings: 'id',
  routines: 'id, updatedAt',
  sessions: 'id, status, startedAt, workoutId, routineId',
  rotations: 'routineId',
  overrides: '[routineId+date], routineId, date',
  bodyEntries: 'id, date',
  photos: 'id, entryId',
};
const V2_STORES = {
  settings: 'id',
  profiles: 'id',
  routines: 'id, updatedAt, profileId',
  sessions: 'id, status, startedAt, workoutId, routineId, profileId',
  rotations: 'routineId',
  overrides: '[routineId+date], routineId, date',
  bodyEntries: 'id, date, profileId',
  photos: 'id, entryId, profileId',
};
const V3_DECLARATION = { goals: 'id, profileId, status, updatedAt' };

const P1 = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Perfil', isDefault: true, createdAt: 1, updatedAt: 1 };
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WED = '2026-10-28';

let n = 0;
const name = () => `planner-db-${++n}`;

async function open(dbName = name()) {
  setDb(new IronTrackDB(dbName));
  await db.open();
  return dbName;
}

/** Banco v3 (app do P12) com dados de todas as tabelas, inclusive uma meta. */
async function createV3(dbName: string) {
  const raw = new Dexie(dbName);
  raw.version(1).stores(V1_STORES);
  raw.version(2).stores(V2_STORES);
  raw.version(3).stores(V3_DECLARATION);
  await raw.open();
  const own = <T extends object>(r: T) => ({ ...r, profileId: P1.id });
  await raw.transaction('rw', raw.tables, async () => {
    await raw.table('profiles').put(P1);
    await raw.table('settings').put(settings());
    await raw.table('routines').put(own(routine()));
    await raw.table('sessions').bulkPut([own(session('s1')), own(session('s2', { status: 'active', startedAt: 1_700_100_000_000 }))]);
    await raw.table('rotations').put(rotation());
    await raw.table('overrides').put({ routineId: 'r1', date: '2026-03-10', kind: 'rest' });
    await raw.table('bodyEntries').put(own(entry('b1')));
    await raw.table('photos').put(own(photo('p1', 'b1')));
    await raw.table('goals').put({ ...own({}), id: 'g1', type: 'weekly_frequency', title: 'x' });
  });
  raw.close();
}

async function rawDump(dbName: string) {
  const raw = new Dexie(dbName);
  await raw.open();
  const out: Record<string, unknown[]> = {};
  for (const t of raw.tables) out[t.name] = await t.toArray();
  const verno = raw.verno;
  raw.close();
  return { verno, tables: out };
}

const clock = (today = WED, now = 1_800_000_000_000) => {
  let i = 0;
  return { today, now, newId: () => `gen-${today}-${++i}` };
};
const monA = { id: 'seg-a', slot: { scope: 'weekly' as const, weekday: 1 }, activity: { routineId: 'r1', workoutId: 'r1-A' } };

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('migração v3 → v4', () => {
  it('banco do P12 (v3): só acrescenta a tabela de planejamento; metas, sessões, rotinas, perfis, fotos e avaliações intactos', async () => {
    const dbName = name();
    await createV3(dbName);
    const before = await rawDump(dbName);
    await open(dbName);
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    // P16: a versão atual (5) também acrescenta a tabela das decisões lembradas, vazia.
    expect(DB_SCHEMA_VERSION).toBe(5);
    expect(db.currentProfileId).toBe(P1.id);
    db.close();
    const after = await rawDump(dbName);
    expect(after.verno).toBe(5);
    const { planEntries, calendarDecisions, ...rest } = after.tables;
    expect(planEntries).toEqual([]);
    expect(calendarDecisions).toEqual([]);
    expect(rest).toEqual(before.tables);
  });

  it('banco v1 → v4 numa única abertura e banco novo direto na v4 com índices', async () => {
    const dbName = name();
    const raw = new Dexie(dbName);
    raw.version(1).stores(V1_STORES);
    await raw.open();
    await raw.table('sessions').put(session('legado'));
    raw.close();
    await open(dbName);
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect((await db.sessions.get('legado'))?.profileId).toBe(db.currentProfileId);
    expect(db.planEntries.schema.indexes.map((i) => i.name).sort()).toEqual(['date', 'profileId', 'routineId', 'scope', 'updatedAt']);
    expect((await checkLocalIntegrity()).ok).toBe(true);
  });

  it('app anterior (P12, declara até a v3) abre o banco v4, grava e não apaga o planejamento', async () => {
    const dbName = name();
    await createV3(dbName);
    await open(dbName);
    await addPlanActivity(monA, clock());
    db.close();
    const p12 = new Dexie(dbName);
    p12.version(1).stores(V1_STORES);
    p12.version(2).stores(V2_STORES);
    p12.version(3).stores(V3_DECLARATION);
    await p12.open();
    expect(await p12.table('goals').count()).toBe(1);
    await p12.table('sessions').put({ ...session('gravado-no-p12'), profileId: P1.id });
    p12.close();
    await open(dbName);
    expect((await listPlanEntries()).map((e) => e.id)).toEqual(['seg-a']);
    expect(await db.sessions.get('gravado-no-p12')).toBeTruthy();
  });
});

describe('gravação do planejamento', () => {
  it('cria com o dono do perfil local e é idempotente no mesmo ID; persiste após reabrir', async () => {
    const dbName = await open();
    const a = await addPlanActivity(monA, clock());
    expect(a).toMatchObject({ id: 'seg-a', profileId: db.currentProfileId, revision: 1, validFrom: WED });
    expect(await addPlanActivity(monA, clock())).toEqual(a);
    expect(await db.planEntries.count()).toBe(1);
    db.close();
    await open(dbName);
    expect(await listPlanEntries()).toEqual([a]);
  });

  it('perfis isolados: entradas de outro perfil não são listadas nem alteradas, e o dono não muda', async () => {
    await open();
    const mine = (await addPlanActivity(monA, clock()))!;
    await db.planEntries.put({ ...mine, id: 'theirs', profileId: OTHER });
    expect((await listPlanEntries()).map((e) => e.id)).toEqual(['seg-a']);
    await expect(updatePlanActivity({ id: 'theirs', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-B' } }, clock())).rejects.toMatchObject({ kind: 'deleted' });
    expect(await removePlanEntry({ id: 'theirs', expectedRevision: 1 }, clock())).toBeNull();
    expect(await db.planEntries.get('theirs')).toBeTruthy();
    await expect(db.planEntries.update('seg-a', { profileId: OTHER })).rejects.toThrow(/perfil/);
    // A mesma atividade no mesmo dia de outro perfil não conta como duplicada aqui.
    expect(planForDate(await listPlanEntries(), '2026-11-02').entries).toHaveLength(1);
  });

  it('revisões: versão antiga é recusada; alteração no modelo cria nova vigência e preserva o passado', async () => {
    await open();
    await addPlanActivity(monA, clock('2026-10-12'));
    const next = await updatePlanActivity({ id: 'seg-a', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-B' } }, clock());
    expect(next).toMatchObject({ workoutId: 'r1-B', validFrom: WED });
    await expect(updatePlanActivity({ id: 'seg-a', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock())).rejects.toBeInstanceOf(PlanConflictError);
    const all = await listPlanEntries();
    expect(planForDate(all, '2026-10-26').entries[0].workoutId).toBe('r1-A');
    expect(planForDate(all, '2026-11-02').entries[0].workoutId).toBe('r1-B');
  });

  it('duas abas (duas conexões): a segunda alteração com versão antiga é recusada; envio repetido não duplica', async () => {
    const dbName = await open();
    await addPlanActivity(monA, clock());
    const tabA = db;
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    setDb(tabA);
    await updatePlanActivity({ id: 'seg-a', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-B' } }, clock());
    setDb(tabB);
    await expect(updatePlanActivity({ id: 'seg-a', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock())).rejects.toMatchObject({ kind: 'changed' });
    expect((await tabB.planEntries.get('seg-a'))!.workoutId).toBe('r1-B');
    // Mesmo dia editado nas duas abas: a segunda vê a impressão digital mudar e não grava.
    const slot = { scope: 'date' as const, date: '2026-11-02' };
    const fp = slotFingerprint(await listPlanEntries(), slot, WED);
    await setPlanMarker({ id: 'rest-a', slot, kind: 'rest', expected: fp }, clock());
    setDb(tabA);
    await expect(addPlanActivity({ id: 'novo', slot, activity: { routineId: 'r1', workoutId: 'r1-C' }, expected: fp }, clock())).rejects.toMatchObject({ kind: 'changed' });
    await Promise.all([addPlanActivity({ ...monA, id: 'dup', slot: { scope: 'weekly', weekday: 5 } }, clock()), addPlanActivity({ ...monA, id: 'dup', slot: { scope: 'weekly', weekday: 5 } }, clock())]);
    expect(await tabB.planEntries.where('id').equals('dup').count()).toBe(1);
    tabB.close();
  });

  it('exclusão concorrente e exceções: remover de novo não é erro; voltar ao modelo apaga só as exceções', async () => {
    await open();
    await addPlanActivity(monA, clock('2026-10-12'));
    await setPlanMarker({ id: 'free', slot: { scope: 'date', date: '2026-11-02' }, kind: 'free' }, clock());
    expect(await removePlanEntry({ id: 'seg-a', expectedRevision: 1 }, clock())).toBeNull();
    expect(await removePlanEntry({ id: 'seg-a', expectedRevision: 2 }, clock())).toBeNull(); // segunda aba
    await clearPlanException({ date: '2026-11-02' }, clock());
    const all = await listPlanEntries();
    expect(all.map((e) => [e.id, e.validUntil])).toEqual([['seg-a', '2026-10-27']]);
  });

  it('falha no meio da gravação: transação desfeita, nada muda', async () => {
    await open();
    await addPlanActivity(monA, clock('2026-10-12'));
    const before = await listPlanEntries();
    vi.spyOn(db.planEntries, 'bulkPut').mockImplementationOnce(() => Promise.reject(new Error('disco cheio (simulado)')) as never);
    await expect(updatePlanActivity({ id: 'seg-a', expectedRevision: 1, activity: { routineId: 'r1', workoutId: 'r1-B' } }, clock())).rejects.toThrow(/disco cheio/);
    expect(await listPlanEntries()).toEqual(before);
  });

  it('nada inválido é gravado', async () => {
    await open();
    await expect(addPlanActivity({ id: 'x', slot: { scope: 'weekly', weekday: 9 }, activity: { routineId: 'r1', workoutId: null } }, clock())).rejects.toBeInstanceOf(PlanConflictError);
    await expect(addPlanActivity({ id: 'y', slot: { scope: 'weekly', weekday: 1 }, activity: { routineId: '', workoutId: null } }, clock())).rejects.toMatchObject({ kind: 'invalid' });
    expect(await db.planEntries.count()).toBe(0);
  });
});

describe('integridade e isolamento das outras tabelas', () => {
  it('planejar nunca escreve em sessões, rotinas, rotação, metas ou outras tabelas', async () => {
    const dbName = name();
    await createV3(dbName);
    await open(dbName);
    const before = await readSnapshot();
    const errorsBefore = (await checkLocalIntegrity()).issues.filter((i) => i.severity === 'error');
    await addPlanActivity(monA, clock());
    await setPlanMarker({ id: 'r', slot: { scope: 'weekly', weekday: 3 }, kind: 'rest' }, clock());
    await updatePlanActivity({ id: 'seg-a', expectedRevision: 1, onDate: '2026-11-02', activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock());
    const after = await readSnapshot();
    expect({ ...after, planEntries: [] }).toEqual({ ...before, planEntries: [] });
    // A meta mínima do banco de teste já era inválida; o planejamento não acrescenta nenhum erro.
    expect((await checkLocalIntegrity()).issues.filter((i) => i.severity === 'error')).toEqual(errorsBefore);
  });

  it('a rotação continua sendo regida só pelo fluxo de treino: iniciar não muda; concluir segue a regra existente', async () => {
    await open();
    const r = routine('rx');
    await addRoutine(r);
    await addPlanActivity({ id: 'p', slot: { scope: 'weekly', weekday: 1 }, activity: { routineId: 'rx', workoutId: 'rx-C' } }, clock());
    expect((await db.rotations.get('rx'))!.nextIndex).toBe(0);
    const s = await startSession('rx', 'rx-C'); // treino planejado (C) diferente do próximo da rotação (A)
    expect((await db.rotations.get('rx'))!.nextIndex).toBe(0);
    expect(await startSession('rx', 'rx-C')).toEqual(s); // treino em andamento é respeitado (sem duplicar)
    await completeSession({ ...s, exercises: s.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, status: 'done' as const, weight: 50, reps: 8 })) })) });
    // Mesma regra de sempre (indexAfter): segue a partir do treino realizado.
    expect((await db.rotations.get('rx'))!.nextIndex).toBe(0);
    expect((await listPlanEntries())[0].revision).toBe(1);
  });

  it('rotina excluída: o planejamento é preservado (sem exclusão silenciosa) e a integridade avisa', async () => {
    await open();
    await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
    await addPlanActivity(monA, clock());
    await db.routines.delete('r1');
    expect(await db.planEntries.count()).toBe(1);
    const report = await checkLocalIntegrity();
    expect(report.ok).toBe(true);
    expect(report.issues.map((i) => i.code)).toContain('PLAN_ROUTINE_MISSING');
  });

  it('"apagar tudo" também apaga o planejamento (mantém o perfil e não afeta metas de outro banco)', async () => {
    await open();
    await addPlanActivity(monA, clock());
    await createGoal('g', fields({ title: 'x', targetValue: 2 }));
    await clearLocalData();
    expect(await db.planEntries.count()).toBe(0);
    expect(await db.goals.count()).toBe(0);
    expect(await db.profiles.count()).toBe(1);
  });
});
