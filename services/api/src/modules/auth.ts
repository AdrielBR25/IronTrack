// Contas, sessões, verificação de e-mail e recuperação de senha (Prompt 21, docs/NUVEM_SEGURANCA.md §2–§5).
// Políticas:
//  - sessão opaca (256 bits) em cookie HttpOnly; no banco só o SHA-256; expiração absoluta e por inatividade; revogável;
//  - login não revela se o e-mail existe (mesma mensagem e tempo); recuperação idem (sempre 202);
//  - cadastro com e-mail já usado responde 409 genérico (enumeração residual aceita, limitada por IP; ver doc);
//  - conta não verificada pode entrar e usar o app; a IA pode exigir verificação (AI_REQUIRE_VERIFIED_EMAIL);
//  - redefinir senha revoga TODAS as sessões; trocar a senha revoga as OUTRAS.
import type { IncomingMessage } from 'node:http';
import { changePasswordSchema, deleteAccountSchema, forgotSchema, isStrongPassword, loginSchema, passwordRequirements, resetSchema, signupSchema, updateProfileSchema, verifySchema, type AccountInfo, type ServerFeatures, type SessionInfo } from '../../../../shared/api/auth.ts';
import type { ApiConfig } from '../config.ts';
import { pgCode, withTx, type Pool, type PoolClient } from '../db/pool.ts';
import { ApiError, clearSessionCookie, parseCookies, readJson, sessionCookie, type AuthState, type RequestCtx, type Router } from '../http/core.ts';
import { newToken, tokenHash, uuid } from '../lib/crypto.ts';
import type { Logger } from '../lib/log.ts';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from '../lib/passwords.ts';
import { LIMITS, type RateLimiter } from '../lib/rateLimit.ts';
import { MailError, type Mailer } from '../mail/mailer.ts';
import { resetEmail, securityNotice, verificationEmail } from '../mail/templates.ts';
import type { z } from 'zod';

export interface AuthDeps {
  cfg: ApiConfig;
  pool: Pool;
  mailer: Mailer;
  limiter: RateLimiter;
  log: Logger;
  aiAvailable: () => boolean;
}

export const VERIFY_TTL_MIN = 24 * 60;
export const RESET_TTL_MIN = 30;
/** Atualiza `last_seen_at` no máximo a cada 10 min (evita uma gravação por requisição). */
const TOUCH_EVERY_MS = 10 * 60_000;

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified_at: Date | null;
  data_profile_id: string;
  created_at: Date;
}

export const toAccount = (u: UserRow): AccountInfo => ({ id: u.id, name: u.name, email: u.email, emailVerified: !!u.email_verified_at, dataProfileId: u.data_profile_id, createdAt: u.created_at.toISOString() });

export function features(d: Pick<AuthDeps, 'cfg' | 'mailer' | 'aiAvailable'>): ServerFeatures {
  return { email: d.mailer.enabled, ai: d.aiAvailable(), aiRequiresVerifiedEmail: d.cfg.ai.requireVerifiedEmail, signup: d.cfg.signupEnabled };
}

/** Valida com Zod e devolve 422 com os campos (só nomes e frases fixas, nunca o valor recebido). */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = String(i.path[0] ?? '(corpo)');
    fields[k] ??= FIELD_MESSAGES[k] ?? 'Valor inválido.';
  }
  throw new ApiError('validation_failed', fields);
}

const FIELD_MESSAGES: Record<string, string> = {
  name: 'Informe seu nome (até 60 caracteres).',
  email: 'Informe um e-mail válido.',
  password: 'Informe a senha.',
  newPassword: 'Informe a nova senha.',
  currentPassword: 'Informe a senha atual.',
  acceptTerms: 'É preciso aceitar os termos de uso e a política de privacidade.',
  token: 'Link inválido.',
  confirm: 'Digite EXCLUIR para confirmar.',
};

/** Descrição curta do navegador para a lista de sessões (sem guardar o user-agent inteiro). */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? '';
  const os = /Android/i.test(s) ? 'Android' : /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Windows/i.test(s) ? 'Windows' : /Mac OS X|Macintosh/i.test(s) ? 'macOS' : /Linux/i.test(s) ? 'Linux' : 'Outro sistema';
  const br = /Edg\//.test(s) ? 'Edge' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Navegador';
  return `${br} · ${os}`;
}

// ------------------------------------------------------------------ sessões

export async function createSession(c: Pool | PoolClient, cfg: ApiConfig, userId: string, req: IncomingMessage): Promise<{ token: string; id: string; cookie: string }> {
  const token = newToken();
  const id = uuid();
  await c.query(`INSERT INTO auth_sessions (id, user_id, token_hash, device_label, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`, [id, userId, tokenHash(token), deviceLabel(req.headers['user-agent']), cfg.sessionTtlDays]);
  return { token, id, cookie: sessionCookie(cfg, token, cfg.sessionTtlDays * 86_400) };
}

