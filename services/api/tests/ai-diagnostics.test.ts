// Hotfix 21.2: IA real com a Anthropic pela conta, com o adaptador DE VERDADE (anthropicAdapter) e respostas HTTP
// simuladas no formato da API oficial (sem rede, sem custo). Cobre os estados do diagnóstico (chave ausente, formato
// errado, não testada, ok, recusada, faturamento, limite, modelo, rede), o "Testar" sem custo, autenticação, e-mail
// confirmado, CSRF, limites e que nenhuma chave, pergunta ou resposta aparece em respostas JSON ou logs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../../ai-gateway/src/providers/anthropic.ts';
import type { FetchLike } from '../../ai-gateway/src/providers/types.ts';
import { Client, linkToken, setupApi, signup, type TestEnv } from './helpers.ts';

const KEY = 'sk-ant-api03-chave-de-teste-secreta-000000000000';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiErr = (type: string, message = 'detalhe interno do provedor XYZ-987') => ({ type: 'error', error: { type, message }, request_id: 'req_teste' });

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
/** Provedor simulado com roteiro: cada teste define o que /v1/messages e /v1/models/{id} respondem. */
function scripted() {
  const calls: Call[] = [];
  let messages: (c: Call) => Response | Promise<Response> = () => json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Resposta real simulada.' }], stop_reason: 'end_turn', usage: { input_tokens: 21, output_tokens: 7 } });
  let models: (c: Call, id: string) => Response | Promise<Response> = (_c, id) => json(200, { type: 'model', id, display_name: id, created_at: '2026-10-01T00:00:00Z' });
  const fetch: FetchLike = async (url, init) => {
    const c: Call = { url, method: init.method, headers: init.headers, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(c);
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname === '/v1/messages') return messages(c);
    const m = /^\/v1\/models\/([^/]+)$/.exec(u.pathname);
    if (init.method === 'GET' && m) return models(c, decodeURIComponent(m[1]));
    return json(404, apiErr('not_found_error'));
  };
  return {
    calls,
    fetch,
    onMessages: (f: typeof messages) => (messages = f),
    onModels: (f: typeof models) => (models = f),
  };
}

async function verified(e: TestEnv) {
  const s = await signup(e);
  await new Client(e).post('/api/v1/auth/verify-email', { token: linkToken(e.mailbox.for(s.email)[0].text) });
  return s;
}

const ask = (c: Client, model = 'claude-haiku-5-5', text = 'Pergunta pessoal sobre meu supino') =>
  c.post('/api/v1/ai/generate', { provider: 'anthropic', model, messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: text }], maxOutputTokens: 300 });
const test = (c: Client, model?: string) => c.post('/api/v1/ai/test', { provider: 'anthropic', ...(model ? { model } : {}) });
const status = async (c: Client) => {
  const p = (await c.get('/api/v1/ai/models')).body.providers[0];
  return { status: p.status as string, available: p.available as boolean, models: Object.fromEntries((p.models as { id: string; status: string }[]).map((m) => [m.id, m.status])) };
};

