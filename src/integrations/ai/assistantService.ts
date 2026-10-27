// Raiz de composição do assistente de IA (IronTrack 2.0 F01/P05). É o ÚNICO lugar do app que
// conhece um adaptador de provedor: aqui o provedor simulado é registrado e o serviço é montado.
// A interface recebe só o AIService e uma descrição pública do provedor; nunca o adaptador.
// Nenhum provedor real existe: nada sai do aparelho e não há rede, chave ou endpoint.
import { AIService, ProviderRegistry, type AIProviderDescriptor } from '@/modules/ai';
import { MockAIProvider } from '@/modules/ai/adapters/MockAIProvider';

/** Cenários do modo de demonstração (o comportamento do provedor simulado). */
export const DEMO_SCENARIOS = ['echo', 'hang', 'fail', 'invalid_response'] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export const DEMO_SCENARIO_LABEL: Record<DemoScenario, string> = {
  echo: 'Resposta simulada (normal)',
  hang: 'Sem resposta (até cancelar ou expirar)',
  fail: 'Simular falha do provedor',
  invalid_response: 'Simular resposta inválida',
};

/** Modelos simulados oferecidos no assistente (respostas em texto). O de JSON fica para etapas futuras. */
export const ASSISTANT_MODEL_IDS: readonly string[] = ['mock-text', 'mock-tiny'];

/** Atraso simulado da resposta: dá tempo de ver o processamento e de cancelar. */
export const DEMO_LATENCY_MS = 1_500;
/** Tempo limite de cada execução no assistente. */
export const ASSISTANT_TIMEOUT_MS = 30_000;

export interface AssistantComposition {
  service: AIService;
  /** Provedores e modelos que a tela pode oferecer (descritores, sem o adaptador). */
  providers: AIProviderDescriptor[];
  /** Muda o cenário da demonstração. Não altera dados nem a solicitação preparada. */
  setScenario(s: DemoScenario): void;
}

export interface AssistantCompositionOptions {
  latencyMs?: number;
  scenario?: DemoScenario;
  now?: () => number;
  randomId?: () => string;
}

/**
 * Monta um serviço novo por tela: registro, autorizações usadas e conversa vivem só na memória
 * daquela página. Sem logger: nenhum evento (nem sem conteúdo) é gravado ou enviado.
 */
export function createAssistantService(opts: AssistantCompositionOptions = {}): AssistantComposition {
  const registry = new ProviderRegistry();
  const mock = new MockAIProvider({ latencyMs: opts.latencyMs ?? DEMO_LATENCY_MS, behavior: opts.scenario ?? 'echo' });
  registry.register(mock);
  const service = new AIService({ registry, ...(opts.now ? { now: opts.now } : {}), ...(opts.randomId ? { randomId: opts.randomId } : {}) });
  return {
    service,
    providers: service
      .listProviders()
      .map((p) => ({ ...p, models: p.models.filter((m) => ASSISTANT_MODEL_IDS.includes(m.id) && m.capabilities.textGeneration) }))
      .filter((p) => p.models.length > 0),
    setScenario: (s) => {
      if ((DEMO_SCENARIOS as readonly string[]).includes(s)) mock.behavior = s;
    },
  };
}