/** Resolve a sessão do cookie. null = sem sessão válida (ausente, revogada, expirada ou ociosa demais). */
export async function resolveSession(d: Pick<AuthDeps, 'cfg' | 'pool'>, req: IncomingMessage): Promise<AuthState | null> {
  const token = parseCookies(req.headers.cookie)[d.cfg.cookieName];
  if (!token || token.length < 40 || token.length > 60) return null;
  const r = await d.pool.query<{ id: string; user_id: string; last_seen_at: Date; email_verified_at: Date | null; data_profile_id: string }>(
    `SELECT s.id, s.user_id, s.last_seen_at, u.email_verified_at, u.data_profile_id
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(days => $2)`,
    [tokenHash(token), d.cfg.sessionIdleDays],
  );
  const s = r.rows[0];
  if (!s) return null;
  if (Date.now() - s.last_seen_at.getTime() > TOUCH_EVERY_MS) await d.pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
  return { userId: s.user_id, sessionId: s.id, emailVerified: !!s.email_verified_at, dataProfileId: s.data_profile_id };
}

async function getUser(c: Pool | PoolClient, id: string): Promise<UserRow> {
  const r = await c.query<UserRow>('SELECT id, email, name, password_hash, email_verified_at, data_profile_id, created_at FROM users WHERE id = $1', [id]);
  if (!r.rows[0]) throw new ApiError('unauthenticated');
  return r.rows[0];
}

async function sendVerification(d: AuthDeps, u: Pick<UserRow, 'id' | 'email' | 'name'>): Promise<'sent' | 'unavailable' | 'failed'> {
  if (!d.mailer.enabled) return 'unavailable';
  const token = newToken();
  await d.pool.query(`INSERT INTO email_verification_tokens (id, user_id, token_hash, email, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`, [uuid(), u.id, tokenHash(token), u.email, VERIFY_TTL_MIN]);
  try {
    await d.mailer.send(verificationEmail(u.email, u.name, d.cfg.appOrigin, token));
    return 'sent';
  } catch {
    d.log.event('email_failed', { kind: 'verification' });
    return 'failed';
  }
}

function weakPasswordError(password: string, email: string): ApiError {
  const missing = passwordRequirements(password, email).filter((r) => !r.ok);
  return new ApiError('weak_password', { password: missing.map((r) => r.label).join(' · ') });
}

// ------------------------------------------------------------------ rotas

