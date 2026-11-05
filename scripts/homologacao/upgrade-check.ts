// Fase 07 — prova de atualização do banco: contas criadas pela API de PRODUÇÃO (só a migração 0001) → migrações
// 0002–0008 desta branch → mesmas contas e dados, isolamento, reexecução segura → pg_dump → restauração num banco
// descartável → mesmos dados. Tudo em PostgreSQL LOCAL e descartável; nunca toca na Railway.
//
// Uso (ver scripts/homologacao/upgrade-check.sh, que prepara o código antigo):
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres OLD_API_DIR=/tmp/irontrack-prod \
//   node scripts/homologacao/upgrade-check.ts
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const admin = process.env.TEST_DATABASE_URL ?? '';
const oldDir = process.env.OLD_API_DIR ?? '';
if (!/^postgres(ql)?:\/\//.test(admin)) throw new Error('Defina TEST_DATABASE_URL (PostgreSQL local).');
if (/railway|rlwy/i.test(admin)) throw new Error('TEST_DATABASE_URL parece ser da Railway: este teste cria e apaga bancos, só em PostgreSQL local.');
if (!oldDir) throw new Error('Defina OLD_API_DIR (cópia do código de produção; use upgrade-check.sh).');

const ORIGIN = 'http://localhost:4173';
const PASSWORD = 'treinoForte2026';
const results: { step: string; ok: boolean; detail?: string }[] = [];
function check(step: string, ok: boolean, detail?: string) {
  results.push({ step, ok, ...(detail ? { detail } : {}) });
  process.stdout.write(`${ok ? '✔' : '✘'} ${step}${detail ? ` — ${detail}` : ''}\n`);
}

function dbUrl(name: string) {
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
}
async function adminQuery(sql: string) {
  const p = new pg.Pool({ connectionString: admin, max: 1 });
  try {
    await p.query(sql);
  } finally {
    await p.end();
  }
}

/** Impressão digital das tabelas da 0001, só com as colunas originais (as migrações novas podem acrescentar colunas). */
async function fingerprint(url: string, onlyColumnsOf?: Map<string, string[]>): Promise<Map<string, string>> {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  const out = new Map<string, string>();
  try {
    const tables = onlyColumnsOf ? [...onlyColumnsOf.keys()] : (await p.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).rows.map((r) => r.t);
    for (const t of tables) {
      const cols = onlyColumnsOf?.get(t) ?? (await p.query<{ c: string }>('SELECT column_name AS c FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', ['public', t])).rows.map((r) => r.c);
      const list = cols.map((c) => `"${c}"`).join(', ');
      const rows = await p.query(`SELECT ${list} FROM "${t}" ORDER BY ${list}`);
      out.set(t, `${rows.rowCount}:${createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex').slice(0, 16)}`);
    }
  } finally {
    await p.end();
  }
  return out;
}
async function columnsOf(url: string): Promise<Map<string, string[]>> {
  const p = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = await p.query<{ t: string; c: string }>("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position");
    const m = new Map<string, string[]>();
    for (const row of r.rows) m.set(row.t, [...(m.get(row.t) ?? []), row.c]);
    m.delete('rate_limits'); // contadores de tentativas mudam a cada login (esperado)
    m.delete('auth_sessions'); // last_seen muda ao usar a sessão (esperado)
    m.delete('schema_migrations'); // ganha as linhas 0002–0008 (esperado; conferido à parte)
    return m;
  } finally {
    await p.end();
  }
}

