// Raiz de composição do assistente de IA (IronTrack 2.0 F01/P05–P06). É o ÚNICO lugar do app que
// conhece adaptadores de provedor: registra o provedor simulado (padrão, offline) e, só quando o
// usuário conecta um gateway, os provedores remotos que esse gateway permite. A interface recebe o
// AIService e descrições públicas (sem adaptador, sem token, sem chave).
// Sem gateway conectado, nada sai do aparelho e o app funciona offline como antes.
import { AIError, AIService, ProviderRegistry, type AIProviderDescriptor } from '@/modules/ai';
import { MockAIProvider } from '@/modules/ai/adapters/MockAIProvider';
import { GatewayAIProvider, gatewayErrorCode, parseGatewayCatalog, type GatewayTransport } from '@/modules/ai/adapters/GatewayAIProvider';
import { createGatewayTransport, isAccessTokenFormat, validateGatewayUrl } from './gatewayTransport';

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
/** Tempo limite de cada execução simulada no assistente. */
export const ASSISTANT_TIMEOUT_MS = 30_000;
/** Tempo limite de uma execução remota (maior que o tempo limite padrão do gateway, 30 s). */
export const REMOTE_TIMEOUT_MS = 45_000;
/** Tempo limite para buscar o catálogo do gateway. */
export const CATALOG_TIMEOUT_MS = 10_000;

/** Provedor remoto oferecido pelo gateway conectado. */
export interface RemoteProviderInfo extends AIProviderDescriptor {
  /** false = permitido no gateway, mas sem chave configurada lá. */
  available: boolean;
}

export interface GatewayConnection {
  origin: string;
  providers: RemoteProviderInfo[];
}

export interface AssistantComposition {
  service: AIService;
  /** Provedor simulado (sempre presente, padrão). */
  providers: AIProviderDescriptor[];
  /** Muda o cenário da demonstração. Não altera dados nem a solicitação preparada. */
  setScenario(s: DemoScenario): void;
  /**
   * Conecta a um gateway por ação explícita do usuário: valida o endereço e o formato do token,
   * busca o catálogo (só o token vai junto; nenhum dado pessoal) e registra os provedores remotos.
   * Não seleciona nenhum deles. Substitui uma conexão anterior.
   */
  connectGateway(input: { url: string; token: string }, signal?: AbortSignal): Promise<GatewayConnection>;
  /** Esquece o gateway: remove os provedores remotos e descarta o token da memória. */
  disconnectGateway(): void;
  /**
   * P20: "Testar conexão" — busca de novo o catálogo com o token já em memória (sem dados pessoais) e atualiza a
   * disponibilidade de cada provedor. Falha com o mesmo erro tipado da conexão.
   */
  testGateway(signal?: AbortSignal): Promise<GatewayConnection>;
}

export interface AssistantCompositionOptions {
  latencyMs?: number;
  scenario?: DemoScenario;
  now?: () => number;
  randomId?: () => string;
  /** Implementação de fetch para o transporte do gateway (testes). */
  fetchImpl?: typeof fetch;
  /** Substitui o transporte inteiro (testes). */
  transportFactory?: (origin: string, token: string) => GatewayTransport;
}

/**
 * Monta um serviço novo por tela: registro, autorizações usadas, token e conversa vivem só na
 * memória daquela página. Sem logger: nenhum evento (nem sem conteúdo) é gravado ou enviado.
 */
export function createAssistantService(opts: AssistantCompositionOptions = {}): AssistantComposition {
  const registry = new ProviderRegistry();
  const mock = new MockAIProvider({ latencyMs: opts.latencyMs ?? DEMO_LATENCY_MS, behavior: opts.scenario ?? 'echo' });
  registry.register(mock);
  const service = new AIService({ registry, ...(opts.now ? { now: opts.now } : {}), ...(opts.randomId ? { randomId: opts.randomId } : {}) });
  let remoteIds: string[] = [];
  let generation = 0;
  let current: { origin: string; transport: GatewayTransport } | null = null;

  const disconnectGateway = () => {
    generation++;
    for (const id of remoteIds) registry.unregister(id);
    remoteIds = [];
    current = null;
  };

  /** Catálogo do gateway com tempo limite e cancelamento. */
  async function fetchCatalog(transport: GatewayTransport, signal?: AbortSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await transport({ method: 'GET', path: '/v1/models', signal: ctrl.signal });
    } catch (e) {
      if (signal?.aborted) throw new AIError('cancelled');
      if (ctrl.signal.aborted) throw new AIError('gateway_unreachable');
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (res.status !== 200) throw new AIError(gatewayErrorCode(res.status, res.body));
    return parseGatewayCatalog(res.body);
  }

  return {
    service,
    providers: service
      .listProviders()
      .map((p) => ({ ...p, models: p.models.filter((m) => ASSISTANT_MODEL_IDS.includes(m.id) && m.capabilities.textGeneration) }))
      .filter((p) => p.models.length > 0),
    setScenario: (s) => {
      if ((DEMO_SCENARIOS as readonly string[]).includes(s)) mock.behavior = s;
    },
    disconnectGateway,
    async connectGateway({ url, token }, signal) {
      const check = validateGatewayUrl(url);
      if (!check.ok) throw new AIError('provider_invalid');
      const tok = typeof token === 'string' ? token.trim() : '';
      if (!isAccessTokenFormat(tok)) throw new AIError('access_denied');
      disconnectGateway();
      const mine = generation;
      const transport = opts.transportFactory ? opts.transportFactory(check.origin, tok) : createGatewayTransport({ origin: check.origin, token: tok, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
      const entries = await fetchCatalog(transport, signal);
      // Outra conexão (ou desconexão) começou enquanto esta esperava: descarta.
      if (mine !== generation) throw new AIError('cancelled');
      const infos: RemoteProviderInfo[] = [];
      for (const entry of entries) {
        if (registry.has(entry.id)) continue;
        registry.register(new GatewayAIProvider({ entry, transport, gatewayOrigin: check.origin }));
        remoteIds.push(entry.id);
        const d = service.listProviders().find((p) => p.id === entry.id)!;
        infos.push({ ...d, available: entry.available });
      }
      current = { origin: check.origin, transport };
      return { origin: check.origin, providers: infos };
    },
    async testGateway(signal) {
      if (!current) throw new AIError('gateway_unreachable');
      const mine = generation;
      const { origin, transport } = current;
      const entries = await fetchCatalog(transport, signal);
      if (mine !== generation) throw new AIError('cancelled');
      const offered = new Map(entries.map((e) => [e.id, e.available]));
      const providers = remoteIds.flatMap((id) => {
        const d = service.listProviders().find((p) => p.id === id);
        return d ? [{ ...d, available: offered.get(id) === true }] : [];
      });
      return { origin, providers };
    },
  };
}
