// Registro e seleção explícita de provedores de IA (IronTrack 2.0 F01/P04).
import { describe, expect, it } from 'vitest';
import { AIError, ProviderRegistry, type AIProvider } from '@/modules/ai';
import { MOCK_MODELS, MockAIProvider } from '@/modules/ai/adapters/MockAIProvider';
import { baseInput, setup } from './aiFixtures';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AIError ? e.code : 'não-AIError';
  }
  return 'sem erro';
};

describe('ProviderRegistry', () => {
  it('registra um provedor válido e o lista sem expor o adaptador', () => {
    const r = new ProviderRegistry();
    r.register(new MockAIProvider());
    expect(r.has('mock')).toBe(true);
    const list = r.list();
    expect(list).toEqual([{ id: 'mock', displayName: 'Provedor simulado', kind: 'simulated', models: MOCK_MODELS }]);
    expect('generate' in list[0]).toBe(false);
    // Cópia: alterar a lista não altera o registro.
    list[0].models[0].capabilities.textGeneration = false;
    expect(r.list()[0].models[0].capabilities.textGeneration).toBe(true);
  });

  it('rejeita ID duplicado sem substituir o provedor existente', () => {
    const r = new ProviderRegistry();
    const first = new MockAIProvider();
    r.register(first);
    expect(code(() => r.register(new MockAIProvider({ displayName: 'Outro' })))).toBe('provider_duplicate');
    expect(r.list()).toHaveLength(1);
    expect(r.resolve('mock', 'mock-text').provider).toBe(first);
  });

  it('rejeita provedor mal configurado (ID, modelos, capacidades)', () => {
    const r = new ProviderRegistry();
    expect(code(() => r.register(new MockAIProvider({ id: 'Com Espaço' })))).toBe('provider_invalid');
    expect(code(() => r.register(new MockAIProvider({ models: [] })))).toBe('provider_invalid');
    expect(code(() => r.register(new MockAIProvider({ models: [MOCK_MODELS[0], MOCK_MODELS[0]] })))).toBe('provider_invalid');
    const broken = { ...MOCK_MODELS[0], capabilities: { ...MOCK_MODELS[0].capabilities, maxOutputTokens: 0 } };
    expect(code(() => r.register(new MockAIProvider({ models: [broken] })))).toBe('provider_invalid');
    expect(code(() => r.register({ id: 'sem-generate', displayName: 'x', kind: 'remote', models: MOCK_MODELS } as unknown as AIProvider))).toBe('provider_invalid');
    expect(r.list()).toEqual([]);
  });

  it('provedor inexistente', () => {
    expect(code(() => new ProviderRegistry().resolve('openai', 'qualquer'))).toBe('provider_not_found');
  });

  it('seleção explícita: devolve exatamente o provedor e o modelo pedidos', () => {
    const r = new ProviderRegistry();
    const a = new MockAIProvider({ id: 'mock-a' });
    const b = new MockAIProvider({ id: 'mock-b' });
    r.register(a);
    r.register(b);
    expect(r.resolve('mock-b', 'mock-structured')).toEqual({ provider: b, model: MOCK_MODELS[1] });
    expect(r.resolve('mock-a', 'mock-text').provider).toBe(a);
  });

  it('modelo não oferecido pelo provedor', () => {
    const r = new ProviderRegistry();
    r.register(new MockAIProvider());
    expect(code(() => r.resolve('mock', 'gpt-qualquer'))).toBe('model_unsupported');
  });

  it('capacidade não suportada pelo modelo (cada modelo declara as suas)', () => {
    const r = new ProviderRegistry();
    r.register(new MockAIProvider());
    expect(code(() => r.resolve('mock', 'mock-text', ['structuredOutput']))).toBe('capability_unsupported');
    expect(code(() => r.resolve('mock', 'mock-text', ['imageInput']))).toBe('capability_unsupported');
    expect(r.resolve('mock', 'mock-structured', ['structuredOutput']).model.id).toBe('mock-structured');
  });
});

describe('seleção no serviço', () => {
  it('sem provedor escolhido não há padrão: a solicitação é recusada', async () => {
    const { service } = setup();
    await expect(service.prepare(baseInput({ providerId: '' }))).rejects.toMatchObject({ code: 'provider_not_found' });
  });

  it('JSON exige modelo com structuredOutput', async () => {
    const { service } = setup();
    await expect(service.prepare(baseInput({ responseFormat: { type: 'json', schemaName: 'resumo' } }))).rejects.toMatchObject({ code: 'capability_unsupported' });
    const p = await service.prepare(baseInput({ modelId: 'mock-structured', responseFormat: { type: 'json', schemaName: 'resumo' } }));
    expect(p.request.responseFormat).toEqual({ type: 'json', schemaName: 'resumo' });
  });

  it('modelo incompatível com o provedor é recusado no preparo', async () => {
    const { service } = setup();
    await expect(service.prepare(baseInput({ modelId: 'claude-qualquer' }))).rejects.toMatchObject({ code: 'model_unsupported' });
  });

  it('listProviders expõe só descritores', () => {
    const { service } = setup({}, [{ id: 'mock-2' }]);
    expect(service.listProviders().map((p) => p.id)).toEqual(['mock', 'mock-2']);
  });
});
