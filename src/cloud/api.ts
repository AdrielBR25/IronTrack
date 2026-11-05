// Cliente HTTP da API do IronTrack (Prompt 21). Mesma origem (proxy), cookie de sessão HttpOnly enviado pelo próprio
// navegador (o app nunca vê o token), cabeçalho anti-CSRF em toda alteração, tempo limite e erros tipados.
// Senhas só trafegam no corpo do POST de login/cadastro/troca e nunca são guardadas.
import { API_ERRORS, CSRF_HEADER, CSRF_VALUE } from '@shared/api/errors.ts';
import type { AccountInfo, ServerFeatures, SessionInfo } from '@shared/api/auth.ts';
import type { PullResponse, PushResponse, SyncOp } from '@shared/sync/protocol.ts';
import { SYNC_PROTOCOL } from '@shared/sync/protocol.ts';
import type { ActionView, AssistantStatusView, ConversationSummaryView, ConversationView, MemoryView, StreamEvent } from '@shared/assistant/protocol.ts';
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

// ------------------------------------------------------------------ Assistente IA central (Fase 00)

/**
 * POST com resposta em streaming (text/event-stream) do assistente. Mesma origem, cookie da sessão e anti-CSRF.
 * Erros antes do streaming chegam como JSON (ApiClientError). Cada evento `data:` é entregue a `onEvent`.
 */
export async function apiStream(path: string, body: unknown, onEvent: (ev: unknown) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch {
    if (signal.aborted) throw new ApiClientError('cancelled', 0, 'Resposta interrompida.');
    throw new ApiClientError('network', 0, NETWORK_MESSAGE);
  }
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    const text = await res.text().catch(() => '');
    let parsed: { error?: { code?: string; message?: string } } | undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed?.error?.code) throw new ApiClientError(res.status === 404 ? 'api_unavailable' : 'http_error', res.status, 'O servidor respondeu com um erro inesperado.');
    const retry = Number(res.headers.get('retry-after'));
    throw new ApiClientError(parsed.error.code, res.status, parsed.error.message ?? 'Erro.', { ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}), body: parsed });
  }
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (!data) continue;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* evento malformado: ignorado */
        }
      }
    }
  } catch {
    if (signal.aborted) throw new ApiClientError('cancelled', 0, 'Resposta interrompida.');
    throw new ApiClientError('network', 0, 'A conexão caiu durante a resposta. O que já chegou foi mantido.');
  } finally {
    reader.cancel().catch(() => {});
  }
}

export const assistantApi = {
  status: () => apiRequest<AssistantStatusView>('GET', '/assistant/status', undefined, { timeoutMs: 10_000 }),
  acceptNotice: (version: number) => apiRequest<AssistantStatusView>('POST', '/assistant/notice', { version }),
  test: (model?: string) => apiRequest<{ result: string; model: string; health: string; paid: false }>('POST', '/assistant/test', model ? { model } : {}, { timeoutMs: 15_000 }),
  conversations: () => apiRequest<{ conversations: ConversationSummaryView[] }>('GET', '/assistant/conversations'),
  conversation: (id: string) => apiRequest<{ conversation: ConversationView }>('GET', `/assistant/conversations/${encodeURIComponent(id)}`),
  rename: (id: string, title: string) => apiRequest<{ title: string }>('PATCH', `/assistant/conversations/${encodeURIComponent(id)}`, { title }),
  remove: (id: string) => apiRequest<void>('DELETE', `/assistant/conversations/${encodeURIComponent(id)}`),
  removeAll: () => apiRequest<{ deleted: number }>('DELETE', '/assistant/conversations'),
  send: (conversationId: string | null, body: { content: string; model?: string; timezone?: string }, onEvent: (ev: StreamEvent) => void, signal: AbortSignal) =>
    apiStream(`/assistant/conversations/${conversationId ? encodeURIComponent(conversationId) : 'new'}/messages`, body, (e) => onEvent(e as StreamEvent), signal),
  action: (id: string) => apiRequest<{ action: ActionView }>('GET', `/assistant/actions/${encodeURIComponent(id)}`),
  approve: (id: string) => apiRequest<{ action: ActionView }>('POST', `/assistant/actions/${encodeURIComponent(id)}/approve`, {}),
  reject: (id: string) => apiRequest<{ action: ActionView }>('POST', `/assistant/actions/${encodeURIComponent(id)}/reject`, {}),
  undo: (id: string) => apiRequest<{ action: ActionView }>('POST', `/assistant/actions/${encodeURIComponent(id)}/undo`, {}),
  memories: () => apiRequest<{ memories: MemoryView[]; max: number }>('GET', '/assistant/memories'),
  addMemory: (content: string) => apiRequest<{ memories: MemoryView[] }>('POST', '/assistant/memories', { content }),
  removeMemory: (id: string) => apiRequest<void>('DELETE', `/assistant/memories/${encodeURIComponent(id)}`),
  removeAllMemories: () => apiRequest<{ deleted: number }>('DELETE', '/assistant/memories'),
};
