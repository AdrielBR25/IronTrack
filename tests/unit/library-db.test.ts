// Persistência da biblioteca de exercícios (IronTrack 2.0 F01/P17): migração Dexie v5 → v6, personalizados (CRUD,
// revisão, arquivamento, exclusão restrita), favoritos (idempotentes entre abas), operações da ficha aplicadas à
// versão gravada, backup v7 (exportar, substituir, mesclar, v6 antigo, outro perfil, inválidos) e integridade.
// Dados fictícios.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { DB_SCHEMA_VERSION, IronTrackDB, db, setDb } from '@/db/db';
import {
  createCustomExercise,
  customExerciseReferences,
  deleteCustomExercise,
  goalsLinkedTo,
  listCustomExercises,
  listFavorites,
  mutateWorkout,
  removeFavoriteRecord,
  setCustomArchived,
  setFavorite,
  updateCustomExercise,
} from '@/db/library';
import { createGoal } from '@/db/goals';
import {
  PROFILE_MERGE_BLOCKED_MESSAGE,
  assignOwner,
  checkLocalIntegrity,
  exportBackup,
  parseBackup,
  previewRestore,
  readSnapshot,
  restoreBackupMerge,
  restoreBackupReplace,
  type BackupFile,
} from '@/lib/backup';
import { CustomExerciseError, WorkoutOpError, catalogItem, customItem, favoriteId, instanceFromItem, substitutionPreview, type CustomFields } from '@/modules/exercises';
import { catalogById } from '@/modules/exercises/catalog';
import { buildSession } from '@/modules/training';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { fields, refOf } from './goalFixtures';
import { routine, session, settings, snapshot } from './fixtures';

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
const V3 = { goals: 'id, profileId, status, updatedAt' };
const V4 = { planEntries: 'id, profileId, scope, date, routineId, updatedAt' };
const V5 = { calendarDecisions: 'id, profileId, date, updatedAt' };
const V1_STORES = { settings: 'id', routines: 'id, updatedAt', sessions: 'id, status, startedAt, workoutId, routineId', rotations: 'routineId', overrides: '[routineId+date], routineId, date', bodyEntries: 'id, date', photos: 'id, entryId' };

const P1 = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'Perfil', isDefault: true, createdAt: 1, updatedAt: 1 };
const OTHER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', displayName: 'Outro perfil', createdAt: 1_600_000_000_000 };
const CX = 'cx_aaaaaaaa-1111';
const CX2 = 'cx_bbbbbbbb-2222';
const FIELDS: CustomFields = { name: 'Remada máquina articulada', modality: 'resistance', primaryMuscle: 'costas', secondaryMuscles: ['biceps'], equipment: ['maquina'], laterality: 'bilateral', loadMode: 'externa', mechanics: 'compound' };
const REST = { restCompoundSec: 150, restIsolationSec: 90 };
const inst = (catalogId: string, id: string) => instanceFromItem(catalogItem(catalogById(catalogId)!), { id, muscleGroups: DEFAULT_SETTINGS.muscleGroups, rest: REST });

let n = 0;
const name = () => `library-db-${++n}`;
async function open(dbName = name()) {
  setDb(new IronTrackDB(dbName));
  await db.open();
  return dbName;
}
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

async function seedRoutine() {
  await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
}
const parse = (o: unknown): BackupFile => {
  const r = parseBackup(JSON.stringify(o));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
};
const roundTrip = async () => parse(JSON.parse(JSON.stringify(await exportBackup())));

