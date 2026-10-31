// Raiz de composição do assistente de IA (IronTrack 2.0 F01/P05–P06). É o ÚNICO lugar do app que
// conhece adaptadores de provedor: registra o provedor simulado (padrão, offline) e, só quando o
// usuário conecta um gateway, os provedores remotos que esse gateway permite. A interface recebe o
// AIService e descrições públicas (sem adaptador, sem token, sem chave).
// Sem gateway conectado, nada sai do aparelho e o app funciona offline como antes.
import { AIError, AIService, ProviderRegistry, type AIProviderDescriptor } from '@/modules/ai';
import { MockAIProvider } from '@/modules/ai/adapters/MockAIProvider';
import { GatewayAIProvider, PROVIDER_HEALTH, gatewayErrorCode, parseGatewayCatalog, type GatewayProviderEntry, type GatewayTransport, type ModelHealth, type ProviderHealth } from '@/modules/ai/adapters/GatewayAIProvider';
import { createAccountTransport, createGatewayTransport, isAccessTokenFormat, validateGatewayUrl } from './gatewayTransport';

/** P21: rótulo do destino quando a IA é usada pela conta (no lugar do endereço do gateway). */
export const ACCOUNT_GATEWAY_LABEL = 'Servidor do IronTrack (sua conta)';

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
  /** false = permitido no gateway, mas sem chave utilizável lá. */
  available: boolean;
  /** Hotfix 21.2 (IA pela conta): diagnóstico do provedor e de cada modelo. Ausente no gateway P06. */
  status?: ProviderHealth;
  checkedAt?: string;
  modelStatus?: Record<string, ModelHealth>;
}

/** Hotfix 21.2: resultado do "Testar" da IA pela conta (consulta sem custo ao provedor, feita pelo servidor). */
export interface AccountTestResult {
  providerId: string;
  modelId: string;
  /** 'ok', 'not_supported' ou o código de erro normalizado do servidor (nunca texto do provedor). */
  result: string;
  status?: ProviderHealth;
  modelStatus?: ModelHealth;
  checkedAt?: string;
}

export type { ModelHealth, ProviderHealth };

/** Tempo limite do "Testar" (o servidor espera até 10 s pelo provedor). */
export const TEST_TIMEOUT_MS = 15_000;

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
  /**
   * P21: conecta pela conta (sessão do app, mesma origem). Sem token digitado e sem endereço: as chaves ficam na
   * Railway e a cota é por conta. Busca só o catálogo (sem dados pessoais) e registra os provedores habilitados.
   */
  connectAccount(signal?: AbortSignal): Promise<GatewayConnection>;
  /**
   * Hotfix 21.2: "Testar" da IA pela conta. O servidor faz uma consulta SEM custo ao provedor (chave aceita? modelo
   * existe e está liberado?) e o catálogo é buscado de novo com o estado atualizado. Nenhum dado pessoal sai.
   */
  testAccount(providerId: string, modelId: string | undefined, signal?: AbortSignal): Promise<{ test: AccountTestResult; connection: GatewayConnection }>;
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
  /** P21: substitui o transporte da conta (testes). */
  accountTransportFactory?: () => GatewayTransport;
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
  let current: { origin: string; transport: GatewayTransport; account?: boolean } | null = null;

  const disconnectGateway = () => {
    generation++;
    for (const id of remoteIds) registry.unregister(id);
    remoteIds = [];
    current = null;
  };

  /** Registra os provedores do catálogo (substituindo os anteriores) e devolve as descrições públicas. */
  function registerEntries(entries: GatewayProviderEntry[], transport: GatewayTransport, origin: string): RemoteProviderInfo[] {
    for (const id of remoteIds) registry.unregister(id);
    remoteIds = [];
    const infos: RemoteProviderInfo[] = [];
    for (const entry of entries) {
      if (registry.has(entry.id)) continue;
      registry.register(new GatewayAIProvider({ entry, transport, gatewayOrigin: origin }));
      remoteIds.push(entry.id);
      const d = service.listProviders().find((p) => p.id === entry.id)!;
      infos.push({
        ...d,
        available: entry.available,
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.checkedAt ? { checkedAt: entry.checkedAt } : {}),
        ...(entry.modelStatus ? { modelStatus: entry.modelStatus } : {}),
      });
    }
    return infos;
  }

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
    async connectAccount(signal) {
      disconnectGateway();
      const mine = generation;
      const transport = opts.accountTransportFactory ? opts.accountTransportFactory() : createAccountTransport(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
      const entries = await fetchCatalog(transport, signal);
      if (mine !== generation) throw new AIError('cancelled');
      const infos = registerEntries(entries, transport, ACCOUNT_GATEWAY_LABEL);
      current = { origin: ACCOUNT_GATEWAY_LABEL, transport, account: true };
      return { origin: ACCOUNT_GATEWAY_LABEL, providers: infos };
    },
    async testAccount(providerId, modelId, signal) {
      if (!current?.account) throw new AIError('gateway_unreachable');
      const mine = generation;
      const { transport } = current;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let res;
      try {
        res = await transport({ method: 'POST', path: '/v1/test', body: { provider: providerId, ...(modelId ? { model: modelId } : {}) }, signal: ctrl.signal });
      } catch (e) {
        if (signal?.aborted) throw new AIError('cancelled');
        if (ctrl.signal.aborted) throw new AIError('timeout');
        throw e;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      if (res.status !== 200) throw new AIError(gatewayErrorCode(res.status, res.body));
      const b = res.body as Record<string, unknown> | null;
      if (!b || typeof b !== 'object' || b.provider !== providerId || typeof b.model !== 'string' || typeof b.result !== 'string' || !/^[a-z_]{1,40}$/.test(b.result)) throw new AIError('invalid_response');
      const test: AccountTestResult = {
        providerId,
        modelId: b.model,
        result: b.result,
        ...(typeof b.status === 'string' && (PROVIDER_HEALTH as readonly string[]).includes(b.status) ? { status: b.status as ProviderHealth } : {}),
        ...(b.modelStatus === 'ok' || b.modelStatus === 'unavailable' || b.modelStatus === 'unverified' ? { modelStatus: b.modelStatus } : {}),
        ...(typeof b.checkedAt === 'string' && b.checkedAt.length <= 40 ? { checkedAt: b.checkedAt } : {}),
      };
      const entries = await fetchCatalog(transport, signal);
      if (mine !== generation) throw new AIError('cancelled');
      const infos = registerEntries(entries, transport, ACCOUNT_GATEWAY_LABEL);
      return { test, connection: { origin: ACCOUNT_GATEWAY_LABEL, providers: infos } };
    },
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
      const infos = registerEntries(entries, transport, check.origin);
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
