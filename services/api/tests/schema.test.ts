import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationChecksumError, migrate, pendingMigrations, readMigrations } from '../src/db/migrate.ts';
import { exportAccount } from '../src/modules/exporter.ts';
import { applyPush } from '../src/modules/sync.ts';
import { setupApi, signup, uuid4, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupApi();
});
afterAll(async () => {
  await env?.close();
});

describe('migrações', () => {
  it('aplicadas uma vez, registradas com checksum; reaplicar não faz nada', async () => {
    expect(await pendingMigrations(env.pool)).toEqual([]);
    const again = await migrate(env.pool);
    expect(again.applied).toEqual([]);
    const rows = await env.pool.query('SELECT name, checksum FROM schema_migrations');
    expect(rows.rows.map((r) => r.name)).toEqual(readMigrations().map((f) => f.name));
  });

  it('migração aplicada e alterada depois é ERRO (nunca reaplica nem ignora)', async () => {
    const files = readMigrations().map((f, i) => (i === 0 ? { ...f, checksum: 'adulterado' } : f));
    await expect(migrate(env.pool, files)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('migração que falha não deixa nada pela metade', async () => {
    const bad = [...readMigrations(), { name: '9999_falha.sql', sql: 'CREATE TABLE teste_parcial (id int); SELECT 1/0;', checksum: 'x' }];
    await expect(migrate(env.pool, bad)).rejects.toThrow(/9999_falha.sql/);
    expect((await env.pool.query("SELECT to_regclass('teste_parcial') AS t")).rows[0].t).toBeNull();
    expect((await env.pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name = '9999_falha.sql'")).rows[0].n).toBe(0);
  });
});

describe('restrições do esquema', () => {
  it('e-mail único e normalizado; FK em cascata; CHECK de status', async () => {
    const id = uuid4();
    await expect(env.pool.query("INSERT INTO users (id, email, name, password_hash, data_profile_id, terms_accepted_at) VALUES ($1, 'Maiuscula@X.com', 'n', 'h', $2, now())", [id, uuid4()])).rejects.toMatchObject({ code: '23514' });
    const { account, email } = await signup(env);
    await expect(env.pool.query("INSERT INTO users (id, email, name, password_hash, data_profile_id, terms_accepted_at) VALUES ($1, $2, 'n', 'h', $3, now())", [uuid4(), email, uuid4()])).rejects.toMatchObject({ code: '23505' });
    await expect(env.pool.query("INSERT INTO workout_sessions (user_id, id, status, started_at, doc, version, server_seq) VALUES ($1, 'x', 'voando', now(), '{}', 1, 1)", [account.id])).rejects.toMatchObject({ code: '23514' });
    await expect(env.pool.query("INSERT INTO routines (user_id, id, doc, version, server_seq) VALUES ($1, 'r', '{}', 1, 1)", [uuid4()])).rejects.toMatchObject({ code: '23503' });
    await expect(env.pool.query("INSERT INTO workout_sets (user_id, session_id, exercise_id, id, position, type, status) VALUES ($1, 'nao', 'existe', 's', 0, 'normal', 'done')", [account.id])).rejects.toMatchObject({ code: '23503' });
  });

  it('excluir a conta apaga em cascata dados, projeções, revisões e importações', async () => {
    const { account } = await signup(env);
    await applyPush(env.pool, account.id, uuid4(), [
      { opId: uuid4(), collection: 'sessions', entityId: 's', kind: 'put', baseVersion: 0, doc: { id: 's', status: 'completed', startedAt: 1, exercises: [{ id: 'e', name: 'x', sets: [{ id: 'a', type: 'normal', status: 'done', weight: 1, reps: 1 }] }] } },
    ]);
    await env.pool.query('DELETE FROM users WHERE id = $1', [account.id]);
    for (const t of ['workout_sessions', 'workout_exercises', 'workout_sets', 'sync_operations', 'auth_sessions']) expect((await env.pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [account.id])).rows[0].n).toBe(0);
  });
});

describe('exportação da conta', () => {
  it('formato de backup v8 do app, só com os dados da própria conta e sem fotos', async () => {
    const a = await signup(env);
    const b = await signup(env);
    await applyPush(env.pool, a.account.id, uuid4(), [{ opId: uuid4(), collection: 'bodyEntries', entityId: 'b', kind: 'put', baseVersion: 0, doc: { id: 'b', date: '2026-10-01', weightKg: 80, createdAt: 1 } }]);
    await applyPush(env.pool, b.account.id, uuid4(), [{ opId: uuid4(), collection: 'bodyEntries', entityId: 'c', kind: 'put', baseVersion: 0, doc: { id: 'c', date: '2026-10-01', weightKg: 60, createdAt: 1 } }]);
    const file = (await exportAccount(env.pool, a.account.id)) as { schemaVersion: number; profile: { id: string }; data: Record<string, unknown[]> };
    expect(file).toMatchObject({ app: 'irontrack', kind: 'backup', schemaVersion: 8, profile: { id: a.account.dataProfileId } });
    expect(file.data.bodyEntries).toEqual([{ id: 'b', date: '2026-10-01', weightKg: 80, createdAt: 1, profileId: a.account.dataProfileId }]);
    expect(file.data.photos).toEqual([]);
    const http = await a.client.get('/api/v1/me/export');
    expect(http.headers.get('content-disposition')).toMatch(/attachment; filename="irontrack-conta-/);
    expect(JSON.stringify(http.body)).not.toContain('"weightKg":60');
  });
});
