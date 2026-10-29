// Provedor remoto via gateway (P06): catálogo, mapeamento do contrato, erros normalizados,
// cancelamento, limite de saída e vínculo do destino na autorização. Transporte sempre simulado.
import { describe, expect, it, vi } from 'vitest';
import { AIError, AIService, ProviderRegistry, createConsent, type AIProvider } from '@/modules/ai';
import { GATEWAY_PROTOCOL, GatewayAIProvider, gatewayErrorCode, parseGatewayCatalog, type GatewayProviderEntry, type GatewayTransport } from '@/modules/ai/adapters/GatewayAIProvider';
import { MOCK_MODELS } from '@/modules/ai/adapters/MockAIProvider';
import { T0, baseInput } from './aiFixtures';

const catalog = (providers: unknown[]) => ({ protocol: GATEWAY_PROTOCOL, providers });
const MODEL = { id: 'modelo-remoto-1', displayName: 'Modelo remoto', maxInputChars: 20_000, maxOutputTokens: 800 };
const ENTRY: GatewayProviderEntry = parseGatewayCatalog(catalog([{ id: 'anthropic', displayName: 'Anthropic Claude', available: true, models: [MODEL] }]))[0];

const okBody = (text = 'Resposta remota.', over: Record<string, unknown> = {}) => ({ provider: 'anthropic', model: MODEL.id, output: { type: 'text', text }, finishReason: 'stop', usage: { inputTokens: 30, outputTokens: 5 }, ...over });

function setup(respond: GatewayTransport = async () => ({ status: 200, body: okBody() }), origin = 'https://gateway.test') {
  const calls: Parameters<GatewayTransport>[0][] = [];
  const transport: GatewayTransport = async (req) => {
    calls.push(req);
    return respond(req);
  };
  const registry = new ProviderRegistry();
  const provider = new GatewayAIProvider({ entry: ENTRY, transport, gatewayOrigin: origin });
  registry.register(provider);
  let clock = T0;
  let seq = 0;
  const service = new AIService({ registry, now: () => clock, randomId: () => `req-${++seq}` });
  const input = baseInput({ providerId: 'anthropic', modelId: MODEL.id });
  return { calls, registry, provider, service, input, consent: (p: Parameters<typeof createConsent>[0]) => createConsent(p, { grantedAt: clock, id: `c-${++seq}` }), advance: (ms: number) => (clock += ms) };
}

describe('catálogo do gateway', () => {
  it('converte provedores e modelos com capacidades conservadoras (só texto)', () => {
    expect(ENTRY).toEqual({
      id: 'anthropic',
      displayName: 'Anthropic Claude',
      available: true,
      models: [{ id: MODEL.id, displayName: 'Modelo remoto', capabilities: { textGeneration: true, systemMessages: true, structuredOutput: false, imageInput: false, streaming: false, maxInputChars: 20_000, maxOutputTokens: 800 } }],
    });
  });

  it('recusa protocolo errado e descarta entradas fora do contrato', () => {
    expect(() => parseGatewayCatalog({ providers: [] })).toThrow(AIError);
    expect(() => parseGatewayCatalog(null)).toThrow(AIError);
    const r = parseGatewayCatalog(
      catalog([
        { id: 'mock', displayName: 'Falso simulado', available: true, models: [MODEL] },
        { id: 'Bad Id', displayName: 'x', available: true, models: [MODEL] },
        { id: 'openai', displayName: 'OpenAI', available: 'sim', models: [MODEL] },
        { id: 'gemini', displayName: 'Gemini', available: false, models: [{ ...MODEL, id: 'a/b' }, { ...MODEL, maxOutputTokens: 0 }, MODEL, MODEL] },
        { id: 'semmodelos', displayName: 'Vazio', available: true, models: [] },
      ]),
    );
    expect(r.map((p) => [p.id, p.available, p.models.map((m) => m.id)])).toEqual([['gemini', false, [MODEL.id]]]);
  });

  it('mapeia códigos de erro do gateway sem usar a mensagem do servidor', () => {
    const e = (code: string) => ({ error: { code, message: 'texto qualquer do servidor' } });
    expect(gatewayErrorCode(401, e('unauthorized'))).toBe('access_denied');
    expect(gatewayErrorCode(403, e('origin_not_allowed'))).toBe('access_denied');
    expect(gatewayErrorCode(403, e('model_not_allowed'))).toBe('model_unsupported');
    expect(gatewayErrorCode(403, e('provider_not_allowed'))).toBe('provider_unavailable');
    expect(gatewayErrorCode(503, e('gateway_disabled'))).toBe('provider_unavailable');
    expect(gatewayErrorCode(503, e('provider_unavailable'))).toBe('provider_unavailable');
    expect(gatewayErrorCode(413, e('payload_too_large'))).toBe('request_invalid');
    expect(gatewayErrorCode(429, e('rate_limited'))).toBe('rate_limited');
    expect(gatewayErrorCode(429, e('provider_rate_limited'))).toBe('rate_limited');
    expect(gatewayErrorCode(429, e('quota_exceeded'))).toBe('quota_exceeded');
    expect(gatewayErrorCode(504, e('timeout'))).toBe('timeout');
    expect(gatewayErrorCode(502, e('content_filtered'))).toBe('content_blocked');
    expect(gatewayErrorCode(502, e('invalid_response'))).toBe('invalid_response');
    expect(gatewayErrorCode(500, '<html>')).toBe('provider_failure');
    expect(gatewayErrorCode(401, undefined)).toBe('access_denied');
  });
});

