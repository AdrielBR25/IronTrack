// Serviço central de IA: execução, falhas, cancelamento, tempo limite, normalização e limites.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIError, AI_ERROR_MESSAGES, AI_REQUEST_LIMITS, BASE_SYSTEM_PROMPT, type AIProvider, type AIProviderResult } from '@/modules/ai';
import { DB_SCHEMA_VERSION, IronTrackDB, db, setDb } from '@/db/db';
import { BACKUP_SCHEMA_VERSION, exportBackup } from '@/lib/backup';
import { baseInput, richSources, setup, T0 } from './aiFixtures';

afterEach(() => vi.useRealTimers());

describe('AIService.execute', () => {
  it('execução válida: resposta normalizada, congelada, com metadados e marcada como simulada', async () => {
    const { service, mock, consent, logs } = setup();
    const p = await service.prepare(baseInput());
    expect(p.request.messages).toEqual([
      { role: 'system', content: BASE_SYSTEM_PROMPT },
      { role: 'user', content: 'Explique o resumo fictício.' },
    ]);
    expect(p.binding).toMatch(/^[0-9a-f]{64}$/);
    const r = await service.execute(p, consent(p));
    expect(r.providerId).toBe('mock');
    expect(r.modelId).toBe('mock-text');
    expect(r.output.type).toBe('text');
    expect(r.output.text.startsWith('[SIMULAÇÃO]')).toBe(true);
    expect(r.finishReason).toBe('stop');
    expect(r.metadata).toEqual({ requestId: 'req-1', startedAt: T0, finishedAt: T0, durationMs: 0, simulated: true, truncated: false });
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
    expect(Object.isFrozen(r)).toBe(true);
    expect(mock.received).toEqual([p.request]);
    expect(logs.map((l) => l.type)).toEqual(['execute_start', 'execute_success']);
  });

  it('modelo sem mensagem de sistema recebe tudo numa mensagem de usuário', async () => {
    const { service } = setup();
    const p = await service.prepare(baseInput({ modelId: 'mock-tiny', maxOutputTokens: 32 }));
    expect(p.request.messages).toHaveLength(1);
    expect(p.request.messages[0].role).toBe('user');
    expect(p.request.messages[0].content.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
  });

  it('resposta estruturada (JSON) normalizada quando o modelo declara suporte', async () => {
    const { service, consent } = setup();
    const p = await service.prepare(baseInput({ modelId: 'mock-structured', responseFormat: { type: 'json', schemaName: 'resumo' } }));
    const r = await service.execute(p, consent(p));
    expect(r.output.type).toBe('json');
    expect(r.output.type === 'json' && r.output.value).toMatchObject({ simulated: true, schema: 'resumo' });
  });

  it('falha do provedor: erro seguro, sem detalhes internos, sem nova tentativa e sem outro provedor', async () => {
    const { service, mock, others, consent, logs } = setup({ behavior: 'fail' }, [{ id: 'mock-b' }]);
    const p = await service.prepare(baseInput({ instruction: 'conteúdo sensível fictício' }));
    const err = (await service.execute(p, consent(p)).catch((e: unknown) => e)) as AIError;
    expect(err).toBeInstanceOf(AIError);
    expect(err.code).toBe('provider_failure');
    expect(err.message).toBe(AI_ERROR_MESSAGES.provider_failure);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    const serialized = JSON.stringify(err) + String(err) + JSON.stringify(logs);
    expect(serialized).not.toMatch(/upstream|sensível|assinatura/);
    expect(mock.received).toHaveLength(1);
    expect(others[0].received).toHaveLength(0);
    expect(logs.at(-1)).toEqual({ type: 'execute_error', requestId: 'req-1', providerId: 'mock', modelId: 'mock-text', code: 'provider_failure', durationMs: 0 });
  });

  it('provedor indisponível: recusa sem enviar', async () => {
    const { service, mock, consent } = setup({ available: false });
    const p = await service.prepare(baseInput());
    await expect(service.execute(p, consent(p))).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(mock.received).toHaveLength(0);
  });

  it('cancelamento antes da execução', async () => {
    const { service, mock, consent } = setup();
    const p = await service.prepare(baseInput());
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(service.execute(p, consent(p), { signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(mock.received).toHaveLength(0);
  });

  it('cancelamento durante a execução', async () => {
    vi.useFakeTimers();
    const { service, consent } = setup({ latencyMs: 10_000 });
    const p = await service.prepare(baseInput());
    const ctrl = new AbortController();
    const run = expect(service.execute(p, consent(p), { signal: ctrl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await vi.advanceTimersByTimeAsync(500);
    ctrl.abort();
    await run;
  });

  it('cancela mesmo se o adaptador ignorar o sinal', async () => {
    const { service, registry, consent } = setup();
    const deaf: AIProvider = { id: 'deaf', displayName: 'Surdo', kind: 'simulated', models: registry.list()[0].models, generate: () => new Promise<AIProviderResult>(() => {}) };
    registry.register(deaf);
    const p = await service.prepare(baseInput({ providerId: 'deaf' }));
    const ctrl = new AbortController();
    const run = service.execute(p, consent(p), { signal: ctrl.signal });
    ctrl.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('tempo limite: encerra e cancela o adaptador', async () => {
    const { service, mock, consent } = setup({ behavior: 'hang' });
    const p = await service.prepare(baseInput());
    await expect(service.execute(p, consent(p), { timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
    expect(mock.received).toHaveLength(1);
  });

  it('resposta inválida do adaptador vira invalid_response', async () => {
    const { service, consent, registry } = setup({ behavior: 'invalid_response' });
    const p = await service.prepare(baseInput());
    await expect(service.execute(p, consent(p))).rejects.toMatchObject({ code: 'invalid_response' });
    const models = registry.list()[0].models;
    const wrongModel: AIProvider = { id: 'liar', displayName: 'x', kind: 'simulated', models, generate: async () => ({ modelId: 'outro', output: { type: 'text', text: 'ok' }, finishReason: 'stop' }) };
    const badJson: AIProvider = { id: 'badjson', displayName: 'x', kind: 'simulated', models, generate: async (r) => ({ modelId: r.modelId, output: { type: 'json', text: '{quebrado', value: {} }, finishReason: 'stop' }) };
    registry.register(wrongModel);
    registry.register(badJson);
    const a = await service.prepare(baseInput({ providerId: 'liar' }));
    await expect(service.execute(a, consent(a))).rejects.toMatchObject({ code: 'invalid_response' });
    const b = await service.prepare(baseInput({ providerId: 'badjson', modelId: 'mock-structured', responseFormat: { type: 'json', schemaName: 's' } }));
    await expect(service.execute(b, consent(b))).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('limite de saída: texto longo é cortado e marcado', async () => {
    const { service, consent } = setup({ behavior: 'overlong' });
    const p = await service.prepare(baseInput({ maxOutputTokens: 50 }));
    const r = await service.execute(p, consent(p));
    expect(r.output.text.length).toBe(50 * AI_REQUEST_LIMITS.charsPerToken);
    expect(r.finishReason).toBe('length');
    expect(r.metadata.truncated).toBe(true);
  });

  it('provedor que não está no registro do serviço não recebe nada', async () => {
    const { service, consent } = setup();
    const p = await service.prepare(baseInput({ providerId: 'mock' }));
    const empty = setup({ id: 'mock-x' });
    await expect(empty.service.execute(p, consent(p))).rejects.toMatchObject({ code: 'provider_not_found' });
  });
});

describe('AIService.prepare: limites de entrada', () => {
  it('instrução vazia, longa demais ou de tipo errado', async () => {
    const { service } = setup();
    await expect(service.prepare(baseInput({ instruction: '   ' }))).rejects.toMatchObject({ code: 'request_invalid' });
    await expect(service.prepare(baseInput({ instruction: 'x'.repeat(AI_REQUEST_LIMITS.maxInstructionChars + 1) }))).rejects.toMatchObject({ code: 'request_invalid' });
    await expect(service.prepare(baseInput({ instruction: 42 as never }))).rejects.toMatchObject({ code: 'request_invalid' });
    await expect(service.prepare(baseInput({ system: 'x'.repeat(AI_REQUEST_LIMITS.maxSystemChars + 1) }))).rejects.toMatchObject({ code: 'request_invalid' });
  });

  it('limite de saída deve ser inteiro, positivo e caber no modelo', async () => {
    const { service } = setup();
    for (const maxOutputTokens of [0, -1, 1.5, 1_025, 10_000]) await expect(service.prepare(baseInput({ maxOutputTokens }))).rejects.toMatchObject({ code: 'request_invalid' });
    expect((await service.prepare(baseInput())).request.maxOutputTokens).toBe(512);
    expect((await service.prepare(baseInput({ modelId: 'mock-tiny' }))).request.maxOutputTokens).toBe(64);
  });

  it('entrada maior que o modelo aceita é recusada', async () => {
    const { service } = setup();
    await expect(service.prepare(baseInput({ modelId: 'mock-tiny', maxOutputTokens: 10, categories: ['training_history'], sources: richSources(), instruction: 'y'.repeat(1_999) }))).resolves.toBeDefined();
    const big = richSources();
    big.trainingSessions = Array.from({ length: 12 }, (_, i) => ({ ...big.trainingSessions[0], startedAt: big.trainingSessions[0].startedAt + i * 86_400_000 }));
    await expect(service.prepare(baseInput({ modelId: 'mock-tiny', maxOutputTokens: 10, categories: ['training_history'], sources: big, instruction: 'y'.repeat(1_999) }))).rejects.toMatchObject({ code: 'request_invalid' });
  });

  it('sem Web Crypto, falha segura: nada é preparado', async () => {
    const { registry } = setup();
    const { AIService } = await import('@/modules/ai');
    const s = new AIService({ registry, digest: () => Promise.reject(new AIError('permission_denied')) });
    await expect(s.prepare(baseInput())).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('banco e backup intactos', () => {
  it('fluxo completo de IA não cria tabelas, não muda a versão do Dexie nem o backup', async () => {
    setDb(new IronTrackDB('ai-no-persist'));
    await db.open();
    const before = await exportBackup();
    const { service, consent } = setup();
    const p = await service.prepare(baseInput({ categories: ['training_summary'], sources: richSources() }));
    await service.execute(p, consent(p));
    const after = await exportBackup();
    expect(db.verno).toBe(DB_SCHEMA_VERSION);
    expect(after.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['bodyEntries', 'goals', 'overrides', 'photos', 'profiles', 'rotations', 'routines', 'sessions', 'settings']);
    expect({ ...after, exportedAt: 0 }).toEqual({ ...before, exportedAt: 0 });
    expect(JSON.stringify(after)).not.toMatch(/consent|binding|SIMULAÇÃO/);
  });
});
