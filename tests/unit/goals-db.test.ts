// Persistência das metas (IronTrack 2.0 F01/P12): migração Dexie v2 → v3 (tabela `goals`), banco antigo e novo,
// app anterior abrindo o banco novo, perfis, integridade, rollback, concorrência entre abas, edição e exclusão.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, IronTrackDB, clearLocalData, db, setDb } from '@/db/db';
import { GoalConflictError, createGoal, deleteGoal, getGoal, listGoals, setGoalStatus, updateGoal } from '@/db/goals';
import { checkLocalIntegrity, readSnapshot } from '@/lib/backup';
import { GoalRuleError } from '@/modules/goals';
import { OTHER_PROFILE, fields, goalRoutine, refOf, ses, set, supino } from './goalFixtures';
import { entry, photo, rotation, session, settings } from './fixtures';

// Cópias congeladas das declarações publicadas (as mesmas de migrations.test.ts).
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

const P1 = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Perfil', isDefault: true, createdAt: 1, updatedAt: 1 };

let n = 0;
const name = () => `goals-db-${++n}`;

async function open(dbName = name()) {
  setDb(new IronTrackDB(dbName));
  await db.open();
  return dbName;
}

/** Banco v2 (app do P11) com dados representativos de todas as tabelas, criado com Dexie puro. */
async function createV2(dbName: string) {
  const raw = new Dexie(dbName);
  raw.version(1).stores(V1_STORES);
  raw.version(2).stores(V2_STORES);
  await raw.open();
  const own = <T extends object>(r: T) => ({ ...r, profileId: P1.id });
  await raw.transaction('rw', raw.tables, async () => {
    await raw.table('profiles').put(P1);
    await raw.table('settings').put(settings({ activeRoutineId: 'gr' }));
    await raw.table('routines').put(own(goalRoutine()));
    await raw.table('sessions').bulkPut([own(ses('s1', '2026-03-03', [supino('sup-A', [set(80, 3)])])), own(session('s2', { status: 'active' }))]);
    await raw.table('rotations').put(rotation('gr'));
    await raw.table('overrides').put({ routineId: 'gr', date: '2026-03-10', kind: 'rest' });
    await raw.table('bodyEntries').put(own(entry('b1')));
    await raw.table('photos').put(own(photo('p1', 'b1')));
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

const loadGoal = (over = {}) => fields({ type: 'max_load', title: 'Supino 85', targetValue: 85, exercise: refOf(['sup-A', 'sup-B']), ...over });

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('migração v2 → v3', () => {
  it('banco antigo (v2): só acrescenta a tabela de metas; tabelas, perfis, IDs e relações intactos', async () => {
    const dbName = name();
    await createV2(dbName);
    const before = await rawDump(dbName);
    await open(dbName);
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    // P13/P16: a versão atual (5) também acrescenta as tabelas do planejamento e das decisões, vazias.
    expect(DB_SCHEMA_VERSION).toBe(6);
    expect(db.currentProfileId).toBe(P1.id);
    expect(await db.goals.count()).toBe(0);
    db.close();
    const after = await rawDump(dbName);
    expect(after.verno).toBe(DB_SCHEMA_VERSION);
    const { goals, planEntries, calendarDecisions, customExercises, exerciseFavorites, ...rest } = after.tables;
    expect(customExercises).toEqual([]);
    expect(exerciseFavorites).toEqual([]);
    expect(goals).toEqual([]);
    expect(planEntries).toEqual([]);
    expect(calendarDecisions).toEqual([]);
    expect(rest).toEqual(before.tables);
  });

  it('banco v1 → v3 numa única abertura: perfil criado, registros adotados, tabela de metas vazia', async () => {
    const dbName = name();
    const raw = new Dexie(dbName);
    raw.version(1).stores(V1_STORES);
    await raw.open();
    await raw.table('sessions').put(session('legado'));
    raw.close();
    await open(dbName);
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect((await db.sessions.get('legado'))?.profileId).toBe(db.currentProfileId);
    expect(await db.goals.count()).toBe(0);
    expect((await checkLocalIntegrity()).ok).toBe(true);
  });

  it('banco novo: cria direto na v3 com a tabela de metas indexada por perfil', async () => {
    await open();
    expect(db.tables.map((t) => t.name)).toContain('goals');
    expect(db.goals.schema.indexes.map((i) => i.name).sort()).toEqual(['profileId', 'status', 'updatedAt']);
  });

  it('app anterior (P11, declara só a v2) abre o banco v3, grava normalmente e não apaga as metas', async () => {
    const dbName = name();
    await createV2(dbName);
    await open(dbName);
    const g = await createGoal('g-compat', loadGoal());
    db.close();
    const p11 = new Dexie(dbName);
    p11.version(1).stores(V1_STORES);
    p11.version(2).stores(V2_STORES);
    await p11.open();
    expect(await p11.table('sessions').count()).toBe(2);
    await p11.table('sessions').put({ ...session('gravado-no-p11'), profileId: P1.id });
    p11.close();
    await open(dbName);
    expect(await getGoal('g-compat')).toEqual(g);
    expect(await db.sessions.get('gravado-no-p11')).toBeTruthy();
  });
});

describe('gravação de metas', () => {
  it('cria com o dono do perfil local, valida e é idempotente no mesmo ID (toque duplo)', async () => {
    await open();
    const a = await createGoal('g1', loadGoal(), 100);
    expect(a).toMatchObject({ id: 'g1', profileId: db.currentProfileId, revision: 1, status: 'active', unit: 'kg' });
    const again = await createGoal('g1', loadGoal(), 200);
    expect(again).toEqual(a);
    expect(await db.goals.count()).toBe(1);
    await expect(createGoal('g1', loadGoal({ title: 'Outra' }))).rejects.toBeInstanceOf(GoalConflictError);
    await expect(createGoal('g2', loadGoal({ targetValue: -5 }))).rejects.toBeInstanceOf(GoalRuleError);
    expect(await db.goals.count()).toBe(1);
  });

  it('isolamento entre perfis: metas de outro perfil não são listadas, lidas nem alteradas, e o dono nunca muda', async () => {
    await open();
    const mine = await createGoal('mine', loadGoal());
    await db.goals.put({ ...mine, id: 'theirs', profileId: OTHER_PROFILE });
    expect((await listGoals()).map((g) => g.id)).toEqual(['mine']);
    expect(await getGoal('theirs')).toBeUndefined();
    await expect(updateGoal('theirs', 1, { title: 'x', targetValue: 1, params: {}, startDate: mine.startDate, targetDate: null })).rejects.toMatchObject({ kind: 'deleted' });
    expect(await deleteGoal('theirs', 1)).toBe('already-deleted');
    expect(await db.goals.get('theirs')).toBeTruthy();
    await expect(db.goals.update('mine', { profileId: OTHER_PROFILE })).rejects.toThrow(/perfil/);
  });

  it('edição confere a versão: versão antiga é recusada sem gravar; exclusão concorrente é informada', async () => {
    await open();
    const g = await createGoal('g', loadGoal());
    const edit = { title: 'Supino 90', targetValue: 90, params: {}, startDate: g.startDate, targetDate: null };
    const v2 = await updateGoal('g', 1, edit, 500);
    expect(v2).toMatchObject({ revision: 2, targetValue: 90, updatedAt: 500, type: 'max_load', exercise: g.exercise });
    const stale = await updateGoal('g', 1, { ...edit, title: 'tela velha' }).catch((e) => e);
    expect(stale).toBeInstanceOf(GoalConflictError);
    expect(stale.kind).toBe('changed');
    expect(stale.current.title).toBe('Supino 90');
    expect((await getGoal('g'))!.title).toBe('Supino 90');
    await deleteGoal('g', 2);
    await expect(updateGoal('g', 2, edit)).rejects.toMatchObject({ kind: 'deleted' });
  });

  it('estado aplicado sobre a versão gravada: arquivar em outra aba não desfaz edição e repetir não duplica', async () => {
    await open();
    await createGoal('g', loadGoal());
    await updateGoal('g', 1, { title: 'Editada na aba A', targetValue: 85, params: {}, startDate: '2026-03-02', targetDate: null });
    const archived = await setGoalStatus('g', 'archive', '2026-03-20', 900);
    expect(archived).toMatchObject({ title: 'Editada na aba A', status: 'archived', revision: 3 });
    const twice = await setGoalStatus('g', 'archive', '2026-03-21', 901);
    expect(twice.revision).toBe(3);
    await expect(setGoalStatus('g', 'pause')).rejects.toThrow(/arquivada/);
    expect((await setGoalStatus('g', 'unarchive')).status).toBe('active');
    expect((await setGoalStatus('g', 'pause', '2026-03-22')).pauses).toEqual([{ from: '2026-03-22', to: null }]);
    expect((await setGoalStatus('g', 'resume', '2026-03-23')).status).toBe('active');
  });

  it('exclusão confirmada: versão mudou → nada é apagado; já excluída → sem erro', async () => {
    await open();
    await createGoal('g', loadGoal());
    await setGoalStatus('g', 'pause', '2026-03-10');
    await expect(deleteGoal('g', 1)).rejects.toMatchObject({ kind: 'changed' });
    expect(await db.goals.count()).toBe(1);
    expect(await deleteGoal('g', 2)).toBe('deleted');
    expect(await deleteGoal('g', 2)).toBe('already-deleted');
  });

  it('duas abas (duas conexões no mesmo banco): a segunda edição com versão antiga é recusada e a primeira fica', async () => {
    const dbName = await open();
    await createGoal('g', loadGoal());
    const tabA = db;
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    setDb(tabA);
    await updateGoal('g', 1, { title: 'Aba A', targetValue: 85, params: {}, startDate: '2026-03-02', targetDate: null });
    setDb(tabB);
    await expect(updateGoal('g', 1, { title: 'Aba B', targetValue: 85, params: {}, startDate: '2026-03-02', targetDate: null })).rejects.toMatchObject({ kind: 'changed' });
    expect((await getGoal('g'))!.title).toBe('Aba A');
    // Criação simultânea com o mesmo envio (mesmo ID): uma meta só.
    const fieldsC = loadGoal({ title: 'Mesmo envio' });
    await createGoal('c', fieldsC);
    setDb(tabA);
    await Promise.all([createGoal('c', fieldsC), createGoal('c', fieldsC)]);
    expect(await tabB.goals.filter((g) => g.title === 'Mesmo envio').count()).toBe(1);
    tabB.close();
  });

  it('falha no meio da gravação: transação desfeita, a meta fica como estava', async () => {
    await open();
    await createGoal('g', loadGoal());
    vi.spyOn(db.goals, 'put').mockImplementationOnce(() => Promise.reject(new Error('disco cheio (simulado)')) as never);
    await expect(updateGoal('g', 1, { title: 'Nova', targetValue: 99, params: {}, startDate: '2026-03-02', targetDate: null })).rejects.toThrow(/disco cheio/);
    expect(await getGoal('g')).toMatchObject({ title: 'Supino 85', revision: 1 });
  });

  it('metas nunca escrevem em treinos, rotinas ou outras tabelas; integridade local continua válida', async () => {
    const dbName = name();
    await createV2(dbName);
    await open(dbName);
    const before = await readSnapshot();
    await createGoal('g', loadGoal());
    await updateGoal('g', 1, { title: 'x', targetValue: 70, params: {}, startDate: '2026-03-02', targetDate: null });
    await setGoalStatus('g', 'pause', '2026-03-10');
    const after = await readSnapshot();
    expect({ ...after, goals: [] }).toEqual({ ...before, goals: [] });
    expect(after.goals).toHaveLength(1);
    expect((await checkLocalIntegrity()).ok).toBe(true);
  });

  it('"apagar tudo" também apaga as metas (mantém o perfil)', async () => {
    await open();
    await createGoal('g', loadGoal());
    await clearLocalData();
    expect(await db.goals.count()).toBe(0);
    expect(await db.profiles.count()).toBe(1);
  });
});
