// Montagem comum dos testes do módulo de IA. Dados fictícios: nunca use registros reais.
import { vi } from 'vitest';
import { AIService, ProviderRegistry, createConsent, type AIPrepareInput, type AILogEvent, type PreparedAIRequest } from '@/modules/ai';
import { MockAIProvider, type MockAIProviderOptions } from '@/modules/ai/adapters/MockAIProvider';
import { entry, session } from './fixtures';

export const T0 = 1_800_000_000_000;

export function setup(opts: MockAIProviderOptions = {}, extra: MockAIProviderOptions[] = []) {
  const registry = new ProviderRegistry();
  const mock = new MockAIProvider(opts);
  registry.register(mock);
  const others = extra.map((o) => {
    const p = new MockAIProvider(o);
    registry.register(p);
    return p;
  });
  let clock = T0;
  let seq = 0;
  const logs: AILogEvent[] = [];
  const service = new AIService({ registry, now: () => clock, randomId: () => `req-${++seq}`, logger: (e) => logs.push(e) });
  return {
    registry,
    mock,
    others,
    service,
    logs,
    advance: (ms: number) => (clock += ms),
    consent: (p: PreparedAIRequest, id = `consent-${++seq}`) => createConsent(p, { grantedAt: clock, id }),
  };
}

export const baseInput = (over: Partial<AIPrepareInput> = {}): AIPrepareInput => ({
  providerId: 'mock',
  modelId: 'mock-text',
  purpose: 'general_question',
  instruction: 'Explique o resumo fictício.',
  ...over,
});

/** Fontes com os registros completos do app (IDs, perfil, observações, foto), para provar a minimização. */
export function richSources() {
  const s = session('sess-11111111-2222-4333-8444-555555555555', {
    profileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    notes: 'observação pessoal secreta',
    startedAt: new Date(2030, 0, 15, 10).getTime(),
  });
  const body = entry('body-entry-id-1', {
    profileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    date: '2030-01-10',
    notes: 'nota pessoal da avaliação',
    skinfolds: { Tricipital: 12 },
  });
  return {
    trainingSummary: { periodDays: 28, sessions: 9, totalSets: 120, totalVolumeKg: 15432.123, consistencyPct: 75, muscleGroups: [{ name: 'Peito', sets: 30 }] },
    trainingSessions: [s],
    bodyEntries: [body, { ...body, id: 'body-entry-id-2', date: '2030-02-10', weightKg: 79 }],
    bodyEvolution: [{ metric: { key: 'weightKg', label: 'Peso corporal', unit: 'kg' }, first: 80, last: 79, delta: -1, verdict: 'neutral' }],
    profilePreferences: { id: 'settings', userName: 'Fulano Fictício', weightUnit: 'kg', trainingDays: [1, 3, 5], goal: 'hypertrophy', activeRoutineId: 'r1' },
    photos: [{ id: 'p1', entryId: 'body-entry-id-1', dataUrl: 'data:image/jpeg;base64,AAAA' }],
  };
}

/** Bloqueia rede para provar que nada sai do aparelho. Devolve os espiões. */
export function blockNetwork() {
  const fetch = vi.fn(() => Promise.reject(new Error('rede proibida nos testes de IA')));
  const xhr = vi.fn(() => {
    throw new Error('XMLHttpRequest proibido');
  });
  const ws = vi.fn(() => {
    throw new Error('WebSocket proibido');
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('XMLHttpRequest', xhr);
  vi.stubGlobal('WebSocket', ws);
  return { fetch, xhr, ws };
}
