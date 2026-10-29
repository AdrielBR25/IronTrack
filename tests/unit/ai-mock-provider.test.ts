// Adaptador simulado: offline, determinístico, com erros e cancelamento controlados.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIError, type AIRequest } from '@/modules/ai';
import { MOCK_DISCLAIMER, MockAIProvider } from '@/modules/ai/adapters/MockAIProvider';
import { blockNetwork } from './aiFixtures';

const req = (over: Partial<AIRequest> = {}): AIRequest => ({
  modelId: 'mock-text',
  messages: [
    { role: 'system', content: 'sistema' },
    { role: 'user', content: 'pergunta fictícia' },
  ],
  maxOutputTokens: 256,
  responseFormat: { type: 'text' },
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MockAIProvider', () => {
  it('resposta determinística, marcada como simulação', async () => {
    const p = new MockAIProvider();
    const a = await p.generate(req());
    const b = await new MockAIProvider().generate(req());
    expect(a).toEqual(b);
    expect(a.output.type).toBe('text');
    expect(a.output.text.startsWith('[SIMULAÇÃO]')).toBe(true);
    expect(a.output.text).toContain(MOCK_DISCLAIMER);
    const c = await p.generate(req({ messages: [{ role: 'user', content: 'outra' }] }));
    expect(c.output.text).not.toBe(a.output.text);
  });

  it('não usa rede nem chave de API', async () => {
    const net = blockNetwork();
    const p = new MockAIProvider();
    await p.generate(req());
    await p.generate(req({ modelId: 'mock-structured', responseFormat: { type: 'json', schemaName: 'x' } }));
    expect(net.fetch).not.toHaveBeenCalled();
    expect(net.xhr).not.toHaveBeenCalled();
    expect(net.ws).not.toHaveBeenCalled();
  });

  it('cancelamento antes da execução: rejeita sem registrar a solicitação', async () => {
    const p = new MockAIProvider();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(p.generate(req(), { signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(p.received).toHaveLength(0);
  });

  it('cancelamento durante a execução', async () => {
    vi.useFakeTimers();
    const p = new MockAIProvider({ latencyMs: 5_000 });
    const ctrl = new AbortController();
    const run = p.generate(req(), { signal: ctrl.signal });
    const assertion = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await vi.advanceTimersByTimeAsync(1_000);
    ctrl.abort();
    await assertion;
  });

  it('erro simulado', async () => {
    await expect(new MockAIProvider({ behavior: 'fail' }).generate(req())).rejects.toThrow(/mock upstream failure/);
  });

  it('resposta inválida (fora do contrato)', async () => {
    const r = await new MockAIProvider({ behavior: 'invalid_response' }).generate(req());
    expect(typeof (r.output as unknown as { text: unknown }).text).toBe('number');
  });

  it('disponibilidade controlada', () => {
    const p = new MockAIProvider({ available: false });
    expect(p.isAvailable()).toBe(false);
    p.setAvailable(true);
    expect(p.isAvailable()).toBe(true);
  });

  it('erros de cancelamento são AIError padronizados', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await new MockAIProvider().generate(req(), { signal: ctrl.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
  });
});
