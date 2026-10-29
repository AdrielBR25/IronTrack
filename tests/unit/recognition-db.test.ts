// Reconhecimento assistido e operações em lote no banco (IronTrack 2.0 F01/P18): associação atômica com revalidação,
// desassociação, concorrência entre abas (duas conexões no mesmo banco), toque duplo, restauração durante a prévia,
// persistência sem novo esquema (Dexie v6 / backup v7) e backup (exportar, substituir, mesclar, outro perfil, antigo).
// Dados fictícios.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB_SCHEMA_VERSION, IronTrackDB, db, setDb } from '@/db/db';
import { applyLinks, createCustomExercise, goalsLinkedToMany, mutateWorkout, setCustomArchived, setFavorite, unlinkExercise, type LinkRequest } from '@/db/library';
import { createGoal } from '@/db/goals';
import { assignOwner, checkLocalIntegrity, exportBackup, parseBackup, previewRestore, readSnapshot, restoreBackupMerge, restoreBackupReplace, type BackupFile } from '@/lib/backup';
import { BACKUP_SCHEMA_VERSION } from '@/lib/backupFormat';
import {
  addManyOp,
  bulkReplacePreview,
  catalogItem,
  instanceFingerprint,
  instancesForAddMany,
  replaceManyOp,
  type CustomFields,
  type LibraryRef,
} from '@/modules/exercises';
import { catalogById } from '@/modules/exercises/catalog';
import type { ExerciseTemplate, Routine } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { fields, refOf } from './goalFixtures';
import { routine, session } from './fixtures';

const OTHER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', displayName: 'Outro perfil', createdAt: 1_600_000_000_000 };
const CX = 'cx_aaaaaaaa-1111';
const FIELDS: CustomFields = { name: 'Remada máquina articulada', modality: 'resistance', primaryMuscle: 'costas', secondaryMuscles: [], equipment: ['maquina'], laterality: 'bilateral', loadMode: 'externa', mechanics: 'compound' };
const O = { muscleGroups: DEFAULT_SETTINGS.muscleGroups, rest: { restCompoundSec: 150, restIsolationSec: 90 } };
const item = (id: string) => catalogItem(catalogById(id)!);
const LEG: LibraryRef = { catalogId: 'leg-press', catalogVersion: 1 };
const STIFF: LibraryRef = { catalogId: 'stiff', catalogVersion: 1 };

let n = 0;
async function open() {
  setDb(new IronTrackDB(`recognition-db-${++n}`));
  await db.open();
  await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
  await db.rotations.put({ routineId: 'r1', nextIndex: 1 } as never);
}
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** Outra aba: outra conexão no mesmo banco. */
async function otherTab() {
  const tab = new IronTrackDB(db.name);
  await tab.open();
  return tab;
}
const stored = async (wid = 'r1-A') => (await db.routines.get('r1'))!.workouts.find((w) => w.id === wid)!;
const exOf = async (id: string, wid = 'r1-A') => (await stored(wid)).exercises.find((e) => e.id === id)!;
async function req(id: string, ref: LibraryRef, wid = 'r1-A'): Promise<LinkRequest> {
  const e = await exOf(id, wid);
  return { routineId: 'r1', workoutId: wid, id, expected: instanceFingerprint(e), ref, name: e.name };
}
async function editInTab(tab: IronTrackDB, fn: (r: Routine) => void) {
  const r = (await tab.routines.get('r1'))!;
  fn(r);
  r.updatedAt += 1;
  await tab.routines.put(r);
}
const parse = (o: unknown): BackupFile => {
  const r = parseBackup(JSON.stringify(o));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
};

describe('persistência', () => {
  it('não há esquema novo: Dexie v6 e backup v7 (a origem já é campo opcional da instância)', () => {
    expect(DB_SCHEMA_VERSION).toBe(6);
    expect(BACKUP_SCHEMA_VERSION).toBe(7);
  });
});