describe('migração v5 → v6', () => {
  it('banco v5 (P16): só acrescenta as duas tabelas vazias; dados, IDs e fichas antigas (sem origem) intactos', async () => {
    const dbName = name();
    const raw = new Dexie(dbName);
    raw.version(1).stores(V1_STORES);
    raw.version(2).stores(V2_STORES);
    raw.version(3).stores({ ...V2_STORES, ...V3 });
    raw.version(4).stores({ ...V2_STORES, ...V3, ...V4 });
    raw.version(5).stores({ ...V2_STORES, ...V3, ...V4, ...V5 });
    await raw.open();
    await raw.table('profiles').put(P1);
    await raw.table('settings').put(settings({ activeRoutineId: 'r1' }));
    await raw.table('routines').put({ ...routine(), profileId: P1.id });
    await raw.table('sessions').put({ ...session('s1'), profileId: P1.id });
    const before: Record<string, unknown[]> = {};
    for (const t of raw.tables) before[t.name] = await t.toArray();
    raw.close();

    await open(dbName);
    expect(DB_SCHEMA_VERSION).toBe(6);
    expect(db.verno).toBe(6);
    expect(db.customExercises.schema.indexes.map((i) => i.name).sort()).toEqual(['profileId', 'updatedAt']);
    expect(db.exerciseFavorites.schema.indexes.map((i) => i.name).sort()).toEqual(['profileId', 'target']);
    expect(await db.customExercises.count()).toBe(0);
    expect(await db.exerciseFavorites.count()).toBe(0);
    const r = await db.routines.get('r1');
    expect(r!.workouts[0].exercises[0]).not.toHaveProperty('catalogId');
    expect((await checkLocalIntegrity()).ok).toBe(true);
    db.close();

    const after = new Dexie(dbName);
    await after.open();
    for (const [t, rows] of Object.entries(before)) expect(await after.table(t).toArray(), t).toEqual(rows);
    after.close();
  });

  it('app anterior (P16, declara só a v5) abre o banco v6 sem apagar personalizados nem favoritos', async () => {
    const dbName = await open();
    await createCustomExercise(CX, FIELDS);
    await setFavorite('catalog:leg-press', true);
    db.close();
    const p16 = new Dexie(dbName);
    p16.version(1).stores(V1_STORES);
    p16.version(2).stores(V2_STORES);
    p16.version(5).stores({ ...V2_STORES, ...V3, ...V4, ...V5 });
    await p16.open().catch(() => undefined);
    p16.close();
    await open(dbName);
    expect((await listCustomExercises()).exercises.map((c) => c.id)).toEqual([CX]);
    expect((await listFavorites()).map((f) => f.target)).toEqual(['catalog:leg-press']);
  });
});

