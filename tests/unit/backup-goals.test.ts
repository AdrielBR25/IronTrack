// Metas no backup (IronTrack 2.0 F01/P12): exportação v4, importação v0–v4, mesclagem, conflitos de ID, perfis,
// integridade e rollback. Metas nunca são descartadas em silêncio. Dados fictícios apenas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createGoal, setGoalStatus } from '@/db/goals';
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
import type { TrainingGoal } from '@/lib/types';
import { fields, goalRoutine, refOf } from './goalFixtures';
import { snapshot } from './fixtures';

const OTHER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', displayName: 'Outro perfil', createdAt: 1_600_000_000_000 };

let n = 0;
beforeEach(async () => {
  setDb(new IronTrackDB(`backup-goals-${++n}`));
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

const loadFields = (over = {}) => fields({ type: 'max_load', title: 'Supino 85', targetValue: 85, exercise: refOf(['sup-A', 'sup-B']), ...over });

/** Banco com a rotina de metas e duas metas (uma de exercício, uma de frequência). */
async function seed() {
  const pid = db.currentProfileId!;
  await db.routines.put({ ...goalRoutine(), profileId: pid });
  const a = await createGoal('g-load', loadFields(), 1000);
  const b = await createGoal('g-freq', fields({ title: 'Treinar 3x', targetValue: 3 }), 2000);
  return { pid, a, b };
}

/** Exporta, serializa e lê de volta, como faria o arquivo baixado. */
async function roundTrip() {
  return parse(JSON.parse(JSON.stringify(await exportBackup())));
}

describe('exportação', () => {
  it('backup atual (v6; metas desde a v4) contém as metas do perfil, com IDs, versão e estado', async () => {
    const { a } = await seed();
    await setGoalStatus('g-freq', 'pause', '2026-03-10');
    const b = await exportBackup();
    expect(BACKUP_SCHEMA_VERSION).toBe(6);
    expect(b.schemaVersion).toBe(6);
    expect(b.data.goals).toHaveLength(2);
    expect(b.data.goals.find((g) => g.id === 'g-load')).toEqual(a);
    expect(b.data.goals.find((g) => g.id === 'g-freq')).toMatchObject({ status: 'paused', revision: 2 });
    expect(checkBackupIntegrity(b).ok).toBe(true);
  });
});

describe('importação de versões anteriores', () => {
  it.each([0, 1, 2, 3])('backup v%i (sem metas) é aceito e chega com goals vazio', async (v) => {
    const data: Record<string, unknown> = { ...snapshot() };
    delete data.goals;
    const raw: Record<string, unknown> = { app: 'irontrack', kind: 'backup', schemaVersion: v, exportedAt: '2026-01-15T12:00:00.000Z', data };
    if (v >= 2) {
      raw.profile = { id: db.currentProfileId, displayName: 'Perfil' };
      raw.data = assignOwner(snapshot(), db.currentProfileId!);
      delete (raw.data as Record<string, unknown>).goals;
    }
    if (v === 0) delete raw.schemaVersion;
    const b = parse(raw);
    expect(b.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(b.data.goals).toEqual([]);
    const p = await previewRestore(b);
    expect(p.blocked).toBe(false);
  });

  it('restaurar (substituir) um backup v4 devolve as metas exatamente como eram', async () => {
    await seed();
    const before = await readSnapshot();
    const b = await roundTrip();
    await db.goals.clear();
    const p = await previewRestore(b);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect((await readSnapshot()).goals).toEqual(before.goals);
  });

  it('substituir por um backup antigo (sem metas) apaga as metas locais, e a prévia mostra isso', async () => {
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.schemaVersion = 3;
    delete raw.data.goals;
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.local.goals).toBe(2);
    expect(p.incoming.goals).toBe(0);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint });
    expect(await db.goals.count()).toBe(0);
  });
});

