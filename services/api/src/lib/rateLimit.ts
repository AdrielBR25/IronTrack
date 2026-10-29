// Limites de taxa persistidos no PostgreSQL (janela fixa). Valem com várias instâncias e após reinícios; a chave
// nunca contém IP ou e-mail em texto puro (HMAC com RATE_LIMIT_SECRET).
import type { Pool } from '../db/pool.ts';
import { ApiError } from '../http/core.ts';
import { keyedHash } from './crypto.ts';

export interface LimitRule {
  /** Nome curto do limite (aparece só na chave). */
  scope: string;
  limit: number;
  windowSec: number;
}

export const LIMITS = {
  signupIp: { scope: 'signup-ip', limit: 5, windowSec: 3600 },
  loginIp: { scope: 'login-ip', limit: 30, windowSec: 900 },
  loginEmail: { scope: 'login-email', limit: 10, windowSec: 900 },
  forgotIp: { scope: 'forgot-ip', limit: 10, windowSec: 3600 },
  forgotEmail: { scope: 'forgot-email', limit: 3, windowSec: 3600 },
  resetIp: { scope: 'reset-ip', limit: 20, windowSec: 3600 },
  verifyIp: { scope: 'verify-ip', limit: 30, windowSec: 3600 },
  verifyResendUser: { scope: 'verify-resend', limit: 3, windowSec: 3600 },
  passwordChangeUser: { scope: 'password-change', limit: 10, windowSec: 3600 },
  deleteUser: { scope: 'delete', limit: 5, windowSec: 3600 },
  syncUser: { scope: 'sync', limit: 240, windowSec: 60 },
  importUser: { scope: 'import', limit: 120, windowSec: 60 },
  exportUser: { scope: 'export', limit: 10, windowSec: 3600 },
} satisfies Record<string, LimitRule>;

export class RateLimiter {
  private readonly pool: Pool;
  private readonly secret: string;
  constructor(pool: Pool, secret: string) {
    this.pool = pool;
    this.secret = secret;
  }

  /** Conta uma tentativa; lança `rate_limited` (com Retry-After) se passar do limite. */
  async consume(rule: LimitRule, subject: string): Promise<void> {
    const bucket = `${rule.scope}:${keyedHash(this.secret, subject)}`;
    const r = await this.pool.query<{ count: number; retry: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET
         window_start = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END,
         count = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END
       RETURNING count, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - now())))::int AS retry`,
      [bucket, rule.windowSec],
    );
    const row = r.rows[0];
    if (row && row.count > rule.limit) throw new ApiError('rate_limited', undefined, { 'retry-after': String(Math.max(1, row.retry)) });
  }

  /** Remove janelas vencidas (chamado periodicamente). */
  async prune(): Promise<number> {
    const r = await this.pool.query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
    return r.rowCount ?? 0;
  }
}