describe('exercícios personalizados', () => {
  it('cria com o dono local, valida (sem HTML), é idempotente no mesmo ID e respeita o limite', async () => {
    await open();
    const c = await createCustomExercise(CX, FIELDS, 100);
    expect(c).toMatchObject({ id: CX, profileId: db.currentProfileId, revision: 1, archivedAt: null });
    expect(await createCustomExercise(CX, { ...FIELDS, name: 'Outro' })).toEqual(c);
    expect(await db.customExercises.count()).toBe(1);
    await expect(createCustomExercise(CX2, { ...FIELDS, name: '<b>x</b>' })).rejects.toThrow();
    await expect(createCustomExercise('supino-reto-barra', FIELDS)).rejects.toThrow();
    expect(await db.customExercises.count()).toBe(1);
  });

  it('edição confere a revisão (outra aba editou → recusa sem gravar); arquivar/restaurar sobre a versão gravada', async () => {
    await open();
    await createCustomExercise(CX, FIELDS);
    const v2 = await updateCustomExercise(CX, 1, { ...FIELDS, name: 'Aba A' }, 200);
    expect(v2).toMatchObject({ revision: 2, name: 'Aba A' });
    const stale = await updateCustomExercise(CX, 1, { ...FIELDS, name: 'Aba B' }).catch((e) => e);
    expect(stale).toBeInstanceOf(CustomExerciseError);
    expect(stale.code).toBe('changed');
    expect((await db.customExercises.get(CX))!.name).toBe('Aba A');
    const a = await setCustomArchived(CX, true, 300);
    expect(a).toMatchObject({ archivedAt: 300, revision: 3, name: 'Aba A' });
    expect((await setCustomArchived(CX, true, 400)).revision).toBe(3);
    expect((await setCustomArchived(CX, false, 500)).archivedAt).toBeNull();
    await expect(updateCustomExercise('cx_naoexiste-0000', 1, FIELDS)).rejects.toMatchObject({ code: 'deleted' });
  });

  it('isolamento: personalizado de outro perfil não aparece nem pode ser alterado; registro inválido é ignorado', async () => {
    await open();
    const mine = await createCustomExercise(CX, FIELDS);
    await db.customExercises.put({ ...mine, id: CX2, profileId: OTHER.id });
    await db.customExercises.put({ ...mine, id: 'cx_invalido-0000', name: '' });
    const listed = await listCustomExercises();
    expect(listed.exercises.map((c) => c.id)).toEqual([CX]);
    expect(listed.invalidIds).toEqual(['cx_invalido-0000']);
    await expect(updateCustomExercise(CX2, 1, FIELDS)).rejects.toMatchObject({ code: 'deleted' });
    expect(await deleteCustomExercise(CX2, 1)).toBe('already-deleted');
    expect(await db.customExercises.get(CX2)).toBeTruthy();
  });

  it('exclusão definitiva só sem referências (fichas ou histórico); remove o favorito junto', async () => {
    await open();
    await seedRoutine();
    const c = await createCustomExercise(CX, FIELDS);
    await setFavorite(`custom:${CX}`, true);
    const t = instanceFromItem(customItem(c), { id: 'cx-inst', muscleGroups: DEFAULT_SETTINGS.muscleGroups, rest: REST });
    await mutateWorkout('r1', 'r1-A', { type: 'add', exercise: t });
    expect(await customExerciseReferences(CX)).toEqual({ templates: 1, sessions: 0 });
    await expect(deleteCustomExercise(CX, 1)).rejects.toMatchObject({ code: 'in_use' });
    // Removido da ficha mas presente no histórico: continua protegido.
    const r = (await db.routines.get('r1'))!;
    await db.sessions.put({ ...buildSession(r, r.workouts[0], [], 1000), profileId: db.currentProfileId!, status: 'completed' });
    await mutateWorkout('r1', 'r1-A', { type: 'remove', id: 'cx-inst' });
    expect(await customExerciseReferences(CX)).toEqual({ templates: 0, sessions: 1 });
    await expect(deleteCustomExercise(CX, 1)).rejects.toMatchObject({ code: 'in_use' });
    expect(await db.customExercises.get(CX)).toBeTruthy();
    // Sem uso: exclui (com a revisão confirmada) e leva o favorito.
    const free = await createCustomExercise(CX2, { ...FIELDS, name: 'Livre' });
    await setFavorite(`custom:${CX2}`, true);
    await expect(deleteCustomExercise(CX2, 99)).rejects.toMatchObject({ code: 'changed' });
    expect(await deleteCustomExercise(CX2, free.revision)).toBe('deleted');
    expect(await deleteCustomExercise(CX2, free.revision)).toBe('already-deleted');
    expect((await listFavorites()).map((f) => f.target)).toEqual([`custom:${CX}`]);
  });
});

describe('favoritos', () => {
  it('idempotente e com ID determinístico: duas abas (duas conexões) gravam um registro só', async () => {
    const dbName = await open();
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    const pid = db.currentProfileId!;
    expect(tabB.currentProfileId).toBe(pid);
    await Promise.all([setFavorite('catalog:stiff', true, 1), setFavorite('catalog:stiff', true, 2)]);
    await tabB.exerciseFavorites.put({ id: favoriteId(pid, 'catalog:stiff'), profileId: pid, target: 'catalog:stiff', createdAt: 3 });
    expect(await db.exerciseFavorites.count()).toBe(1);
    expect(await setFavorite('catalog:stiff', false)).toBe(false);
    expect(await setFavorite('catalog:stiff', false)).toBe(false);
    expect(await tabB.exerciseFavorites.count()).toBe(0);
    tabB.close();
    await expect(setFavorite('catalog:<x>' as never, true)).rejects.toThrow();
  });

  it('favorito de exercício que sumiu fica no banco até ser removido explicitamente', async () => {
    await open();
    await setFavorite('custom:cx_sumiu000-0000', true);
    expect(await listFavorites()).toHaveLength(1);
    await removeFavoriteRecord(favoriteId(db.currentProfileId!, 'custom:cx_sumiu000-0000'));
    expect(await listFavorites()).toHaveLength(0);
  });
});