describe('Anthropic de ponta a ponta (adaptador real, HTTP simulado)', () => {
  const p = scripted();
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupApi({}, { adapter: anthropicAdapter, providerKey: KEY, fetch: p.fetch });
  });
  afterAll(async () => {
    await env?.close();
  });

  it('chave configurada e não testada → "unverified"; nenhuma chamada ao provedor só por abrir a tela', async () => {
    const { client } = await verified(env);
    expect(await status(client)).toEqual({ status: 'unverified', available: true, models: { 'claude-haiku-5-5': 'unverified', 'claude-sonnet-5-5': 'unverified' } });
    expect(p.calls).toHaveLength(0);
    expect(env.api.aiStatus().join('\n')).toMatch(/ANTHROPIC_API_KEY configurada; ainda não validada/);
    expect(env.api.aiStatus().join('\n')).not.toContain(KEY);
  });

  it('Testar: consulta SEM custo (GET /v1/models/{id}), chave no cabeçalho só para a Anthropic; provedor e modelo confirmados', async () => {
    const { client } = await verified(env);
    const before = p.calls.length;
    const r = await test(client, 'claude-sonnet-5-5');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', result: 'ok', status: 'ok', modelStatus: 'ok', paid: false });
    const call = p.calls[before];
    expect(call).toMatchObject({ method: 'GET', url: 'https://api.anthropic.com/v1/models/claude-sonnet-5-5', body: null });
    expect(call.headers['x-api-key']).toBe(KEY);
    expect(call.headers['anthropic-version']).toBe('2026-10-21');
    expect(p.calls.filter((c) => c.url.endsWith('/v1/messages'))).toHaveLength(0);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect((await status(client)).status).toBe('ok');
  });

  it('pergunta real: corpo da Messages API correto (modelo, max_tokens, system, raciocínio e esforço do servidor) e resposta exibível', async () => {
    const { client } = await verified(env);
    const before = p.calls.length;
    const r = await ask(client, 'claude-haiku-5-5');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5', output: { type: 'text', text: 'Resposta real simulada.' }, finishReason: 'stop', usage: { inputTokens: 21, outputTokens: 7 } });
    const call = p.calls[before];
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 300,
      thinking: { type: 'disabled' },
      output_config: { effort: 'medium' },
      system: 'Sistema',
      messages: [{ role: 'user', content: 'Pergunta pessoal sobre meu supino' }],
    });
    expect(call.body).not.toHaveProperty('temperature');
    // Sonnet 5.5: `between_tools` (o `disabled` daria 400)
    await ask(client, 'claude-sonnet-5-5');
    expect(p.calls.at(-1)!.body).toMatchObject({ model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } });
    // nada da pergunta ou da resposta nos logs nem nos eventos de uso
    expect(env.logs.join('\n')).not.toMatch(/supino|Resposta real simulada/);
    const ev = await env.pool.query('SELECT * FROM ai_usage_events');
    expect(JSON.stringify(ev.rows)).not.toMatch(/supino|Resposta real simulada/);
  });

  it('cliente não escolhe destino, cabeçalho nem campos extras; modelo fora da lista recusado sem chamar o provedor', async () => {
    const { client } = await verified(env);
    const before = p.calls.length;
    const extra = await client.post('/api/v1/ai/generate', { provider: 'anthropic', model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'oi' }], maxOutputTokens: 10, baseUrl: 'https://atacante.invalid' });
    expect(extra.body.error.code).toBe('request_invalid');
    expect((await ask(client, 'claude-3-opus-20240229')).body.error.code).toBe('model_not_allowed');
    expect((await client.post('/api/v1/ai/test', { provider: 'anthropic', url: 'https://atacante.invalid' })).body.error.code).toBe('request_invalid');
    expect((await test(client, 'modelo-inexistente')).body.error.code).toBe('model_not_allowed');
    expect((await client.post('/api/v1/ai/generate', { provider: 'anthropic', model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'oi' }], maxOutputTokens: 5000 })).body.error.code).toBe('request_invalid');
    expect(p.calls.length).toBe(before);
  });
});

