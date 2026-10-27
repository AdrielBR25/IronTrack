// Contrato do provedor local Ollama (P06): só endereço digitado e em loopback, mapeamento da API
// /api/chat e erros. Não está registrado na interface; transporte simulado.
import { describe, expect, it } from 'vitest';
import { OllamaProvider, validateLocalEndpoint, type LocalTransport } from '@/modules/ai/adapters/OllamaProvider';
import { MOCK_MODELS } from '@/modules/ai/adapters/MockAIProvider';
import { ProviderRegistry } from '@/modules/ai';

const REQ = { modelId: 'mock-text', messages: [{ role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'u' }], maxOutputTokens: 50, responseFormat: { type: 'text' as const } };

describe('endereço local', () => {
  it.each([
    ['http://localhost:11434', true],
    ['http://127.0.0.1:11434/', true],
    ['http://[::1]:11434', true],
    ['', false],
    ['localhost:11434', false],
    ['http://192.168.0.10:11434', false],
    ['http://ollama.lan:11434', false],
    ['http://user:pw@localhost:11434', false],
    ['http://localhost:11434/api/chat', false],
    ['http://localhost:11434/?x=1', false],
    ['file:///etc/passwd', false],
  ])('%s → %s', (url, ok) => {
    expect(validateLocalEndpoint(url).ok).toBe(ok);
  });

  it('não há endereço padrão: construir sem endereço válido falha', () => {
    expect(() => new OllamaProvider({ origin: '', transport: async () => ({ status: 200, body: {} }), models: MOCK_MODELS })).toThrow();
    expect(() => new OllamaProvider({ origin: 'http://10.0.0.2:11434', transport: async () => ({ status: 200, body: {} }), models: MOCK_MODELS })).toThrow();
  });
});

describe('mapeamento /api/chat', () => {
  const make = (t: LocalTransport) => new OllamaProvider({ origin: 'http://localhost:11434', transport: t, models: MOCK_MODELS });

  it('envia mensagens, modelo, stream:false e num_predict; lê texto, motivo e uso', async () => {
    const seen: unknown[] = [];
    const p = make(async (r) => (seen.push(r), { status: 200, body: { message: { role: 'assistant', content: 'oi' }, done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 2 } }));
    expect(p.kind).toBe('local');
    expect(p.destination).toBe('http://localhost:11434 (servidor local)');
    expect(new ProviderRegistry().register(p)).toBeUndefined();
    const r = await p.generate(REQ);
    expect(r).toEqual({ modelId: 'mock-text', output: { type: 'text', text: 'oi' }, finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 2 } });
    expect(seen[0]).toMatchObject({ path: '/api/chat', body: { model: 'mock-text', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], stream: false, options: { num_predict: 50 } } });
  });

  it('erros: 404 → model_unsupported; 500 → provider_failure; corpo inválido → invalid_response; length', async () => {
    await expect(make(async () => ({ status: 404, body: {} })).generate(REQ)).rejects.toMatchObject({ code: 'model_unsupported' });
    await expect(make(async () => ({ status: 500, body: {} })).generate(REQ)).rejects.toMatchObject({ code: 'provider_failure' });
    await expect(make(async () => ({ status: 200, body: { message: {} } })).generate(REQ)).rejects.toMatchObject({ code: 'invalid_response' });
    expect((await make(async () => ({ status: 200, body: { message: { content: 'x' }, done_reason: 'length' } })).generate(REQ)).finishReason).toBe('length');
  });

  it('cancelado antes de começar e JSON estruturado não suportado', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(make(async () => ({ status: 200, body: {} })).generate(REQ, { signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(make(async () => ({ status: 200, body: {} })).generate({ ...REQ, responseFormat: { type: 'json', schemaName: 'x' } })).rejects.toMatchObject({ code: 'capability_unsupported' });
  });
});
