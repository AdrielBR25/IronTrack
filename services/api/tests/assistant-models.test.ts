// Fase 07: um modelo que a chave não tem liberado (404 no "Testar", consulta sem custo) deixa de ser o padrão; o app
// passa a usar o próximo modelo disponível em vez de insistir no indisponível.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../ai-gateway/src/providers/types.ts';
import { setupApi, signup, type TestEnv } from './helpers.ts';

const KEY = 'sk-proj-chave-de-teste-0123456789abcdef';
const BASE_CONFIG = (await import('../config/assistant.json', { with: { type: 'json' } })).default;
const calls: string[] = [];
const fetchFn: FetchLike = async (url, init) => {
  calls.push(`${init.method} ${url}`);
  const m = /\/v1\/models\/([^/]+)$/.exec(String(url));
  if (m) {
    const id = decodeURIComponent(m[1]!);
    return new Response(JSON.stringify(id === 'gpt-6.1-terra' ? { error: { code: 'model_not_found' } } : { id, object: 'model' }), { status: id === 'gpt-6.1-terra' ? 404 : 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 500 });
};

let env: TestEnv;
beforeAll(async () => {
  env = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { serviceEnv: { OPENAI_API_KEY: KEY, ASSISTANT_CONFIG_JSON: JSON.stringify({ ...BASE_CONFIG, baseUrl: 'http://openai.invalid' }) }, assistant: { fetch: fetchFn } });
});
afterAll(async () => {
  await env?.close();
});

describe('modelo padrão indisponível', () => {
  it('depois do Testar (sem custo), o padrão passa para o próximo modelo liberado e o indisponível some da lista', async () => {
    const { client } = await signup(env);
    expect((await client.get('/api/v1/assistant/status')).body.defaultModel).toBe('gpt-6.1-terra');
    const t = await client.post('/api/v1/assistant/test', { model: 'gpt-6.1-terra' });
    expect(t.body).toMatchObject({ result: 'model_unavailable', paid: false });
    const ok = await client.post('/api/v1/assistant/test', { model: 'gpt-6-luna' });
    expect(ok.body).toMatchObject({ result: 'ok', paid: false });
    const st = (await client.get('/api/v1/assistant/status')).body;
    expect(st.defaultModel).toBe('gpt-6-luna');
    expect(st.models.map((m: { id: string }) => m.id)).not.toContain('gpt-6.1-terra');
    // só consultas GET /v1/models (gratuitas); nenhuma geração
    expect(calls.every((c) => c.startsWith('GET ') && c.includes('/v1/models/'))).toBe(true);
  });
});
