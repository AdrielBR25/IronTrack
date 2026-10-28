import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { renameProfile } from '@/db/profiles';
import {
  BackupRestoreError,
  PROFILE_MERGE_BLOCKED_MESSAGE,
  PROFILE_TRANSFER_REQUIRED_MESSAGE,
  STALE_PREVIEW_MESSAGE,
  assignOwner,
  checkBackupIntegrity,
  exportBackup,
  parseBackup,
  previewRestore,
  readLocalState,
  readSnapshot,
  restoreBackupMerge,
  restoreBackupReplace,
  type BackupFile,
} from '@/lib/backup';
import { checkIntegrity } from '@/lib/integrity';
import type { DataSnapshot, LocalProfile } from '@/lib/types';
import { backupOf, entry, photo, routine, session, snapshot } from './fixtures';

// Backups e identidade do perfil (F01/P02). Dados fictícios apenas.

const OTHER = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', displayName: 'Outro perfil', createdAt: 1_600_000_000_000 };

let n = 0;
async function freshDb() {
  setDb(new IronTrackDB(`backup-profile-${++n}`));
  await db.open();
}

async function seedDb(d: DataSnapshot) {
  await db.transaction('rw', db.tables, async () => {
    if (d.settings) await db.settings.put(d.settings);
    await db.routines.bulkPut(d.routines);
    await db.sessions.bulkPut(d.sessions);
    await db.rotations.bulkPut(d.rotations);
    await db.overrides.bulkPut(d.overrides);
    await db.bodyEntries.bulkPut(d.bodyEntries);
    await db.photos.bulkPut(d.photos);
  });
}

const parse = (o: unknown): BackupFile => {
  const r = parseBackup(JSON.stringify(o));
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
};

/** Backup v2 de um perfil (registros já com o dono do arquivo). */
const v2Of = (data: DataSnapshot, profile: { id: string; displayName: string; createdAt?: number }) => ({
  app: 'irontrack',
  kind: 'backup',
  schemaVersion: 2,
  exportedAt: '2026-10-20T12:00:00.000Z',
  profile,
  data: assignOwner(data, profile.id),
});

const localProfile = async (): Promise<LocalProfile> => (await db.profiles.get(db.currentProfileId!))!;

beforeEach(freshDb);
afterEach(() => vi.restoreAllMocks());

describe('formato do backup com perfil (v2, lido como v4)', () => {
  it('exporta o perfil proprietário e reimporta: mesmo perfil, só duplicatas', async () => {
    await seedDb(snapshot());
    const b = parse(await exportBackup());
    expect(b.schemaVersion).toBe(4);
    expect(b.profile?.id).toBe(db.currentProfileId);
    expect([...b.data.routines, ...b.data.sessions, ...b.data.bodyEntries, ...b.data.photos].every((r) => r.profileId === db.currentProfileId)).toBe(true);
    const p = await previewRestore(b);
    expect(p.identity.relation).toBe('same');
    expect(p.merge.totals).toMatchObject({ add: 0, conflict: 0, skipped: 0 });
    expect(p.merge.profileBlocked).toBe(false);
    expect(p.replaceRequiresProfileTransfer).toBe(false);
  });

  it('não confunde versão do backup com versão do banco: v0/v1 viram v4 sem perfil; v5 é rejeitada', () => {
    const v1 = parse(backupOf(snapshot()));
    expect(v1).toMatchObject({ schemaVersion: 4, profile: null });
    const v0 = parse({ app: 'irontrack', exportedAt: '2025-01-01T00:00:00.000Z', ...snapshot() });
    expect(v0).toMatchObject({ schemaVersion: 4, profile: null });
    const future = parseBackup(JSON.stringify({ ...v2Of(snapshot(), OTHER), schemaVersion: 5 }));
    expect(!future.ok && future.errors[0]).toMatch(/versão mais nova/);
    const noProfile = parseBackup(JSON.stringify({ ...v2Of(snapshot(), OTHER), profile: undefined }));
    expect(noProfile.ok).toBe(false);
  });

  it('integridade do arquivo v2: dono divergente, sem dono, ID inválido e referência cruzada bloqueiam', () => {
    const base = v2Of(snapshot(), OTHER);
    const codes = (o: unknown) => checkBackupIntegrity(parse(o)).issues.filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes(base)).toEqual([]);
    const foreign = structuredClone(base);
    foreign.data.sessions[0].profileId = '99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(codes(foreign)).toContain('RECORD_PROFILE_UNKNOWN');
    const unowned = structuredClone(base);
    delete unowned.data.photos[0].profileId;
    expect(codes(unowned)).toEqual(['RECORD_UNOWNED']);
    const badId = structuredClone(base);
    badId.profile = { ...OTHER, id: 'perfil-1' };
    expect(codes(badId)).toContain('PROFILE_INVALID_ID');
    // legado com dono declarado: arquivo adulterado
    const legacy = backupOf(snapshot());
    (legacy.data.sessions[0] as { profileId?: string }).profileId = OTHER.id;
    expect(codes(legacy)).toEqual(['RECORD_PROFILE_UNKNOWN']);
  });
});

