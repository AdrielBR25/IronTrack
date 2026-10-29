import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordHash } from '../../../shared/canonical.ts';
import { Client, setupApi, signup, uuid4, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupApi();
});
afterAll(async () => {
  await env?.close();
});

type Item = { collection: string; entityId: string; doc: Record<string, unknown>; hash: string };

async function items(pid: string): Promise<Item[]> {
  const docs: [string, string, Record<string, unknown>][] = [
    ['settings', 'settings', { id: 'settings', userName: 'Ana', weightUnit: 'kg' }],
    ['routines', 'r1', { id: 'r1', profileId: pid, name: 'Ficha ABC', workouts: [{ id: 'w1', label: 'A', name: 'Peito', exercises: [] }], createdAt: 1, updatedAt: 1 }],
    ['sessions', 's1', { id: 's1', profileId: pid, routineId: 'r1', workoutId: 'w1', status: 'completed', startedAt: 1_700_000_000_000, exercises: [{ id: 'e1', exerciseKey: 'k', name: 'Supino', sets: [{ id: 'x', type: 'normal', status: 'done', weight: 50, reps: 8 }] }], updatedAt: 2 }],
    ['bodyEntries', 'b1', { id: 'b1', profileId: pid, date: '2026-09-01', weightKg: 81.4, createdAt: 3 }],
    ['rotations', 'r1', { routineId: 'r1', nextIndex: 1, updatedAt: 4 }],
    ['overrides', 'r1|2026-10-10', { routineId: 'r1', date: '2026-10-10', kind: 'rest' }],
    ['exerciseFavorites', `${pid}~catalog:supino`, { id: `${pid}~catalog:supino`, profileId: pid, target: 'catalog:supino', createdAt: 5 }],
  ];
  return Promise.all(docs.map(async ([collection, entityId, doc]) => ({ collection, entityId, doc, hash: await recordHash(doc) })));
}

async function runImport(c: Client, list: Item[], policy: 'merge' | 'replace' = 'merge', fingerprint = 'a'.repeat(64)) {
  const job = await c.post('/api/v1/import/jobs', { sourceKind: 'backup_file', sourceFingerprint: fingerprint, sourceProfileId: 'perfil-antigo', expectedItems: list.length });
  expect(job.status).toBe(201);
  const id = job.body.jobId;
  for (let i = 0; i < list.length; i += 3) expect((await c.post(`/api/v1/import/jobs/${id}/items`, { items: list.slice(i, i + 3) })).status).toBe(200);
  const preview = await c.get(`/api/v1/import/jobs/${id}/preview`);
  const commit = await c.post(`/api/v1/import/jobs/${id}/commit`, policy === 'replace' ? { policy, confirmReplace: true } : { policy });
  const verify = await c.get(`/api/v1/import/jobs/${id}/verify`);
  return { id, job: job.body, preview: preview.body, report: commit.body.report, verify: verify.body, commitStatus: commit.status };
}

