// Servidor dos testes E2E da nuvem (Prompt 21): banco PostgreSQL NOVO a cada execução (a partir de TEST_DATABASE_URL),
// migrações pelo executor de produção, provedor de IA SIMULADO em HTTP local (formato da API da Anthropic) e caixa de
// e-mail de teste (exposta só com API_TEST_MODE). Nunca use um banco de produção aqui: o banco é criado e descartado.
// Uso: node e2e-cloud/server.ts  (Node 22.18+). Porta da API: E2E_API_PORT (padrão 8788).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    // Fase 00: OpenAI simulada (Responses API com streaming e ferramentas) para o assistente central.
    if (req.url === '/openai/v1/responses' && req.method === 'POST' && req.headers.authorization?.startsWith('Bearer sk-proj-e2e')) {
      const parsed = JSON.parse(body);
      // Fase 03: análise de foto (saída estruturada, sem streaming). Prato fixo: arroz, feijão, frango, alface e um molho
      // que não dá para identificar (precisa de revisão).
      if (parsed.text?.format?.type === 'json_schema') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'resp_v', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(E2E_PLATE) }] }], usage: { input_tokens: 1200, output_tokens: 250 } }));
        return;
      }
      openAiReply(parsed, res);
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

const E2E_PLATE = {
  contem_comida: true,
  qualidade_imagem: 'boa',
  itens: [
    { nome: 'arroz branco', termos_busca: ['arroz tipo 1 cozido'], preparo: 'cozido', papel: 'principal', quantidade: 150, quantidade_min: 120, quantidade_max: 180, unidade: 'g', confianca: 'alta', observacao: null },
    { nome: 'feijão carioca', termos_busca: ['feijão carioca cozido'], preparo: 'cozido', papel: 'principal', quantidade: 120, quantidade_min: 100, quantidade_max: 140, unidade: 'g', confianca: 'alta', observacao: null },
    { nome: 'peito de frango', termos_busca: ['frango peito grelhado'], preparo: 'grelhado', papel: 'principal', quantidade: 160, quantidade_min: 130, quantidade_max: 190, unidade: 'g', confianca: 'media', observacao: null },
    { nome: 'alface', termos_busca: ['alface crua'], preparo: 'cru', papel: 'acompanhamento', quantidade: 40, quantidade_min: 20, quantidade_max: 60, unidade: 'g', confianca: 'media', observacao: null },
    { nome: 'molho da casa', termos_busca: ['molho especial e2e'], preparo: 'nao_identificado', papel: 'molho', quantidade: null, quantidade_min: null, quantidade_max: null, unidade: 'g', confianca: 'baixa', observacao: 'Base do molho incerta.' },
  ],
  observacoes_caloricas: ['O frango pode ter sido preparado com óleo.'],
  nao_identificado: [],
  resumo: 'Prato com arroz, feijão, frango grelhado e salada.',
};

/** "Modelo" roteirizado: pede uma ficha quando a pessoa pede, consulta a evolução quando perguntam do supino, senão responde texto. */
function openAiReply(body: { input: { role?: string; type?: string; content?: string; output?: string }[] }, res: import('node:http').ServerResponse) {
  const last = [...body.input].reverse().find((i) => i.role === 'user')?.content ?? '';
  const outputs = body.input.filter((i) => i.type === 'function_call_output');
  const out: unknown[] = [];
  let text = '';
  if (!outputs.length && /crie uma ficha/i.test(last)) {
    out.push({
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'propose_create_routine',
      arguments: JSON.stringify({
        name: 'Full body IA',
        rationale: 'Três treinos completos por semana.',
        workouts: [{ label: 'A', name: 'Corpo todo', exercises: [{ name: 'Agachamento livre', muscleGroup: 'Quadríceps', category: 'compound', equipment: 'barbell', sets: 3, repMin: 6, repMax: 8, restSec: 120 }] }],
      }),
    });
  } else if (!outputs.length && /supino/i.test(last)) {
    out.push({ type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'get_exercise_progress', arguments: JSON.stringify({ exercise: 'supino' }) });
  } else if (outputs.length) {
    const o = JSON.parse(outputs[outputs.length - 1].output ?? '{}');
    text = o.status === 'awaiting_user_approval' ? 'Preparei a proposta abaixo. **Revise e aprove** se fizer sentido.' : `Consultei seus registros: ${o.data?.matches?.length ? 'há dados de supino.' : 'não há treinos de supino registrados no período.'}`;
  } else text = 'Olá! Sou a **OpenAI simulada** do teste.';
  const events: unknown[] = [];
  if (text) {
    for (const part of text.match(/.{1,12}/g) ?? []) events.push({ type: 'response.output_text.delta', delta: part });
    out.push({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  events.push({ type: 'response.completed', response: { id: 'resp_e2e', status: 'completed', output: out, usage: { input_tokens: 50, output_tokens: 10 } } });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
}

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
  // Fase 00: assistente central com a OpenAI simulada local (chave fictícia).
  OPENAI_API_KEY: `sk-proj-e2e-${randomBytes(12).toString('hex')}`,
  ASSISTANT_CONFIG_JSON: JSON.stringify({ ...JSON.parse(readFileSync(new URL('../services/api/config/assistant.json', import.meta.url), 'utf8')), baseUrl: `${providerBase}/openai` }),
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