class Client {
  cookie = '';
  ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async req(method: string, path: string, body?: unknown) {
    const h: Record<string, string> = { origin: ORIGIN, 'x-forwarded-for': this.ip };
    if (this.cookie) h.cookie = this.cookie;
    if (method !== 'GET') h['x-irontrack-csrf'] = '1';
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(`${this.base}${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [n, v] = pair!.split('=');
      this.cookie = /Max-Age=0/.test(c) || !v ? '' : `${n}=${v}`;
    }
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
}

async function startApi(codeDir: string, url: string, extraEnv: Record<string, string> = {}) {
  const imp = (p: string) => import(pathToFileURL(join(codeDir, p)).href);
  const { createApi } = await imp('services/api/src/app.ts');
  const { loadConfig } = await imp('services/api/src/config.ts');
  const { createPool } = await imp('services/api/src/db/pool.ts');
  const { migrate } = await imp('services/api/src/db/migrate.ts');
  const cfg = loadConfig({ DATABASE_URL: url, DATABASE_SSL: 'disable', NODE_ENV: 'test', APP_ORIGIN: ORIGIN, RATE_LIMIT_SECRET: 'homologacao-0123456789-0123456789-01', COOKIE_SECURE: 'false', TRUST_PROXY_HOPS: '1', ACCESS_LOG: 'off', ...extraEnv });
  const pool = createPool(cfg);
  const api = createApi({ cfg, pool, logger: { access() {}, event() {}, error() {} }, env: {} });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', () => r()));
  const a = api.server.address();
  return { base: `http://127.0.0.1:${a.port}`, pool, migrate: (opts?: unknown) => migrate(pool, undefined, opts), async stop() { await api.shutdown(500); await pool.end(); } };
}

const session = (id: string, weight: number) => ({
  id, routineId: 'r1', workoutId: 'w1', workoutLabel: 'A', workoutName: 'Peito', status: 'completed',
  startedAt: Date.UTC(2026, 9, 20, 10), finishedAt: Date.UTC(2026, 9, 20, 11), durationSec: 3600, updatedAt: 1, profileId: 'p',
  exercises: [{ id: 'e1', exerciseKey: 'k-supino', templateId: 't1', catalogId: 'supino-reto-barra', name: 'Supino reto', muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', repMin: 8, repMax: 12, restSec: 90, plannedSets: 1, sets: [{ id: 's1', type: 'normal', status: 'done', weight, reps: 10 }] }],
});
const put = (collection: string, entityId: string, doc: unknown) => ({ opId: randomUUID(), collection, entityId, kind: 'put', baseVersion: 0, doc });

const id = randomBytes(4).toString('hex');
const DB = `hml_upgrade_${id}`;
const DB_RESTORE = `hml_restore_${id}`;
const newDir = new URL('../../', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'irontrack-hml-'));
let exit = 0;
try {
  await adminQuery(`CREATE DATABASE ${DB}`);
  // ---------- 1. produção de hoje: código antigo, só a 0001
  const old = await startApi(oldDir, dbUrl(DB));
  const r0 = await old.migrate();
  check('código de produção aplica só a 0001 num banco novo', JSON.stringify(r0.applied) === '["0001_init.sql"]', r0.applied.join(','));
  const accounts: { email: string; id: string; client: Client; deviceId: string }[] = [];
  for (const [name, weight] of [['Conta Antiga A', 80], ['Conta Antiga B', 40]] as const) {
    const c = new Client(old.base);
    const email = `antiga.${name.at(-1)!.toLowerCase()}.${id}@exemplo.test`;
    const r = await c.req('POST', '/api/v1/auth/signup', { name, email, password: PASSWORD, acceptTerms: true });
    if (r.status !== 201) throw new Error(`cadastro na API antiga falhou: ${r.status}`);
    const deviceId = randomUUID();
    const p = await c.req('POST', '/api/v1/sync/push', { protocol: 'irontrack.sync.v1', deviceId, accountId: r.body.account.id, ops: [put('sessions', `sess-${name.at(-1)}`, session(`sess-${name.at(-1)}`, weight)), put('settings', 'settings', { id: 'settings', userName: name, unit: 'kg', updatedAt: 1 })] });
    check(`API antiga: ${name} criada e sincronizou 2 registros`, p.status === 200 && p.body.results.every((x: any) => x.status === 'applied'), `push ${p.status}: ${p.body.results?.map((x: any) => x.status + (x.code ? `(${x.code})` : '')).join(', ')}`);
    accounts.push({ email, id: r.body.account.id, client: c, deviceId });
  }
  const pulledBefore = await Promise.all(accounts.map((a) => a.client.req('GET', '/api/v1/sync/pull?cursor=0')));
  await old.stop();
  const oldCols = await columnsOf(dbUrl(DB));
  const fpBefore = await fingerprint(dbUrl(DB), oldCols);

  // ---------- 2. atualização: migrações desta branch
  const neu = await startApi(newDir, dbUrl(DB));
  const r1 = await neu.migrate();
  check('migrações 0002–0008 aplicadas sobre o banco de produção (cópia)', r1.applied.length === 7 && r1.applied[0] === '0002_assistant.sql' && r1.applied.at(-1) === '0008_integration.sql', r1.applied.join(', '));
  const r2 = await neu.migrate();
  check('reexecução: nada a aplicar, checksums conferidos', r2.applied.length === 0, `${r2.alreadyApplied} já aplicadas`);
  const fpAfter = await fingerprint(dbUrl(DB), oldCols);
  const changed = [...fpBefore].filter(([t, v]) => fpAfter.get(t) !== v).map(([t]) => t);
  check('nenhuma linha das tabelas antigas mudou (colunas originais)', changed.length === 0, changed.length ? `mudaram: ${changed.join(', ')}` : `${fpBefore.size} tabelas idênticas`);

  // ---------- 3. contas antigas no código novo
  for (const [i, a] of accounts.entries()) {
    const c = new Client(neu.base);
    const l = await c.req('POST', '/api/v1/auth/login', { email: a.email, password: PASSWORD });
    check(`conta antiga ${i ? 'B' : 'A'} entra com a mesma senha no código novo`, l.status === 200, `login ${l.status}`);
    const pull = await c.req('GET', '/api/v1/sync/pull?cursor=0');
    const same = JSON.stringify(pull.body.changes) === JSON.stringify(pulledBefore[i]!.body.changes);
    check(`conta antiga ${i ? 'B' : 'A'}: sincronização devolve exatamente os mesmos registros e versões`, pull.status === 200 && same, `${pull.body.changes?.length} registros`);
    const statuses: string[] = [];
    for (const path of ['/api/v1/me', '/api/v1/life/dashboard', '/api/v1/planner/week', '/api/v1/insights/evolution', '/api/v1/nutrition/days', '/api/v1/bible/home', '/api/v1/knowledge/dashboard', '/api/v1/bible/prefs', '/api/v1/assistant/conversations', '/api/v1/me/export']) {
      const r = await c.req('GET', path);
      statuses.push(`${path.replace('/api/v1/', '')}=${r.status}`);
    }
    check(`conta antiga ${i ? 'B' : 'A'}: telas novas respondem sem erro`, statuses.every((s) => /=(200|202)$/.test(s)), statuses.join(' '));
    if (i === 0) {
      const other = accounts[1]!;
      const x = await c.req('GET', `/api/v1/sync/pull?cursor=0&accountId=${other.id}`);
      const exp = await c.req('GET', '/api/v1/me/export');
      const leaks = JSON.stringify(exp.body).includes('Conta Antiga B') || JSON.stringify(pull.body).includes('sess-B');
      check('isolamento: A não lê dados de B (pull com a conta de B recusado, exportação sem dados de B)', x.status === 409 || x.status === 403 ? !leaks : false, `pull de B → ${x.status}`);
    }
  }
  const fpOpened = await fingerprint(dbUrl(DB), oldCols);
  const changed2 = [...fpBefore].filter(([t, v]) => fpOpened.get(t) !== v).map(([t]) => t);
  check('abrir as telas novas não alterou dados antigos', changed2.length === 0, changed2.join(', ') || 'idênticas');
  await neu.stop();

  // ---------- 4. rollback só de código: a API de produção (antiga) sobre o banco já migrado
  const back = await startApi(oldDir, dbUrl(DB));
  const rb = await back.migrate();
  check('rollback de código: API antiga aceita o banco migrado (não tenta desfazer nada)', rb.applied.length === 0);
  {
    const c = new Client(back.base);
    const l = await c.req('POST', '/api/v1/auth/login', { email: accounts[0]!.email, password: PASSWORD });
    const pull = await c.req('GET', '/api/v1/sync/pull?cursor=0');
    const n = new Client(back.base);
    const su = await n.req('POST', '/api/v1/auth/signup', { name: 'Conta no rollback', email: `rollback.${id}@exemplo.test`, password: PASSWORD, acceptTerms: true });
    check('rollback de código: login, sincronização e cadastro funcionam na API antiga', l.status === 200 && pull.status === 200 && su.status === 201, `login ${l.status}, pull ${pull.status}, cadastro ${su.status}`);
  }
  await back.stop();

  // ---------- 5. backup e restauração num banco descartável
  const dump = join(tmp, 'irontrack.dump');
  execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${dump}`, dbUrl(DB)], { stdio: 'inherit' });
  await adminQuery(`CREATE DATABASE ${DB_RESTORE}`);
  execFileSync('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${dbUrl(DB_RESTORE)}`, dump], { stdio: 'inherit' });
  const fpFull = await fingerprint(dbUrl(DB));
  const fpRestored = await fingerprint(dbUrl(DB_RESTORE));
  const diff = [...fpFull].filter(([t, v]) => fpRestored.get(t) !== v).map(([t]) => t);
  check('restauração: todas as tabelas idênticas ao original', diff.length === 0 && fpFull.size === fpRestored.size, diff.join(', ') || `${fpFull.size} tabelas`);
  const rest = await startApi(newDir, dbUrl(DB_RESTORE));
  const r3 = await rest.migrate();
  check('banco restaurado: nenhuma migração pendente', r3.applied.length === 0);
  const c = new Client(rest.base);
  const l = await c.req('POST', '/api/v1/auth/login', { email: accounts[0]!.email, password: PASSWORD });
  const pull = await c.req('GET', '/api/v1/sync/pull?cursor=0');
  check('banco restaurado: login e sincronização da conta A funcionam', l.status === 200 && JSON.stringify(pull.body.changes) === JSON.stringify(pulledBefore[0]!.body.changes));
  await rest.stop();
} catch (e) {
  check('execução', false, e instanceof Error ? e.message : String(e));
} finally {
  await adminQuery(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
  await adminQuery(`DROP DATABASE IF EXISTS ${DB_RESTORE} WITH (FORCE)`).catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
  exit = results.every((r) => r.ok) ? 0 : 1;
  process.stdout.write(`\n${results.filter((r) => r.ok).length}/${results.length} verificações ok\n`);
}
process.exit(exit);
