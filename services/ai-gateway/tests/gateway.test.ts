// Gateway: autenticação, autorização, allowlists, limites, tempo limite, cancelamento, erros
// normalizados, ausência de vazamento de credenciais e de dados pessoais nos logs, falha segura.
// Toda chamada ao provedor é simulada (sem rede externa e sem custo).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryUsageStore } from '../src/limits.ts';
import { MODEL, fakeKey, genBody, hang, json, newToken, openaiOk, post, start, testConfig, type Started } from './helpers.ts';

let s: Started | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.useRealTimers();
});

const TOKEN = newToken();
const OPENAI_KEY = fakeKey('sk-test-');
const env = { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: fakeKey('sk-ant-'), GEMINI_API_KEY: fakeKey('AIza') };
const boot = (o: Parameters<typeof start>[0] = {}) => start({ config: testConfig(TOKEN), env, ...o });
const err = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

describe('autenticação e autorização', () => {
  it('1. sem credencial: 401, provedor não é chamado', async () => {
    s = await boot();
    const r = await post(s.base, null, genBody());
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect((await err(r)).code).toBe('unauthorized');
    expect((await fetch(`${s.base}/v1/models`)).status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  it('2. credencial inválida (token errado, formato errado, titular desativado): 401', async () => {
    const disabled = newToken();
    const cfg = testConfig(TOKEN);
    const { sha256Hex } = await import('../src/auth.ts');
    cfg.clients.push({ id: 'off', tokenSha256: sha256Hex(disabled), enabled: false });
    s = await boot({ config: cfg });
    for (const auth of [`Bearer ${newToken()}`, `Basic ${TOKEN}`, `Bearer  ${TOKEN}`, TOKEN, `Bearer ${disabled}`, 'Bearer curto']) {
      const r = await fetch(`${s.base}/v1/generate`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(genBody()) });
      expect(r.status, auth.slice(0, 12)).toBe(401);
    }
    expect(s.calls).toHaveLength(0);
  });

  it('o UUID do perfil, a origem ou campos do corpo não autenticam', async () => {
    s = await boot();
    const r = await fetch(`${s.base}/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:4173', 'x-profile-id': '6f1c1d2e-0000-4000-8000-000000000000' },
      body: JSON.stringify({ ...genBody(), profileId: '6f1c1d2e-0000-4000-8000-000000000000', token: TOKEN }),
    });
    expect(r.status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  it('3. credencial válida: 200 com resposta normalizada; catálogo lista só o permitido', async () => {
    s = await boot();
    const models = await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(models.status).toBe(200);
    const cat = (await models.json()) as { protocol: string; providers: { id: string; available: boolean; models: { id: string }[] }[] };
    expect(cat.protocol).toBe('irontrack.ai-gateway.v1');
    expect(cat.providers.map((p) => p.id)).toEqual(['openai', 'anthropic', 'gemini']);
    expect(cat.providers.every((p) => p.available && p.models[0].id === MODEL.id)).toBe(true);

    const r = await post(s.base, TOKEN, genBody());
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ provider: 'openai', model: MODEL.id, output: { type: 'text', text: 'Resposta de teste.' }, finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 8 } });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe('https://api.openai.com/v1/responses');
  });

  it('4. provedor não permitido (desconhecido ou desabilitado): 403', async () => {
    const cfg = testConfig(TOKEN);
    (cfg.providers.gemini as { enabled: boolean }).enabled = false;
    s = await boot({ config: cfg });
    for (const provider of ['gemini', 'ollama', 'azure']) {
      const r = await post(s.base, TOKEN, genBody({ provider }));
      expect(r.status).toBe(403);
      expect((await err(r)).code).toBe('provider_not_allowed');
    }
    const cat = (await (await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { providers: { id: string }[] };
    expect(cat.providers.map((p) => p.id)).not.toContain('gemini');
    expect(s.calls).toHaveLength(0);
  });

  it('5. modelo fora da allowlist: 403', async () => {
    s = await boot();
    for (const model of ['gpt-qualquer', '../../v1/files', 'test-model-1/../x']) {
      const r = await post(s.base, TOKEN, genBody({ model }));
      expect(r.status).toBe(403);
      expect((await err(r)).code).toBe('model_not_allowed');
    }
    expect(s.calls).toHaveLength(0);
  });
});

describe('validação e limites', () => {
  it('6. entrada inválida: 400 (JSON quebrado, campos extras, papéis, ordem, tipos)', async () => {
    s = await boot();
    const bad: unknown[] = [
      '{nao-json',
      [],
      genBody({ extra: 1 }),
      genBody({ messages: [] }),
      genBody({ messages: [{ role: 'tool', content: 'x' }] }),
      genBody({ messages: [{ role: 'user', content: '' }] }),
      genBody({ messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }] }),
      genBody({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
      genBody({ messages: [{ role: 'user', content: 'a', name: 'x' }] }),
      genBody({ maxOutputTokens: 0 }),
      genBody({ maxOutputTokens: 1.5 }),
      genBody({ maxOutputTokens: 100_000 }),
    ];
    for (const b of bad) {
      const r = await post(s.base, TOKEN, b);
      expect(r.status, JSON.stringify(b).slice(0, 60)).toBe(400);
      expect((await err(r)).code).toBe('request_invalid');
    }
    const ct = await fetch(`${s.base}/v1/generate`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' }, body: JSON.stringify(genBody()) });
    expect(ct.status).toBe(400);
    expect(s.calls).toHaveLength(0);
  });

  it('7. entrada excessiva: corpo, número de mensagens e caracteres acima do limite → 413', async () => {
    s = await boot({ config: testConfig(TOKEN, { limits: { maxBodyBytes: 20_000, maxMessages: 3, requestsPerMinute: 100 } }) });
    const big = await post(s.base, TOKEN, genBody({ messages: [{ role: 'user', content: 'x'.repeat(30_000) }] }));
    expect(big.status).toBe(413);
    const many = await post(s.base, TOKEN, genBody({ messages: Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'oi' })).reverse() }));
    expect(many.status).toBe(413);
    const chars = await post(s.base, TOKEN, genBody({ messages: [{ role: 'user', content: 'y'.repeat(MODEL.maxInputChars + 1) }] }));
    expect(chars.status).toBe(413);
    expect((await err(chars)).code).toBe('payload_too_large');
    expect(s.calls).toHaveLength(0);
  });

  it('8. limite de consumo: cota diária por credencial (reserva antes, ajuste pelo consumo real)', async () => {
    const store = new MemoryUsageStore();
    s = await boot({ store, config: testConfig(TOKEN, { limits: { dailyTokenBudget: 700, requestsPerMinute: 100 } }) });
    // Reserva = ~10 tokens de entrada + 256 de saída; consumo real informado = 48.
    expect((await post(s.base, TOKEN, genBody())).status).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    expect(store.usage('tester', day)).toBe(48);
    expect((await post(s.base, TOKEN, genBody({ maxOutputTokens: 512 }))).status).toBe(200);
    // 48 + 48 usados; reservar mais 512+ excederia 700.
    const r = await post(s.base, TOKEN, genBody({ maxOutputTokens: 512, messages: [{ role: 'user', content: 'z'.repeat(800) }] }));
    expect(r.status).toBe(429);
    expect((await err(r)).code).toBe('quota_exceeded');
    expect(s.calls).toHaveLength(2);
  });

  it('cota por titular sobrescreve a global', async () => {
    const cfg = testConfig(TOKEN);
    (cfg.clients[0] as { dailyTokenBudget?: number }).dailyTokenBudget = 100;
    s = await boot({ config: cfg });
    expect((await post(s.base, TOKEN, genBody({ maxOutputTokens: 200 }))).status).toBe(429);
  });

  it('9. limite de requisições por minuto e de simultaneidade: 429', async () => {
    let t = 1_000_000;
    s = await boot({ now: () => t, config: testConfig(TOKEN, { limits: { requestsPerMinute: 2, maxConcurrentPerClient: 1 } }) });
    expect((await post(s.base, TOKEN, genBody())).status).toBe(200);
    expect((await post(s.base, TOKEN, genBody())).status).toBe(200);
    const r = await post(s.base, TOKEN, genBody());
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await err(r)).code).toBe('rate_limited');
    t += 60_000;
    expect((await post(s.base, TOKEN, genBody())).status).toBe(200);
    await s.close();

    // Simultaneidade: a segunda solicitação enquanto a primeira está pendurada.
    s = await boot({ upstream: hang, config: testConfig(TOKEN, { limits: { maxConcurrentPerClient: 1, upstreamTimeoutMs: 500, requestsPerMinute: 100 } }) });
    const first = post(s.base, TOKEN, genBody());
    await vi.waitFor(() => expect(s!.calls).toHaveLength(1));
    const second = await post(s.base, TOKEN, genBody());
    expect(second.status).toBe(429);
    expect((await first).status).toBe(504);
  });

  it('10. tempo limite: 504 timeout e o sinal do provedor é abortado', async () => {
    s = await boot({ upstream: hang, config: testConfig(TOKEN, { limits: { upstreamTimeoutMs: 150, requestsPerMinute: 100 } }) });
    const r = await post(s.base, TOKEN, genBody());
    expect(r.status).toBe(504);
    expect((await err(r)).code).toBe('timeout');
    expect(s.calls[0].init.signal.aborted).toBe(true);
  });

  it('tempo limite mesmo se o adaptador ignorar o sinal', async () => {
    s = await boot({
      config: testConfig(TOKEN, { limits: { upstreamTimeoutMs: 150, requestsPerMinute: 100 } }),
      adapters: { openai: { id: 'openai', defaultBaseUrl: 'https://api.openai.com', generate: () => new Promise(() => {}) } },
    });
    expect((await post(s.base, TOKEN, genBody())).status).toBe(504);
  });

  it('11. cancelamento: o cliente desconecta e a chamada ao provedor é abortada', async () => {
    s = await boot({ upstream: hang, config: testConfig(TOKEN, { limits: { upstreamTimeoutMs: 5_000, requestsPerMinute: 100 } }) });
    const ctrl = new AbortController();
    const p = post(s.base, TOKEN, genBody(), { signal: ctrl.signal });
    await vi.waitFor(() => expect(s!.calls).toHaveLength(1));
    ctrl.abort();
    await expect(p).rejects.toThrow();
    await vi.waitFor(() => expect(s!.calls[0].init.signal.aborted).toBe(true));
    await vi.waitFor(() => expect(s!.logs.some((l) => l.code === 'cancelled' && l.status === 499)).toBe(true));
  });
});

describe('falhas e normalização', () => {
  it('12. falha do provedor (5xx, 429, rede): 502 sem repetir e sem o texto do provedor', async () => {
    for (const upstream of [async () => json(500, { error: { message: 'detalhe interno XYZ-123' } }), async () => json(429, { error: { message: 'rate XYZ-123' } }), async () => { throw new TypeError('ECONNRESET XYZ-123'); }]) {
      s = await boot({ upstream });
      const r = await post(s.base, TOKEN, genBody());
      const text = await r.text();
      expect(r.status).toBe(502);
      expect(JSON.parse(text).error.code).toBe('provider_failure');
      expect(text).not.toContain('XYZ-123');
      expect(s.calls).toHaveLength(1);
      await s.close();
      s = undefined;
    }
  });

  it('chave recusada pelo provedor (401): 503 provider_unavailable', async () => {
    s = await boot({ upstream: async () => json(401, { error: { message: 'bad key' } }) });
    const r = await post(s.base, TOKEN, genBody());
    expect(r.status).toBe(503);
    expect((await err(r)).code).toBe('provider_unavailable');
  });

  it('13. resposta inválida: corpo não JSON, formato inesperado, vazia ou grande demais → 502', async () => {
    const cases = [
      async () => new Response('<html>oops</html>', { status: 200 }),
      async () => json(200, { output: 'texto' }),
      async () => json(200, { status: 'completed', output: [] }),
      async () => json(200, openaiOk('x'.repeat(300_000))),
    ];
    for (const upstream of cases) {
      s = await boot({ upstream });
      const r = await post(s.base, TOKEN, genBody());
      expect(r.status).toBe(502);
      expect((await err(r)).code).toBe('invalid_response');
      await s.close();
      s = undefined;
    }
  });

  it('limite de saída: texto acima de maxOutputTokens × 4 é cortado e marcado', async () => {
    s = await boot({ upstream: async () => json(200, openaiOk('a'.repeat(2_000))) });
    const r = (await (await post(s.base, TOKEN, genBody({ maxOutputTokens: 100 }))).json()) as { output: { text: string }; finishReason: string };
    expect(r.output.text).toHaveLength(400);
    expect(r.finishReason).toBe('length');
  });

  it('14. nenhuma credencial vaza: nem a chave do provedor nem o token aparecem em respostas', async () => {
    // Provedor malicioso/defeituoso ecoando a chave no texto e no erro.
    s = await boot({ upstream: async (_u, init) => json(200, openaiOk(`eco: ${init.headers.authorization}`)) });
    const r = await post(s.base, TOKEN, genBody());
    const body = await r.text();
    expect(r.status).toBe(500);
    expect(body).not.toContain(OPENAI_KEY);
    await s.close();
    s = await boot({ upstream: async () => json(401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }) });
    const r2 = await post(s.base, TOKEN, genBody());
    const b2 = await r2.text();
    expect(b2).not.toContain(OPENAI_KEY);
    expect(b2).not.toContain(TOKEN);
    const cat = await (await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    for (const v of Object.values(env)) expect(cat).not.toContain(v);
    expect(cat).not.toMatch(/apiKeyEnv|tokenSha256|baseUrl/);
  });

  it('a chave só vai ao provedor certo, no cabeçalho, nunca na URL', async () => {
    s = await boot({ upstream: async (url) => (url.includes('anthropic') ? json(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) : json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })) });
    await post(s.base, TOKEN, genBody({ provider: 'anthropic' }));
    await post(s.base, TOKEN, genBody({ provider: 'gemini' }));
    const [a, g] = s.calls;
    expect(a.init.headers['x-api-key']).toBe(env.ANTHROPIC_API_KEY);
    expect(JSON.stringify(a.init.headers)).not.toContain(OPENAI_KEY);
    expect(g.init.headers['x-goog-api-key']).toBe(env.GEMINI_API_KEY);
    expect(g.url).not.toContain(env.GEMINI_API_KEY);
    for (const c of s.calls) expect(c.init.body).not.toContain(env.ANTHROPIC_API_KEY);
  });

  it('15. logs sem dados pessoais: sem prompt, resposta, dados corporais, token ou chave', async () => {
    const secretPrompt = 'Peso 83,4 kg, cintura 88 cm, gordura 17%: MARCADOR-PESSOAL-777';
    s = await boot({ upstream: async () => json(200, openaiOk('Resposta MARCADOR-RESPOSTA-888')) });
    await post(s.base, TOKEN, genBody({ messages: [{ role: 'user', content: secretPrompt }] }));
    await post(s.base, TOKEN, '{quebrado MARCADOR-PESSOAL-777');
    await post(s.base, null, genBody({ messages: [{ role: 'user', content: secretPrompt }] }));
    const all = JSON.stringify(s.logs);
    expect(s.logs).toHaveLength(3);
    for (const bad of ['MARCADOR-PESSOAL-777', 'MARCADOR-RESPOSTA-888', '83,4', 'cintura', TOKEN, OPENAI_KEY, 'authorization']) expect(all).not.toContain(bad);
    const ok = s.logs[0];
    expect(Object.keys(ok).sort()).toEqual(['clientId', 'durationMs', 'id', 'inputTokens', 'model', 'outputTokens', 'provider', 'route', 'status', 'ts']);
    expect(ok).toMatchObject({ route: 'POST /v1/generate', status: 200, clientId: 'tester', provider: 'openai', model: MODEL.id });
  });

  it('16. endpoints arbitrários bloqueados: rotas, query, métodos e campos de URL', async () => {
    s = await boot();
    const h = { authorization: `Bearer ${TOKEN}` };
    for (const p of ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/https://evil.example', '/v1/generate/../models', '/v1/generate?url=https://evil.example', '/']) {
      const r = await fetch(`${s.base}${p}`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(genBody()) });
      expect([404, 405], p).toContain(r.status);
    }
    expect((await fetch(`${s.base}/v1/generate`, { headers: h })).status).toBe(405);
    for (const extra of [{ baseUrl: 'https://evil.example' }, { endpoint: '/v1/files' }, { url: 'http://169.254.169.254/' }, { headers: { 'x-api-key': 'x' } }, { tools: [] }]) {
      const r = await post(s.base, TOKEN, genBody(extra));
      expect(r.status).toBe(400);
    }
    expect(s.calls).toHaveLength(0);
  });

  it('CORS não é autenticação: origem permitida sem token → 401; origem estranha → 403', async () => {
    s = await boot();
    const pre = await fetch(`${s.base}/v1/generate`, { method: 'OPTIONS', headers: { origin: 'http://localhost:4173', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    const anon = await fetch(`${s.base}/v1/generate`, { method: 'POST', headers: { origin: 'http://localhost:4173', 'content-type': 'application/json' }, body: JSON.stringify(genBody()) });
    expect(anon.status).toBe(401);
    const evil = await fetch(`${s.base}/v1/models`, { headers: { origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${s.base}/v1/generate`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
});

describe('falha segura', () => {
  it('17. sem configuração, configuração inválida ou desligada: 503 em todas as rotas', async () => {
    for (const config of [undefined, {}, { ...testConfig(TOKEN), enabled: 'sim' }, { ...testConfig(TOKEN), segredo: 1 }, testConfig(TOKEN, { enabled: false })]) {
      s = await boot({ config });
      for (const [path, method] of [['/v1/models', 'GET'], ['/v1/generate', 'POST'], ['/qualquer', 'GET']]) {
        const r = await fetch(`${s.base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(genBody()) } : {}) });
        expect(r.status).toBe(503);
        expect((await err(r)).code).toBe('gateway_disabled');
      }
      expect(s.calls).toHaveLength(0);
      await s.close();
      s = undefined;
    }
  });

  it('configuração inválida aponta só os campos, sem valores', async () => {
    s = await boot({ config: { ...testConfig(TOKEN), clients: [{ id: 'X Y', tokenSha256: 'abc', enabled: true }] } });
    expect(s.gw.config).toBeNull();
    expect(s.gw.configErrors).toEqual(['clients[0]']);
  });

  it('18. sem a chave do provedor no servidor: 503 provider_unavailable e catálogo indica indisponível', async () => {
    s = await boot({ env: { OPENAI_API_KEY: '' } });
    const r = await post(s.base, TOKEN, genBody());
    expect(r.status).toBe(503);
    expect((await err(r)).code).toBe('provider_unavailable');
    const cat = (await (await fetch(`${s.base}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { providers: { id: string; available: boolean }[] };
    expect(cat.providers.every((p) => !p.available)).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  it('sem fallback: falha num provedor não aciona outro', async () => {
    s = await boot({ upstream: async () => json(503, {}) });
    expect((await post(s.base, TOKEN, genBody({ provider: 'anthropic' }))).status).toBe(502);
    expect(s.calls.map((c) => new URL(c.url).hostname)).toEqual(['api.anthropic.com']);
  });

  it('nada é persistido: o código do gateway não grava arquivos nem usa banco (só main.ts LÊ a configuração)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '..', 'src');
    const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|sqlite|redis|indexedDB|localStorage/);
      if (f !== 'main.ts') expect(src, f).not.toMatch(/from 'node:fs'/);
    }
  });
});
