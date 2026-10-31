// Infra dos testes de integração da API: PostgreSQL REAL e descartável por arquivo de teste (CREATE DATABASE a partir
// de TEST_DATABASE_URL), migrações aplicadas pelo executor de produção e a API ouvindo numa porta livre.
// Nunca aponte TEST_DATABASE_URL para o banco de produção: cada arquivo cria e APAGA o próprio banco.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createApi, type Api } from '../src/app.ts';
import { loadConfig, type ApiConfig } from '../src/config.ts';
import { createPool, type Pool } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import type { Logger } from '../src/lib/log.ts';
import type { TestMailbox } from '../src/mail/mailer.ts';
import type { UpstreamAdapter } from '../../ai-gateway/src/providers/types.ts';

export const APP_ORIGIN = 'http://localhost:4173';
export const STRONG = 'treinoForte2026';

export function adminUrl(): string {
  const u = process.env.TEST_DATABASE_URL;
  if (!u) throw new Error('Defina TEST_DATABASE_URL (PostgreSQL de teste; ver docs/RAILWAY_FULLSTACK.md §10).');
  if (/railway|rlwy/i.test(u)) throw new Error('TEST_DATABASE_URL parece ser do Railway. Testes destrutivos só em banco local/CI.');
  return u;
}

export interface TestEnv {
  base: string;
  api: Api;
  pool: Pool;
  cfg: ApiConfig;
  mailbox: TestMailbox;
  logs: string[];
  dbName: string;
  close(): Promise<void>;
}

/** Provedor simulado (sem rede): devolve um texto fixo e uso informado. */
export const fakeAnthropic = (behavior: { text?: string; fail?: boolean } = {}): UpstreamAdapter => ({
  id: 'anthropic',
  defaultBaseUrl: 'https://provider.invalid',
  async generate(_req, ctx) {
    await ctx.fetch('https://provider.invalid/v1/messages', { method: 'POST', headers: {}, body: '{}', signal: ctx.signal, redirect: 'manual' });
    if (behavior.fail) throw new (await import('../../ai-gateway/src/errors.ts')).GatewayError('provider_failure');
    return { text: behavior.text ?? 'Resposta simulada do provedor.', finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 10 } };
  },
});

export async function setupApi(env: Record<string, string> = {}, opts: { adapter?: UpstreamAdapter; providerKey?: string | null } = {}): Promise<TestEnv> {
  const admin = adminUrl();
  const dbName = `it_${randomBytes(6).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
  await adminPool.query(`CREATE DATABASE ${dbName}`);
  await adminPool.end();
  const url = new URL(admin);
  url.pathname = `/${dbName}`;
  const cfg = loadConfig({
    DATABASE_URL: url.toString(),
    DATABASE_SSL: 'disable',
    NODE_ENV: 'test',
    APP_ORIGIN,
    RATE_LIMIT_SECRET: 'teste-0123456789-0123456789-0123456789',
    COOKIE_SECURE: 'false',
    EMAIL_PROVIDER: 'test-mailbox',
    API_TEST_MODE: '1',
    // Um proxy confiável: cada Client simula um aparelho com IP próprio (X-Forwarded-For).
    TRUST_PROXY_HOPS: '1',
    ...env,
  });
  const pool = createPool(cfg);
  await migrate(pool);
  const logs: string[] = [];
  const write = (s: string) => logs.push(s);
  const logger: Logger = {
    access: (e) => write(JSON.stringify(e)),
    event: (n, d) => write(JSON.stringify({ n, ...d })),
    error: (w, e) => write(JSON.stringify({ w, e: String(e) })),
  };
  const providerKey = opts.providerKey === undefined ? 'sk-ant-teste-chave-secreta-0000000000' : opts.providerKey;
  const api = createApi({ cfg, pool, logger, env: providerKey ? { ANTHROPIC_API_KEY: providerKey } : {}, ai: { adapters: { anthropic: opts.adapter ?? fakeAnthropic() }, fetch: async () => new Response('{}', { status: 200 }) } });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', () => r()));
  const addr = api.server.address();
  const base = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
  return {
    base,
    api,
    pool,
    cfg,
    mailbox: api.mailer as TestMailbox,
    logs,
    dbName,
    async close() {
      await api.shutdown(1000);
      await pool.end();
      const p = new pg.Pool({ connectionString: admin, max: 1 });
      await p.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await p.end();
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Cliente HTTP com "pote de cookies" próprio: cada instância é um navegador diferente. */
export class Client {
  cookie = '';
  ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  constructor(
    private readonly env: Pick<TestEnv, 'base'>,
    private readonly opts: { origin?: string | null; csrf?: boolean } = {},
  ) {}
  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h: Record<string, string> = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    h['x-forwarded-for'] ??= this.ip;
    if (body !== undefined) h['content-type'] ??= 'application/json';
    if (method !== 'GET' && this.opts.csrf !== false) h['x-irontrack-csrf'] ??= '1';
    if (this.opts.origin !== null) h.origin ??= this.opts.origin ?? APP_ORIGIN;
    const res = await fetch(`${this.env.base}${path}`, { method, headers: h, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (/Max-Age=0/.test(c) || !value) this.cookie = '';
      else this.cookie = `${name}=${value}`;
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }
  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, b?: unknown) => this.req<T>('POST', p, b ?? {});
}

let counter = 0;
export const uniqueEmail = (tag = 'pessoa') => `${tag}.${Date.now().toString(36)}${(counter++).toString(36)}@exemplo.test`;

export async function signup(env: TestEnv, name = 'Pessoa Teste', email = uniqueEmail()): Promise<{ client: Client; account: any; email: string }> {
  const client = new Client(env);
  const r = await client.post('/api/v1/auth/signup', { name, email, password: STRONG, acceptTerms: true });
  if (r.status !== 201) throw new Error(`cadastro falhou: ${r.status} ${JSON.stringify(r.body)}`);
  return { client, account: r.body.account, email };
}

export const linkToken = (text: string): string => {
  const m = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!m) throw new Error('link sem token');
  return decodeURIComponent(m[1]);
};

export const uuid4 = () => crypto.randomUUID();
