// Montagem da API: rotas, sessão, CSRF, CORS restrito, limites de corpo e tempo, erros normalizados e log de acesso.
// Ordem das proteções em cada requisição: cabeçalhos de segurança → CORS (só origens permitidas) → rota → tempo limite
// → CSRF (alterações) → sessão (rotas autenticadas) → validação do corpo (no módulo) → autorização por recurso
// (toda consulta filtra pela conta da sessão) → resposta sem segredos.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { API_ERRORS, CSRF_HEADER } from '../../../shared/api/errors.ts';
import type { ApiConfig } from './config.ts';
import type { Pool } from './db/pool.ts';
import { pendingMigrations } from './db/migrate.ts';
import { ApiError, Router, checkCsrf, clientIp, errorPayload, isApiError, originAllowed, securityHeaders, sendJson, type RequestCtx } from './http/core.ts';
import { RateLimiter } from './lib/rateLimit.ts';
import { createLogger, type Logger } from './lib/log.ts';
import { createMailer, TestMailbox, type Mailer } from './mail/mailer.ts';
import { authRoutes, resolveSession, testRoutes } from './modules/auth.ts';
import { createAiModule, type AiDeps } from './modules/ai.ts';
import { exportRoutes } from './modules/exporter.ts';
import { importRoutes } from './modules/importer.ts';
import { syncRoutes } from './modules/sync.ts';

export interface ApiOptions {
  cfg: ApiConfig;
  pool: Pool;
  env?: Record<string, string | undefined>;
  mailer?: Mailer;
  logger?: Logger;
  /** Substituições da IA (testes: provedor simulado). */
  ai?: Pick<AiDeps, 'fetch' | 'adapters' | 'now'>;
}

export interface Api {
  server: Server;
  mailer: Mailer;
  limiter: RateLimiter;
  /** Requisições em andamento (encerramento gracioso). */
  inFlight(): number;
  /** Para de aceitar requisições, espera as em andamento até `graceMs` e fecha as conexões. */
  shutdown(graceMs?: number): Promise<void>;
  /** Limpeza periódica (limites vencidos, idempotência antiga, tokens expirados). */
  maintenance(): Promise<void>;
}

