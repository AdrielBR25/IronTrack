// Núcleo HTTP da API (node:http, sem framework): roteamento, leitura de JSON com limite, cookies, erros
// normalizados, cabeçalhos de segurança, CORS restrito e proteção CSRF. Nenhum corpo, cookie ou cabeçalho de
// autenticação vai para o log.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_ERRORS, CSRF_HEADER, CSRF_VALUE, type ApiErrorCode } from '../../../../shared/api/errors.ts';
import type { ApiConfig } from '../config.ts';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly fields?: Record<string, string>;
  readonly headers?: Record<string, string>;
  constructor(code: ApiErrorCode, fields?: Record<string, string>, headers?: Record<string, string>) {
    super(API_ERRORS[code].message);
    this.name = 'ApiError';
    this.code = code;
    if (fields) this.fields = fields;
    if (headers) this.headers = headers;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export function errorPayload(code: ApiErrorCode, fields?: Record<string, string>) {
  return { error: { code, message: API_ERRORS[code].message, ...(fields ? { fields } : {}) } };
}

export interface RequestCtx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  params: Record<string, string>;
  ip: string;
  signal: AbortSignal;
  /** Preenchido pelo middleware de sessão nas rotas autenticadas. */
  auth?: AuthState;
  /** Metadados para o log de acesso. */
  log: { route?: string; userId?: string; code?: string };
}

export interface AuthState {
  userId: string;
  sessionId: string;
  emailVerified: boolean;
  dataProfileId: string;
}

export type Handler = (ctx: RequestCtx) => Promise<Reply | void>;

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export type AuthLevel = 'public' | 'session' | 'verified';

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Caminho com parâmetros `:nome` (ex.: /api/v1/import/jobs/:id/items). */
  path: string;
  auth: AuthLevel;
  handler: Handler;
  /** Limite do corpo desta rota, só documental: cada handler passa o próprio limite a `readJson`. */
  maxBody?: number;
}

interface CompiledRoute extends Route {
  re: RegExp;
  keys: string[];
}

export class Router {
  private routes: CompiledRoute[] = [];
  add(r: Route): this {
    const keys: string[] = [];
    const re = new RegExp(`^${r.path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ ...r, re, keys });
    return this;
  }
  match(method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
    return pathMatched ? 'method' : null;
  }
}


/** Lê e interpreta o corpo JSON com limite de tamanho. */
export async function readJson(ctx: RequestCtx, max: number): Promise<unknown> {
  const ct = String(ctx.req.headers['content-type'] ?? '');
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(ct)) throw new ApiError('bad_request');
  const declared = Number(ctx.req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new ApiError('payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new ApiError('timeout'));
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    ctx.req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new ApiError('payload_too_large'));
        ctx.req.pause();
        return;
      }
      chunks.push(c);
    });
    ctx.req.on('end', () => {
      ctx.signal.removeEventListener('abort', onAbort);
      resolve();
    });
    ctx.req.on('error', () => reject(new ApiError('bad_request')));
  });
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new ApiError('bad_request');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('bad_request');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

export function sessionCookie(cfg: Pick<ApiConfig, 'cookieName' | 'cookieSecure'>, token: string, maxAgeSec: number): string {
  // __Host-: exige Secure, Path=/ e nenhum Domain (o cookie fica preso ao host que o recebeu: o do irontrack-web, via proxy).
  return [`${cfg.cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, ...(cfg.cookieSecure ? ['Secure'] : [])].join('; ');
}

export function clearSessionCookie(cfg: Pick<ApiConfig, 'cookieName' | 'cookieSecure'>): string {
  return [`${cfg.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', ...(cfg.cookieSecure ? ['Secure'] : [])].join('; ');
}

/** IP do cliente considerando `trustProxyHops` proxies confiáveis (cada um acrescenta um IP ao X-Forwarded-For). */
export function clientIp(req: IncomingMessage, hops: number): string {
  const direct = req.socket.remoteAddress ?? '';
  if (hops <= 0) return direct;
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Com N proxies confiáveis, o IP do cliente é o N-ésimo a partir da direita (os anteriores podem ser forjados).
  return xff.length >= hops ? xff[xff.length - hops] : (xff[0] ?? direct);
}

export function originAllowed(cfg: Pick<ApiConfig, 'allowedOrigins' | 'allowedOriginPattern'>, origin: string): boolean {
  return cfg.allowedOrigins.includes(origin) || (cfg.allowedOriginPattern?.test(origin) ?? false);
}

/** Cabeçalhos de segurança de toda resposta da API (JSON, nunca HTML). */
export function securityHeaders(res: ServerResponse, production: boolean): void {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-resource-policy', 'same-site');
  if (production) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

/**
 * CSRF: toda alteração exige o cabeçalho próprio (um formulário de outro site não consegue enviá-lo sem CORS, que
 * só é concedido às origens permitidas) e, se o navegador informar a origem, ela tem de ser permitida.
 */
export function checkCsrf(cfg: Pick<ApiConfig, 'allowedOrigins' | 'allowedOriginPattern'>, req: IncomingMessage): boolean {
  if (req.headers[CSRF_HEADER] !== CSRF_VALUE) return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null' && !originAllowed(cfg, origin)) return false;
  if (origin === 'null') return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && !['same-origin', 'same-site', 'none'].includes(site) && !(typeof origin === 'string' && originAllowed(cfg, origin))) return false;
  return true;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (res.writableEnded || res.destroyed) return;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (status === 204 || body === undefined) {
    res.statusCode = status;
    res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
