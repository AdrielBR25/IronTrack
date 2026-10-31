// Chamada HTTP a um provedor com limite de tamanho da resposta e cancelamento. Nunca devolve nem
// registra o corpo de erro do provedor (pode ecoar o prompt ou parte da chave).
// Redirecionamentos NÃO são seguidos (`redirect: 'manual'`): um 307/308 reenviaria o corpo (o prompt)
// e cabeçalhos como `x-api-key`/`x-goog-api-key` (que o fetch não remove em redirecionamento entre
// origens) a outro destino. Qualquer 3xx vira `provider_failure`.
import { GatewayError } from '../errors.ts';
import type { FetchLike } from './types.ts';

export interface UpstreamHttpResult {
  status: number;
  json: unknown;
}

async function readLimited(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new GatewayError('invalid_response');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new GatewayError('invalid_response');
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** POST JSON. Erros de rede viram `provider_unreachable`; cancelamento é repassado ao chamador. */
export function postJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, maxBytes: number): Promise<UpstreamHttpResult> {
  return requestJson(fetchFn, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) }, url, signal, maxBytes);
}

/** GET JSON (diagnóstico sem custo, ex.: consulta de modelo). Mesmas proteções do POST. */
export function getJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal, maxBytes: number): Promise<UpstreamHttpResult> {
  return requestJson(fetchFn, { method: 'GET', headers: { accept: 'application/json', ...headers } }, url, signal, maxBytes);
}

async function requestJson(fetchFn: FetchLike, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }, url: string, signal: AbortSignal, maxBytes: number): Promise<UpstreamHttpResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal, redirect: 'manual' });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    throw new GatewayError('provider_unreachable');
  }
  // Redirecionamento (ou resposta opaca de redirect): descarta o corpo sem ler e não segue.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    res.body?.cancel().catch(() => {});
    throw new GatewayError('provider_failure');
  }
  let text: string;
  try {
    text = await readLimited(res, maxBytes, signal);
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    // Conexão caiu no meio da resposta: falha do provedor (não repassamos detalhes).
    throw e instanceof GatewayError ? e : new GatewayError('provider_failure');
  }
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/**
 * Mapeia o status HTTP de erro do provedor. Sem repetição e sem o texto do provedor (o corpo só é lido para
 * classificar a causa, nunca devolvido nem registrado).
 * 401: chave recusada (inválida ou revogada); 403: chave sem permissão; 402 (ou `billing_error`, ou 400 de saldo de
 * créditos): faturamento; 404 (`not_found_error`): modelo inexistente ou não liberado; 429: limite/cota da conta no
 * provedor; 413: corpo grande; 400/408/5xx/529: falha do provedor.
 */
export function upstreamStatusError(status: number, json?: unknown): GatewayError {
  const err = isObj(json) && isObj(json.error) ? json.error : undefined;
  const type = typeof err?.type === 'string' ? err.type : '';
  const message = typeof err?.message === 'string' ? err.message : '';
  if (status === 401 || type === 'authentication_error') return new GatewayError('provider_auth_failed');
  if (status === 402 || type === 'billing_error' || (status === 400 && /credit balance|billing/i.test(message))) return new GatewayError('provider_billing');
  if (status === 403) return new GatewayError('provider_forbidden');
  if (status === 404) return new GatewayError('model_unavailable');
  if (status === 429) return new GatewayError('provider_rate_limited');
  if (status === 413) return new GatewayError('payload_too_large');
  return new GatewayError('provider_failure');
}

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function nonNegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function usageOf(input: unknown, output: unknown, extraOutput?: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  const i = nonNegInt(input);
  const base = nonNegInt(output);
  const extra = nonNegInt(extraOutput);
  const o = base === undefined && extra === undefined ? undefined : (base ?? 0) + (extra ?? 0);
  if (i === undefined && o === undefined) return undefined;
  return { ...(i !== undefined ? { inputTokens: i } : {}), ...(o !== undefined ? { outputTokens: o } : {}) };
}