describe('construtor de fichas (operações sobre a versão gravada)', () => {
  it('adicionar do catálogo, duplicar, mover, substituir; a rotação e os demais treinos não mudam', async () => {
    await open();
    await seedRoutine();
    await db.rotations.put({ routineId: 'r1', order: ['r1-A', 'r1-B', 'r1-C'], nextIndex: 1, updatedAt: 1 } as never);
    const rotBefore = await db.rotations.get('r1');
    await mutateWorkout('r1', 'r1-A', { type: 'add', exercise: inst('leg-press', 'lp') });
    await mutateWorkout('r1', 'r1-A', { type: 'add', exercise: inst('leg-press', 'lp') });
    await mutateWorkout('r1', 'r1-A', { type: 'duplicate', id: 'lp', newId: 'lp2' });
    await mutateWorkout('r1', 'r1-A', { type: 'move', id: 'lp2', delta: -1 });
    const sup = (await db.routines.get('r1'))!.workouts[0].exercises.find((e) => e.id === 'lp')!;
    const p = substitutionPreview(sup, catalogItem(catalogById('agachamento-livre')!), { id: 'agach', muscleGroups: DEFAULT_SETTINGS.muscleGroups, rest: REST, linkedGoals: 0 });
    await mutateWorkout('r1', 'r1-A', { type: 'replace', id: 'lp', exercise: p.next });
    const r = (await db.routines.get('r1'))!;
    expect(r.workouts[0].exercises.map((e) => e.id)).toEqual(['r1-A-e1', 'r1-A-e2', 'lp2', 'agach']);
    expect(r.workouts[0].exercises.find((e) => e.id === 'agach')).toMatchObject({ catalogId: 'agachamento-livre' });
    expect(r.workouts.slice(1)).toEqual(routine().workouts.slice(1));
    expect(await db.rotations.get('r1')).toEqual(rotBefore);
  });

  it('duas abas no mesmo treino: cada ação é aplicada à versão gravada, nada é perdido', async () => {
    const dbName = await open();
    await seedRoutine();
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    await Promise.all([
      mutateWorkout('r1', 'r1-A', { type: 'add', exercise: inst('stiff', 'aba-a') }),
      mutateWorkout('r1', 'r1-A', { type: 'add', exercise: inst('mesa-flexora', 'aba-b') }),
      mutateWorkout('r1', 'r1-A', { type: 'remove', id: 'r1-A-e1' }),
    ]);
    // Tela velha reordena com IDs antigos: o que ela não conhecia vai para o fim, sem sumir.
    await mutateWorkout('r1', 'r1-A', { type: 'reorder', order: ['r1-A-e2', 'r1-A-e1'] });
    const r = (await tabB.routines.get('r1'))!;
    expect(r.workouts[0].exercises.map((e) => e.id).sort()).toEqual(['aba-a', 'aba-b', 'r1-A-e2'].sort());
    expect(r.workouts[0].exercises[0].id).toBe('r1-A-e2');
    tabB.close();
    await expect(mutateWorkout('r1', 'r1-A', { type: 'update', exercise: { ...inst('stiff', 'x') } })).rejects.toBeInstanceOf(WorkoutOpError);
    await expect(mutateWorkout('nao', 'r1-A', { type: 'remove', id: 'x' })).rejects.toMatchObject({ code: 'missing_routine' });
    await expect(mutateWorkout('r1', 'nao', { type: 'remove', id: 'x' })).rejects.toMatchObject({ code: 'missing_workout' });
  });

  it('personalizado arquivado ou excluído não entra em ficha nova; o que já estava continua', async () => {
    await open();
    await seedRoutine();
    const c = await createCustomExercise(CX, FIELDS);
    const t = instanceFromItem(customItem(c), { id: 'antes', muscleGroups: DEFAULT_SETTINGS.muscleGroups, rest: REST });
    await mutateWorkout('r1', 'r1-A', { type: 'add', exercise: t });
    await setCustomArchived(CX, true);
    await expect(mutateWorkout('r1', 'r1-B', { type: 'add', exercise: { ...t, id: 'depois' } })).rejects.toMatchObject({ code: 'archived' });
    await expect(mutateWorkout('r1', 'r1-B', { type: 'add', exercise: { ...t, id: 'x', customExerciseId: 'cx_naoexiste-0000' } })).rejects.toMatchObject({ code: 'deleted' });
    expect((await db.routines.get('r1'))!.workouts[0].exercises.some((e) => e.id === 'antes')).toBe(true);
  });

  it('substituir não redireciona metas: a meta continua ligada ao ID antigo', async () => {
    await open();
    await db.routines.put({ ...routine('gr'), profileId: db.currentProfileId! });
    await createGoal('g1', fields({ type: 'max_load', title: 'Meta', targetValue: 90, exercise: refOf(['gr-A-e1']) }));
    expect(await goalsLinkedTo('gr-A-e1')).toBe(1);
    await mutateWorkout('gr', 'gr-A', { type: 'replace', id: 'gr-A-e1', exercise: inst('supino-inclinado-halteres', 'novo') });
    expect((await db.goals.get('g1'))!.exercise!.templateIds).toEqual(['gr-A-e1']);
    expect(await goalsLinkedTo('novo')).toBe(0);
  });
});

