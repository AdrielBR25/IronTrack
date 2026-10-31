// Servidor dos testes E2E da nuvem (Prompt 21): banco PostgreSQL NOVO a cada execução (a partir de TEST_DATABASE_URL),
// migrações pelo executor de produção, provedor de IA SIMULADO em HTTP local (formato da API da Anthropic) e caixa de
// e-mail de teste (exposta só com API_TEST_MODE). Nunca use um banco de produção aqui: o banco é criado e descartado.
// Uso: node e2e-cloud/server.ts  (Node 22.18+). Porta da API: E2E_API_PORT (padrão 8788).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApi } from '../services/api/src/app.ts';
import { loadConfig } from '../services/api/src/config.ts';
import { createPool } from '../services/api/src/db/pool.ts';
import { migrate } from '../services/api/src/db/migrate.ts';

const admin = process.env.TEST_DATABASE_URL;
if (!admin) throw new Error('Defina TEST_DATABASE_URL (PostgreSQL local ou do CI).');
if (/railway|rlwy/i.test(admin)) throw new Error('TEST_DATABASE_URL parece ser do Railway: testes E2E só em banco descartável.');

const API_PORT = Number(process.env.E2E_API_PORT ?? 8788);
const APP_ORIGIN = process.env.E2E_APP_ORIGIN ?? 'http://localhost:4174';

// Provedor simulado: responde como a API de mensagens da Anthropic (sem rede externa).
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // Hotfix 21.2: consulta de modelo (diagnóstico sem custo do "Testar"). O Sonnet simula um modelo não liberado.
    const model = /^\/v1\/models\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && model && req.headers['x-api-key'] && req.headers['anthropic-version'] === '2026-10-21') {
      const id = decodeURIComponent(model[1]);
      res.writeHead(id === 'claude-haiku-5-5' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(id === 'claude-haiku-5-5' ? { type: 'model', id, display_name: 'Claude Haiku 5.5' } : { type: 'error', error: { type: 'not_found_error', message: `model: ${id}` } }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/messages' || !req.headers['x-api-key']) {
      res.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body) as { messages?: { content: unknown }[] };
    const n = JSON.stringify(parsed.messages ?? []).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_teste', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: `Resposta do provedor simulado (${n} caracteres recebidos).` }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 12 } }));
  });
});
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', () => r()));
const pa = provider.address();
const providerBase = `http://127.0.0.1:${pa && typeof pa === 'object' ? pa.port : 0}`;

const dbName = `e2e_${randomBytes(5).toString('hex')}`;
const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
await adminPool.query(`CREATE DATABASE ${dbName}`);
const url = new URL(admin);
url.pathname = `/${dbName}`;

const aiConfig = {
  enabled: true,
  clients: [],
  limits: { maxBodyBytes: 65536, maxMessages: 6, maxInputChars: 24000, maxOutputTokens: 1024, requestsPerMinute: 30, dailyTokenBudget: 20000, maxConcurrentPerClient: 1, maxConcurrentTotal: 4, upstreamTimeoutMs: 10000, maxUpstreamResponseBytes: 262144 },
  providers: {
    anthropic: {
      enabled: true,
      displayName: 'Anthropic Claude',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      apiVersion: '2026-10-21',
      baseUrl: providerBase,
      models: [
        { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', maxInputChars: 24000, maxOutputTokens: 1024, effort: 'medium', thinking: 'disabled' },
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', maxInputChars: 24000, maxOutputTokens: 1024, effort: 'medium', thinking: 'between_tools' },
      ],
    },
    openai: { enabled: false, displayName: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'modelo-x', displayName: 'X', maxInputChars: 24000, maxOutputTokens: 1024 }] },
  },
};

const env: Record<string, string> = {
  NODE_ENV: 'test',
  API_TEST_MODE: '1',
  DATABASE_URL: url.toString(),
  DATABASE_SSL: 'disable',
  APP_ORIGIN,
  RATE_LIMIT_SECRET: randomBytes(32).toString('hex'),
  COOKIE_SECURE: 'false',
  EMAIL_PROVIDER: 'test-mailbox',
  AI_CONFIG_JSON: JSON.stringify(aiConfig),
  AI_DAILY_REQUESTS_PER_USER: '4',
  // o proxy na frente (vite preview ou o Caddy do irontrack-web) acrescenta um IP; cada navegador do teste informa um IP
  // próprio no X-Forwarded-For (papel da borda da Railway). Limites por IP separados por navegador.
  TRUST_PROXY_HOPS: '2',
  ACCESS_LOG: 'off',
  // chave fictícia, só para o provedor simulado local
  ANTHROPIC_API_KEY: `sk-ant-api03-e2e-${randomBytes(12).toString('hex')}`,
};
const cfg = loadConfig(env);
const pool = createPool(cfg);
await migrate(pool);
const api = createApi({ cfg, pool, env });
await new Promise<void>((r) => api.server.listen(API_PORT, '127.0.0.1', () => r()));
process.stderr.write(`[e2e-cloud] API em 127.0.0.1:${API_PORT}, banco ${dbName}\n`);

async function stop() {
  await api.shutdown(2000).catch(() => undefined);
  await pool.end().catch(() => undefined);
  provider.close();
  await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  await adminPool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