describe('backup legado (v0/v1, sem perfil)', () => {
  it('mesclar atribui explicitamente os registros ao perfil local e informa na prévia', async () => {
    await seedDb(snapshot({ sessions: [], photos: [] }));
    const b = parse(backupOf(snapshot()));
    const p = await previewRestore(b);
    expect(p.identity).toMatchObject({ relation: 'legacy', backupProfile: null, localProfile: { id: db.currentProfileId } });
    expect(p.merge.totals.add).toBe(4);
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint });
    const d = await readSnapshot();
    expect(d.sessions.map((s) => s.profileId)).toEqual([db.currentProfileId, db.currentProfileId]);
    expect(d.photos.every((x) => x.profileId === db.currentProfileId)).toBe(true);
  });

  it('v0 com tabelas na raiz também é restaurado por substituição, mantendo o perfil local', async () => {
    const before = await localProfile();
    const b = parse({ app: 'irontrack', exportedAt: '2025-01-01T00:00:00.000Z', ...snapshot() });
    await restoreBackupReplace(b);
    expect(await localProfile()).toEqual(before);
    expect((await db.photos.get('p1'))).toMatchObject({ entryId: 'b1', profileId: before.id });
  });
});

describe('backup de outro perfil', () => {
  it('prévia informa a identidade diferente; mesclar é bloqueado e nada é gravado', async () => {
    await seedDb(snapshot({ sessions: [] }));
    const before = await readLocalState();
    const b = parse(v2Of(snapshot({ sessions: [session('outro-s')] }), OTHER));
    const p = await previewRestore(b);
    expect(p.identity).toMatchObject({ relation: 'different', backupProfile: { id: OTHER.id }, localProfile: { id: db.currentProfileId } });
    expect(p.merge.profileBlocked).toBe(true);
    expect(p.replaceRequiresProfileTransfer).toBe(true);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true })).rejects.toThrow(PROFILE_MERGE_BLOCKED_MESSAGE);
    expect(await readLocalState()).toEqual(before);
  });

  it('substituir exige transferência explícita; com ela, os dados passam ao perfil local e o ID local não muda', async () => {
    await seedDb(snapshot());
    const profile = await localProfile();
    const before = await readLocalState();
    const inc = snapshot({ routines: [routine('r-outro')], sessions: [session('so', { routineId: 'r-outro', workoutId: 'r-outro-A' }), session('hist', { routineId: 'excluida' })], rotations: [], overrides: [], bodyEntries: [entry('be')], photos: [photo('pe', 'be')] });
    const b = parse(v2Of(inc, OTHER));
    const p = await previewRestore(b);
    const err = await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupRestoreError);
    expect(err.message).toBe(PROFILE_TRANSFER_REQUIRED_MESSAGE);
    expect(await readLocalState()).toEqual(before);

    await restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint, acceptProfileTransfer: true });
    expect(await localProfile()).toEqual(profile);
    expect(await db.profiles.count()).toBe(1);
    expect(db.currentProfileId).toBe(profile.id);
    const d = await readSnapshot();
    expect(new Set([...d.routines, ...d.sessions, ...d.bodyEntries, ...d.photos].map((r) => r.profileId))).toEqual(new Set([profile.id]));
    // referências preservadas
    expect((await db.sessions.get('so'))?.routineId).toBe('r-outro');
    expect((await db.sessions.get('hist'))?.routineId).toBe('excluida');
    expect((await db.photos.get('pe'))?.entryId).toBe('be');
    const report = checkIntegrity(d, { scope: 'local', profiles: await db.profiles.toArray() });
    expect(report.ok).toBe(true);
  });

  it('falha transacional na substituição com transferência desfaz tudo, inclusive a identidade', async () => {
    await seedDb(snapshot());
    const before = await readLocalState();
    const b = parse(v2Of(snapshot({ sessions: [session('nova')] }), OTHER));
    vi.spyOn(db.photos, 'bulkPut').mockRejectedValueOnce(new Error('disco cheio (simulado)'));
    await expect(restoreBackupReplace(b, { acceptProfileTransfer: true })).rejects.toThrow(/disco cheio/);
    expect(await readLocalState()).toEqual(before);
  });
});