describe('registro e destino', () => {
  it('provedor remoto precisa declarar destino', () => {
    const r = new ProviderRegistry();
    const p = { id: 'remoto', displayName: 'Remoto', kind: 'remote', models: MOCK_MODELS, generate: async () => ({}) } as unknown as AIProvider;
    expect(() => r.register(p)).toThrow(expect.objectContaining({ code: 'provider_invalid' }));
    r.register({ ...p, destination: 'https://gw → X' } as AIProvider);
    expect(r.list()[0].destination).toBe('https://gw → X');
  });

  it('descritor expõe destino e tipo remoto, sem o transporte', () => {
    const { service } = setup();
    const d = service.listProviders()[0];
    expect(d).toMatchObject({ id: 'anthropic', kind: 'remote', destination: 'https://gateway.test → Anthropic Claude' });
    expect(JSON.stringify(d)).not.toMatch(/transport|token|Bearer/);
  });
});

describe('fluxo prepare → prévia → consentimento → execute com provedor remoto', () => {
  it('sem consentimento, nada vai ao gateway', async () => {
    const { calls, service, input } = setup();
    const p = await service.prepare(input);
    expect(p.destination).toBe('https://gateway.test → Anthropic Claude');
    await expect(service.execute(p, undefined)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(calls).toHaveLength(0);
  });

  it('com consentimento envia exatamente as mensagens preparadas, uma única vez', async () => {
    const { calls, service, input, consent } = setup();
    const p = await service.prepare(input);
    const c = consent(p);
    const r = await service.execute(p, c);
    expect(r).toMatchObject({ providerId: 'anthropic', modelId: MODEL.id, output: { type: 'text', text: 'Resposta remota.' }, finishReason: 'stop', usage: { inputTokens: 30, outputTokens: 5 } });
    expect(r.metadata.simulated).toBe(false);
    expect(calls).toHaveLength(1);
    const sent = calls[0] as { method: string; path: string; body: Record<string, unknown> };
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/v1/generate');
    expect(Object.keys(sent.body).sort()).toEqual(['maxOutputTokens', 'messages', 'model', 'provider']);
    expect(sent.body.messages).toEqual(p.request.messages.map((m) => ({ role: m.role, content: m.content })));
    expect(sent.body.maxOutputTokens).toBe(p.request.maxOutputTokens);
    await expect(service.execute(p, c)).rejects.toMatchObject({ code: 'permission_denied' });
    expect(calls).toHaveLength(1);
  });

  it('o destino faz parte da autorização: reconectar a outro gateway invalida o pedido preparado', async () => {
    const a = setup();
    const p = await a.service.prepare(a.input);
    const c = a.consent(p);
    a.registry.unregister('anthropic');
    a.registry.register(new GatewayAIProvider({ entry: ENTRY, transport: async () => ({ status: 200, body: okBody() }), gatewayOrigin: 'https://outro-gateway.test' }));
    await expect(a.service.execute(p, c)).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('adulterar o destino da solicitação preparada invalida a assinatura', async () => {
    const { service, input, consent } = setup();
    const p = await service.prepare(input);
    const forged = { ...p, destination: 'https://evil.test → X' };
    await expect(service.execute(forged, consent(p))).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('desconectar (remover o provedor) impede executar o pedido já preparado', async () => {
    const { registry, service, input, consent, calls } = setup();
    const p = await service.prepare(input);
    registry.unregister('anthropic');
    await expect(service.execute(p, consent(p))).rejects.toMatchObject({ code: 'provider_not_found' });
    expect(calls).toHaveLength(0);
  });

  it('provedor indisponível no catálogo: não envia', async () => {
    const calls: unknown[] = [];
    const registry = new ProviderRegistry();
    registry.register(new GatewayAIProvider({ entry: { ...ENTRY, available: false }, transport: async (r) => (calls.push(r), { status: 200, body: okBody() }), gatewayOrigin: 'https://g.test' }));
    const service = new AIService({ registry, now: () => T0, randomId: () => 'r1' });
    const p = await service.prepare(baseInput({ providerId: 'anthropic', modelId: MODEL.id }));
    await expect(service.execute(p, createConsent(p, { grantedAt: T0, id: 'c' }))).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, { error: { code: 'unauthorized' } }, 'access_denied'],
    [429, { error: { code: 'quota_exceeded' } }, 'quota_exceeded'],
    [429, { error: { code: 'rate_limited' } }, 'rate_limited'],
    [502, { error: { code: 'content_filtered' } }, 'content_blocked'],
    [503, { error: { code: 'provider_unavailable', message: 'detalhe interno sk-abc' } }, 'provider_unavailable'],
    [200, okBody('x', { model: 'outro-modelo' }), 'invalid_response'],
    [200, okBody('x', { provider: 'openai' }), 'invalid_response'],
    [200, okBody('x', { finishReason: 'tool_use' }), 'invalid_response'],
    [200, { output: 'texto' }, 'invalid_response'],
  ])('status %i → %s (mensagem fixa)', async (status, body, code) => {
    const { service, input, consent } = setup(async () => ({ status, body }));
    const p = await service.prepare(input);
    const e = await service.execute(p, consent(p)).catch((x: AIError) => x);
    expect(e).toMatchObject({ code });
    expect((e as Error).message).not.toMatch(/sk-abc|detalhe interno/);
  });

  it('falha de rede do transporte → gateway_unreachable, sem repetir', async () => {
    let n = 0;
    const { service, input, consent } = setup(async () => {
      n++;
      throw new AIError('gateway_unreachable');
    });
    const p = await service.prepare(input);
    await expect(service.execute(p, consent(p))).rejects.toMatchObject({ code: 'gateway_unreachable' });
    expect(n).toBe(1);
  });

  it('cancelamento: o sinal chega ao transporte e a execução termina como cancelada', async () => {
    let seen: AbortSignal | undefined;
    const { service, input, consent } = setup((req) => {
      seen = req.signal;
      return new Promise((_r, reject) => req.signal?.addEventListener('abort', () => reject(new AIError('cancelled'))));
    });
    const p = await service.prepare(input);
    const ctrl = new AbortController();
    const run = service.execute(p, consent(p), { signal: ctrl.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen!.aborted).toBe(true);
  });

  it('tempo limite do app mesmo se o gateway não responder', async () => {
    const { service, input, consent } = setup(() => new Promise(() => {}));
    const p = await service.prepare(input);
    await expect(service.execute(p, consent(p), { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('limite de saída: texto acima do limite é cortado e marcado', async () => {
    const { service, input, consent } = setup(async () => ({ status: 200, body: okBody('y'.repeat(10_000)) }));
    const p = await service.prepare({ ...input, maxOutputTokens: 100 });
    const r = await service.execute(p, consent(p));
    expect(r.output.text).toHaveLength(400);
    expect(r.metadata.truncated).toBe(true);
    expect(r.finishReason).toBe('length');
  });

  it('capacidade não suportada: JSON estruturado é recusado antes de qualquer envio', async () => {
    const { service, input, calls } = setup();
    await expect(service.prepare({ ...input, responseFormat: { type: 'json', schemaName: 'x' } })).rejects.toMatchObject({ code: 'capability_unsupported' });
    const direct = new GatewayAIProvider({ entry: ENTRY, transport: async () => ({ status: 200, body: okBody() }), gatewayOrigin: 'https://g.test' });
    await expect(direct.generate({ modelId: MODEL.id, messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10, responseFormat: { type: 'json', schemaName: 's' } })).rejects.toMatchObject({ code: 'capability_unsupported' });
    expect(calls).toHaveLength(0);
  });

  it('modelo fora do catálogo: recusado na preparação', async () => {
    const { service, input } = setup();
    await expect(service.prepare({ ...input, modelId: 'gpt-qualquer' })).rejects.toMatchObject({ code: 'model_unsupported' });
  });
});
