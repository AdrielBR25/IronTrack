import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPush } from '../src/modules/sync.ts';
import { Client, setupApi, signup, uuid4, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupApi();
});
afterAll(async () => {
  await env?.close();
});

const PROTOCOL = 'irontrack.sync.v1';

function session(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    routineId: 'r1',
    workoutId: 'w1',
    workoutLabel: 'A',
    workoutName: 'Peito',
    status: 'completed',
    startedAt: Date.UTC(2026, 9, 1, 10),
    finishedAt: Date.UTC(2026, 9, 1, 11),
    durationSec: 3600,
    updatedAt: 1,
    profileId: 'perfil-qualquer',
    exercises: [
      {
        id: 'e1',
        exerciseKey: 'k-supino',
        templateId: 't1',
        catalogId: 'supino-reto-barra',
        name: 'Supino reto',
        muscleGroup: 'Peito',
        category: 'compound',
        equipment: 'barbell',
        repMin: 8,
        repMax: 12,
        restSec: 90,
        plannedSets: 2,
        sets: [
          { id: 's1', type: 'normal', status: 'done', weight: 60, reps: 10, completedAt: Date.UTC(2026, 9, 1, 10, 10) },
          { id: 's2', type: 'normal', status: 'done', weight: 62.5, reps: 8 },
        ],
      },
    ],
    ...over,
  };
}

const put = (collection: string, entityId: string, doc: Record<string, unknown>, baseVersion = 0, extra: Record<string, unknown> = {}) => ({ opId: uuid4(), collection, entityId, kind: 'put', baseVersion, doc, ...extra });
const push = (c: Client, account: { id: string }, ops: unknown[], deviceId = uuid4()) => c.post('/api/v1/sync/push', { protocol: PROTOCOL, deviceId, accountId: account.id, ops });
const pull = (c: Client, cursor = '0') => c.get(`/api/v1/sync/pull?cursor=${cursor}`);

