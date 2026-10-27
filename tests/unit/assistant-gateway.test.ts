// Integração do assistente com o gateway (P06): validação do endereço, transporte HTTP seguro e
// conexão pela raiz de composição. Rede sempre simulada (fetch falso); nenhum token fixo.
import { describe, expect, it, vi } from 'vitest';
import { AIError } from '@/modules/ai';
import { createAssistantService } from '@/integrations/ai/assistantService';
import { createGatewayTransport, isAccessTokenFormat, validateGatewayUrl } from '@/integrations/ai/gatewayTransport';

const TOKEN = 'T'.repeat(20) + crypto.randomUUID().replace(/-/g, '');
const catalog = {
  protocol: 'irontrack.ai-gateway.v1',
  providers: [
    { id: 'openai', displayName: 'OpenAI', available: true, models: [{ id: 'modelo-a', displayName: 'Modelo A', maxInputChars: 20000, maxOutputTokens: 800 }] },
    { id: 'gemini', displayName: 'Google Gemini', available: false, models: [{ id: 'modelo-g', displayName: 'Modelo G', maxInputChars: 20000, maxOutputTokens: 800 }] },
  ],
};
const res = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('endereço e token', () => {
  it.each([
    ['https://gateway.exemplo', true],
    ['https://gateway.exemplo:8443/', true],
    ['http://localhost:8787', true],
    ['http://127.0.0.1:8787', true],
    ['http://gateway.exemplo', false],
    ['http://192.168.1.5:8787', false],
    ['https://user:senha@gateway.exemplo', false],
    ['https://gateway.exemplo/v1/generate', false],
    ['https://gateway.exemplo/?k=1', false],
    ['javascript:alert(1)', false],
    ['', false],
  ])('%s → %s', (u, ok) => expect(validateGatewayUrl(u).ok).toBe(ok));

  it('token: formato de alta entropia', () => {
    expect(isAccessTokenFormat(TOKEN)).toBe(true);
    expect(isAccessTokenFormat('curto')).toBe(false);
    expect(isAccessTokenFormat(`${TOKEN} `)).toBe(false);
  });
});

describe('transporte', () => {
  it('envia só às rotas fixas, com Bearer, sem cookies, sem redirect e sem Referer', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => res(200, { ok: 1 }));
    const t = createGatewayTransport({ origin: 'https://gateway.exemplo', token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    await t({ method: 'POST', path: '/v1/generate', body: { a: 1 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://gateway.exemplo/v1/generate');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', body: '{"a":1}' });
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    await expect(t({ method: 'GET', path: '/v1/outra' as '/v1/models' })).rejects.toMatchObject({ code: 'request_invalid' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falha de rede → gateway_unreachable; abortado → cancelled; resposta grande → invalid_response', async () => {
    const down = createGatewayTransport({ origin: 'https://g.exemplo', token: TOKEN, fetchImpl: (async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch });
    await expect(down({ method: 'GET', path: '/v1/models' })).rejects.toMatchObject({ code: 'gateway_unreachable' });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(down({ method: 'GET', path: '/v1/models', signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    const big = createGatewayTransport({ origin: 'https://g.exemplo', token: TOKEN, maxResponseBytes: 100, fetchImpl: (async () => res(200, { t: 'x'.repeat(1000) })) as unknown as typeof fetch });
    await expect(big({ method: 'GET', path: '/v1/models' })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('corpo não JSON vira undefined (o adaptador trata como inválido)', async () => {
    const t = createGatewayTransport({ origin: 'https://g.exemplo', token: TOKEN, fetchImpl: (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch });
    expect(await t({ method: 'GET', path: '/v1/models' })).toEqual({ status: 502, body: undefined });
  });

  it('endereço inválido nem cria o transporte', () => {
    expect(() => createGatewayTransport({ origin: 'http://gateway.exemplo', token: TOKEN })).toThrow(AIError);
  });
});

describe('conexão pela raiz de composição', () => {
  it('padrão: só o provedor simulado; nenhum remoto registrado e nenhuma rede', () => {
    const fetchImpl = vi.fn();
    const c = createAssistantService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(c.providers.map((p) => [p.id, p.kind])).toEqual([['mock', 'simulated']]);
    expect(c.service.listProviders().map((p) => p.id)).toEqual(['mock']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('conectar busca só o catálogo (GET, sem corpo) e registra os provedores sem escolher nenhum', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => res(200, catalog));
    const c = createAssistantService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const conn = await c.connectGateway({ url: 'https://gateway.exemplo/', token: TOKEN });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://gateway.exemplo/v1/models');
    expect(init!.method).toBe('GET');
    expect(init!.body).toBeUndefined();
    expect(conn.origin).toBe('https://gateway.exemplo');
    expect(conn.providers.map((p) => [p.id, p.available, p.kind, p.destination])).toEqual([
      ['openai', true, 'remote', 'https://gateway.exemplo → OpenAI'],
      ['gemini', false, 'remote', 'https://gateway.exemplo → Google Gemini'],
    ]);
    expect(JSON.stringify(conn)).not.toContain(TOKEN);
    c.disconnectGateway();
    expect(c.service.listProviders().map((p) => p.id)).toEqual(['mock']);
  });

  it('erros de conexão: endereço, token, credencial recusada, gateway desligado, protocolo errado, rede', async () => {
    const make = (r: () => Promise<Response>) => createAssistantService({ fetchImpl: r as unknown as typeof fetch });
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: AIError) => e.code);
    expect(await code(make(async () => res(200, catalog)).connectGateway({ url: 'http://gateway.exemplo', token: TOKEN }))).toBe('provider_invalid');
    expect(await code(make(async () => res(200, catalog)).connectGateway({ url: 'https://g.exemplo', token: 'abc' }))).toBe('access_denied');
    expect(await code(make(async () => res(401, { error: { code: 'unauthorized' } })).connectGateway({ url: 'https://g.exemplo', token: TOKEN }))).toBe('access_denied');
    expect(await code(make(async () => res(503, { error: { code: 'gateway_disabled' } })).connectGateway({ url: 'https://g.exemplo', token: TOKEN }))).toBe('provider_unavailable');
    expect(await code(make(async () => res(200, { providers: [] })).connectGateway({ url: 'https://g.exemplo', token: TOKEN }))).toBe('invalid_response');
    expect(await code(make(async () => Promise.reject(new TypeError('x'))).connectGateway({ url: 'https://g.exemplo', token: TOKEN }))).toBe('gateway_unreachable');
  });

  it('reconectar substitui os provedores anteriores', async () => {
    const c = createAssistantService({ fetchImpl: (async () => res(200, catalog)) as unknown as typeof fetch });
    await c.connectGateway({ url: 'https://a.exemplo', token: TOKEN });
    const second = await c.connectGateway({ url: 'https://b.exemplo', token: TOKEN });
    expect(second.providers[0].destination).toBe('https://b.exemplo → OpenAI');
    expect(c.service.listProviders().filter((p) => p.id === 'openai')).toHaveLength(1);
  });
});