describe('mesmo perfil: garantias do Prompt 01 mantidas', () => {
  it('mesclagem com conflitos exige confirmação; o dono dos registros locais não muda', async () => {
    await seedDb(snapshot());
    const me = await localProfile();
    const inc = snapshot();
    inc.sessions[0] = { ...inc.sessions[0], notes: 'editado em outro lugar' };
    const b = parse(v2Of(inc, me));
    const p = await previewRestore(b);
    expect(p.identity.relation).toBe('same');
    expect(p.merge.totals.conflict).toBe(1);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(/Confirme explicitamente/);
    const sum = await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect(sum.conflicts).toBe(1);
    expect(await db.sessions.get('s1')).toMatchObject({ profileId: me.id });
    expect((await db.sessions.get('s1'))?.notes).toBeUndefined();
  });

  it('substituir pelo backup do próprio perfil não pede transferência e preserva a identidade', async () => {
    await seedDb(snapshot({ sessions: [session('local-only')] }));
    const me = await localProfile();
    const b = parse(v2Of(snapshot(), me));
    await restoreBackupReplace(b);
    expect(await localProfile()).toEqual(me);
    expect((await db.sessions.toArray()).map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('prévia desatualizada: renomear o perfil depois da prévia cancela a restauração', async () => {
    await seedDb(snapshot());
    const me = await localProfile();
    const b = parse(v2Of(snapshot({ sessions: [session('nova')] }), me));
    const p = await previewRestore(b);
    await renameProfile(me.id, 'Renomeado');
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(STALE_PREVIEW_MESSAGE);
    await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(STALE_PREVIEW_MESSAGE);
    expect(await db.sessions.get('nova')).toBeUndefined();
  });

  it('cancelar após a prévia não altera dados nem perfis', async () => {
    await seedDb(snapshot());
    const before = await readLocalState();
    await previewRestore(parse(v2Of(snapshot({ sessions: [session('nova')] }), OTHER)));
    await previewRestore(parse(backupOf(snapshot({ sessions: [session('nova')] }))));
    expect(await readLocalState()).toEqual(before);
  });

  it('falha no meio da mesclagem desfaz tudo', async () => {
    await seedDb(snapshot({ sessions: [], photos: [] }));
    const me = await localProfile();
    const before = await readLocalState();
    const b = parse(v2Of(snapshot(), me));
    vi.spyOn(db.photos, 'bulkAdd').mockRejectedValueOnce(new Error('falha simulada'));
    await expect(restoreBackupMerge(b)).rejects.toThrow(/falha simulada/);
    expect(await readLocalState()).toEqual(before);
  });
});

describe('integridade local com perfis', () => {
  it('detecta dono inexistente, sem dono, ID inválido, referência cruzada e principal ausente/duplicado', () => {
    const me = { id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', isDefault: true };
    const d = assignOwner(snapshot(), me.id);
    const codes = (x: DataSnapshot, profiles = [me]) => checkIntegrity(x, { scope: 'local', profiles }).issues.map((i) => `${i.severity}:${i.code}:${i.id ?? ''}`);
    expect(codes(d)).toEqual([]);
    const x = structuredClone(d);
    x.sessions[0].profileId = OTHER.id; // dono inexistente e rotina de outro dono
    delete x.bodyEntries[1].profileId; // legado não migrado
    x.photos[0].profileId = 'xyz';
    expect(codes(x)).toEqual(
      expect.arrayContaining(['error:RECORD_PROFILE_UNKNOWN:s1', 'error:CROSS_PROFILE_REFERENCE:s1', 'warning:RECORD_UNOWNED:b2', 'error:PROFILE_INVALID_ID:p1']),
    );
    expect(codes(d, [])).toContain('error:PROFILE_DEFAULT_MISSING:');
    expect(codes(d, [me, { id: OTHER.id, isDefault: true }])).toContain(`warning:PROFILE_DEFAULT_DUPLICATE:${me.id}, ${OTHER.id}`);
    // foto ligada a avaliação de outro perfil
    const y = structuredClone(d);
    y.bodyEntries[0].profileId = OTHER.id;
    expect(codes(y, [me, { id: OTHER.id, isDefault: false }])).toContain('error:CROSS_PROFILE_REFERENCE:p1');
  });

  it('exceções históricas do Prompt 01 continuam válidas: treino de rotina excluída não é erro', () => {
    const me = { id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', isDefault: true };
    const d = assignOwner(snapshot({ routines: [], rotations: [], overrides: [] }), me.id);
    d.settings = { ...d.settings!, activeRoutineId: null };
    const r = checkIntegrity(d, { scope: 'local', profiles: [me] });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(['SESSION_HISTORICAL_REFERENCE', 'SESSION_HISTORICAL_REFERENCE']);
  });
});
