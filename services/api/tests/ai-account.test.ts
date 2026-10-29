import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, fakeAnthropic, linkToken, setupApi, signup, type TestEnv } from './helpers.ts';

const KEY = 'sk-ant-teste-chave-secreta-0000000000';
let env: TestEnv;
beforeAll(async () => {
  env = await setupApi({ AI_DAILY_REQUESTS_PER_USER: '3' });
});
afterAll(async () => {
  await env?.close();
});

const ask = (c: Client, text = 'Quantos treinos fiz?') => c.post('/api/v1/ai/generate', { provider: 'anthropic', model: 'claude-haiku-5-5', messages: [{ role: 'user', content: text }], maxOutputTokens: 200 });

async function verified(e: TestEnv) {
  const s = await signup(e);
  await new Client(e).post('/api/v1/auth/verify-email', { token: linkToken(e.mailbox.for(s.email)[0].text) });
  return s;
}

describe('IA pela conta', () => {
  it('sem sessão: 401; catálogo mostra só provedores habilitados e se têm chave', async () => {
    expect((await new Client(env).get('/api/v1/ai/models')).status).toBe(401);
    const { client } = await signup(env);
    const cat = await client.get('/api/v1/ai/models');
    expect(cat.body.providers).toEqual([{ id: 'anthropic', displayName: 'Anthropic Claude', available: true, models: [{ id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', maxInputChars: 24000, maxOutputTokens: 1024 }] }]);
    expect(JSON.stringify(cat.body)).not.toContain(KEY);
    const conf = await client.get('/api/v1/config');
    expect(conf.body.features.ai).toBe(true);
  });

  it('exige e-mail verificado (padrão) e depois responde pelo provedor', async () => {
    const { client } = await signup(env);
    const blocked = await ask(client);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_not_verified');
    const v = await verified(env);
    const r = await ask(v.client);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', output: { type: 'text', text: 'Resposta simulada do provedor.' }, finishReason: 'stop' });
  });

  it('cota diária por conta persistida no PostgreSQL; consumo visível; nenhum conteúdo gravado', async () => {
    const v = await verified(env);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await ask(v.client, `pergunta secreta ${i}`)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    const usage = await v.client.get('/api/v1/ai/usage');
    expect(usage.body).toMatchObject({ requestsUsed: 3, tokensUsed: 150, dailyRequests: 3 });
    const events = await env.pool.query('SELECT * FROM ai_usage_events WHERE user_id = $1', [v.account.id]);
    expect(events.rows.length).toBe(4);
    expect(JSON.stringify(events.rows)).not.toContain('pergunta secreta');
    expect(env.logs.join('\n')).not.toContain('pergunta secreta');
    // outra conta tem a própria cota
    const w = await verified(env);
    expect((await ask(w.client)).status).toBe(200);
  });

  it('valida o contrato: provedor/modelo fora da lista, campos extras', async () => {
    const v = await verified(env);
    expect((await v.client.post('/api/v1/ai/generate', { provider: 'openai', model: 'x', messages: [{ role: 'user', content: 'oi' }], maxOutputTokens: 10 })).body.error.code).toBe('provider_not_allowed');
    expect((await v.client.post('/api/v1/ai/generate', { provider: 'anthropic', model: 'outro', messages: [{ role: 'user', content: 'oi' }], maxOutputTokens: 10 })).body.error.code).toBe('model_not_allowed');
    expect((await v.client.post('/api/v1/ai/generate', { provider: 'anthropic', model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'oi' }], maxOutputTokens: 10, baseUrl: 'https://x' })).body.error.code).toBe('request_invalid');
  });
});

describe('sem chave do provedor', () => {
  it('provedor aparece indisponível e a geração não acontece', async () => {
    const e = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { providerKey: null, adapter: fakeAnthropic() });
    try {
      const { client } = await signup(e);
      const cat = await client.get('/api/v1/ai/models');
      expect(cat.body.providers[0].available).toBe(false);
      expect((await client.get('/api/v1/config')).body.features.ai).toBe(false);
      const r = await ask(client);
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('provider_unavailable');
    } finally {
      await e.close();
    }
  });
});
