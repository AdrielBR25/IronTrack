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
  readSnapshot,
  restoreBackupMerge,
  restoreBackupReplace,
  type BackupFile,
} from '@/lib/backup';
import { planMerge } from '@/lib/merge';
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

beforeEach(freshDb);
afterEach(() => vi.restoreAllMocks());

describe('exportação', () => {
  it('exporta todas as tabelas em formato v1 legível e reimportável', async () => {
    await seedDb(snapshot());
    const b = await exportBackup();
    expect(b).toMatchObject({ app: 'irontrack', kind: 'backup', schemaVersion: 1 });
    expect(sorted(b.data)).toEqual(sorted(snapshot()));
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
  it('importa backup v0 (tabelas na raiz) migrando para v1', () => {
    const d = snapshot();
    const r = parseBackup(JSON.stringify({ app: 'irontrack', exportedAt: '2025-01-01T00:00:00.000Z', ...d }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schemaVersion).toBe(1);
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
    const r = parseBackup(JSON.stringify({ ...backupOf(snapshot()), schemaVersion: 2 }));
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
    expect(sorted(await readSnapshot())).toEqual(sorted(d));
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
    const plan = planMerge(await readSnapshot(), inc);
    expect(plan.counts.sessions.conflict).toBe(1);
    expect(plan.counts.bodyEntries.conflict).toBe(1);
    expect(plan.items.filter((i) => i.code === 'ID_CONFLICT').map((i) => i.id)).toEqual(['s1', 'b1']);
    // a foto da avaliação em conflito não é ligada à avaliação errada
    expect(plan.items.find((i) => i.code === 'PHOTO_ENTRY_CONFLICT')).toBeUndefined(); // p1 idêntica já existe
    const sum = await restoreBackupMerge(parse(backupOf(inc)));
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
    const plan = planMerge(await readSnapshot(), snapshot({ sessions: [twin] }));
    expect(plan.items.find((i) => i.code === 'SIMILAR_SESSION')?.id).toBe('s1-gemea');
    const sum = await restoreBackupMerge(parse(backupOf(snapshot({ sessions: [twin] }))));
    expect(sum.sessions).toBe(1);
    expect(await db.sessions.count()).toBe(3);
  });

  it('avaliações semelhantes (mesma data, peso e cintura) mas distintas: ambas mantidas', async () => {
    await seedDb(snapshot());
    const twin = entry('b1-gemea', { bodyFatPct: 15, notes: 'medida com outra balança' });
    const inc = snapshot({ bodyEntries: [twin], photos: [photo('pt', 'b1-gemea')] });
    const plan = planMerge(await readSnapshot(), inc);
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
    const plan = planMerge(await readSnapshot(), inc);
    expect(plan.items.find((i) => i.code === 'PHOTO_ENTRY_CONFLICT')?.id).toBe('nova');
    expect(plan.items.find((i) => i.code === 'PHOTO_ORPHAN')?.id).toBe('orfa');
    await restoreBackupMerge(parse(backupOf(inc)));
    expect(await db.photos.get('nova')).toBeUndefined();
    expect((await db.photos.get('orfa'))?.entryId).toBe('sumiu');
  });

  it('treino em andamento do backup não substitui o treino em andamento local', async () => {
    await seedDb(snapshot({ sessions: [session('ativo-local', { status: 'active' })] }));
    const sum = await restoreBackupMerge(parse(backupOf(snapshot({ sessions: [session('ativo-backup', { status: 'active', startedAt: 1_800_000_000_000 })] }))));
    expect(sum.sessions).toBe(0);
    expect(await db.sessions.where('status').equals('active').count()).toBe(1);
    expect((await db.sessions.where('status').equals('active').first())?.id).toBe('ativo-local');
  });

  it('configurações locais são mantidas; aplicadas só quando não existem', async () => {
    await seedDb(snapshot({ settings: settings({ weightStep: 5 }) }));
    await restoreBackupMerge(parse(backupOf(snapshot({ settings: settings({ weightStep: 1 }) }))));
    expect((await db.settings.get('settings'))?.weightStep).toBe(5);
    await db.settings.clear();
    await restoreBackupMerge(parse(backupOf(snapshot({ settings: settings({ weightStep: 1 }) }))));
    expect((await db.settings.get('settings'))?.weightStep).toBe(1);
  });

  it('prévia não grava nada e a assinatura detecta mudanças antes de confirmar', async () => {
    await seedDb(snapshot({ sessions: [] }));
    const before = await readSnapshot();
    const b = parse(backupOf(snapshot()));
    const p = await previewRestore(b);
    expect(p.blocked).toBe(false);
    expect(p.merge.counts.sessions.add).toBe(2);
    expect(await readSnapshot()).toEqual(before);
    await db.sessions.put(session('s1'));
    await expect(restoreBackupMerge(b, { expectedSignature: p.merge.signature })).rejects.toThrow(/mudaram desde a prévia/);
    expect(await db.sessions.count()).toBe(1);
    const p2 = await previewRestore(b);
    const sum = await restoreBackupMerge(b, { expectedSignature: p2.merge.signature });
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
