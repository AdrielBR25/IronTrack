// Utilitários dos testes do gateway. Tokens e chaves são gerados NA EXECUÇÃO (nada fixo no repositório).
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { sha256Hex } from '../src/auth.ts';
import { createGateway, type GatewayLogEvent, type GatewayOptions } from '../src/gateway.ts';
import type { FetchLike } from '../src/providers/types.ts';

export const newToken = () => randomBytes(32).toString('base64url');
/** Chave falsa de provedor, aleatória a cada execução, com formato parecido com o real. */
export const fakeKey = (prefix: string) => `${prefix}${randomBytes(24).toString('hex')}`;

export const MODEL = { id: 'test-model-1', displayName: 'Modelo de teste', maxInputChars: 8_000, maxOutputTokens: 512 };

export function testConfig(token: string, over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: ['http://localhost:4173'],
    clients: [{ id: 'tester', tokenSha256: sha256Hex(token), enabled: true }],
    limits: { requestsPerMinute: 100, dailyTokenBudget: 100_000, upstreamTimeoutMs: 2_000 },
    providers: {
      openai: { enabled: true, displayName: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', models: [MODEL] },
      anthropic: { enabled: true, displayName: 'Anthropic Claude', apiKeyEnv: 'ANTHROPIC_API_KEY', apiVersion: '2026-10-21', models: [MODEL] },
      gemini: { enabled: true, displayName: 'Google Gemini', apiKeyEnv: 'GEMINI_API_KEY', models: [MODEL] },
    },
    ...over,
  };
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const openaiOk = (text = 'Resposta de teste.') => ({
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: { input_tokens: 40, output_tokens: 8 },
});

export interface Started {
  base: string;
  logs: GatewayLogEvent[];
  calls: { url: string; init: Parameters<FetchLike>[1] }[];
  gw: ReturnType<typeof createGateway>;
  close: () => Promise<void>;
}

/** Sobe o gateway numa porta livre do loopback. `upstream` responde no lugar do provedor. */
export async function start(opts: Partial<GatewayOptions> & { upstream?: FetchLike } = {}): Promise<Started> {
  const logs: GatewayLogEvent[] = [];
  const calls: Started['calls'] = [];
  const upstream = opts.upstream ?? (async () => json(200, openaiOk()));
  const gw = createGateway({
    config: opts.config,
    env: opts.env ?? {},
    logger: (e) => logs.push(e),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return upstream(url, init);
    },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
  });
  await new Promise<void>((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    calls,
    gw,
    close: () =>
      new Promise((r) => {
        gw.server.closeAllConnections();
        gw.server.close(() => r());
      }),
  };
}

export const genBody = (over: Record<string, unknown> = {}) => ({
  provider: 'openai',
  model: MODEL.id,
  messages: [
    { role: 'system', content: 'Instrução fixa do app.' },
    { role: 'user', content: 'Pergunta de teste.' },
  ],
  maxOutputTokens: 256,
  ...over,
});

export function post(base: string, token: string | null, body: unknown, extra: RequestInit = {}) {
  return fetch(`${base}/v1/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extra.headers as Record<string, string> | undefined) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
}

/** Resposta que só termina quando o sinal aborta (provedor que não responde). */
export const hang: FetchLike = (_url, init) =>
  new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