describe('mesclagem', () => {
  it('acrescenta metas novas, ignora as idênticas e mantém a local no conflito de ID (com confirmação)', async () => {
    const { a } = await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    const changed: TrainingGoal = { ...a, targetValue: 95, revision: 2 };
    const fresh: TrainingGoal = { ...a, id: 'g-nova', title: 'Supino 100', targetValue: 100 };
    raw.data.goals = [changed, raw.data.goals.find((g: TrainingGoal) => g.id === 'g-freq'), fresh];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.merge.counts.goals).toMatchObject({ add: 1, duplicate: 1, conflict: 1 });
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(/Confirme explicitamente/);
    expect(await db.goals.count()).toBe(2);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect((await db.goals.get('g-load'))!.targetValue).toBe(85);
    expect((await db.goals.get('g-nova'))!.title).toBe('Supino 100');
    expect(await db.goals.count()).toBe(3);
  });

  it('meta igual com outro ID não é duplicada; mesmo título com valores diferentes é mantida e avisada', async () => {
    const { a } = await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.goals = [
      { ...a, id: 'copia', createdAt: 5, updatedAt: 5, revision: 4 },
      { ...a, id: 'parecida', targetValue: 90 },
    ];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.merge.counts.goals).toMatchObject({ add: 1, duplicate: 1, conflict: 0 });
    expect(p.merge.items.some((i) => i.code === 'SIMILAR_GOAL' && i.id === 'parecida')).toBe(true);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint });
    expect((await db.goals.toArray()).map((g) => g.id).sort()).toEqual(['g-freq', 'g-load', 'parecida']);
  });

  it('quando a rotina do backup já existe aqui com outro ID, a meta passa a apontar para a rotina local', async () => {
    const { pid } = await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.routines = [{ ...goalRoutine('gr'), id: 'gr-backup', profileId: pid }];
    // A rotina do backup tem o mesmo conteúdo da local (mesmos treinos e exercícios), com outro ID.
    raw.data.routines[0].workouts = goalRoutine().workouts;
    const load = raw.data.goals.find((g: TrainingGoal) => g.id === 'g-load');
    raw.data.goals = [{ ...load, id: 'g-remap', title: 'Remapeada', exercise: { ...load.exercise, routineId: 'gr-backup' } }];
    raw.data.sessions = [];
    raw.data.rotations = [];
    raw.data.overrides = [];
    const b = parse(raw);
    const p = await previewRestore(b);
    expect(p.integrity.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(p.blocked).toBe(false);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect((await db.goals.get('g-remap'))!.exercise!.routineId).toBe('gr');
    expect(await db.routines.count()).toBe(1);
  });
});

describe('perfis e integridade', () => {
  const otherBackup = async () => {
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.profile = OTHER;
    raw.data = assignOwner(raw.data, OTHER.id);
    return parse(raw);
  };

  it('backup de outro perfil: mesclar é bloqueado; substituir com transferência adota as metas no perfil local', async () => {
    const { pid } = await seed();
    const b = await otherBackup();
    expect(b.data.goals.every((g) => g.profileId === OTHER.id)).toBe(true);
    const p = await previewRestore(b);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true })).rejects.toThrow(PROFILE_MERGE_BLOCKED_MESSAGE);
    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint, acceptProfileTransfer: true });
    const goals = await db.goals.toArray();
    expect(goals).toHaveLength(2);
    expect(goals.every((g) => g.profileId === pid)).toBe(true);
  });

  it('meta inválida ou de outro dono no backup bloqueia a restauração; nada é gravado', async () => {
    await seed();
    for (const bad of [
      (g: TrainingGoal) => ({ ...g, targetValue: -1 }),
      (g: TrainingGoal) => ({ ...g, unit: 'reps' }),
      (g: TrainingGoal) => ({ ...g, profileId: OTHER.id }),
    ]) {
      const raw = JSON.parse(JSON.stringify(await exportBackup()));
      raw.data.goals[0] = bad(raw.data.goals[0]);
      const b = parse(raw);
      const p = await previewRestore(b);
      expect(p.blocked).toBe(true);
      await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    }
    expect(await db.goals.count()).toBe(2);
  });

  it('IDs de meta repetidos no arquivo bloqueiam a restauração (nenhuma é descartada em silêncio)', async () => {
    await seed();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.goals.push({ ...raw.data.goals[0], title: 'Repetida' });
    const b = parse(raw);
    expect(checkBackupIntegrity(b).ok).toBe(false);
  });

  it('falha no meio da restauração: tudo é desfeito, metas e treinos locais ficam como estavam', async () => {
    await seed();
    const before = await readSnapshot();
    const raw = JSON.parse(JSON.stringify(await exportBackup()));
    raw.data.goals = [{ ...raw.data.goals[0], id: 'g-x', title: 'Nova' }];
    const b = parse(raw);
    const p = await previewRestore(b);
    vi.spyOn(db.goals, 'bulkPut').mockImplementationOnce(() => Promise.reject(new Error('falha simulada')) as never);
    await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow();
    expect(await readSnapshot()).toEqual(before);
  });
});
