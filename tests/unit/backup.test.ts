import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import {
  BACKUP_LIMITS,
  BackupRestoreError,
  checkBackupSize,
  checkLocalIntegrity,
  exportBackup,
  parseBackup,
  previewRestore,
  assignOwner,
  readLocalState,
  readSnapshot,
  restoreBackupMerge,
  restoreBackupReplace,
  type BackupFile,
} from '@/lib/backup';
import { planMerge } from '@/lib/merge';
import { checkIntegrity, snapshotFingerprint } from '@/lib/integrity';
import type { DataSnapshot } from '@/lib/types';
import { backupOf, entry, photo, rotation, routine, session, settings, snapshot } from './fixtures';

let n = 0;
async function freshDb() {
  setDb(new IronTrackDB(`backup-test-${++n}`));
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

const sorted = (d: DataSnapshot) => ({
  ...d,
  routines: [...d.routines].sort((a, b) => a.id.localeCompare(b.id)),
  sessions: [...d.sessions].sort((a, b) => a.id.localeCompare(b.id)),
  bodyEntries: [...d.bodyEntries].sort((a, b) => a.id.localeCompare(b.id)),
  photos: [...d.photos].sort((a, b) => a.id.localeCompare(b.id)),
});

/** Registros do backup como ficam após a atribuição explícita ao perfil local (backup legado). */
const own = (d: DataSnapshot) => assignOwner(d, db.currentProfileId!);

beforeEach(freshDb);
afterEach(() => vi.restoreAllMocks());

describe('exportação', () => {
  it('exporta todas as tabelas em formato v5 legível e reimportável, com o perfil proprietário', async () => {
    await seedDb(snapshot());
    const b = await exportBackup();
    expect(b).toMatchObject({ app: 'irontrack', kind: 'backup', schemaVersion: 5, profile: { id: db.currentProfileId, displayName: 'Meu perfil' } });
    expect(sorted(b.data)).toEqual(sorted(own(snapshot())));
    expect(parseBackup(JSON.stringify(b, null, 2)).ok).toBe(true);
  });

  it('retrato consistente: gravação simultânea entra inteira ou não entra', async () => {
    await seedDb(snapshot());
    // Simula concluir um treino: grava sessão e avança a rotação na mesma transação.
    const write = db.transaction('rw', db.sessions, db.rotations, async () => {
      await db.sessions.put(session('s9', { startedAt: 1_700_900_000_000 }));
      for (let i = 0; i < 20; i++) await db.sessions.get('s1');
      await db.rotations.put(rotation('r1', 2));
    });
    const [b] = await Promise.all([exportBackup(), write]);
    const hasSession = b.data.sessions.some((s) => s.id === 's9');
    const rot = b.data.rotations[0].nextIndex;
    expect(hasSession ? rot === 2 : rot === 1).toBe(true);
  });

  it('usa uma única transação de leitura para todas as tabelas', async () => {
    const spy = vi.spyOn(db, 'transaction');
    await exportBackup();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('r');
  });
});

describe('leitura e validação do arquivo', () => {
  it('importa backup v0 (tabelas na raiz) migrando até v5 como legado sem perfil', () => {
    const d = snapshot();
    const r = parseBackup(JSON.stringify({ app: 'irontrack', exportedAt: '2025-01-01T00:00:00.000Z', ...d }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(5);
    expect(r.value.profile).toBeNull();
    expect(r.value.data.goals).toEqual([]);
    expect(r.value.data.planEntries).toEqual([]);
    expect(r.value.data.sessions).toHaveLength(2);
    expect(r.value.data.photos).toHaveLength(2);
  });

  it('importa backup v1 preservando campos extras', () => {
    const d = snapshot();
    (d.sessions[0] as unknown as Record<string, unknown>).campoFuturo = 'x';
    const b = parse(backupOf(d));
    expect((b.data.sessions[0] as unknown as Record<string, unknown>).campoFuturo).toBe('x');
  });

  it('rejeita versão futura', () => {
    const r = parseBackup(JSON.stringify({ ...backupOf(snapshot()), schemaVersion: 6 }));
    expect(!r.ok && r.errors[0]).toMatch(/versão mais nova/);
  });

  it('rejeita arquivos inválidos com mensagens específicas', () => {
    expect(parseBackup('{').ok).toBe(false);
    const ficha = parseBackup(JSON.stringify({ formato: 'irontrack.ficha', versao: 1 }));
    expect(!ficha.ok && ficha.errors[0]).toMatch(/ficha de treino/);
    const other = parseBackup(JSON.stringify({ app: 'outro' }));
    expect(!other.ok && other.errors[0]).toMatch(/não é um backup do IronTrack/);
    const kind = parseBackup(JSON.stringify({ ...backupOf(snapshot()), kind: 'ficha' }));
    expect(!kind.ok && kind.errors[0]).toMatch(/backup completo/);
    const bad = backupOf(snapshot());
    (bad.data.sessions[0] as unknown as Record<string, unknown>).startedAt = 'ontem';
    const r = parseBackup(JSON.stringify(bad));
    expect(!r.ok && r.errors.join()).toMatch(/startedAt/);
  });

  it('limites de tamanho e complexidade', () => {
    expect(checkBackupSize(BACKUP_LIMITS.maxBytes + 1)).toMatch(/muito grande/);
    expect(checkBackupSize(1024)).toBeNull();
    const big = backupOf(snapshot({ photos: [photo('p1', 'b1', { dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(BACKUP_LIMITS.maxPhotoChars) })] }));
    const r = parseBackup(JSON.stringify(big));
    expect(!r.ok && r.errors[0]).toMatch(/limite por foto/);
    const many = backupOf(snapshot({ overrides: Array.from({ length: BACKUP_LIMITS.maxRecords.overrides + 1 }, (_, i) => ({ routineId: `r${i}`, date: '2026-01-01', kind: 'rest' as const })) }));
    const m = parseBackup(JSON.stringify(many));
    expect(!m.ok && m.errors[0]).toMatch(/"overrides" tem/);
  });
});

describe('restauração por substituição', () => {
  it('substitui tudo pelo conteúdo do backup', async () => {
    await seedDb(snapshot({ sessions: [session('local-only')] }));
    const d = snapshot();
    const sum = await restoreBackupReplace(parse(backupOf(d)));
    expect(sum).toMatchObject({ routines: 1, sessions: 2, bodyEntries: 2, photos: 2 });
    expect(sorted(await readSnapshot())).toEqual(sorted(own(d)));
  });

  it('backup com erro de integridade não altera nada', async () => {
    await seedDb(snapshot());
    const before = await readSnapshot();
    const bad = backupOf(snapshot({ sessions: [session('s1'), session('s1', { notes: 'diferente' })] }));
    await expect(restoreBackupReplace(parse(bad))).rejects.toBeInstanceOf(BackupRestoreError);
    expect(await readSnapshot()).toEqual(before);
  });

  it('falha simulada no meio da transação desfaz tudo (rollback)', async () => {
    await seedDb(snapshot());
    const before = await readSnapshot();
    const other = snapshot({ routines: [routine('r2')], sessions: [session('n1', { routineId: 'r2' })], photos: [], bodyEntries: [entry('n-b')] });
    // tabelas já limpas e várias já regravadas quando a última escrita falha
    vi.spyOn(db.photos, 'bulkPut').mockRejectedValueOnce(new Error('disco cheio (simulado)'));
    await expect(restoreBackupReplace(parse(backupOf(other)))).rejects.toThrow(/disco cheio/);
    expect(await readSnapshot()).toEqual(before);
  });
});

describe('restauração por mesclagem', () => {
  it('mesmo ID e mesmo conteúdo: duplicata confirmada, nada gravado', async () => {
    await seedDb(snapshot());
    const before = await readSnapshot();
    const sum = await restoreBackupMerge(parse(backupOf(snapshot())));
    expect(sum).toMatchObject({ routines: 0, sessions: 0, bodyEntries: 0, photos: 0, conflicts: 0 });
    expect(sum.duplicates).toBe(1 + 1 + 2 + 1 + 2 + 2 + 2);
    expect(await readSnapshot()).toEqual(before);
  });

  it('mesmo ID e conteúdo diferente: conflito, registro local mantido e informado', async () => {
    await seedDb(snapshot());
    const inc = snapshot();
    inc.sessions[0] = { ...inc.sessions[0], notes: 'editado em outro aparelho' };
    inc.bodyEntries[0] = { ...inc.bodyEntries[0], weightKg: 77 };
    const plan = planMerge(await readSnapshot(), own(inc));
    expect(plan.counts.sessions.conflict).toBe(1);
    expect(plan.counts.bodyEntries.conflict).toBe(1);
    expect(plan.items.filter((i) => i.code === 'ID_CONFLICT').map((i) => i.id)).toEqual(['s1', 'b1']);
    // a foto da avaliação em conflito não é ligada à avaliação errada
    expect(plan.items.find((i) => i.code === 'PHOTO_ENTRY_CONFLICT')).toBeUndefined(); // p1 idêntica já existe
    const sum = await restoreBackupMerge(parse(backupOf(inc)), { acceptPartial: true });
    expect(sum.conflicts).toBe(2);
    expect((await db.sessions.get('s1'))?.notes).toBeUndefined();
    expect((await db.bodyEntries.get('b1'))?.weightKg).toBe(80);
  });

  it('IDs diferentes e conteúdo igual: duplicata; fotos passam a apontar para o registro local', async () => {
    await seedDb(snapshot({ photos: [] }));
    const inc = snapshot({
      sessions: [{ ...session('s1'), id: 'outro-s1' }],
      bodyEntries: [{ ...entry('b1'), id: 'outro-b1', createdAt: 5 }],
      photos: [photo('px', 'outro-b1')],
    });
    const sum = await restoreBackupMerge(parse(backupOf(inc)));
    expect(sum).toMatchObject({ sessions: 0, bodyEntries: 0, photos: 1 });
    expect(await db.sessions.count()).toBe(2);
    expect(await db.bodyEntries.get('outro-b1')).toBeUndefined();
    expect((await db.photos.get('px'))?.entryId).toBe('b1');
  });

  it('rotina idêntica com outro ID: rotação e substituições seguem a rotina local', async () => {
    await seedDb(snapshot({ rotations: [], overrides: [] }));
    const r2 = { ...routine(), id: 'r1-copia', createdAt: 1, updatedAt: 2 };
    const inc = snapshot({ routines: [r2], sessions: [session('n1', { routineId: 'r1-copia' })], rotations: [rotation('r1-copia', 2)], overrides: [{ routineId: 'r1-copia', date: '2026-03-01', kind: 'rest' }] });
    const sum = await restoreBackupMerge(parse(backupOf(inc)));
    expect(sum.routines).toBe(0);
    expect(await db.routines.count()).toBe(1);
    expect((await db.sessions.get('n1'))?.routineId).toBe('r1');
    expect((await db.rotations.get('r1'))?.nextIndex).toBe(2);
    expect(await db.overrides.get(['r1', '2026-03-01'])).toBeTruthy();
  });

  it('sessões semelhantes (mesmo início e nome) mas distintas: ambas mantidas, com aviso', async () => {
    await seedDb(snapshot());
    const twin = session('s1-gemea');
    twin.exercises[0].sets[0].weight = 70;
    const plan = planMerge(await readSnapshot(), own(snapshot({ sessions: [twin] })));
    expect(plan.items.find((i) => i.code === 'SIMILAR_SESSION')?.id).toBe('s1-gemea');
    const sum = await restoreBackupMerge(parse(backupOf(snapshot({ sessions: [twin] }))));
    expect(sum.sessions).toBe(1);
    expect(await db.sessions.count()).toBe(3);
  });

  it('avaliações semelhantes (mesma data, peso e cintura) mas distintas: ambas mantidas', async () => {
    await seedDb(snapshot());
    const twin = entry('b1-gemea', { bodyFatPct: 15, notes: 'medida com outra balança' });
    const inc = snapshot({ bodyEntries: [twin], photos: [photo('pt', 'b1-gemea')] });
    const plan = planMerge(await readSnapshot(), own(inc));
    expect(plan.items.find((i) => i.code === 'SIMILAR_BODY_ENTRY')?.id).toBe('b1-gemea');
    const sum = await restoreBackupMerge(parse(backupOf(inc)));
    expect(sum).toMatchObject({ bodyEntries: 1, photos: 1 });
    expect(await db.bodyEntries.count()).toBe(3);
    expect((await db.photos.get('pt'))?.entryId).toBe('b1-gemea');
  });

  it('fotos: avaliação em conflito não recebe foto; foto órfã é preservada com aviso', async () => {
    await seedDb(snapshot({ photos: [] }));
    const inc = snapshot({
      bodyEntries: [{ ...entry('b1'), weightKg: 70 }],
      photos: [photo('nova', 'b1'), photo('orfa', 'sumiu')],
    });
    const plan = planMerge(await readSnapshot(), own(inc));
    expect(plan.items.find((i) => i.code === 'PHOTO_ENTRY_CONFLICT')?.id).toBe('nova');
    expect(plan.items.find((i) => i.code === 'PHOTO_ORPHAN')?.id).toBe('orfa');
    await restoreBackupMerge(parse(backupOf(inc)), { acceptPartial: true });
    expect(await db.photos.get('nova')).toBeUndefined();
    expect((await db.photos.get('orfa'))?.entryId).toBe('sumiu');
  });

  it('treino em andamento do backup não substitui o treino em andamento local', async () => {
    await seedDb(snapshot({ sessions: [session('ativo-local', { status: 'active' })] }));
    const sum = await restoreBackupMerge(parse(backupOf(snapshot({ sessions: [session('ativo-backup', { status: 'active', startedAt: 1_800_000_000_000 })] }))), { acceptPartial: true });
    expect(sum.sessions).toBe(0);
    expect(await db.sessions.where('status').equals('active').count()).toBe(1);
    expect((await db.sessions.where('status').equals('active').first())?.id).toBe('ativo-local');
  });

  it('configurações locais são mantidas; aplicadas só quando não existem', async () => {
    await seedDb(snapshot({ settings: settings({ weightStep: 5 }) }));
    await restoreBackupMerge(parse(backupOf(snapshot({ settings: settings({ weightStep: 1 }) }))), { acceptPartial: true });
    expect((await db.settings.get('settings'))?.weightStep).toBe(5);
    await db.settings.clear();
    await restoreBackupMerge(parse(backupOf(snapshot({ settings: settings({ weightStep: 1 }) }))));
    expect((await db.settings.get('settings'))?.weightStep).toBe(1);
  });

  it('prévia não grava nada; nova prévia após mudança permite confirmar', async () => {
    await seedDb(snapshot({ sessions: [] }));
    const before = await readSnapshot();
    const b = parse(backupOf(snapshot()));
    const p = await previewRestore(b);
    expect(p.blocked).toBe(false);
    expect(p.merge.counts.sessions.add).toBe(2);
    expect(await readSnapshot()).toEqual(before);
    await db.sessions.put(session('s1'));
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(/mudaram desde a prévia/);
    expect(await db.sessions.count()).toBe(1);
    const p2 = await previewRestore(b);
    const sum = await restoreBackupMerge(b, { expectedLocalFingerprint: p2.localFingerprint });
    expect(sum.sessions).toBe(1);
  });

  it('falha simulada no meio da mesclagem desfaz tudo', async () => {
    await seedDb(snapshot({ sessions: [], photos: [] }));
    const before = await readSnapshot();
    vi.spyOn(db.photos, 'bulkAdd').mockRejectedValueOnce(new Error('quota excedida (simulado)'));
    await expect(restoreBackupMerge(parse(backupOf(snapshot())))).rejects.toThrow(/quota/);
    expect(await readSnapshot()).toEqual(before);
  });

  it('backup bloqueado por integridade não é mesclado', async () => {
    const bad = backupOf(snapshot({ photos: [photo('p1', 'b1', { dataUrl: 'javascript:alert(1)' })] }));
    const b = parse(bad);
    expect((await previewRestore(b)).blocked).toBe(true);
    await expect(restoreBackupMerge(b)).rejects.toBeInstanceOf(BackupRestoreError);
    expect(await db.routines.count()).toBe(0);
  });

  it('mesclar duas vezes é idempotente', async () => {
    await seedDb(snapshot({ sessions: [session('local')] }));
    const b = parse(backupOf(snapshot()));
    await restoreBackupMerge(b);
    const once = await readSnapshot();
    const again = await restoreBackupMerge(b);
    expect(again).toMatchObject({ routines: 0, sessions: 0, bodyEntries: 0, photos: 0, conflicts: 0 });
    expect(await readSnapshot()).toEqual(once);
  });
});

describe('diagnóstico local', () => {
  it('verifica a integridade do banco deste aparelho', async () => {
    await seedDb(snapshot({ photos: [photo('p9', 'nao-existe')] }));
    const r = await checkLocalIntegrity();
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(['PHOTO_ORPHAN']);
  });
});

describe('revisão corretiva: conflitos e prévia', () => {
  it('impressão digital muda com qualquer alteração de conteúdo, mesmo sem mudar contagens', () => {
    const base = snapshot();
    const fp = snapshotFingerprint(base);
    expect(snapshotFingerprint(snapshot())).toBe(fp);
    // ordem dos registros e das chaves não importa
    expect(snapshotFingerprint({ ...base, sessions: [...base.sessions].reverse() })).toBe(fp);
    const variants: DataSnapshot[] = [
      { ...base, sessions: [{ ...base.sessions[0], notes: 'x' }, base.sessions[1]] },
      { ...base, photos: [{ ...base.photos[0], dataUrl: base.photos[0].dataUrl + 'A' }, base.photos[1]] },
      { ...base, rotations: [{ ...base.rotations[0], nextIndex: 2 }] },
      { ...base, settings: { ...base.settings!, weightStep: 5 } },
      { ...base, bodyEntries: [{ ...base.bodyEntries[0], weightKg: 80.1 }, base.bodyEntries[1]] },
    ];
    for (const v of variants) expect(snapshotFingerprint(v)).not.toBe(fp);
  });

  it('alteração local com a mesma quantidade de registros cancela a mesclagem, dentro da transação', async () => {
    await seedDb(snapshot({ sessions: [session('so-local', { startedAt: 1_600_000_000_000 })] }));
    const b = parse(backupOf(snapshot()));
    const p = await previewRestore(b);
    const before = await readSnapshot();
    // edição de nota: mesma contagem, mesmo plano (a assinatura antiga não detectava)
    await db.sessions.update('so-local', { notes: 'editado após a prévia' });
    const changed = await readSnapshot();
    expect(planMerge(changed, own(b.data)).totals).toEqual(planMerge(before, own(b.data)).totals);
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(/mudaram desde a prévia/);
    expect(await readSnapshot()).toEqual(changed);
  });

  it('alteração local após a prévia também cancela a substituição', async () => {
    await seedDb(snapshot());
    const b = parse(backupOf(snapshot({ sessions: [] })));
    const p = await previewRestore(b);
    await db.sessions.update('s1', { notes: 'concluído em outra aba' });
    const changed = await readSnapshot();
    await expect(restoreBackupReplace(b, { expectedLocalFingerprint: p.localFingerprint })).rejects.toThrow(/mudaram desde a prévia/);
    expect(await readSnapshot()).toEqual(changed);
    const ok = await restoreBackupReplace(b, { expectedLocalFingerprint: (await previewRestore(b)).localFingerprint });
    expect(ok.sessions).toBe(0);
  });

  it('a conferência acontece dentro da transação de escrita', async () => {
    await seedDb(snapshot({ sessions: [] }));
    const b = parse(backupOf(snapshot()));
    const p = await previewRestore(b);
    const spy = vi.spyOn(db, 'transaction');
    await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint });
    // uma única transação rw (a leitura do retrato é subtransação dela)
    expect(spy.mock.calls[0][0]).toBe('rw');
    expect(spy.mock.calls.filter((c) => c[0] === 'rw')).toHaveLength(1);
  });

  it('conflito de ID exige confirmação explícita; sem ela nada é gravado', async () => {
    await seedDb(snapshot({ sessions: [], photos: [] }));
    const inc = snapshot();
    inc.bodyEntries[0] = { ...inc.bodyEntries[0], weightKg: 70 };
    const b = parse(backupOf(inc));
    const p = await previewRestore(b);
    expect(p.merge.notRestored).toBe(2); // avaliação em conflito + foto dela
    const before = await readSnapshot();
    const err = await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint }).catch((e) => e);
    expect(err).toBeInstanceOf(BackupRestoreError);
    expect(err.message).toMatch(/2 registro\(s\) do backup não serão restaurados/);
    expect(err.details.join()).toMatch(/b1/);
    expect(await readSnapshot()).toEqual(before);
    const sum = await restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true });
    expect(sum).toMatchObject({ sessions: 2, photos: 1, conflicts: 1, notRestored: 2 });
    expect(await db.photos.get('p1')).toBeUndefined();
    expect((await db.bodyEntries.get('b1'))?.weightKg).toBe(80);
  });

  it('registros ignorados são informados com motivo e contados como não restaurados', async () => {
    await seedDb(snapshot({ sessions: [session('ativo', { status: 'active' })], settings: settings({ weightStep: 5 }) }));
    const inc = snapshot({ sessions: [session('ativo-2', { status: 'active', startedAt: 1_800_000_000_000 })], settings: settings({ weightStep: 1 }) });
    const plan = planMerge(await readSnapshot(), own(inc));
    expect(plan.items.filter((i) => i.kind === 'skipped').map((i) => i.code)).toEqual(['ACTIVE_SESSION_CONFLICT']);
    expect(plan.items.find((i) => i.code === 'SETTINGS_KEPT')?.kind).toBe('kept-local');
    expect(plan.notRestored).toBe(2);
    const sum = await restoreBackupMerge(parse(backupOf(inc)), { acceptPartial: true });
    expect(sum.notRestored).toBe(2);
    expect(await db.sessions.get('ativo-2')).toBeUndefined();
  });

  it('rotina em conflito: rotação e agenda do backup não são aplicadas à versão local', async () => {
    await seedDb(snapshot({ rotations: [], overrides: [] }));
    const r = routine();
    const changed = { ...r, workouts: [r.workouts[0]] }; // backup tem só o treino A
    const inc = snapshot({ routines: [changed], rotations: [rotation('r1', 0)], overrides: [{ routineId: 'r1', date: '2026-04-01', kind: 'workout', workoutId: 'r1-A' }] });
    const plan = planMerge(await readSnapshot(), own(inc));
    expect(plan.counts.routines.conflict).toBe(1);
    expect(plan.items.filter((i) => i.code === 'ROUTINE_CONFLICT_DEPENDENT').map((i) => i.collection)).toEqual(['rotations', 'overrides']);
    await restoreBackupMerge(parse(backupOf(inc)), { acceptPartial: true });
    expect((await db.routines.get('r1'))?.workouts).toHaveLength(3);
    expect(await db.rotations.get('r1')).toBeUndefined();
    expect(await db.overrides.count()).toBe(0);
  });

  it('integridade das referências após mesclar: nenhuma foto, rotação ou agenda órfã nova', async () => {
    await seedDb(snapshot({ photos: [] }));
    const r2 = routine('r2');
    const inc = snapshot({
      routines: [{ ...routine(), workouts: [] }, r2], // r1 em conflito, r2 nova
      rotations: [rotation('r1', 0), rotation('r2', 2)],
      overrides: [{ routineId: 'r2', date: '2026-05-01', kind: 'workout', workoutId: 'r2-B' }],
      bodyEntries: [{ ...entry('b1'), weightKg: 1 }, { ...snapshot().bodyEntries[1], id: 'b2-copia', createdAt: 9 }, entry('b3', { date: '2026-03-10' })],
      photos: [photo('f1', 'b1'), photo('f2', 'b2-copia'), photo('f3', 'b3')],
    });
    const before = checkIntegrity(await readSnapshot());
    await restoreBackupMerge(parse(backupOf(inc)), { acceptPartial: true });
    const after = await readSnapshot();
    const report = checkIntegrity(after);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'warning')).toEqual(before.issues.filter((i) => i.severity === 'warning'));
    expect((await db.photos.get('f2'))?.entryId).toBe('b2');
    expect(await db.photos.get('f1')).toBeUndefined();
    expect((await db.photos.get('f3'))?.entryId).toBe('b3');
    expect((await db.rotations.get('r2'))?.nextIndex).toBe(2);
  });

  it('dados históricos locais preservados: nenhuma sessão ou avaliação local é alterada', async () => {
    const local = snapshot();
    await seedDb(local);
    const inc = snapshot({ sessions: snapshot().sessions.map((s) => ({ ...s, notes: 'versão do backup' })), bodyEntries: [], photos: [] });
    await restoreBackupMerge(parse(backupOf(inc)), { acceptPartial: true });
    const after = await readSnapshot();
    expect(sorted(after).sessions).toEqual(sorted(local).sessions);
    expect(sorted(after).bodyEntries).toEqual(sorted(local).bodyEntries);
  });

  it('cancelar após a prévia (não confirmar) não altera nada', async () => {
    await seedDb(snapshot());
    const before = await readSnapshot();
    const p = await previewRestore(parse(backupOf(snapshot({ sessions: [session('nova')] }))));
    expect(p.merge.totals.add).toBe(1);
    expect(await readSnapshot()).toEqual(before);
  });

  it('rollback: falha depois de parte das inserções desfaz a mesclagem confirmada', async () => {
    await seedDb(snapshot({ sessions: [], photos: [] }));
    const b = parse(backupOf(snapshot()));
    const p = await previewRestore(b);
    const before = await readSnapshot();
    vi.spyOn(db.bodyEntries, 'bulkAdd').mockRejectedValueOnce(new Error('falha simulada'));
    await expect(restoreBackupMerge(b, { expectedLocalFingerprint: p.localFingerprint, acceptPartial: true })).rejects.toThrow(/falha simulada/);
    expect(await readSnapshot()).toEqual(before);
    const state = await readLocalState();
    expect(snapshotFingerprint(state.data, state.profiles)).toBe(p.localFingerprint);
  });
});
