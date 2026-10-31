// Cliente HTTP da API do IronTrack (Prompt 21). Mesma origem (proxy), cookie de sessão HttpOnly enviado pelo próprio
// navegador (o app nunca vê o token), cabeçalho anti-CSRF em toda alteração, tempo limite e erros tipados.
// Senhas só trafegam no corpo do POST de login/cadastro/troca e nunca são guardadas.
import { API_ERRORS, CSRF_HEADER, CSRF_VALUE } from '@shared/api/errors.ts';
import type { AccountInfo, ServerFeatures, SessionInfo } from '@shared/api/auth.ts';
import type { PullResponse, PushResponse, SyncOp } from '@shared/sync/protocol.ts';
import { SYNC_PROTOCOL } from '@shared/sync/protocol.ts';
import { API_BASE } from './config';

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, string>;
  readonly retryAfter?: number;
  readonly body?: unknown;
  constructor(code: string, status: number, message: string, extra: { fields?: Record<string, string>; retryAfter?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    if (extra.fields) this.fields = extra.fields;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
    if (extra.body !== undefined) this.body = extra.body;
  }
}

export const NETWORK_MESSAGE = 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
export const isNetworkError = (e: unknown) => e instanceof ApiClientError && (e.code === 'network' || e.code === 'timeout');
export const isAuthError = (e: unknown) => e instanceof ApiClientError && e.status === 401 && e.code === 'unauthenticated';

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function apiRequest<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_VALUE;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: ctrl.signal,
    });
  } catch {
    if (opts.signal?.aborted) throw new ApiClientError('cancelled', 0, 'Operação cancelada.');
    throw new ApiClientError(ctrl.signal.aborted ? 'timeout' : 'network', 0, ctrl.signal.aborted ? 'O servidor demorou demais para responder.' : NETWORK_MESSAGE);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (res.ok) return parsed as T;
  // Página HTML (ex.: proxy /api/v1 do irontrack-web sem destino) ou corpo inesperado.
  const err = (parsed as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | undefined)?.error;
  if (!err?.code) {
    if (res.status === 404 || res.status === 405) throw new ApiClientError('api_unavailable', res.status, 'O servidor do IronTrack não está disponível neste endereço.');
    throw new ApiClientError('http_error', res.status, 'O servidor respondeu com um erro inesperado.');
  }
  const known = (API_ERRORS as Record<string, { message: string }>)[err.code];
  const retry = Number(res.headers.get('retry-after'));
  throw new ApiClientError(err.code, res.status, known?.message ?? err.message ?? 'Erro.', { ...(err.fields ? { fields: err.fields } : {}), ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}), body: parsed });
}

export interface AuthResponse {
  account: AccountInfo;
  features: ServerFeatures;
  verificationEmail?: 'sent' | 'unavailable' | 'failed';
}

export const api = {
  config: () => apiRequest<{ features: ServerFeatures }>('GET', '/config', undefined, { timeoutMs: 8000 }),
  signup: (b: { name: string; email: string; password: string; acceptTerms: true }) => apiRequest<AuthResponse>('POST', '/auth/signup', b),
  login: (b: { email: string; password: string }) => apiRequest<AuthResponse>('POST', '/auth/login', b),
  logout: () => apiRequest<void>('POST', '/auth/logout', {}),
  me: (opts?: RequestOptions) => apiRequest<{ account: AccountInfo; features: ServerFeatures }>('GET', '/me', undefined, opts),
  updateName: (name: string) => apiRequest<{ account: AccountInfo }>('PATCH', '/me', { name }),
  changePassword: (currentPassword: string, newPassword: string) => apiRequest<{ changed: true }>('POST', '/me/password', { currentPassword, newPassword }),
  verifyEmail: (token: string) => apiRequest<{ verified: true }>('POST', '/auth/verify-email', { token }),
  resendVerification: () => apiRequest<{ verificationEmail: string }>('POST', '/auth/verify-email/resend', {}),
  forgotPassword: (email: string) => apiRequest<{ accepted: true }>('POST', '/auth/password/forgot', { email }),
  resetPassword: (token: string, password: string) => apiRequest<{ reset: true }>('POST', '/auth/password/reset', { token, password }),
  sessions: () => apiRequest<{ sessions: SessionInfo[] }>('GET', '/me/sessions'),
  revokeOthers: () => apiRequest<{ revoked: number }>('POST', '/me/sessions/revoke-others', {}),
  revokeSession: (id: string) => apiRequest<void>('DELETE', `/me/sessions/${encodeURIComponent(id)}`),
  exportData: () => apiRequest<Record<string, unknown>>('GET', '/me/export', undefined, { timeoutMs: 60_000 }),
  deleteAccount: (password: string) => apiRequest<{ deleted: true }>('POST', '/me/delete', { password, confirm: 'EXCLUIR' }),
  push: (accountId: string, deviceId: string, ops: SyncOp[], signal?: AbortSignal) =>
    apiRequest<PushResponse>('POST', '/sync/push', { protocol: SYNC_PROTOCOL, accountId, deviceId, ops }, { timeoutMs: 45_000, ...(signal ? { signal } : {}) }),
  pull: (accountId: string, cursor: string, signal?: AbortSignal) =>
    apiRequest<PullResponse & { reset?: boolean }>('GET', `/sync/pull?cursor=${encodeURIComponent(cursor)}&accountId=${encodeURIComponent(accountId)}`, undefined, { timeoutMs: 45_000, ...(signal ? { signal } : {}) }),
};