describe('backup v7', () => {
  async function seedLibrary() {
    await seedRoutine();
    const c = await createCustomExercise(CX, FIELDS, 100);
    await setFavorite('catalog:leg-press', true, 1);
    await setFavorite(`custom:${CX}`, true, 2);
    await mutateWorkout('r1', 'r1-A', { type: 'add', exercise: inst('leg-press', 'lp') });
    return c;
  }

  it('exporta personalizados, favoritos e a origem nas fichas; substituir devolve tudo igual', async () => {
    await open();
    await seedLibrary();
    const b = await roundTrip();
    expect(b.schemaVersion).toBe(8);
    expect(b.data.customExercises.map((c) => c.id)).toEqual([CX]);
    expect(b.data.exerciseFavorites.map((f) => f.target).sort()).toEqual(['catalog:leg-press', `custom:${CX}`]);
    expect(b.data.routines[0].workouts[0].exercises.find((e) => e.id === 'lp')).toMatchObject({ catalogId: 'leg-press', catalogVersion: 1 });
    const before = await readSnapshot();
    await db.customExercises.clear();
    await db.exerciseFavorites.clear();
    const p = await previewRestore(b);
    expect(p.incoming.customExercises).toBe(1);
    expect(p.incoming.exerciseFavorites).toBe(2);
    const sum = await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(sum).toMatchObject({ customExercises: 1, exerciseFavorites: 2 });
    expect(await readSnapshot()).toEqual(before);
  });

  it('mesclar: só acrescenta o que falta (por ID), nunca sobrescreve o personalizado local', async () => {
    await open();
    await seedLibrary();
    const b = await roundTrip();
    await updateCustomExercise(CX, 1, { ...FIELDS, name: 'Editado depois do backup' });
    await setFavorite('catalog:leg-press', false);
    const p = await previewRestore(b);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect((await db.customExercises.get(CX))!.name).toBe('Editado depois do backup');
    expect((await listFavorites()).map((f) => f.target).sort()).toEqual(['catalog:leg-press', `custom:${CX}`]);
  });

  it('backup v6 (antes da biblioteca) é aceito com as listas vazias; fichas sem origem continuam válidas', async () => {
    await open();
    const data: Record<string, unknown> = { ...assignOwner(snapshot(), db.currentProfileId!) };
    delete data.customExercises;
    delete data.exerciseFavorites;
    const b = parse({ app: 'irontrack', kind: 'backup', schemaVersion: 6, exportedAt: '2026-10-01T12:00:00.000Z', profile: { id: db.currentProfileId, displayName: 'Perfil' }, data });
    expect(b.schemaVersion).toBe(8);
    expect(b.data.customExercises).toEqual([]);
    expect(b.data.exerciseFavorites).toEqual([]);
    const p = await previewRestore(b);
    expect(p.blocked).toBe(false);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect((await checkLocalIntegrity()).ok).toBe(true);
  });

  it('backup de outro perfil: mesclar bloqueado; substituir adota personalizados e refaz o ID dos favoritos', async () => {
    await open();
    await seedLibrary();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.profile = OTHER;
    raw.data = assignOwner(raw.data, OTHER.id);
    const b = parse(raw);
    expect(b.data.exerciseFavorites.every((f) => f.id.startsWith(`${OTHER.id}~`))).toBe(true);
    const p = await previewRestore(b);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true })).rejects.toThrow(PROFILE_MERGE_BLOCKED_MESSAGE);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint, acceptProfileTransfer: true });
    const pid = db.currentProfileId!;
    expect((await db.exerciseFavorites.toArray()).every((f) => f.profileId === pid && f.id === favoriteId(pid, f.target))).toBe(true);
    expect((await listFavorites())).toHaveLength(2);
    expect((await listCustomExercises()).exercises.map((c) => c.profileId)).toEqual([pid]);
  });

  it('personalizado ou favorito inválido bloqueia a restauração; nada é gravado', async () => {
    await open();
    await seedLibrary();
    const before = await readSnapshot();
    for (const bad of [
      (d: BackupFile['data']) => { (d.customExercises[0] as { name: string }).name = '<script>x</script>'; },
      (d: BackupFile['data']) => { (d.customExercises[0] as { modality: string }).modality = 'yoga'; },
      (d: BackupFile['data']) => { (d.exerciseFavorites[0] as { id: string }).id = 'qualquer'; },
    ]) {
      const raw = JSON.parse(JSON.stringify(await exportBackup()));
      bad(raw.data);
      const b = parse(raw);
      const p = await previewRestore(b);
      expect(p.blocked).toBe(true);
      await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    }
    expect(await readSnapshot()).toEqual(before);
  });

  it('origem que aponta para item inexistente é só informativa (o exercício da ficha continua utilizável)', async () => {
    await open();
    await seedRoutine();
    await mutateWorkout('r1', 'r1-A', { type: 'add', exercise: { ...inst('leg-press', 'lp'), catalogId: 'retirado-do-catalogo' } });
    // Personalizado excluído (ou backup de outro aparelho): gravado direto, como chegaria por uma restauração.
    const r = (await db.routines.get('r1'))!;
    const { catalogId: _c, catalogVersion: _v, ...plain } = inst('leg-press', 'cx');
    r.workouts[1].exercises.push({ ...plain, customExerciseId: 'cx_sumiu000-0000' });
    await db.routines.put(r);
    const rep = await checkLocalIntegrity();
    expect(rep.ok).toBe(true);
    // O catálogo não é carregado na verificação (fica fora do pacote principal): só o personalizado ausente é citado.
    expect(rep.issues.filter((i) => i.code === 'LIBRARY_REF_MISSING')).toMatchObject([{ severity: 'info', collection: 'routines', id: 'r1' }]);
  });
});
