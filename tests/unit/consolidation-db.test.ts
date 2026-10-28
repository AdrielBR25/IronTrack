// Consolidação de agendas no banco (IronTrack 2.0 F01/P15): importação transacional (tudo ou nada), prévia
// desatualizada, falha no meio, rollback, concorrência entre abas, idempotência, desfazer seguro, perfis, preservação
// da agenda anterior/sessões/rotação/fichas, Dexie v4 e backup v5 inalterados (o registro do desfazer não entra no
// backup). Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_SCHEMA_VERSION, IronTrackDB, clearLocalData, db, saveSettings, setDb } from '@/db/db';
import { addPlanActivity, listPlanEntries, removePlanEntry, replacePlanDate, updatePlanActivity } from '@/db/planner';
import { IMPORT_RECORD_PREFIX, LegacyImportError, applyImport, checkUndoImport, previewImport, readLastImport, undoLastImport } from '@/db/legacyImport';
import { BACKUP_SCHEMA_VERSION, exportBackup, parseBackup, previewRestore, readSnapshot, restoreBackupMerge, restoreBackupReplace, type BackupFile } from '@/lib/backup';
import { planForDate } from '@/modules/planner';
import { routine, session } from './fixtures';

const WED = '2026-10-28';
const FRI = '2026-10-30';
const MON = '2026-11-02';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let n = 0;
let dbName = '';
beforeEach(async () => {
  dbName = `consolidation-db-${++n}`;
  setDb(new IronTrackDB(dbName));
  await db.open();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const clock = (today = WED, now = 1_800_000_000_000) => {
  let i = 0;
  return { today, now, newId: () => `gen-${today}-${now}-${++i}` };
};
const parse = (o: unknown): BackupFile => {
  const r = parseBackup(JSON.stringify(o));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
};

/** Rotina ativa r1 (A, B, C), dias de treino seg/qua/sex, reagendamento sexta → C, descanso na segunda, uma sessão. */
async function seed() {
  const pid = db.currentProfileId!;
  await db.routines.put({ ...routine('r1'), profileId: pid });
  await db.routines.put({ ...routine('r2'), profileId: pid });
  await db.rotations.bulkPut([
    { routineId: 'r1', nextIndex: 1, updatedAt: 5 },
    { routineId: 'r2', nextIndex: 0, updatedAt: 5 },
  ]);
  await saveSettings({ activeRoutineId: 'r1', trainingDays: [1, 3, 5] });
  await db.overrides.bulkPut([
    { routineId: 'r1', date: FRI, kind: 'workout', workoutId: 'r1-C' },
    { routineId: 'r1', date: MON, kind: 'rest' },
    { routineId: 'r1', date: '2026-10-01', kind: 'rest' },
  ]);
  await db.sessions.put({ ...session('s1'), profileId: pid });
  return pid;
}

async function importNow(mode: 'empty_only' | 'review' = 'empty_only', decisions?: Record<string, 'keep' | 'legacy' | 'skip'>, c = clock()) {
  const p = await previewImport({ mode, decisions }, c);
  return applyImport({ operationId: `op-${c.now}`, mode, decisions, expectedFingerprint: p.fingerprint }, c);
}

describe('importação transacional', () => {
  it('cria as entradas seguras, grava o registro do desfazer e não toca agenda anterior, sessões, rotação ou fichas', async () => {
    await seed();
    const before = await readSnapshot();
    const r = await importNow();
    expect(r.repeated).toBe(false);
    const all = await listPlanEntries();
    expect(all.filter((e) => e.scope === 'weekly').map((e) => [e.weekday, e.workoutId]).sort()).toEqual([
      [1, null],
      [3, null],
      [5, null],
    ]);
    expect(all.filter((e) => e.scope === 'date').map((e) => [e.date, e.kind, e.workoutId]).sort()).toEqual([
      [FRI, 'workout', 'r1-C'],
      [MON, 'rest', null],
    ]);
    const after = await readSnapshot();
    expect({ ...after, planEntries: [] }).toEqual({ ...before, planEntries: [] }); // settings, overrides, sessões, rotação, rotinas iguais
    const rec = await readLastImport();
    expect(rec).toMatchObject({ status: 'applied', day: WED, routineId: 'r1', profileId: db.currentProfileId });
    expect(rec!.changes.created).toHaveLength(5);
    expect(DB_SCHEMA_VERSION).toBe(4);
    expect(db.verno).toBe(4);
  });

  it('modo "só visualizar" e prévia sem mudanças não gravam nada', async () => {
    await seed();
    await expect(applyImport({ operationId: 'v', mode: 'view' as never, expectedFingerprint: 'x' }, clock())).rejects.toMatchObject({ kind: 'view_only' });
    await importNow();
    const p = await previewImport({ mode: 'empty_only' }, clock());
    expect(p.put).toEqual([]);
    await expect(applyImport({ operationId: 'op-2', mode: 'empty_only', expectedFingerprint: p.fingerprint }, clock())).rejects.toMatchObject({ kind: 'nothing' });
    expect(await listPlanEntries()).toHaveLength(5); // reimportar não duplica
  });

  it('confirmar duas vezes a mesma prévia (toque duplo, outra aba) aplica uma vez só', async () => {
    await seed();
    const c = clock();
    const p = await previewImport({ mode: 'empty_only' }, c);
    const input = { operationId: 'op-dup', mode: 'empty_only' as const, expectedFingerprint: p.fingerprint };
    const [a, b] = await Promise.all([applyImport(input, clock()), applyImport(input, clock())]);
    expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
    expect(await listPlanEntries()).toHaveLength(5);
  });

  it('prévia desatualizada (planejamento alterado em outra aba entre a prévia e a confirmação): nada é gravado', async () => {
    await seed();
    const p = await previewImport({ mode: 'empty_only' }, clock());
    // Outra aba planeja a segunda.
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    const tabA = db;
    setDb(tabB);
    await addPlanActivity({ id: 'outra-aba', slot: { scope: 'weekly', weekday: 1 }, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
    setDb(tabA);
    await expect(applyImport({ operationId: 'op', mode: 'empty_only', expectedFingerprint: p.fingerprint }, clock())).rejects.toMatchObject({ kind: 'changed' });
    expect((await listPlanEntries()).map((e) => e.id)).toEqual(['outra-aba']);
    expect(await readLastImport()).toBeNull();
    // A nova prévia trata a segunda como conflito (mantém o planejado na outra aba).
    const p2 = await previewImport({ mode: 'empty_only' }, clock());
    expect(p2.items.find((i) => i.key === 'weekday:1')!.outcome).toBe('keep');
    tabB.close();
  });

  it('agenda anterior alterada depois da prévia (reagendamento, dias de treino ou exclusão): recusa', async () => {
    await seed();
    const p = await previewImport({ mode: 'empty_only' }, clock());
    await db.overrides.delete(['r1', FRI]);
    await expect(applyImport({ operationId: 'a', mode: 'empty_only', expectedFingerprint: p.fingerprint }, clock())).rejects.toBeInstanceOf(LegacyImportError);
    const p2 = await previewImport({ mode: 'empty_only' }, clock());
    await saveSettings({ trainingDays: [1] });
    await expect(applyImport({ operationId: 'b', mode: 'empty_only', expectedFingerprint: p2.fingerprint }, clock())).rejects.toMatchObject({ kind: 'changed' });
    expect(await db.planEntries.count()).toBe(0);
  });

  it('falha de armazenamento no meio: rollback completo (nem entradas, nem registro)', async () => {
    await seed();
    const p = await previewImport({ mode: 'empty_only' }, clock());
    vi.spyOn(db.planEntries, 'bulkPut').mockImplementationOnce(() => Promise.reject(new Error('cota excedida (simulado)')) as never);
    await expect(applyImport({ operationId: 'op', mode: 'empty_only', expectedFingerprint: p.fingerprint }, clock())).rejects.toThrow(/cota excedida/);
    expect(await db.planEntries.count()).toBe(0);
    expect(await readLastImport()).toBeNull();
    // Falha ao gravar o registro (depois das entradas) também desfaz as entradas.
    const settingsTable = db.table('settings');
    vi.spyOn(settingsTable, 'put').mockImplementationOnce(() => Promise.reject(new Error('falha no registro (simulado)')) as never);
    await expect(applyImport({ operationId: 'op2', mode: 'empty_only', expectedFingerprint: p.fingerprint }, clock())).rejects.toThrow(/falha no registro/);
    expect(await db.planEntries.count()).toBe(0);
  });

  it('modo de revisão: "usar agenda antiga" substitui só o dia decidido; o resto é preservado', async () => {
    await seed();
    await addPlanActivity({ id: 'seg-b', slot: { scope: 'weekly', weekday: 1 }, activity: { routineId: 'r1', workoutId: 'r1-B' } }, clock('2026-10-05'));
    await addPlanActivity({ id: 'qua-c', slot: { scope: 'weekly', weekday: 3 }, activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock('2026-10-05'));
    await importNow('review', { 'weekday:1': 'legacy' });
    const all = await listPlanEntries();
    expect(all.find((e) => e.id === 'seg-b')!.validUntil).toBe('2026-10-27'); // passado preservado
    expect(all.find((e) => e.id === 'qua-c')).toMatchObject({ validUntil: null, revision: 1 }); // conflito mantido
    expect(planForDate(all, '2026-11-09').entries.map((e) => e.workoutId)).toEqual([null]);
    expect(planForDate(all, '2026-10-26').entries.map((e) => e.workoutId)).toEqual(['r1-B']);
  });
});

describe('desfazer', () => {
  it('reverte só o que a importação criou; continua disponível depois de reabrir o app', async () => {
    await seed();
    await addPlanActivity({ id: 'ter', slot: { scope: 'weekly', weekday: 2 }, activity: { routineId: 'r2', workoutId: null } }, clock());
    const r = await importNow();
    const rotationBefore = await db.rotations.toArray();
    // "Reiniciar o app": fecha e abre outra conexão.
    db.close();
    setDb(new IronTrackDB(dbName));
    await db.open();
    const check = await checkUndoImport(clock());
    expect(check.plan!.ok).toBe(true);
    await undoLastImport({ recordId: r.record.id }, clock());
    expect((await listPlanEntries()).map((e) => e.id)).toEqual(['ter']);
    expect((await readLastImport())!.status).toBe('undone');
    expect(await db.rotations.toArray()).toEqual(rotationBefore);
    expect(await db.overrides.count()).toBe(3);
    await expect(undoLastImport({ recordId: r.record.id }, clock())).rejects.toMatchObject({ kind: 'undo_changed' });
  });

  it('reimportar depois de desfazer cria de novo, sem duplicar', async () => {
    await seed();
    const r = await importNow();
    await undoLastImport({ recordId: r.record.id }, clock());
    await importNow('empty_only', undefined, clock(WED, 1_800_000_000_001));
    expect(await listPlanEntries()).toHaveLength(5);
  });

  it('alteração posterior (mesmo em outra aba) bloqueia o desfazer inteiro, sem reverter nada', async () => {
    await seed();
    const r = await importNow();
    const fri = (await listPlanEntries()).find((e) => e.date === FRI)!;
    const tabB = new IronTrackDB(dbName);
    await tabB.open();
    const tabA = db;
    setDb(tabB);
    await updatePlanActivity({ id: fri.id, expectedRevision: fri.revision, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
    setDb(tabA);
    const snapshot = await listPlanEntries();
    await expect(undoLastImport({ recordId: r.record.id }, clock())).rejects.toMatchObject({ kind: 'undo_blocked' });
    expect(await listPlanEntries()).toEqual(snapshot);
    const check = await checkUndoImport(clock());
    expect(check.plan!.problems.join(' ')).toMatch(/30\/10/);
    tabB.close();
  });

  it('exclusão concorrente de uma entrada importada também bloqueia (a pessoa mexeu no dia)', async () => {
    await seed();
    const r = await importNow();
    const mon = (await listPlanEntries()).find((e) => e.scope === 'weekly' && e.weekday === 1)!;
    await removePlanEntry({ id: mon.id, expectedRevision: mon.revision }, clock());
    await expect(undoLastImport({ recordId: r.record.id }, clock())).rejects.toMatchObject({ kind: 'undo_blocked' });
  });

  it('o registro é de um perfil: outro perfil não vê nem desfaz', async () => {
    await seed();
    const r = await importNow();
    const own = db.currentProfileId;
    db.currentProfileId = OTHER;
    expect(await readLastImport()).toBeNull();
    await expect(undoLastImport({ recordId: r.record.id }, clock())).rejects.toMatchObject({ kind: 'undo_missing' });
    db.currentProfileId = own;
    expect((await readLastImport())!.id).toBe(r.record.id);
  });
});

describe('perfis', () => {
  it('planejamento e rotinas de outro perfil não entram na prévia nem são alterados', async () => {
    await seed();
    await db.planEntries.put({ id: 'alheia', profileId: OTHER, scope: 'weekly', weekday: 1, date: null, kind: 'rest', routineId: null, workoutId: null, enabled: true, validFrom: '2026-01-05', validUntil: null, createdAt: 1, updatedAt: 1, revision: 1 });
    await db.routines.put({ ...routine('r9'), profileId: OTHER });
    await db.overrides.put({ routineId: 'r9', date: FRI, kind: 'rest' });
    const p = await previewImport({ mode: 'empty_only' }, clock());
    expect(p.items.find((i) => i.key === 'weekday:1')!.action).toBe('create'); // a entrada alheia não conta
    expect(p.overview.otherRoutineOverrides).toBe(0); // reagendamento de rotina de outro perfil nem é lido
    await importNow();
    expect(await db.planEntries.get('alheia')).toMatchObject({ profileId: OTHER, revision: 1 });
    expect((await db.planEntries.where('profileId').equals(db.currentProfileId!).toArray()).length).toBe(5);
  });
});

describe('backup', () => {
  it('exportação continua v5, inclui as entradas importadas e NÃO inclui o registro do desfazer', async () => {
    await seed();
    await importNow();
    const b = await exportBackup();
    expect(BACKUP_SCHEMA_VERSION).toBe(5);
    expect(b.schemaVersion).toBe(5);
    expect(b.data.planEntries).toHaveLength(5);
    expect(JSON.stringify(b)).not.toContain(IMPORT_RECORD_PREFIX);
    expect(b.data.settings!.id).toBe('settings');
  });

  it('substituir pelo backup apaga o registro (o desfazer deixa de valer) e devolve os dados exatos', async () => {
    await seed();
    await importNow();
    const before = await readSnapshot();
    const b = parse(JSON.parse(JSON.stringify(await exportBackup())));
    const p = await previewRestore(b);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await readSnapshot()).toEqual(before);
    expect(await readLastImport()).toBeNull();
  });

  it('backup anterior à consolidação (sem planejamento): restaurar por substituição volta ao estado antigo; a agenda anterior continua', async () => {
    await seed();
    const old = parse(JSON.parse(JSON.stringify(await exportBackup())));
    await importNow();
    const p = await previewRestore(old);
    expect(p.incoming.planEntries).toBe(0);
    expect(p.local.planEntries).toBe(5);
    await restoreBackupReplace(old, { expectedLocalFingerprint: p.localFingerprint });
    expect(await db.planEntries.count()).toBe(0);
    expect(await db.overrides.count()).toBe(3);
    expect((await previewImport({ mode: 'empty_only' }, clock())).counts.create).toBe(5); // dá para importar de novo
  });

  it('mesclar um backup com as mesmas entradas não duplica; o registro do desfazer fica e confere a situação', async () => {
    await seed();
    const r = await importNow();
    const b = parse(JSON.parse(JSON.stringify(await exportBackup())));
    const p = await previewRestore(b);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect(await listPlanEntries()).toHaveLength(5);
    expect((await checkUndoImport(clock())).plan!.ok).toBe(true);
    await undoLastImport({ recordId: r.record.id }, clock());
    expect(await db.planEntries.count()).toBe(0);
  });

  it('"apagar tudo" também apaga o registro', async () => {
    await seed();
    await importNow();
    await clearLocalData();
    expect(await readLastImport()).toBeNull();
  });
});

describe('decisão da central de divergências', () => {
  it('"usar a agenda antiga só neste dia" grava só a exceção da data, com conferência do dia', async () => {
    await seed();
    await addPlanActivity({ id: 'sex-a', slot: { scope: 'weekly', weekday: 5 }, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
    const before = await readSnapshot();
    await expect(replacePlanDate({ id: 'ex', date: FRI, kind: 'workout', activity: { routineId: 'r1', workoutId: 'r1-C' }, expected: 'versão antiga' }, clock())).rejects.toMatchObject({ kind: 'changed' });
    await replacePlanDate({ id: 'ex', date: FRI, kind: 'workout', activity: { routineId: 'r1', workoutId: 'r1-C' } }, clock());
    const all = await listPlanEntries();
    expect(planForDate(all, FRI).entries.map((e) => e.workoutId)).toEqual(['r1-C']);
    expect(all.find((e) => e.id === 'sex-a')!.revision).toBe(1);
    const after = await readSnapshot();
    expect({ ...after, planEntries: [] }).toEqual({ ...before, planEntries: [] });
  });
});
