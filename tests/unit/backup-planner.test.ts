// Planejamento semanal no backup (IronTrack 2.0 F01/P13): exportação v5, importação v0–v5, substituição, mesclagem,
// remapeamento de rotina, conflitos, perfis, dados inválidos e rollback. Nada é descartado em silêncio. Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addPlanActivity, setPlanMarker } from '@/db/planner';
import {
  BACKUP_SCHEMA_VERSION,
  PROFILE_MERGE_BLOCKED_MESSAGE,
  assignOwner,
  checkBackupIntegrity,
  exportBackup,
  parseBackup,
  previewRestore,
  readSnapshot,
  restoreBackupMerge,
  restoreBackupReplace,
  type BackupFile,
} from '@/lib/backup';
import type { PlanEntry } from '@/lib/types';
import { routine, snapshot } from './fixtures';

const OTHER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', displayName: 'Outro perfil', createdAt: 1_600_000_000_000 };
const WED = '2026-10-28';

let n = 0;
beforeEach(async () => {
  setDb(new IronTrackDB(`backup-planner-${++n}`));
  await db.open();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const parse = (o: unknown): BackupFile => {
  const r = parseBackup(JSON.stringify(o));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
};
const clock = (today = WED) => {
  let i = 0;
  return { today, now: 1_800_000_000_000, newId: () => `gen-${today}-${++i}` };
};

/** Rotina r1 + planejamento: A toda segunda, cardio "próximo da rotação" toda sexta, descanso numa data. */
async function seed() {
  const pid = db.currentProfileId!;
  await db.routines.put({ ...routine(), profileId: pid });
  await addPlanActivity({ id: 'seg-a', slot: { scope: 'weekly', weekday: 1 }, activity: { routineId: 'r1', workoutId: 'r1-A' } }, clock());
  await addPlanActivity({ id: 'sex', slot: { scope: 'weekly', weekday: 5 }, activity: { routineId: 'r1', workoutId: null } }, clock());
  await setPlanMarker({ id: 'desc', slot: { scope: 'date', date: '2026-11-02' }, kind: 'rest' }, clock());
  return pid;
}

const roundTrip = async () => parse(JSON.parse(JSON.stringify(await exportBackup())));

describe('exportação', () => {
  it('backup v5 contém o planejamento do perfil, com IDs, vigências e versões', async () => {
    await seed();
    const b = await exportBackup();
    expect(BACKUP_SCHEMA_VERSION).toBe(5);
    expect(b.schemaVersion).toBe(5);
    expect(b.data.planEntries.map((e) => e.id).sort()).toEqual(['desc', 'seg-a', 'sex']);
    expect(b.data.planEntries.find((e) => e.id === 'seg-a')).toMatchObject({ scope: 'weekly', weekday: 1, validFrom: WED, revision: 1, profileId: db.currentProfileId });
    expect(checkBackupIntegrity(b).ok).toBe(true);
  });
});

describe('importação de versões anteriores', () => {
  it.each([0, 1, 2, 3, 4])('backup v%i (sem planejamento) é aceito e chega com planEntries vazio', async (v) => {
    const data: Record<string, unknown> = { ...snapshot() };
    delete data.planEntries;
    if (v < 4) delete data.goals;
    const raw: Record<string, unknown> = { app: 'irontrack', kind: 'backup', schemaVersion: v, exportedAt: '2026-01-15T12:00:00.000Z', data };
    if (v >= 2) {
      raw.profile = { id: db.currentProfileId, displayName: 'Perfil' };
      const owned = assignOwner(snapshot(), db.currentProfileId!) as unknown as Record<string, unknown>;
      delete owned.planEntries;
      if (v < 4) delete owned.goals;
      raw.data = owned;
    }
    if (v === 0) delete raw.schemaVersion;
    const b = parse(raw);
    expect(b.schemaVersion).toBe(5);
    expect(b.data.planEntries).toEqual([]);
    expect((await previewRestore(b)).blocked).toBe(false);
  });

  it('backup v5 restaurado (substituir) devolve o planejamento exatamente como era', async () => {
    await seed();
    const before = await readSnapshot();
    const b = await roundTrip();
    await db.planEntries.clear();
    const p = await previewRestore(b);
    expect(p.incoming.planEntries).toBe(3);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await readSnapshot()).toEqual(before);
  });

  it('versão futura (v6) é recusada sem gravar', () => {
    const r = parseBackup(JSON.stringify({ app: 'irontrack', kind: 'backup', schemaVersion: 6, exportedAt: 'x', profile: null, data: {} }));
    expect(!r.ok && r.errors[0]).toMatch(/versão mais nova/);
  });
});

describe('mesclagem', () => {
  it('acrescenta entradas novas, ignora idênticas e mantém a local em conflito de ID (com confirmação)', async () => {
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    const seg = raw.data.planEntries.find((e: PlanEntry) => e.id === 'seg-a');
    raw.data.planEntries = [
      { ...seg, workoutId: 'r1-C', revision: 2 }, // mesmo ID, conteúdo diferente
      raw.data.planEntries.find((e: PlanEntry) => e.id === 'sex'), // idêntica
      { ...seg, id: 'ter-b', weekday: 2, workoutId: 'r1-B' }, // nova
    ];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.merge.counts.planEntries).toMatchObject({ add: 1, duplicate: 1, conflict: 1 });
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(/Confirme explicitamente/);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect((await db.planEntries.get('seg-a'))!.workoutId).toBe('r1-A');
    expect((await db.planEntries.get('ter-b'))!.workoutId).toBe('r1-B');
    expect(await db.planEntries.count()).toBe(4);
  });

  it('mesma atividade vigente no mesmo dia com outro ID não duplica o dia', async () => {
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    const seg = raw.data.planEntries.find((e: PlanEntry) => e.id === 'seg-a');
    raw.data.planEntries = [{ ...seg, id: 'copia', validFrom: '2026-09-01', createdAt: 5 }];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.merge.counts.planEntries).toMatchObject({ add: 0, duplicate: 1 });
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await db.planEntries.count()).toBe(3);
  });

  it('rotina do backup que já existe aqui com outro ID: o planejamento passa a apontar para a rotina local', async () => {
    const pid = await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.routines = [{ ...routine(), id: 'r1-backup', profileId: pid }];
    raw.data.planEntries = [{ ...raw.data.planEntries.find((e: PlanEntry) => e.id === 'seg-a'), id: 'qui', weekday: 4, routineId: 'r1-backup' }];
    raw.data.sessions = [];
    raw.data.rotations = [];
    raw.data.overrides = [];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.blocked).toBe(false);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect((await db.planEntries.get('qui'))!.routineId).toBe('r1');
    expect(await db.routines.count()).toBe(1);
  });

  it('rotina em conflito: entrada que aponta para treino que só existe na versão do backup não é aplicada (nunca ao treino errado)', async () => {
    const pid = await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    const r = routine();
    raw.data.routines = [{ ...r, profileId: pid, name: 'Versão do backup', workouts: [...r.workouts, { id: 'r1-D', label: 'D', name: 'Treino D', exercises: [] }] }];
    raw.data.planEntries = [
      { ...raw.data.planEntries.find((e: PlanEntry) => e.id === 'seg-a'), id: 'dom-d', weekday: 0, workoutId: 'r1-D' },
      { ...raw.data.planEntries.find((e: PlanEntry) => e.id === 'seg-a'), id: 'sab-b', weekday: 6, workoutId: 'r1-B' },
    ];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.merge.counts.planEntries).toMatchObject({ add: 1, skipped: 1 });
    expect(p.merge.items.some((i) => i.collection === 'planEntries' && i.id === 'dom-d' && i.code === 'ROUTINE_CONFLICT_DEPENDENT')).toBe(true);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect(await db.planEntries.get('dom-d')).toBeUndefined();
    expect(await db.planEntries.get('sab-b')).toBeTruthy();
  });

  it('rotina inexistente: o planejamento é preservado com aviso (não bloqueia, não descarta)', async () => {
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.planEntries.push({ ...raw.data.planEntries[0], id: 'orfa', weekday: 2, kind: 'workout', routineId: 'sumiu', workoutId: null, scope: 'weekly', date: null, validFrom: WED, validUntil: null });
    const b = parse(raw);
    const report = checkBackupIntegrity(b);
    expect(report.ok).toBe(true);
    expect(report.issues.find((i) => i.id === 'orfa')?.code).toBe('PLAN_ROUTINE_MISSING');
    const p = await previewRestore(b);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await db.planEntries.get('orfa')).toBeTruthy();
  });
});

