// IA pela conta (Prompt 21): transporte de mesma origem com sessão, sem token nem endereço digitados.
import { describe, expect, it } from 'vitest';
import { createAccountTransport } from '@/integrations/ai/gatewayTransport';
import { ACCOUNT_GATEWAY_LABEL, createAssistantService } from '@/integrations/ai/assistantService';

const catalog = { protocol: 'irontrack.ai-gateway.v1', providers: [{ id: 'anthropic', displayName: 'Anthropic Claude', available: true, models: [{ id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', maxInputChars: 24000, maxOutputTokens: 1024 }] }] };

describe('transporte da conta', () => {
  it('caminho fixo /api/v1/ai, cookie da mesma origem, anti-CSRF no POST, sem redirecionamento nem Referer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const t = createAccountTransport({ fetchImpl });
    await t({ method: 'GET', path: '/v1/models' });
    await t({ method: 'POST', path: '/v1/generate', body: { a: 1 } });
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/ai/models', '/api/v1/ai/generate']);
    for (const c of calls) expect(c.init).toMatchObject({ credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'same-origin' });
    expect((calls[1].init.headers as Record<string, string>)['x-irontrack-csrf']).toBe('1');
    expect(JSON.stringify(calls.map((c) => c.init.headers))).not.toMatch(/authorization|bearer/i);
    await expect(t({ method: 'GET', path: '/v1/outra' as never })).rejects.toMatchObject({ code: 'request_invalid' });
  });

  it('conectar pela conta registra só os provedores do servidor, com destino "sua conta"', async () => {
    const c = createAssistantService({ accountTransportFactory: () => async () => ({ status: 200, body: catalog }) });
    const conn = await c.connectAccount();
    expect(conn).toMatchObject({ origin: ACCOUNT_GATEWAY_LABEL, providers: [{ id: 'anthropic', available: true }] });
    expect(c.service.listProviders().map((p) => p.id)).toContain('anthropic');
  });

  it('sessão expirada no catálogo: erro de acesso, nada registrado', async () => {
    const c = createAssistantService({ accountTransportFactory: () => async () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'x' } } }) });
    await expect(c.connectAccount()).rejects.toMatchObject({ code: 'access_denied' });
    expect(c.service.listProviders().map((p) => p.id)).not.toContain('anthropic');
  });
});