describe('push e pull', () => {
  it('grava, devolve versão e cursor, e o outro aparelho baixa o mesmo registro', async () => {
    const { client, account, email } = await signup(env);
    const r = await push(client, account, [put('sessions', 'sess-1', session('sess-1'))]);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ status: 'applied', version: 1, seq: 1 });
    // segundo "navegador" da mesma conta
    const other = new Client(env);
    await other.post('/api/v1/auth/login', { email, password: 'treinoForte2026' });
    const p = await pull(other);
    expect(p.body.changes).toHaveLength(1);
    expect(p.body.changes[0]).toMatchObject({ collection: 'sessions', entityId: 'sess-1', version: 1, deleted: false });
    // dono normalizado para o perfil da conta (o valor enviado é ignorado)
    expect(p.body.changes[0].doc.profileId).toBe(account.dataProfileId);
    expect(p.body.cursor).toBe('1');
    expect((await pull(other, '1')).body.changes).toHaveLength(0);
  });

  it('projeção relacional de exercícios e séries na mesma transação, com identidades separadas', async () => {
    const { client, account } = await signup(env);
    await push(client, account, [put('sessions', 'sess-p', session('sess-p'))]);
    const ex = await env.pool.query('SELECT exercise_key, template_id, catalog_id, name FROM workout_exercises WHERE user_id = $1', [account.id]);
    expect(ex.rows).toEqual([{ exercise_key: 'k-supino', template_id: 't1', catalog_id: 'supino-reto-barra', name: 'Supino reto' }]);
    const sets = await env.pool.query('SELECT id, weight_kg, reps, status FROM workout_sets WHERE user_id = $1 ORDER BY position', [account.id]);
    expect(sets.rows.map((s) => [s.id, Number(s.weight_kg), s.reps])).toEqual([
      ['s1', 60, 10],
      ['s2', 62.5, 8],
    ]);
    // edição remove uma série: projeção acompanha
    const edited = session('sess-p');
    edited.exercises[0].sets.pop();
    await push(client, account, [put('sessions', 'sess-p', edited, 1)]);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM workout_sets WHERE user_id = $1', [account.id])).rows[0].n).toBe(1);
  });

  it('versão desatualizada = conflito com a versão do servidor (sem sobrescrever)', async () => {
    const { client, account } = await signup(env);
    await push(client, account, [put('goals', 'g1', { id: 'g1', type: 'session_count', status: 'active', title: 'Meta', revision: 1 })]);
    await push(client, account, [put('goals', 'g1', { id: 'g1', type: 'session_count', status: 'paused', title: 'Meta', revision: 2 }, 1)]);
    const r = await push(client, account, [put('goals', 'g1', { id: 'g1', type: 'session_count', status: 'archived', title: 'Meta', revision: 2 }, 1)]);
    expect(r.body.results[0].status).toBe('conflict');
    expect(r.body.results[0].server).toMatchObject({ version: 2, deleted: false });
    expect(r.body.results[0].server.doc.status).toBe('paused');
    const row = await env.pool.query("SELECT doc->>'status' AS s, version FROM goals WHERE user_id = $1", [account.id]);
    expect(row.rows[0]).toEqual({ s: 'paused', version: 2 });
  });

  it('idempotente: reenviar a mesma operação devolve o mesmo resultado sem nova versão', async () => {
    const { client, account } = await signup(env);
    const op = put('routines', 'r1', { id: 'r1', name: 'Ficha', workouts: [], createdAt: 1, updatedAt: 1 });
    const a = await push(client, account, [op]);
    const b = await push(client, account, [op]);
    expect(a.body.results[0]).toMatchObject({ status: 'applied', version: 1 });
    expect(b.body.results[0]).toMatchObject({ status: 'applied', version: 1, replayed: true });
    expect((await env.pool.query('SELECT version FROM routines WHERE user_id = $1', [account.id])).rows[0].version).toBe(1);
  });

  it('exclusão gera marca para os outros aparelhos e guarda a versão anterior', async () => {
    const { client, account } = await signup(env);
    await push(client, account, [put('bodyEntries', 'b1', { id: 'b1', date: '2026-10-01', weightKg: 80, createdAt: 1 })]);
    const del = await push(client, account, [{ opId: uuid4(), collection: 'bodyEntries', entityId: 'b1', kind: 'delete', baseVersion: 1 }]);
    expect(del.body.results[0]).toMatchObject({ status: 'applied', version: 2 });
    const p = await pull(client);
    expect(p.body.changes[0]).toMatchObject({ entityId: 'b1', deleted: true, doc: null, version: 2 });
    const rev = await env.pool.query("SELECT reason, doc->>'weightKg' AS w FROM record_revisions WHERE user_id = $1", [account.id]);
    expect(rev.rows).toEqual([{ reason: 'delete', w: '80' }]);
  });

  it('resolução explícita de conflito guarda a versão substituída', async () => {
    const { client, account } = await signup(env);
    await push(client, account, [put('routines', 'r9', { id: 'r9', name: 'A', workouts: [], createdAt: 1, updatedAt: 1 })]);
    await push(client, account, [put('routines', 'r9', { id: 'r9', name: 'B', workouts: [], createdAt: 1, updatedAt: 2 }, 1, { reason: 'conflict_resolution' })]);
    const rev = await env.pool.query("SELECT reason, version, doc->>'name' AS name FROM record_revisions WHERE user_id = $1", [account.id]);
    expect(rev.rows).toEqual([{ reason: 'conflict_resolution', version: 1, name: 'A' }]);
  });

  it('recusa só a operação inválida; as outras do lote são aplicadas', async () => {
    const { client, account } = await signup(env);
    const r = await push(client, account, [
      put('bodyEntries', 'ok', { id: 'ok', date: '2026-10-02', createdAt: 1 }),
      put('bodyEntries', 'ruim', { id: 'ruim', date: '2026-02-30', createdAt: 1 }),
      put('sessions', 'sx', { ...session('sx'), status: 'voando' }),
      put('routines', 'id-a', { id: 'id-b', name: 'x', workouts: [], createdAt: 1, updatedAt: 1 }),
      { opId: 'nao-uuid', collection: 'routines' },
    ]);
    expect(r.body.results.map((x: { status: string; code?: string }) => x.code ?? x.status)).toEqual(['applied', 'invalid_record', 'invalid_record', 'entity_mismatch', 'invalid_op']);
    expect((await env.pool.query('SELECT id FROM body_measurements WHERE user_id = $1', [account.id])).rows).toEqual([{ id: 'ok' }]);
  });

  it('IDs dependentes de perfil (decisões, favoritos) têm de usar o perfil da conta', async () => {
    const { client, account } = await signup(env);
    const pid = account.dataProfileId;
    const r = await push(client, account, [
      put('exerciseFavorites', `outro~catalog:supino`, { id: 'outro~catalog:supino', target: 'catalog:supino', createdAt: 1 }),
      put('exerciseFavorites', `${pid}~catalog:supino`, { id: `${pid}~catalog:supino`, target: 'catalog:supino', createdAt: 1 }),
    ]);
    expect(r.body.results.map((x: { status: string; code?: string }) => x.code ?? x.status)).toEqual(['profile_mismatch', 'applied']);
  });

  it('cursor à frente do servidor (banco restaurado) pede recomeço', async () => {
    const { client } = await signup(env);
    const r = await pull(client, '999');
    expect(r.body).toMatchObject({ reset: true, cursor: '0' });
  });
});