describe('perfis, integridade e rollback', () => {
  const otherBackup = async () => {
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.profile = OTHER;
    raw.data = assignOwner(raw.data, OTHER.id);
    return parse(raw);
  };

  it('backup de outro perfil: mesclar bloqueado; substituir com transferência adota o planejamento', async () => {
    const pid = await seed();
    const b = await otherBackup();
    expect(b.data.planEntries.every((e) => e.profileId === OTHER.id)).toBe(true);
    const p = await previewRestore(b);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true })).rejects.toThrow(PROFILE_MERGE_BLOCKED_MESSAGE);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint, acceptProfileTransfer: true });
    const all = await db.planEntries.toArray();
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.profileId === pid)).toBe(true);
  });

  it('entrada inválida, de outro dono ou com ID repetido bloqueia a restauração; nada é gravado', async () => {
    await seed();
    const before = await readSnapshot();
    for (const bad of [
      (e: PlanEntry) => ({ ...e, weekday: 8 }),
      (e: PlanEntry) => ({ ...e, kind: 'treino' }),
      (e: PlanEntry) => ({ ...e, scope: 'date', date: '2026-02-31' }),
      (e: PlanEntry) => ({ ...e, profileId: OTHER.id }),
    ]) {
      const raw = JSON.parse(JSON.stringify(await exportBackup()));
      raw.data.planEntries[0] = bad(raw.data.planEntries[0]);
      const b = parse(raw);
      const p = await previewRestore(b);
      expect(p.blocked).toBe(true);
      await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    }
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.planEntries.push({ ...raw.data.planEntries[0], weekday: 3 });
    expect(checkBackupIntegrity(parse(raw)).ok).toBe(false);
    expect(await readSnapshot()).toEqual(before);
  });

  it('falha no meio da restauração: tudo é desfeito, planejamento e treinos locais ficam como estavam', async () => {
    await seed();
    const before = await readSnapshot();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.planEntries = [{ ...raw.data.planEntries[0], id: 'novo', weekday: 2 }];
    const b = parse(raw);
    const p = await previewRestore(b);
    vi.spyOn(db.planEntries, 'bulkPut').mockImplementationOnce(() => Promise.reject(new Error('falha simulada')) as never);
    await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    expect(await readSnapshot()).toEqual(before);
    vi.spyOn(db.planEntries, 'bulkAdd').mockImplementationOnce(() => Promise.reject(new Error('falha simulada')) as never);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    expect(await readSnapshot()).toEqual(before);
  });

  it('prévia desatualizada (planejamento alterado em outra aba depois da prévia) cancela a restauração', async () => {
    await seed();
    const b = await roundTrip();
    const p = await previewRestore(b);
    await setPlanMarker({ id: 'outra-aba', slot: { scope: 'weekly', weekday: 3 }, kind: 'rest' }, clock());
    await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(/mudaram desde a prévia/);
  });
});