describe('importação de backup', () => {
  it('prévia, efetivação e leitura de volta com hash igual por registro', async () => {
    const { client, account } = await signup(env);
    const list = await items(account.dataProfileId);
    const r = await runImport(client, list);
    expect(r.preview.totals).toMatchObject({ new: 7, identical: 0, conflict: 0 });
    expect(r.preview.staged).toBe(7);
    expect(r.report.totals).toMatchObject({ new: 7, identical: 0, conflict: 0, replaced: 0 });
    expect(r.verify).toMatchObject({ ok: true, checked: 7, matched: 7, mismatches: [] });
    expect(r.verify.accountCounts).toMatchObject({ routines: 1, sessions: 1, bodyEntries: 1, settings: 1 });
    // o que foi importado chega aos aparelhos pela sincronização
    const pull = await client.get('/api/v1/sync/pull?cursor=0');
    expect(pull.body.changes).toHaveLength(7);
    // projeção do treino importado
    expect((await env.pool.query('SELECT count(*)::int AS n FROM workout_sets WHERE user_id = $1', [account.id])).rows[0].n).toBe(1);
  });

  it('importar o MESMO backup de novo não duplica nada e informa a importação anterior', async () => {
    const { client, account } = await signup(env);
    const list = await items(account.dataProfileId);
    await runImport(client, list, 'merge', 'b'.repeat(64));
    const again = await runImport(client, list, 'merge', 'b'.repeat(64));
    expect(again.job.previousImport).not.toBeNull();
    expect(again.report.totals).toMatchObject({ new: 0, identical: 7, conflict: 0 });
    expect(again.verify.ok).toBe(true);
    const seq = await env.pool.query('SELECT sync_seq FROM users WHERE id = $1', [account.id]);
    expect(seq.rows[0].sync_seq).toBe(7);
  });

  it('mesmo ID com conteúdo diferente: conflito, sem sobrescrever na política mesclar', async () => {
    const { client, account } = await signup(env);
    const list = await items(account.dataProfileId);
    await runImport(client, list);
    const changed = await Promise.all(list.map(async (i) => (i.collection === 'bodyEntries' ? { ...i, doc: { ...i.doc, weightKg: 79 }, hash: await recordHash({ ...i.doc, weightKg: 79 }) } : i)));
    const r = await runImport(client, changed, 'merge', 'c'.repeat(64));
    expect(r.preview.totals.conflict).toBe(1);
    expect(r.report.conflicts).toEqual([{ collection: 'bodyEntries', entityId: 'b1', outcome: 'conflict' }]);
    expect(r.verify).toMatchObject({ ok: true, keptAccountVersion: 1 });
    const w = await env.pool.query("SELECT doc->>'weightKg' AS w FROM body_measurements WHERE user_id = $1", [account.id]);
    expect(w.rows[0].w).toBe('81.4');
  });

  it('substituir exige confirmação explícita e guarda a versão anterior', async () => {
    const { client, account } = await signup(env);
    const list = await items(account.dataProfileId);
    await runImport(client, list);
    const changed = await Promise.all(list.map(async (i) => (i.collection === 'bodyEntries' ? { ...i, doc: { ...i.doc, weightKg: 79 }, hash: await recordHash({ ...i.doc, weightKg: 79 }) } : i)));
    const job = await client.post('/api/v1/import/jobs', { sourceKind: 'backup_file', sourceFingerprint: 'd'.repeat(64), sourceProfileId: null, expectedItems: changed.length });
    await client.post(`/api/v1/import/jobs/${job.body.jobId}/items`, { items: changed });
    const noConfirm = await client.post(`/api/v1/import/jobs/${job.body.jobId}/commit`, { policy: 'replace' });
    expect(noConfirm.status).toBe(422);
    const ok = await client.post(`/api/v1/import/jobs/${job.body.jobId}/commit`, { policy: 'replace', confirmReplace: true });
    expect(ok.body.report.totals).toMatchObject({ replaced: 1, identical: 6 });
    const rev = await env.pool.query("SELECT reason, doc->>'weightKg' AS w FROM record_revisions WHERE user_id = $1", [account.id]);
    expect(rev.rows).toEqual([{ reason: 'import_replace', w: '81.4' }]);
    expect((await client.get(`/api/v1/import/jobs/${job.body.jobId}/verify`)).body.ok).toBe(true);
  });

  it('não efetiva enquanto faltam lotes; hash que não confere recusa o lote inteiro', async () => {
    const { client, account } = await signup(env);
    const list = await items(account.dataProfileId);
    const job = await client.post('/api/v1/import/jobs', { sourceKind: 'local_profile', sourceFingerprint: 'e'.repeat(64), sourceProfileId: 'p', expectedItems: list.length });
    await client.post(`/api/v1/import/jobs/${job.body.jobId}/items`, { items: list.slice(0, 2) });
    const early = await client.post(`/api/v1/import/jobs/${job.body.jobId}/commit`, { policy: 'merge' });
    expect(early.status).toBe(409);
    expect(early.body.error.fields.items).toContain('Recebidos 2 de 7');
    const tampered = [{ ...list[2], hash: 'f'.repeat(64) }, list[3]];
    const bad = await client.post(`/api/v1/import/jobs/${job.body.jobId}/items`, { items: tampered });
    expect(bad.status).toBe(422);
    expect(bad.body.items).toEqual([{ collection: 'sessions', entityId: 's1', reason: 'hash' }]);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM import_job_items WHERE job_id = $1', [job.body.jobId])).rows[0].n).toBe(2);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM workout_sessions WHERE user_id = $1', [account.id])).rows[0].n).toBe(0);
  });

  it('falha no meio da efetivação desfaz TUDO (rollback transacional)', async () => {
    const { client, account } = await signup(env);
    const list = await items(account.dataProfileId);
    const job = await client.post('/api/v1/import/jobs', { sourceKind: 'backup_file', sourceFingerprint: '1'.repeat(64), sourceProfileId: null, expectedItems: list.length });
    await client.post(`/api/v1/import/jobs/${job.body.jobId}/items`, { items: list });
    // Corrompe um item na área de preparo (status inválido para a tabela): a gravação falha no meio.
    await env.pool.query(`UPDATE import_job_items SET doc = jsonb_set(doc, '{status}', '"voando"') WHERE job_id = $1 AND collection = 'sessions'`, [job.body.jobId]);
    const r = await client.post(`/api/v1/import/jobs/${job.body.jobId}/commit`, { policy: 'merge' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('import_invalid');
    for (const t of ['routines', 'body_measurements', 'workout_sessions', 'user_settings']) expect((await env.pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [account.id])).rows[0].n).toBe(0);
    expect((await env.pool.query('SELECT status FROM import_jobs WHERE id = $1', [job.body.jobId])).rows[0].status).toBe('staging');
  });

  it('o dono é sempre a conta: perfil antigo nos registros é trocado; ID de favorito de outro perfil é recusado', async () => {
    const { client, account } = await signup(env);
    const doc = { id: 'r2', profileId: 'perfil-antigo', name: 'x', workouts: [], createdAt: 1, updatedAt: 1 };
    const wrongHash = await recordHash(doc);
    const job = await client.post('/api/v1/import/jobs', { sourceKind: 'backup_file', sourceFingerprint: '2'.repeat(64), sourceProfileId: null, expectedItems: 1 });
    // hash calculado com o perfil antigo não confere com o registro normalizado
    expect((await client.post(`/api/v1/import/jobs/${job.body.jobId}/items`, { items: [{ collection: 'routines', entityId: 'r2', doc, hash: wrongHash }] })).status).toBe(422);
    const fixed = { ...doc, profileId: account.dataProfileId };
    expect((await client.post(`/api/v1/import/jobs/${job.body.jobId}/items`, { items: [{ collection: 'routines', entityId: 'r2', doc, hash: await recordHash(fixed) }] })).status).toBe(200);
    const fav = { id: 'outro~catalog:x', target: 'catalog:x', createdAt: 1 };
    const job2 = await client.post('/api/v1/import/jobs', { sourceKind: 'backup_file', sourceFingerprint: '3'.repeat(64), sourceProfileId: null, expectedItems: 1 });
    const r = await client.post(`/api/v1/import/jobs/${job2.body.jobId}/items`, { items: [{ collection: 'exerciseFavorites', entityId: fav.id, doc: fav, hash: await recordHash(fav) }] });
    expect(r.body.items[0].reason).toBe('profile_mismatch');
  });

  it('outra conta não enxerga nem usa o trabalho de importação', async () => {
    const a = await signup(env);
    const b = await signup(env);
    const job = await a.client.post('/api/v1/import/jobs', { sourceKind: 'backup_file', sourceFingerprint: '4'.repeat(64), sourceProfileId: null, expectedItems: 1 });
    const id = job.body.jobId;
    expect((await b.client.get(`/api/v1/import/jobs/${id}/preview`)).status).toBe(404);
    expect((await b.client.post(`/api/v1/import/jobs/${id}/commit`, { policy: 'merge' })).status).toBe(404);
    expect((await b.client.req('DELETE', `/api/v1/import/jobs/${id}`)).status).toBe(404);
    const fav = { id: `${b.account.dataProfileId}~catalog:x`, target: 'catalog:x', createdAt: 1 };
    expect((await b.client.post(`/api/v1/import/jobs/${id}/items`, { items: [{ collection: 'exerciseFavorites', entityId: fav.id, doc: fav, hash: await recordHash(fav) }] })).status).toBe(404);
    void uuid4;
  });
});