describe('estados de erro do provedor, um a um', () => {
  const p = scripted();
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupApi({}, { adapter: anthropicAdapter, providerKey: KEY, fetch: p.fetch });
  });
  afterAll(async () => {
    await env?.close();
  });

  it('faturamento (402 billing_error ou 400 de saldo): código próprio, sem o texto do provedor; Testar sem custo não o esconde', async () => {
    const { client } = await verified(env);
    p.onMessages(() => json(400, apiErr('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')));
    const r = await ask(client);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('provider_billing');
    expect(JSON.stringify(r.body)).not.toMatch(/credit balance|XYZ-987/);
    expect((await status(client)).status).toBe('billing');
    p.onMessages(() => json(402, apiErr('billing_error')));
    expect((await ask(client)).body.error.code).toBe('provider_billing');
    // o teste sem custo confirma a chave e o modelo, mas não os créditos: o estado continua "billing"
    expect((await test(client)).body).toMatchObject({ result: 'ok', status: 'billing', modelStatus: 'ok' });
    // só uma resposta real aceita tira o aviso
    p.onMessages(() => json(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    expect((await ask(client)).status).toBe(200);
    expect((await status(client)).status).toBe('ok');
    // a cota de tokens só conta a resposta aceita (as recusadas não consomem)
    const usage = await client.get('/api/v1/ai/usage');
    expect(usage.body.tokensUsed).toBe(2);
  });

  it('limite da conta no provedor (429 rate_limit_error) → provider_rate_limited e estado "rate_limited"', async () => {
    const { client } = await verified(env);
    p.onMessages(() => json(429, apiErr('rate_limit_error')));
    const r = await ask(client);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('provider_rate_limited');
    expect((await status(client)).status).toBe('rate_limited');
  });

  it('modelo inexistente ou não liberado (404 not_found_error): só aquele modelo fica indisponível', async () => {
    const { client } = await verified(env);
    p.onModels((_c, id) => (id === 'claude-sonnet-5-5' ? json(404, apiErr('not_found_error', `model: ${id}`)) : json(200, { type: 'model', id })));
    const r = await test(client, 'claude-sonnet-5-5');
    expect(r.body).toMatchObject({ result: 'model_unavailable', modelStatus: 'unavailable' });
    p.onMessages(() => json(404, apiErr('not_found_error')));
    expect((await ask(client, 'claude-sonnet-5-5')).body.error.code).toBe('model_unavailable');
    const st = await status(client);
    expect(st.models['claude-sonnet-5-5']).toBe('unavailable');
    expect(st.available).toBe(true);
    // o outro modelo continua utilizável e, ao responder, confirma provedor e modelo
    p.onMessages(() => json(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    expect((await ask(client, 'claude-haiku-5-5')).status).toBe(200);
    expect(await status(client)).toMatchObject({ status: 'ok', models: { 'claude-haiku-5-5': 'ok', 'claude-sonnet-5-5': 'unavailable' } });
  });

  it('falha de rede e tempo esgotado → estado "network"; nenhuma nova tentativa', async () => {
    const { client } = await verified(env);
    p.onMessages(() => {
      throw new TypeError('fetch failed ECONNRESET');
    });
    const before = p.calls.length;
    const r = await ask(client);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('provider_unreachable');
    expect(p.calls.length).toBe(before + 1);
    expect((await status(client)).status).toBe('network');
  });

  it('chave inválida ou revogada (401): provedor indisponível para todos até um teste aceito; a chave nunca aparece', async () => {
    const { client } = await verified(env);
    p.onMessages(() => json(401, apiErr('authentication_error', 'invalid x-api-key')));
    const r = await ask(client);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('provider_auth_failed');
    expect(await status(client)).toMatchObject({ status: 'auth_failed', available: false });
    // outra conta: recusada sem chamar o provedor de novo
    const other = await verified(env);
    const before = p.calls.length;
    expect((await ask(other.client)).body.error.code).toBe('provider_auth_failed');
    expect(p.calls.length).toBe(before);
    // Testar com a chave recusada: confirma a recusa
    p.onModels(() => json(401, apiErr('authentication_error')));
    expect((await test(client)).body).toMatchObject({ result: 'provider_auth_failed', status: 'auth_failed' });
    // a Anthropic volta a aceitar (ex.: chave reativada): o teste libera de novo
    p.onModels((_c, id) => json(200, { type: 'model', id }));
    expect((await test(client)).body).toMatchObject({ result: 'ok', status: 'ok' });
    expect((await status(client)).available).toBe(true);
    expect(env.logs.join('\n')).not.toContain(KEY);
  });

  it('Testar é limitado por conta (5 por minuto)', async () => {
    const { client } = await verified(env);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await test(client)).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('autenticação, e-mail confirmado, CSRF e chave ausente ou malformada', () => {
  it('sem sessão: 401 no catálogo, no teste e na geração; sem e-mail confirmado: 403 email_not_verified; sem CSRF: 403', async () => {
    const p = scripted();
    const env = await setupApi({}, { adapter: anthropicAdapter, providerKey: KEY, fetch: p.fetch });
    try {
      const anon = new Client(env);
      expect((await anon.get('/api/v1/ai/models')).status).toBe(401);
      expect((await test(anon)).status).toBe(401);
      expect((await ask(anon)).status).toBe(401);
      const { client } = await signup(env);
      const t = await test(client);
      expect(t.status).toBe(403);
      expect(t.body.error.code).toBe('email_not_verified');
      expect((await ask(client)).body.error.code).toBe('email_not_verified');
      const v = await verified(env);
      const noCsrf = new Client(env, { csrf: false });
      noCsrf.cookie = v.client.cookie;
      expect((await test(noCsrf)).status).toBe(403);
      expect(p.calls).toHaveLength(0);
    } finally {
      await env.close();
    }
  });

  it('valor que não é uma chave de API (chave de administração, texto com aspas): "invalid_key_format", sem chamar a Anthropic', async () => {
    for (const bad of ['sk-ant-admin01-chave-de-administracao-000000', '"sk-ant-api03-com-aspas-000000000000"', 'minha-chave-123456']) {
      const p = scripted();
      const env = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { adapter: anthropicAdapter, providerKey: bad, fetch: p.fetch });
      try {
        const { client } = await signup(env);
        expect(await status(client)).toMatchObject({ status: 'invalid_key_format', available: false });
        expect((await test(client)).body).toMatchObject({ result: 'provider_unavailable', status: 'invalid_key_format' });
        expect((await ask(client)).body.error.code).toBe('provider_unavailable');
        expect(p.calls).toHaveLength(0);
        expect(env.api.aiStatus().join('\n')).toContain('não tem o formato de uma chave de API');
        expect(env.api.aiStatus().join('\n')).not.toContain(bad);
        expect(JSON.stringify((await client.get('/api/v1/ai/models')).body)).not.toContain(bad);
      } finally {
        await env.close();
      }
    }
  });

  it('chave ausente: "missing_key", Testar responde sem rede e o log de inicialização orienta a configurar ANTHROPIC_API_KEY', async () => {
    const p = scripted();
    const env = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { adapter: anthropicAdapter, providerKey: null, fetch: p.fetch });
    try {
      const { client } = await signup(env);
      expect(await status(client)).toMatchObject({ status: 'missing_key', available: false });
      expect((await test(client)).body).toMatchObject({ result: 'provider_unavailable', status: 'missing_key' });
      expect(p.calls).toHaveLength(0);
      expect(env.api.aiStatus()[0]).toMatch(/Anthropic Claude — variável ANTHROPIC_API_KEY AUSENTE neste serviço/);
    } finally {
      await env.close();
    }
  });
});
