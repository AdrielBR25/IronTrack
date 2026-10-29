// Importação para a conta (Prompt 21): preparação dos itens no aparelho (dono, identidade, hash) e lotes.
import { describe, expect, it } from 'vitest';
import { recordHash } from '@shared/canonical.ts';
import { IMPORT_BATCH, importBatches, prepareImport } from '@/cloud/importer';
import type { BackupData } from '@/lib/backupFormat';

const P = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';

const data = (): BackupData =>
  ({
    settings: { id: 'settings', userName: 'Ana', theme: 'dark' },
    routines: [{ id: 'r1', profileId: OLD, name: 'ABC', workouts: [] }],
    sessions: [{ id: 's1', profileId: OLD, status: 'completed', exercises: [], startedAt: 1, extra: undefined }],
    rotations: [{ routineId: 'r1', nextIndex: 1 }],
    overrides: [{ routineId: 'r1', date: '2026-10-01', kind: 'rest' }],
    bodyEntries: [],
    photos: [{ id: 'f1', profileId: OLD, dataUrl: 'data:image/png;base64,AAAA' }],
    goals: [],
    planEntries: [],
    calendarDecisions: [{ id: `${OLD}~c1`, profileId: OLD, conflictId: 'c1', date: '2026-10-01' }],
    customExercises: [],
    exerciseFavorites: [{ id: `${OLD}~cat:x`, profileId: OLD, target: 'cat:x' }],
  }) as unknown as BackupData;

describe('preparação da importação', () => {
  it('atribui os registros ao perfil da conta (inclusive IDs que dependem do perfil) e calcula o hash canônico', async () => {
    const p = await prepareImport(data(), P, { kind: 'backup_file', profileId: OLD });
    expect(p.counts).toEqual({ settings: 1, routines: 1, sessions: 1, rotations: 1, overrides: 1, calendarDecisions: 1, exerciseFavorites: 1 });
    expect(p.items.find((i) => i.collection === 'sessions')!.doc).toEqual({ id: 's1', profileId: P, status: 'completed', exercises: [], startedAt: 1 });
    expect(p.items.find((i) => i.collection === 'calendarDecisions')!.entityId).toBe(`${P}~c1`);
    expect(p.items.find((i) => i.collection === 'exerciseFavorites')!.entityId).toBe(`${P}~cat:x`);
    expect(p.items.find((i) => i.collection === 'overrides')!.entityId).toBe('r1|2026-10-01');
    for (const it of p.items) expect(it.hash).toBe(await recordHash(it.doc));
    // fotos não vão para a nuvem
    expect(p.items.some((i) => (i.collection as string) === 'photos')).toBe(false);
    expect(p.photos.map((f) => f.profileId)).toEqual([P]);
  });

  it('a impressão digital da origem não depende da ordem e muda com o conteúdo', async () => {
    const a = await prepareImport(data(), P, { kind: 'backup_file', profileId: null });
    const d2 = data();
    d2.routines = [...d2.routines].reverse();
    expect((await prepareImport(d2, P, { kind: 'backup_file', profileId: null })).fingerprint).toBe(a.fingerprint);
    d2.sessions[0].status = 'active';
    expect((await prepareImport(d2, P, { kind: 'backup_file', profileId: null })).fingerprint).not.toBe(a.fingerprint);
  });

  it('lotes respeitam o máximo de itens e de bytes', () => {
    const items = Array.from({ length: 1201 }, (_, i) => ({ collection: 'bodyEntries' as const, entityId: `b${i}`, doc: { id: `b${i}` }, hash: 'h' }));
    expect(importBatches(items).map((b) => b.length)).toEqual([500, 500, 201]);
    const big = Array.from({ length: 4 }, (_, i) => ({ collection: 'sessions' as const, entityId: `s${i}`, doc: { id: `s${i}`, notes: 'x'.repeat(1024 * 1024) }, hash: 'h' }));
    for (const b of importBatches(big)) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThanOrEqual(IMPORT_BATCH.maxBytes + 1024);
  });
});