export function createApi(o: ApiOptions): Api {
  const { cfg, pool } = o;
  const log = o.logger ?? createLogger(cfg.accessLog);
  const mailer = o.mailer ?? createMailer(cfg);
  const limiter = new RateLimiter(pool, cfg.rateLimitSecret);
  const ai = createAiModule({ cfg, pool, log, env: o.env ?? process.env, ...o.ai });
  const router = new Router();

  router.add({ method: 'GET', path: '/api/v1/health', auth: 'public', handler: async () => ({ status: 200, body: { status: 'ok' } }) });
  router.add({
    method: 'GET',
    path: '/api/v1/ready',
    auth: 'public',
    handler: async () => {
      try {
        await pool.query('SELECT 1');
        const pending = await pendingMigrations(pool);
        return pending.length ? { status: 503, body: { status: 'migrations_pending', pending: pending.length } } : { status: 200, body: { status: 'ready' } };
      } catch {
        return { status: 503, body: { status: 'database_unavailable' } };
      }
    },
  });
  authRoutes(router, { cfg, pool, mailer, limiter, log, aiAvailable: () => ai.available() });
  syncRoutes(router, { pool, limiter });
  importRoutes(router, { pool, limiter });
  exportRoutes(router, { pool, limiter });
  ai.register(router);
  if (cfg.testMode && cfg.env !== 'production' && mailer instanceof TestMailbox) testRoutes(router, mailer);

  let running = 0;
  let draining = false;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    running++;
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctrl.abort(new ApiError('timeout'));
    });
    const ctx: RequestCtx = { req, res, method: req.method ?? 'GET', url: new URL('http://api.invalid/'), params: {}, ip: clientIp(req, cfg.trustProxyHops), signal: ctrl.signal, log: {} };
    let status = 500;
    const timer = setTimeout(() => ctrl.abort(new ApiError('timeout')), cfg.requestTimeoutMs);
    try {
      securityHeaders(res, cfg.env === 'production');
      const origin = req.headers.origin;
      const corsOk = typeof origin === 'string' && originAllowed(cfg, origin);
      if (corsOk) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('vary', 'Origin');
      }
      try {
        ctx.url = new URL(req.url ?? '/', 'http://api.invalid');
      } catch {
        throw new ApiError('bad_request');
      }
      if (draining) throw new ApiError('service_unavailable', undefined, { connection: 'close' });
      if (ctx.method === 'OPTIONS') {
        if (!corsOk || router.match('OPTIONS', ctx.url.pathname) === null) throw new ApiError('forbidden');
        res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE');
        res.setHeader('access-control-allow-headers', `content-type, ${CSRF_HEADER}`);
        res.setHeader('access-control-max-age', '600');
        status = 204;
        sendJson(res, 204, undefined);
        return;
      }
      const m = router.match(ctx.method, ctx.url.pathname);
      if (m === null) throw new ApiError('not_found');
      if (m === 'method') throw new ApiError('method_not_allowed');
      ctx.params = m.params;
      ctx.log.route = `${m.route.method} ${m.route.path}`;
      if (ctx.method !== 'GET' && !checkCsrf(cfg, req)) throw new ApiError('csrf_failed');
      if (m.route.auth !== 'public') {
        const s = await resolveSession({ cfg, pool }, req);
        if (!s) throw new ApiError('unauthenticated');
        if (m.route.auth === 'verified' && !s.emailVerified) throw new ApiError('email_not_verified');
        ctx.auth = s;
        ctx.log.userId = s.userId;
      }
      const reply = await Promise.race([
        m.route.handler(ctx),
        new Promise<never>((_, reject) => {
          if (ctrl.signal.aborted) reject(ctrl.signal.reason);
          ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason), { once: true });
        }),
      ]);
      status = reply?.status ?? 204;
      sendJson(res, status, reply?.body, reply?.headers ?? {});
    } catch (e) {
      const err = isApiError(e) ? e : new ApiError('internal_error');
      if (!isApiError(e)) log.error(ctx.log.route ?? 'outra', e);
      status = API_ERRORS[err.code].status;
      ctx.log.code = err.code;
      sendJson(res, status, errorPayload(err.code, err.fields), err.headers ?? {});
    } finally {
      clearTimeout(timer);
      running--;
      log.access({ ts: new Date(started).toISOString(), id: randomUUID(), method: ctx.method, route: ctx.log.route ?? 'outra', status, ms: Date.now() - started, ...(ctx.log.code ? { code: ctx.log.code } : {}), ...(ctx.log.userId ? { user: ctx.log.userId } : {}) });
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  server.headersTimeout = 15_000;
  server.requestTimeout = cfg.requestTimeoutMs + 10_000;
  server.maxHeadersCount = 60;
  server.keepAliveTimeout = 65_000; // acima do tempo ocioso dos proxies (evita 502 em conexões reaproveitadas)

  return {
    server,
    mailer,
    limiter,
    inFlight: () => running,
    async shutdown(graceMs = 10_000) {
      draining = true;
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      const deadline = Date.now() + graceMs;
      while (running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      server.closeAllConnections();
      await closed;
    },
    async maintenance() {
      await limiter.prune();
      await pool.query("DELETE FROM sync_operations WHERE created_at < now() - interval '30 days'");
      await pool.query("DELETE FROM email_verification_tokens WHERE expires_at < now() - interval '7 days'");
      await pool.query("DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '7 days'");
      await pool.query("DELETE FROM auth_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR expires_at < now() - interval '30 days'");
      await pool.query("DELETE FROM import_job_items WHERE job_id IN (SELECT id FROM import_jobs WHERE (status = 'committed' AND committed_at < now() - interval '7 days') OR (status = 'staging' AND created_at < now() - interval '2 days'))");
      await pool.query("UPDATE import_jobs SET status = 'cancelled' WHERE status = 'staging' AND created_at < now() - interval '2 days'");
      await pool.query("DELETE FROM ai_usage_events WHERE created_at < now() - interval '90 days'");
    },
  };
}
