// IA da conta (Prompt 21, docs/NUVEM_API.md §IA). Mesmo contrato do gateway (`irontrack.ai-gateway.v1`) para o app
// reutilizar o GatewayAIProvider, mas o acesso é pela SESSÃO da conta (sem token compartilhado) e os limites são
// persistidos no PostgreSQL por conta: requisições por minuto, solicitações e tokens por dia. A simultaneidade é por
// processo (memória), somada ao teto total de chamadas ao provedor.
// Nada do conteúdo (perguntas, respostas, dados do treino) é gravado: `ai_usage_events` guarda só metadados.
// Hotfix 21.2: diagnóstico do provedor separado por estado (chave ausente, formato errado, não testada, ok, recusada,
// sem permissão, faturamento, limite, rede) e por modelo (inexistente/não liberado). O estado vem da última resposta
// real do provedor ou do "Testar" (POST /api/v1/ai/test), que usa uma consulta SEM custo (Models API): nenhuma chamada
// paga automática, nada é consultado ao abrir a tela. Fica em memória: reiniciar o serviço (ex.: ao trocar a chave
// na Railway) volta a "não testada".
import { GATEWAY_ERRORS, GatewayError, errorBody, isGatewayError, type GatewayErrorCode } from '../../../ai-gateway/src/errors.ts';
import { isProviderId, type GatewayConfig, type ProviderId } from '../../../ai-gateway/src/config.ts';
import { raceAbort, runGeneration, type GenerationLog } from '../../../ai-gateway/src/generation.ts';
import type { UsageStore } from '../../../ai-gateway/src/limits.ts';
import { utcDay } from '../../../ai-gateway/src/limits.ts';
import { PROTOCOL_VERSION, parseGenerateRequest, type CatalogResponse, type ModelHealth, type ProviderHealth } from '../../../ai-gateway/src/protocol.ts';
import { ADAPTERS } from '../../../ai-gateway/src/providers/index.ts';
import type { FetchLike, UpstreamAdapter } from '../../../ai-gateway/src/providers/types.ts';
import type { ApiConfig } from '../config.ts';
import type { Pool } from '../db/pool.ts';
import { ApiError, readJson, type RequestCtx, type Router } from '../http/core.ts';
import type { Logger } from '../lib/log.ts';

/** Cota e limites por conta, persistidos (valem com várias instâncias e após reinícios). */
export class PgUsageStore implements UsageStore {
  private readonly inFlight = new Map<string, number>();
  private readonly pool: Pool;
  private readonly dailyRequests: number;
  constructor(pool: Pool, dailyRequests: number) {
    this.pool = pool;
    this.dailyRequests = dailyRequests;
  }