export function authRoutes(router: Router, d: AuthDeps): void {
  const { cfg, pool, limiter } = d;

  router.add({
    method: 'GET',
    path: '/api/v1/config',
    auth: 'public',
    handler: async () => ({ status: 200, body: { features: features(d) } }),
  });

  router.add({
    method: 'POST',
    path: '/api/v1/auth/signup',
    auth: 'public',
    handler: async (ctx) => {
      if (!cfg.signupEnabled) throw new ApiError('forbidden');
      await limiter.consume(LIMITS.signupIp, ctx.ip);
      const b = parseBody(signupSchema, await readJson(ctx, 4096));
      if (!isStrongPassword(b.password, b.email)) throw weakPasswordError(b.password, b.email);
      const hash = await hashPassword(b.password);
      const id = uuid();
      let user: UserRow;
      try {
        const r = await pool.query<UserRow>(
          `INSERT INTO users (id, email, name, password_hash, data_profile_id, terms_accepted_at) VALUES ($1, $2, $3, $4, $5, now())
           RETURNING id, email, name, password_hash, email_verified_at, data_profile_id, created_at`,
          [id, b.email, b.name, hash, uuid()],
        );
        user = r.rows[0];
      } catch (e) {
        if (pgCode(e) === '23505') throw new ApiError('signup_unavailable');
        throw e;
      }
      const s = await createSession(pool, cfg, user.id, ctx.req);
      const verification = await sendVerification(d, user);
      ctx.log.userId = user.id;
      d.log.event('account_created', { user: user.id });
      return { status: 201, body: { account: toAccount(user), features: features(d), verificationEmail: verification }, headers: { 'set-cookie': s.cookie } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/auth/login',
    auth: 'public',
    handler: async (ctx) => {
      await limiter.consume(LIMITS.loginIp, ctx.ip);
      const b = parseBody(loginSchema, await readJson(ctx, 4096));
      await limiter.consume(LIMITS.loginEmail, b.email);
      const r = await pool.query<UserRow>('SELECT id, email, name, password_hash, email_verified_at, data_profile_id, created_at FROM users WHERE email = $1', [b.email]);
      const user = r.rows[0];
      // Sem conta: verifica contra um hash fixo para gastar o mesmo tempo, e responde igual a senha errada.
      const ok = await verifyPassword(user?.password_hash ?? (await dummyHash()), b.password);
      if (!user || !ok) throw new ApiError('invalid_credentials');
      if (needsRehash(user.password_hash)) await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, await hashPassword(b.password)]);
      const s = await createSession(pool, cfg, user.id, ctx.req);
      ctx.log.userId = user.id;
      return { status: 200, body: { account: toAccount(user), features: features(d) }, headers: { 'set-cookie': s.cookie } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/auth/logout',
    auth: 'public',
    handler: async (ctx) => {
      const s = await resolveSession(d, ctx.req);
      if (s) await pool.query("UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL", [s.sessionId]);
      return { status: 204, headers: { 'set-cookie': clearSessionCookie(cfg) } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/auth/verify-email',
    auth: 'public',
    handler: async (ctx) => {
      await limiter.consume(LIMITS.verifyIp, ctx.ip);
      const b = parseBody(verifySchema, await readJson(ctx, 1024));
      const ok = await withTx(pool, async (c) => {
        const r = await c.query<{ id: string; user_id: string; email: string }>(
          `SELECT t.id, t.user_id, t.email FROM email_verification_tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.email = t.email FOR UPDATE OF t`,
          [tokenHash(b.token)],
        );
        const t = r.rows[0];
        if (!t) return false;
        await c.query('UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [t.user_id]);
        await c.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [t.user_id]);
        return true;
      });
      if (!ok) throw new ApiError('token_invalid');
      return { status: 200, body: { verified: true } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/auth/verify-email/resend',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      if (!d.mailer.enabled) throw new ApiError('email_not_configured');
      await limiter.consume(LIMITS.verifyResendUser, a.userId);
      const u = await getUser(pool, a.userId);
      if (u.email_verified_at) return { status: 200, body: { verificationEmail: 'already_verified' } };
      const res = await sendVerification(d, u);
      if (res === 'failed') throw new ApiError('email_failed');
      return { status: 202, body: { verificationEmail: res } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/auth/password/forgot',
    auth: 'public',
    handler: async (ctx) => {
      // Sem provedor de e-mail o recurso está indisponível para todos (a resposta não depende do e-mail).
      if (!d.mailer.enabled) throw new ApiError('email_not_configured');
      await limiter.consume(LIMITS.forgotIp, ctx.ip);
      const b = parseBody(forgotSchema, await readJson(ctx, 1024));
      await limiter.consume(LIMITS.forgotEmail, b.email);
      const r = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [b.email]);
      const u = r.rows[0];
      if (u) {
        const token = newToken();
        await pool.query(`INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`, [uuid(), u.id, tokenHash(token), RESET_TTL_MIN]);
        // Falha do provedor não muda a resposta (senão revelaria que a conta existe); fica no log operacional.
        d.mailer.send(resetEmail(b.email, cfg.appOrigin, token)).catch(() => d.log.event('email_failed', { kind: 'reset' }));
      }
      return { status: 202, body: { accepted: true } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/auth/password/reset',
    auth: 'public',
    handler: async (ctx) => {
      await limiter.consume(LIMITS.resetIp, ctx.ip);
      const b = parseBody(resetSchema, await readJson(ctx, 2048));
      const found = await pool.query<{ user_id: string; email: string }>(
        `SELECT t.user_id, u.email FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
        [tokenHash(b.token)],
      );
      const pre = found.rows[0];
      if (!pre) throw new ApiError('token_invalid');
      if (!isStrongPassword(b.password, pre.email)) throw weakPasswordError(b.password, pre.email);
      const hash = await hashPassword(b.password);
      const email = await withTx(pool, async (c) => {
        // Uso único: marca o token dentro da transação; uma segunda tentativa simultânea não encontra o token livre.
        const t = await c.query<{ user_id: string }>('UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id', [tokenHash(b.token)]);
        const uid = t.rows[0]?.user_id;
        if (!uid) return null;
        await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [uid]);
        // Quem recebe o link prova o controle do e-mail: a conta fica verificada.
        const u = await c.query<{ email: string }>('UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1 RETURNING email', [uid, hash]);
        await c.query("UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL", [uid]);
        return u.rows[0].email;
      });
      if (!email) throw new ApiError('token_invalid');
      d.mailer.send(securityNotice(email, 'password_reset')).catch(() => d.log.event('email_failed', { kind: 'security' }));
      return { status: 200, body: { reset: true }, headers: { 'set-cookie': clearSessionCookie(cfg) } };
    },
  });

  // ---------------------------------------------------------------- minha conta

  router.add({
    method: 'GET',
    path: '/api/v1/me',
    auth: 'session',
    handler: async (ctx) => ({ status: 200, body: { account: toAccount(await getUser(pool, ctx.auth!.userId)), features: features(d) } }),
  });

  router.add({
    method: 'PATCH',
    path: '/api/v1/me',
    auth: 'session',
    handler: async (ctx) => {
      const b = parseBody(updateProfileSchema, await readJson(ctx, 1024));
      const r = await pool.query<UserRow>('UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, email, name, password_hash, email_verified_at, data_profile_id, created_at', [ctx.auth!.userId, b.name]);
      return { status: 200, body: { account: toAccount(r.rows[0]) } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/me/password',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      await limiter.consume(LIMITS.passwordChangeUser, a.userId);
      const b = parseBody(changePasswordSchema, await readJson(ctx, 2048));
      const u = await getUser(pool, a.userId);
      if (!(await verifyPassword(u.password_hash, b.currentPassword))) throw new ApiError('invalid_credentials', { currentPassword: 'Senha atual incorreta.' });
      if (!isStrongPassword(b.newPassword, u.email)) throw weakPasswordError(b.newPassword, u.email);
      const hash = await hashPassword(b.newPassword);
      await withTx(pool, async (c) => {
        await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [a.userId, hash]);
        await c.query("UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_changed' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [a.userId, a.sessionId]);
      });
      if (d.mailer.enabled) d.mailer.send(securityNotice(u.email, 'password_changed')).catch(() => d.log.event('email_failed', { kind: 'security' }));
      return { status: 200, body: { changed: true } };
    },
  });

  router.add({
    method: 'GET',
    path: '/api/v1/me/sessions',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      const r = await pool.query<{ id: string; created_at: Date; last_seen_at: Date; expires_at: Date; device_label: string }>(
        `SELECT id, created_at, last_seen_at, expires_at, device_label FROM auth_sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND last_seen_at > now() - make_interval(days => $2)
          ORDER BY last_seen_at DESC LIMIT 50`,
        [a.userId, cfg.sessionIdleDays],
      );
      const sessions: SessionInfo[] = r.rows.map((s) => ({ id: s.id, current: s.id === a.sessionId, createdAt: s.created_at.toISOString(), lastSeenAt: s.last_seen_at.toISOString(), expiresAt: s.expires_at.toISOString(), device: s.device_label || 'Navegador' }));
      return { status: 200, body: { sessions } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/me/sessions/revoke-others',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      const r = await pool.query("UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout_others' WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [a.userId, a.sessionId]);
      return { status: 200, body: { revoked: r.rowCount ?? 0 } };
    },
  });

  router.add({
    method: 'DELETE',
    path: '/api/v1/me/sessions/:id',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      if (!/^[0-9a-f-]{36}$/.test(ctx.params.id)) throw new ApiError('not_found');
      // `user_id = $1`: uma sessão de outra conta nunca é encontrada (404, não 403: não confirma que existe).
      const r = await pool.query("UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL", [a.userId, ctx.params.id]);
      if (!r.rowCount) throw new ApiError('not_found');
      const headers: Record<string, string> = ctx.params.id === a.sessionId ? { 'set-cookie': clearSessionCookie(cfg) } : {};
      return { status: 204, headers };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/me/delete',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      await limiter.consume(LIMITS.deleteUser, a.userId);
      const b = parseBody(deleteAccountSchema, await readJson(ctx, 1024));
      const u = await getUser(pool, a.userId);
      if (!(await verifyPassword(u.password_hash, b.password))) throw new ApiError('invalid_credentials', { password: 'Senha incorreta.' });
      // ON DELETE CASCADE remove sessões, tokens, dados do app, revisões, importações e uso de IA numa transação.
      await pool.query('DELETE FROM users WHERE id = $1', [a.userId]);
      d.log.event('account_deleted', { user: a.userId });
      return { status: 200, body: { deleted: true }, headers: { 'set-cookie': clearSessionCookie(cfg) } };
    },
  });
}

/** Rotas de teste (caixa de e-mail simulada). Só registradas com API_TEST_MODE=1 fora de produção. */
export function testRoutes(router: Router, mailbox: { for(to: string): { subject: string; text: string }[]; clear(): void }): void {
  router.add({
    method: 'GET',
    path: '/api/v1/__test__/mailbox',
    auth: 'public',
    handler: async (ctx: RequestCtx) => {
      const to = ctx.url.searchParams.get('to') ?? '';
      return { status: 200, body: { messages: mailbox.for(to.toLowerCase()).map((m) => ({ subject: m.subject, text: m.text })) } };
    },
  });
}

export { MailError };