describe('isolamento entre contas', () => {
  it('uma conta nunca vê nem altera dados de outra, mesmo com o mesmo ID', async () => {
    const a = await signup(env);
    const b = await signup(env);
    await push(a.client, a.account, [put('bodyEntries', 'mesmo-id', { id: 'mesmo-id', date: '2026-10-01', weightKg: 70, createdAt: 1 })]);
    // B não recebe nada de A
    expect((await pull(b.client)).body.changes).toHaveLength(0);
    // B grava o MESMO ID: cria o registro de B (versão 1), A continua intacto
    const r = await push(b.client, b.account, [put('bodyEntries', 'mesmo-id', { id: 'mesmo-id', date: '2026-10-01', weightKg: 99, createdAt: 1 })]);
    expect(r.body.results[0]).toMatchObject({ status: 'applied', version: 1 });
    const rows = await env.pool.query("SELECT user_id, doc->>'weightKg' AS w FROM body_measurements WHERE id = 'mesmo-id' ORDER BY w");
    expect(rows.rows).toEqual([
      { user_id: a.account.id, w: '70' },
      { user_id: b.account.id, w: '99' },
    ]);
    // B tenta excluir "o de A" pelo ID: só afeta o próprio
    await push(b.client, b.account, [{ opId: uuid4(), collection: 'bodyEntries', entityId: 'mesmo-id', kind: 'delete', baseVersion: 1 }]);
    expect((await pull(a.client)).body.changes[0].deleted).toBe(false);
  });

  it('accountId do corpo diferente da sessão é recusado (fila de outra conta no mesmo aparelho)', async () => {
    const a = await signup(env);
    const b = await signup(env);
    const r = await push(a.client, b.account, [put('bodyEntries', 'x', { id: 'x', date: '2026-10-01', createdAt: 1 })]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('account_mismatch');
    expect((await pull(b.client)).body.changes).toHaveLength(0);
    expect((await a.client.get(`/api/v1/sync/pull?cursor=0&accountId=${b.account.id}`)).status).toBe(409);
  });

  it('sem sessão não há sincronização', async () => {
    const anon = new Client(env);
    expect((await anon.get('/api/v1/sync/pull?cursor=0')).status).toBe(401);
    expect((await anon.post('/api/v1/sync/push', { protocol: PROTOCOL, deviceId: uuid4(), accountId: uuid4(), ops: [] })).status).toBe(401);
  });
});

describe('concorrência', () => {
  it('dois aparelhos editam o mesmo treino ao mesmo tempo: exatamente um vence, o outro recebe conflito', async () => {
    const { account } = await signup(env);
    await applyPush(env.pool, account.id, uuid4(), [put('sessions', 'cc', session('cc'))]);
    const phone = put('sessions', 'cc', session('cc', { notes: 'celular' }), 1);
    const pc = put('sessions', 'cc', session('cc', { notes: 'computador' }), 1);
    const [r1, r2] = await Promise.all([applyPush(env.pool, account.id, uuid4(), [phone]), applyPush(env.pool, account.id, uuid4(), [pc])]);
    const statuses = [r1[0].status, r2[0].status].sort();
    expect(statuses).toEqual(['applied', 'conflict']);
    const row = await env.pool.query('SELECT version FROM workout_sessions WHERE user_id = $1', [account.id]);
    expect(row.rows[0].version).toBe(2);
  });

  it('cursor sem buracos com envios simultâneos (seq em série por conta)', async () => {
    const { client, account } = await signup(env);
    const batches = Array.from({ length: 8 }, (_, i) => applyPush(env.pool, account.id, uuid4(), [put('bodyEntries', `c${i}`, { id: `c${i}`, date: '2026-10-01', createdAt: i })]));
    await Promise.all(batches);
    const p = await pull(client);
    expect(p.body.changes.map((c: { seq: number }) => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('recusa de dado pelo banco (CHECK) recusa só a operação; erro inesperado desfaz o LOTE inteiro', async () => {
    const { account } = await signup(env);
    const r1 = (name: string, id: string) => put('routines', id, { id, name, workouts: [], createdAt: 1, updatedAt: 1 });
    await env.pool.query("ALTER TABLE routines ADD CONSTRAINT teste_falha CHECK (name <> 'explode') NOT VALID");
    try {
      const r = await applyPush(env.pool, account.id, uuid4(), [r1('boa', 'ok1'), r1('explode', 'bad')]);
      expect(r.map((x) => x.status)).toEqual(['applied', 'rejected']);
    } finally {
      await env.pool.query('ALTER TABLE routines DROP CONSTRAINT teste_falha');
    }
    // Falha que não é de dado (ex.: bug, banco caindo): exceção, nada do lote é gravado e o app reenvia os mesmos IDs.
    await env.pool.query(`CREATE FUNCTION teste_pane() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'pane' THEN RAISE EXCEPTION 'pane'; END IF; RETURN NEW; END $$`);
    await env.pool.query('CREATE TRIGGER teste_pane BEFORE INSERT ON routines FOR EACH ROW EXECUTE FUNCTION teste_pane()');
    try {
      const before = (await env.pool.query('SELECT sync_seq FROM users WHERE id = $1', [account.id])).rows[0].sync_seq;
      await expect(applyPush(env.pool, account.id, uuid4(), [r1('primeira', 'p1'), r1('pane', 'p2')])).rejects.toThrow();
      expect((await env.pool.query("SELECT count(*)::int AS n FROM routines WHERE user_id = $1 AND id = 'p1'", [account.id])).rows[0].n).toBe(0);
      expect((await env.pool.query('SELECT sync_seq FROM users WHERE id = $1', [account.id])).rows[0].sync_seq).toBe(before);
    } finally {
      await env.pool.query('DROP TRIGGER teste_pane ON routines; DROP FUNCTION teste_pane()');
    }
  });
});