describe('associação (applyLinks)', () => {
  it('grava só a origem; sessões, metas, rotação, planejamento e demais treinos ficam iguais', async () => {
    await open();
    await db.sessions.put({ ...session('s1'), profileId: db.currentProfileId! });
    await createGoal('g1', fields({ type: 'max_load', exercise: refOf(['r1-A-e1'], { routineId: 'r1', name: 'Exercício r1-A1' }), targetValue: 100, params: {} }));
    const before = await readSnapshot();
    const e1 = await exOf('r1-A-e1');
    const r = await applyLinks([await req('r1-A-e1', LEG)], 5_000_000_000_000);
    expect(r).toMatchObject({ applied: true, results: [{ status: 'linked' }] });
    const after = await readSnapshot();
    expect(await exOf('r1-A-e1')).toEqual({ ...e1, ...LEG });
    expect(after.sessions).toEqual(before.sessions);
    expect(after.goals).toEqual(before.goals);
    expect(after.rotations).toEqual(before.rotations);
    expect(after.planEntries).toEqual(before.planEntries);
    const rb = before.routines[0];
    const ra = after.routines[0];
    expect(ra.workouts.slice(1)).toEqual(rb.workouts.slice(1));
    expect(ra.workouts[0].exercises[1]).toEqual(rb.workouts[0].exercises[1]);
    expect(ra.updatedAt).toBe(5_000_000_000_000);
  });

  it('lote: tudo ou nada — uma entrada alterada em outra aba impede todas, com o motivo de cada uma', async () => {
    await open();
    const reqs = [await req('r1-A-e1', LEG), await req('r1-A-e2', STIFF), await req('r1-B-e1', LEG, 'r1-B')];
    const tab = await otherTab();
    await editInTab(tab, (r) => (r.workouts[0].exercises[1].sets = 9));
    tab.close();
    const before = await readSnapshot();
    const r = await applyLinks(reqs);
    expect(r.applied).toBe(false);
    expect(r.results.map((x) => x.status)).toEqual(['linked', 'changed', 'linked']);
    expect(r.results[1].message).toMatch(/alterado depois da prévia/);
    expect(await readSnapshot()).toEqual(before);
    // Revisado de novo, aplica tudo.
    const again = await applyLinks([reqs[0], await req('r1-A-e2', STIFF), reqs[2]]);
    expect(again.applied).toBe(true);
    expect((await stored()).exercises.map((e) => e.catalogId)).toEqual(['leg-press', 'stiff']);
    expect((await exOf('r1-B-e1', 'r1-B')).catalogId).toBe('leg-press');
  });

  it('mesmo exercício em duas abas: a segunda (mesma escolha) não muda nada; escolha diferente não sobrescreve', async () => {
    await open();
    const a = await req('r1-A-e1', LEG);
    const b = { ...a };
    expect((await applyLinks([a])).results[0].status).toBe('linked');
    expect(await applyLinks([b])).toMatchObject({ applied: true, results: [{ status: 'already' }] });
    const r = await applyLinks([{ ...b, ref: STIFF }]);
    expect(r).toMatchObject({ applied: false, results: [{ status: 'already_linked' }] });
    expect((await exOf('r1-A-e1')).catalogId).toBe('leg-press');
  });

  it('exercícios diferentes do mesmo treino associados por duas abas: as duas associações ficam', async () => {
    await open();
    const a = await req('r1-A-e1', LEG);
    const b = await req('r1-A-e2', STIFF);
    await applyLinks([a]);
    await applyLinks([b]);
    expect((await stored()).exercises.map((e) => e.catalogId)).toEqual(['leg-press', 'stiff']);
  });

  it('toque duplo na confirmação: uma gravação só', async () => {
    await open();
    const a = await req('r1-A-e1', LEG);
    const put = vi.spyOn(db.routines, 'put');
    const [x, y] = await Promise.all([applyLinks([a]), applyLinks([a])]);
    expect([x.results[0].status, y.results[0].status].sort()).toEqual(['already', 'linked']);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('exercício excluído durante a prévia, rotina excluída, personalizado arquivado ou excluído: nada é gravado', async () => {
    await open();
    const a = await req('r1-A-e1', LEG);
    const tab = await otherTab();
    await editInTab(tab, (r) => r.workouts[0].exercises.splice(0, 1));
    tab.close();
    expect(await applyLinks([a])).toMatchObject({ applied: false, results: [{ status: 'missing_exercise' }] });
    await createCustomExercise(CX, FIELDS);
    const c = await req('r1-A-e2', { customExerciseId: CX });
    await setCustomArchived(CX, true);
    expect(await applyLinks([c])).toMatchObject({ applied: false, results: [{ status: 'custom_archived' }] });
    await setCustomArchived(CX, false);
    expect(await applyLinks([c])).toMatchObject({ applied: true, results: [{ status: 'linked' }] });
    expect((await exOf('r1-A-e2')).customExerciseId).toBe(CX);
    expect(await applyLinks([{ ...c, id: 'r1-B-e1', workoutId: 'r1-B', ref: { customExerciseId: 'cx_naoexiste-0000' } }])).toMatchObject({ applied: false, results: [{ status: 'custom_deleted' }] });
    await db.routines.delete('r1');
    expect(await applyLinks([c])).toMatchObject({ applied: false, results: [{ status: 'missing_routine' }] });
  });

  it('rotina de outro perfil não é alcançada', async () => {
    await open();
    await db.routines.put({ ...routine('r2'), profileId: OTHER.id });
    const e = (await db.routines.get('r2'))!.workouts[0].exercises[0];
    const r = await applyLinks([{ routineId: 'r2', workoutId: 'r2-A', id: e.id, expected: instanceFingerprint(e), ref: LEG, name: e.name }]);
    expect(r).toMatchObject({ applied: false, results: [{ status: 'missing_routine' }] });
  });

  it('restaurar um backup durante a prévia: se a instância voltou diferente, a associação é recusada', async () => {
    await open();
    const b = parse(JSON.parse(JSON.stringify(await exportBackup())));
    await mutateWorkout('r1', 'r1-A', { type: 'update', exercise: { ...(await exOf('r1-A-e1')), sets: 5 } });
    const a = await req('r1-A-e1', LEG);
    const p = await previewRestore(b);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await applyLinks([a])).toMatchObject({ applied: false, results: [{ status: 'changed' }] });
    expect((await exOf('r1-A-e1')).sets).toBe(3);
  });
});

describe('desassociação', () => {
  it('remove só a origem (explícita), é reversível e não toca favoritos nem o personalizado', async () => {
    await open();
    await createCustomExercise(CX, FIELDS);
    await setFavorite(`custom:${CX}`, true);
    const original = await exOf('r1-A-e1');
    await applyLinks([await req('r1-A-e1', { customExerciseId: CX })]);
    const linked = await exOf('r1-A-e1');
    const favs = await db.exerciseFavorites.toArray();
    const custom = await db.customExercises.get(CX);
    const r = await unlinkExercise('r1', 'r1-A', 'r1-A-e1', instanceFingerprint(linked));
    expect(r.changed).toBe(true);
    expect(await exOf('r1-A-e1')).toEqual(original);
    expect(await db.exerciseFavorites.toArray()).toEqual(favs);
    expect(await db.customExercises.get(CX)).toEqual(custom);
    // Repetir não muda nada; associar de novo volta ao estado associado.
    expect((await unlinkExercise('r1', 'r1-A', 'r1-A-e1', instanceFingerprint(linked))).changed).toBe(false);
    await applyLinks([await req('r1-A-e1', { customExerciseId: CX })]);
    expect(await exOf('r1-A-e1')).toEqual(linked);
  });

  it('desassociar algo que outra aba editou desde a prévia é recusado', async () => {
    await open();
    await applyLinks([await req('r1-A-e1', LEG)]);
    const seen = await exOf('r1-A-e1');
    const tab = await otherTab();
    await editInTab(tab, (r) => (r.workouts[0].exercises[0].restSec = 30));
    tab.close();
    await expect(unlinkExercise('r1', 'r1-A', 'r1-A-e1', instanceFingerprint(seen))).rejects.toMatchObject({ code: 'changed' });
    expect((await exOf('r1-A-e1')).catalogId).toBe('leg-press');
  });
});

describe('concorrência com edição, substituição e adição', () => {
  it('editar a configuração (formulário aberto antes) enquanto outra aba associa: a associação não se perde', async () => {
    await open();
    const formCopy = await exOf('r1-A-e1');
    await applyLinks([await req('r1-A-e1', LEG)]);
    await mutateWorkout('r1', 'r1-A', { type: 'update', exercise: { ...formCopy, sets: 4 } });
    expect(await exOf('r1-A-e1')).toMatchObject({ sets: 4, ...LEG });
  });

  it('substituir (prévia aberta) enquanto outra aba associa: recusa com a impressão digital da prévia', async () => {
    await open();
    const seen = await exOf('r1-A-e1');
    await applyLinks([await req('r1-A-e1', LEG)]);
    const next = { ...seen, id: 'novo', name: 'Outro' };
    await expect(mutateWorkout('r1', 'r1-A', { type: 'replace', id: seen.id, exercise: next, expected: instanceFingerprint(seen) })).rejects.toMatchObject({ code: 'changed' });
    expect((await exOf('r1-A-e1')).catalogId).toBe('leg-press');
  });

  it('adicionar vários enquanto outra aba edita: as duas mudanças ficam; toque duplo não duplica', async () => {
    await open();
    const exs = instancesForAddMany([{ item: item('supino-maquina'), id: 'n1' }, { item: item('peck-deck'), id: 'n2' }], O);
    const tab = await otherTab();
    await editInTab(tab, (r) => (r.workouts[0].exercises[0].sets = 6));
    tab.close();
    const [a, b] = await Promise.all([mutateWorkout('r1', 'r1-A', addManyOp(exs)), mutateWorkout('r1', 'r1-A', addManyOp(exs))]);
    expect([a.changed, b.changed].sort()).toEqual([false, true]);
    const w = await stored();
    expect(w.exercises.map((e) => e.id)).toEqual(['r1-A-e1', 'r1-A-e2', 'n1', 'n2']);
    expect(w.exercises[0].sets).toBe(6);
    expect(w.exercises[2]).toMatchObject({ catalogId: 'supino-maquina', catalogVersion: 1 });
  });

  it('adicionar vários com personalizado arquivado é recusado inteiro', async () => {
    await open();
    const c = await createCustomExercise(CX, FIELDS);
    const { customItem } = await import('@/modules/exercises');
    const exs = instancesForAddMany([{ item: item('peck-deck'), id: 'n1' }, { item: customItem(c), id: 'n2' }], O);
    await setCustomArchived(CX, true);
    await expect(mutateWorkout('r1', 'r1-A', addManyOp(exs))).rejects.toMatchObject({ code: 'archived' });
    expect((await stored()).exercises).toHaveLength(2);
  });

  it('substituir vários enquanto outra aba reordena: trocas nas posições atuais, ordem da outra aba preservada', async () => {
    await open();
    await createGoal('g1', fields({ type: 'max_load', exercise: refOf(['r1-A-e1'], { routineId: 'r1', name: 'Exercício r1-A1' }), targetValue: 100, params: {} }));
    const w = await stored();
    const goals = await goalsLinkedToMany(w.exercises.map((e) => e.id));
    expect(goals.get('r1-A-e1')).toBe(1);
    const pv = bulkReplacePreview(w, [{ id: 'r1-A-e1', item: item('supino-maquina'), newId: 'n1' }], O, goals);
    const tab = await otherTab();
    await editInTab(tab, (r) => r.workouts[0].exercises.reverse());
    tab.close();
    await mutateWorkout('r1', 'r1-A', replaceManyOp(pv));
    expect((await stored()).exercises.map((e) => e.id)).toEqual(['r1-A-e2', 'n1']);
    // Meta continua no ID antigo; outros treinos, sessões e catálogo intocados.
    expect((await db.goals.get('g1'))!.exercise!.templateIds).toEqual(['r1-A-e1']);
    expect((await stored('r1-B')).exercises.map((e) => e.id)).toEqual(['r1-B-e1', 'r1-B-e2']);
  });

  it('substituir vários: exercício editado em outra aba depois da prévia impede tudo', async () => {
    await open();
    const w = await stored();
    const pv = bulkReplacePreview(w, [{ id: 'r1-A-e1', item: item('supino-maquina'), newId: 'n1' }, { id: 'r1-A-e2', item: item('peck-deck'), newId: 'n2' }], O, new Map());
    const tab = await otherTab();
    await editInTab(tab, (r) => (r.workouts[0].exercises[1].notes = 'mudou'));
    tab.close();
    await expect(mutateWorkout('r1', 'r1-A', replaceManyOp(pv))).rejects.toMatchObject({ code: 'changed' });
    expect((await stored()).exercises.map((e) => e.id)).toEqual(['r1-A-e1', 'r1-A-e2']);
  });
});

describe('backup e restauração', () => {
  async function seed() {
    await createCustomExercise(CX, FIELDS, 100);
    await setFavorite('catalog:leg-press', true, 1);
    await applyLinks([await req('r1-A-e1', LEG), await req('r1-B-e1', { customExerciseId: CX }, 'r1-B')]);
    const w = await stored('r1-C');
    await mutateWorkout('r1', 'r1-C', replaceManyOp(bulkReplacePreview(w, [{ id: 'r1-C-e1', item: item('peck-deck'), newId: 'pk' }], O, new Map())));
  }

  it('exportar e substituir: antigo sem origem, associado, personalizado, favorito e substituto voltam iguais', async () => {
    await open();
    await seed();
    const before = await readSnapshot();
    const b = parse(JSON.parse(JSON.stringify(await exportBackup())));
    expect(b.schemaVersion).toBe(7);
    const exs = b.data.routines[0].workouts.flatMap((w) => w.exercises);
    expect(exs.find((e) => e.id === 'r1-A-e1')).toMatchObject(LEG);
    expect(exs.find((e) => e.id === 'r1-A-e2')!.catalogId).toBeUndefined();
    expect(exs.find((e) => e.id === 'r1-B-e1')!.customExerciseId).toBe(CX);
    expect(exs.find((e) => e.id === 'pk')).toMatchObject({ catalogId: 'peck-deck' });
    expect(exs.some((e) => e.id === 'r1-C-e1')).toBe(false);
    await db.routines.clear();
    const p = await previewRestore(b);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await readSnapshot()).toEqual(before);
    expect((await checkLocalIntegrity()).ok).toBe(true);
  });

  it('mesclar: fichas ausentes entram com as origens; a ficha local (mesmo ID) não é sobrescrita', async () => {
    await open();
    await seed();
    await db.routines.put({ ...routine('r9'), profileId: db.currentProfileId! });
    await applyLinks([{ routineId: 'r9', workoutId: 'r9-A', id: 'r9-A-e1', expected: instanceFingerprint((await db.routines.get('r9'))!.workouts[0].exercises[0]), ref: STIFF, name: 'x' }]);
    const b = parse(JSON.parse(JSON.stringify(await exportBackup())));
    await db.routines.delete('r9');
    await unlinkExercise('r1', 'r1-A', 'r1-A-e1', instanceFingerprint(await exOf('r1-A-e1')));
    const p = await previewRestore(b);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect((await db.routines.get('r9'))!.workouts[0].exercises[0]).toMatchObject(STIFF);
    // Local prevalece: a desassociação feita depois do backup continua valendo.
    expect((await exOf('r1-A-e1')).catalogId).toBeUndefined();
  });

  it('transferência de perfil (substituir com backup de outro perfil) preserva as origens e as identidades', async () => {
    await open();
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.profile = OTHER;
    raw.data = assignOwner(raw.data, OTHER.id);
    const b = parse(raw);
    const p = await previewRestore(b);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint, acceptProfileTransfer: true });
    const r = (await db.routines.get('r1'))!;
    expect(r.profileId).toBe(db.currentProfileId);
    expect(r.workouts[0].exercises[0]).toMatchObject({ id: 'r1-A-e1', ...LEG });
    expect(r.workouts[1].exercises[0]).toMatchObject({ id: 'r1-B-e1', customExerciseId: CX });
    expect(r.workouts[2].exercises[0].id).toBe('pk');
  });

  it('backup antigo (v6, antes da biblioteca) restaura fichas sem origem; dá para associar depois', async () => {
    await open();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.schemaVersion = 6;
    delete raw.data.customExercises;
    delete raw.data.exerciseFavorites;
    const b = parse(raw);
    const p = await previewRestore(b);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect((await stored()).exercises.every((e) => e.catalogId === undefined && e.customExerciseId === undefined)).toBe(true);
    expect((await applyLinks([await req('r1-A-e1', LEG)])).applied).toBe(true);
  });

  it('referência a personalizado ausente no backup: preservada e só informada pela integridade', async () => {
    await open();
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.customExercises = [];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.blocked).toBe(false);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect((await exOf('r1-B-e1', 'r1-B')).customExerciseId).toBe(CX);
    const rep = await checkLocalIntegrity();
    expect(rep.ok).toBe(true);
    expect(rep.issues.some((i) => i.code === 'LIBRARY_REF_MISSING' && i.severity === 'info')).toBe(true);
  });
});

// Garante o tipo nas fixtures acima.
export type { ExerciseTemplate };