  async hit(userId: string): Promise<number> {
    const r = await this.pool.query<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET
         window_start = CASE WHEN rate_limits.window_start <= now() - interval '60 seconds' THEN now() ELSE rate_limits.window_start END,
         count = CASE WHEN rate_limits.window_start <= now() - interval '60 seconds' THEN 1 ELSE rate_limits.count + 1 END
       RETURNING count`,
      [`ai-rpm:${userId}`],
    );
    return r.rows[0]?.count ?? 1;
  }

  async reserve(userId: string, day: string, amount: number, budget: number): Promise<boolean> {
    if (amount > budget) return false;
    // Atômico: a linha só muda se continuar dentro da cota de tokens E de solicitações do dia.
    const r = await this.pool.query(
      `INSERT INTO ai_usage_daily (user_id, day, tokens, requests) VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET tokens = ai_usage_daily.tokens + $3, requests = ai_usage_daily.requests + 1
       WHERE ai_usage_daily.tokens + $3 <= $4 AND ai_usage_daily.requests < $5
       RETURNING tokens`,
      [userId, day, amount, budget, this.dailyRequests],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async settle(userId: string, day: string, reserved: number, actual: number): Promise<void> {
    await this.pool.query('UPDATE ai_usage_daily SET tokens = GREATEST(0, tokens - $3 + $4) WHERE user_id = $1 AND day = $2', [userId, day, reserved, actual]);
  }

  async acquire(userId: string, max: number): Promise<boolean> {
    const n = this.inFlight.get(userId) ?? 0;
    if (n >= max) return false;
    this.inFlight.set(userId, n + 1);
    return true;
  }

  async release(userId: string): Promise<void> {
    const n = (this.inFlight.get(userId) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(userId);
    else this.inFlight.set(userId, n);
  }
}

export interface AiDeps {
  cfg: ApiConfig;
  pool: Pool;
  log: Logger;
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
  adapters?: Partial<Record<ProviderId, UpstreamAdapter>>;
  now?: () => number;
}

export interface AiModule {
  /** Algum provedor habilitado com chave utilizável no servidor. */
  available(): boolean;
  /** Linhas para o log de inicialização: estado de cada provedor habilitado, nunca o valor de uma chave. */
  describe(): string[];
  register(router: Router): void;
}

/** Formato mínimo de uma chave de API por provedor (pega valor colado errado sem chamar o provedor). */
const KEY_FORMAT: Partial<Record<ProviderId, (k: string) => boolean>> = {
  // Chave da Claude API: "sk-ant-api…". Chave de administração ("sk-ant-admin…") não gera mensagens.
  anthropic: (k) => /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(k) && !k.startsWith('sk-ant-admin'),
};

/** Código de erro do provedor → estado do provedor (ou do modelo) para o diagnóstico. */
const HEALTH_OF: Partial<Record<GatewayErrorCode, ProviderHealth>> = {
  provider_auth_failed: 'auth_failed',
  provider_forbidden: 'forbidden',
  provider_billing: 'billing',
  provider_rate_limited: 'rate_limited',
  provider_unreachable: 'network',
  timeout: 'network',
};

/** Estados em que o provedor pode ser escolhido (a chave existe e não foi recusada). */
const USABLE: readonly ProviderHealth[] = ['unverified', 'ok', 'forbidden', 'billing', 'rate_limited', 'network'];

/** Tempo limite do diagnóstico (consulta sem custo). */
const CHECK_TIMEOUT_MS = 10_000;
/** Diagnósticos por conta por minuto (cada um é uma chamada ao provedor, ainda que sem custo). */
const CHECKS_PER_MINUTE = 5;

const sendGatewayError = (code: GatewayErrorCode) => ({ status: GATEWAY_ERRORS[code].status, body: errorBody(code), ...(code === 'rate_limited' ? { headers: { 'retry-after': '60' } } : {}) });

export function createAiModule(d: AiDeps): AiModule {
  const config: GatewayConfig | null = d.cfg.ai.config && d.cfg.ai.config.enabled ? d.cfg.ai.config : null;
  const store = new PgUsageStore(d.pool, d.cfg.ai.dailyRequests);
  const upstream = { active: 0 };
  const now = d.now ?? Date.now;
  const fetchFn: FetchLike = d.fetch ?? ((url, init) => fetch(url, init));
  const adapters = { ...ADAPTERS, ...d.adapters };

  const rawKeyOf = (id: ProviderId): string | undefined => {
    const p = config?.providers[id];
    const v = p ? d.env[p.apiKeyEnv] : undefined;
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  };
  const keyFormatOk = (id: ProviderId, k: string) => k.length >= 8 && (KEY_FORMAT[id]?.(k) ?? true);
  /** Chave utilizável: presente, com formato de chave e não recusada pelo provedor. */
  const keyOf = (id: ProviderId): string | undefined => {
    const k = rawKeyOf(id);
    return k && keyFormatOk(id, k) && health.get(id)?.status !== 'auth_failed' ? k : undefined;
  };

  /** Último estado confirmado pelo provedor (em memória, por processo). */
  const health = new Map<ProviderId, { status: ProviderHealth; at: string }>();
  const modelHealth = new Map<string, ModelHealth>();
  const mkey = (id: ProviderId, model: string) => `${id}\u0000${model}`;
  const providerStatus = (id: ProviderId): ProviderHealth => {
    const k = rawKeyOf(id);
    if (!k) return 'missing_key';
    if (!keyFormatOk(id, k)) return 'invalid_key_format';
    return health.get(id)?.status ?? 'unverified';
  };
  /** Registra o que o provedor respondeu (resposta real ou diagnóstico). */
  function record(id: ProviderId, model: string, outcome: 'ok' | GatewayErrorCode, source: 'generate' | 'test') {
    const at = new Date(now()).toISOString();
    if (outcome === 'ok') {
      // O teste sem custo não confere créditos: um problema de faturamento só sai com uma resposta real aceita.
      if (source === 'test' && health.get(id)?.status === 'billing') health.set(id, { status: 'billing', at });
      else health.set(id, { status: 'ok', at });
      modelHealth.set(mkey(id, model), 'ok');
      return;
    }
    if (outcome === 'model_unavailable') {
      modelHealth.set(mkey(id, model), 'unavailable');
      // O provedor aceitou a chave para responder sobre o modelo: uma recusa anterior da chave deixa de valer.
      if (health.get(id)?.status === 'auth_failed') health.delete(id);
      return;
    }
    const h = HEALTH_OF[outcome];
    if (h) health.set(id, { status: h, at });
  }

  const catalog = (): CatalogResponse => ({
    protocol: PROTOCOL_VERSION,
    providers: config
      ? (Object.entries(config.providers) as [ProviderId, NonNullable<GatewayConfig['providers'][ProviderId]>][])
          .filter(([, p]) => p.enabled)
          .map(([id, p]) => {
            const status = providerStatus(id);
            const at = health.get(id)?.at;
            return {
              id,
              displayName: p.displayName,
              available: USABLE.includes(status),
              status,
              ...(at && status !== 'missing_key' && status !== 'invalid_key_format' ? { checkedAt: at } : {}),
              models: p.models.map((m) => ({ id: m.id, displayName: m.displayName, maxInputChars: m.maxInputChars, maxOutputTokens: m.maxOutputTokens, status: modelHealth.get(mkey(id, m.id)) ?? 'unverified' })),
            };
          })
      : [],
  });
  const available = () => catalog().providers.some((p) => p.available);
  /** Nenhuma chave sai numa resposta, aconteça o que acontecer. */
  const secrets = () => (config ? (Object.keys(config.providers) as ProviderId[]).map(rawKeyOf).filter((s): s is string => !!s) : []);
  const leaks = (body: unknown) => {
    const text = JSON.stringify(body);
    return secrets().some((s) => text.includes(s));
  };

  /** POST /api/v1/ai/test — diagnóstico sem custo do provedor (e do modelo) escolhido. Nenhum dado pessoal sai. */
  async function test(ctx: RequestCtx) {
    const a = ctx.auth!;
    if (!config) return sendGatewayError('gateway_disabled');
    if (d.cfg.ai.requireVerifiedEmail && !a.emailVerified) throw new ApiError('email_not_verified');
    let json: unknown;
    try {
      json = await readJson(ctx, 1024);
    } catch {
      return sendGatewayError('request_invalid');
    }
    const b = json as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'provider' && k !== 'model')) return sendGatewayError('request_invalid');
    const pid = b.provider;
    if (!isProviderId(pid) || !config.providers[pid]?.enabled) return sendGatewayError('provider_not_allowed');
    const pcfg = config.providers[pid]!;
    const model = b.model === undefined ? pcfg.models[0] : pcfg.models.find((m) => m.id === b.model);
    if (!model) return sendGatewayError('model_not_allowed');
    const reply = (code: 'ok' | GatewayErrorCode | 'not_supported') => {
      const body = {
        provider: pid,
        model: model.id,
        result: code,
        status: providerStatus(pid),
        modelStatus: modelHealth.get(mkey(pid, model.id)) ?? 'unverified',
        checkedAt: new Date(now()).toISOString(),
        paid: false,
      };
      return leaks(body) ? sendGatewayError('internal_error') : { status: 200, body };
    };
    const status = providerStatus(pid);
    // Sem chave utilizável não há o que perguntar ao provedor (nenhuma rede).
    if (status === 'missing_key' || status === 'invalid_key_format') return reply('provider_unavailable');
    if ((await store.hit(`test:${a.userId}`)) > CHECKS_PER_MINUTE) return sendGatewayError('rate_limited');
    const adapter = adapters[pid];
    if (!adapter.check) return reply('not_supported');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(new GatewayError('cancelled'));
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new GatewayError('timeout')), CHECK_TIMEOUT_MS);
    let outcome: 'ok' | GatewayErrorCode;
    try {
      await raceAbort(
        adapter.check(model.id, { apiKey: rawKeyOf(pid)!, fetch: fetchFn, signal: ctrl.signal, baseUrl: pcfg.baseUrl ?? adapter.defaultBaseUrl, maxResponseBytes: config.limits.maxUpstreamResponseBytes, ...(pcfg.apiVersion ? { apiVersion: pcfg.apiVersion } : {}) }),
        ctrl.signal,
      );
      outcome = 'ok';
    } catch (e) {
      outcome = ctrl.signal.aborted && isGatewayError(ctrl.signal.reason) ? ctrl.signal.reason.code : isGatewayError(e) ? e.code : 'internal_error';
      if (outcome === 'internal_error') d.log.error('ai.test', e);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
    if (outcome === 'cancelled') return sendGatewayError('cancelled');
    // Uma chave recusada antes só volta a valer quando o provedor a aceita de novo num teste.
    record(pid, model.id, outcome, 'test');
    return reply(outcome);
  }

  async function generate(ctx: RequestCtx) {
    const a = ctx.auth!;
    if (!config) return sendGatewayError('gateway_disabled');
    if (d.cfg.ai.requireVerifiedEmail && !a.emailVerified) throw new ApiError('email_not_verified');
    const started = now();
    const log: GenerationLog = {};
    let status = 'ok';
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(new GatewayError('cancelled'));
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new GatewayError('timeout')), config.limits.upstreamTimeoutMs);
    try {
      if ((await store.hit(a.userId)) > config.limits.requestsPerMinute) {
        status = 'rate_limited';
        return sendGatewayError('rate_limited');
      }
      let json: unknown;
      try {
        json = await readJson(ctx, config.limits.maxBodyBytes);
      } catch (e) {
        status = 'request_invalid';
        return sendGatewayError(e instanceof ApiError && e.code === 'payload_too_large' ? 'payload_too_large' : 'request_invalid');
      }
      const body = parseGenerateRequest(json, config.limits);
      // A chave pode ter sido recusada por outra conta desde que este usuário abriu a tela.
      if (isProviderId(body.provider) && providerStatus(body.provider) === 'auth_failed') {
        status = 'provider_auth_failed';
        return sendGatewayError('provider_auth_failed');
      }
      const result = await runGeneration(
        { store, adapters, fetch: fetchFn, now, upstream },
        { config, body, clientId: a.userId, dailyBudget: d.cfg.ai.dailyTokenBudget, maxConcurrent: d.cfg.ai.maxConcurrentPerUser, signal: ctrl.signal, apiKeyFor: keyOf, log },
      );
      record(result.provider as ProviderId, result.model, 'ok', 'generate');
      if (leaks(result)) {
        status = 'internal_error';
        return sendGatewayError('internal_error');
      }
      return { status: 200, body: result };
    } catch (e) {
      const code: GatewayErrorCode = ctrl.signal.aborted && isGatewayError(ctrl.signal.reason) ? ctrl.signal.reason.code : isGatewayError(e) ? e.code : 'internal_error';
      status = code;
      if (code === 'internal_error') d.log.error('ai.generate', e);
      // Só o que veio do provedor muda o diagnóstico (limites e validações do servidor não).
      if (log.provider && log.model && isProviderId(log.provider) && (code === 'model_unavailable' || HEALTH_OF[code])) record(log.provider, log.model, code, 'generate');
      return sendGatewayError(code);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      if (log.provider && log.model)
        await d.pool
          .query('INSERT INTO ai_usage_events (user_id, provider, model, status, input_tokens, output_tokens, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
            a.userId,
            log.provider,
            log.model,
            status.slice(0, 40),
            log.inputTokens ?? null,
            log.outputTokens ?? null,
            Math.max(0, now() - started),
          ])
          .catch((err) => d.log.error('ai.usage_event', err));
    }
  }

  return {
    available,
    describe() {
      if (!config) return ['IA: desativada (configuração ausente ou inválida).'];
      return (Object.entries(config.providers) as [ProviderId, NonNullable<GatewayConfig['providers'][ProviderId]>][])
        .filter(([, p]) => p.enabled)
        .map(([id, p]) => {
          const st = providerStatus(id);
          const what =
            st === 'missing_key'
              ? `variável ${p.apiKeyEnv} AUSENTE neste serviço (configure-a no irontrack-api e implante)`
              : st === 'invalid_key_format'
                ? `variável ${p.apiKeyEnv} presente, mas o valor não tem o formato de uma chave de API (confira se colou a chave certa, sem aspas)`
                : `chave em ${p.apiKeyEnv} configurada; ainda não validada (use "Testar" no app)`;
          return `IA: ${p.displayName} — ${what}; modelos: ${p.models.map((m) => m.id).join(', ')}.`;
        });
    },
    register(router) {
      router.add({ method: 'GET', path: '/api/v1/ai/models', auth: 'session', handler: async () => (config ? { status: 200, body: catalog() } : sendGatewayError('gateway_disabled')) });
      router.add({ method: 'POST', path: '/api/v1/ai/generate', auth: 'session', maxBody: 64 * 1024, handler: generate });
      router.add({ method: 'POST', path: '/api/v1/ai/test', auth: 'session', maxBody: 1024, handler: test });
      router.add({
        method: 'GET',
        path: '/api/v1/ai/usage',
        auth: 'session',
        handler: async (ctx) => {
          const r = await d.pool.query<{ tokens: number; requests: number }>('SELECT tokens, requests FROM ai_usage_daily WHERE user_id = $1 AND day = $2', [ctx.auth!.userId, utcDay(now())]);
          return {
            status: 200,
            body: {
              day: utcDay(now()),
              tokensUsed: r.rows[0]?.tokens ?? 0,
              requestsUsed: r.rows[0]?.requests ?? 0,
              dailyTokenBudget: d.cfg.ai.dailyTokenBudget,
              dailyRequests: d.cfg.ai.dailyRequests,
              requestsPerMinute: config?.limits.requestsPerMinute ?? 0,
              requiresVerifiedEmail: d.cfg.ai.requireVerifiedEmail,
            },
          };
        },
      });
    },
  };
}
