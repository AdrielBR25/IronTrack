// IA da conta (Prompt 21, docs/NUVEM_API.md §IA). Mesmo contrato do gateway (`irontrack.ai-gateway.v1`) para o app
// reutilizar o GatewayAIProvider, mas o acesso é pela SESSÃO da conta (sem token compartilhado) e os limites são
// persistidos no PostgreSQL por conta: requisições por minuto, solicitações e tokens por dia. A simultaneidade é por
// processo (memória), somada ao teto total de chamadas ao provedor.
// Nada do conteúdo (perguntas, respostas, dados do treino) é gravado: `ai_usage_events` guarda só metadados.
import { GATEWAY_ERRORS, GatewayError, errorBody, isGatewayError, type GatewayErrorCode } from '../../../ai-gateway/src/errors.ts';
import { type GatewayConfig, type ProviderId } from '../../../ai-gateway/src/config.ts';
import { runGeneration, type GenerationLog } from '../../../ai-gateway/src/generation.ts';
import type { UsageStore } from '../../../ai-gateway/src/limits.ts';
import { utcDay } from '../../../ai-gateway/src/limits.ts';
import { PROTOCOL_VERSION, parseGenerateRequest, type CatalogResponse } from '../../../ai-gateway/src/protocol.ts';
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
  /** Algum provedor habilitado com chave configurada no servidor. */
  available(): boolean;
  register(router: Router): void;
}

const sendGatewayError = (code: GatewayErrorCode) => ({ status: GATEWAY_ERRORS[code].status, body: errorBody(code), ...(code === 'rate_limited' ? { headers: { 'retry-after': '60' } } : {}) });

export function createAiModule(d: AiDeps): AiModule {
  const config: GatewayConfig | null = d.cfg.ai.config && d.cfg.ai.config.enabled ? d.cfg.ai.config : null;
  const store = new PgUsageStore(d.pool, d.cfg.ai.dailyRequests);
  const upstream = { active: 0 };
  const now = d.now ?? Date.now;
  const fetchFn: FetchLike = d.fetch ?? ((url, init) => fetch(url, init));
  const adapters = { ...ADAPTERS, ...d.adapters };

  const keyOf = (id: ProviderId): string | undefined => {
    const p = config?.providers[id];
    const v = p ? d.env[p.apiKeyEnv] : undefined;
    return typeof v === 'string' && v.trim().length >= 8 ? v.trim() : undefined;
  };
  const catalog = (): CatalogResponse => ({
    protocol: PROTOCOL_VERSION,
    providers: config
      ? (Object.entries(config.providers) as [ProviderId, NonNullable<GatewayConfig['providers'][ProviderId]>][])
          .filter(([, p]) => p.enabled)
          .map(([id, p]) => ({ id, displayName: p.displayName, available: !!keyOf(id), models: p.models.map((m) => ({ ...m })) }))
      : [],
  });
  const available = () => catalog().providers.some((p) => p.available);
  /** Nenhuma chave sai numa resposta, aconteça o que acontecer. */
  const secrets = () => (config ? (Object.keys(config.providers) as ProviderId[]).map(keyOf).filter((s): s is string => !!s) : []);

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
      const result = await runGeneration(
        { store, adapters, fetch: fetchFn, now, upstream },
        { config, body, clientId: a.userId, dailyBudget: d.cfg.ai.dailyTokenBudget, maxConcurrent: d.cfg.ai.maxConcurrentPerUser, signal: ctrl.signal, apiKeyFor: keyOf, log },
      );
      const text = JSON.stringify(result);
      if (secrets().some((s) => text.includes(s))) {
        status = 'internal_error';
        return sendGatewayError('internal_error');
      }
      return { status: 200, body: result };
    } catch (e) {
      const code: GatewayErrorCode = ctrl.signal.aborted && isGatewayError(ctrl.signal.reason) ? ctrl.signal.reason.code : isGatewayError(e) ? e.code : 'internal_error';
      status = code;
      if (code === 'internal_error') d.log.error('ai.generate', e);
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
    register(router) {
      router.add({ method: 'GET', path: '/api/v1/ai/models', auth: 'session', handler: async () => (config ? { status: 200, body: catalog() } : sendGatewayError('gateway_disabled')) });
      router.add({ method: 'POST', path: '/api/v1/ai/generate', auth: 'session', maxBody: 64 * 1024, handler: generate });
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
