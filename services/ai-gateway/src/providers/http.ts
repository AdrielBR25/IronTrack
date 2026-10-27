// Chamada HTTP a um provedor com limite de tamanho da resposta e cancelamento. Nunca devolve nem
// registra o corpo de erro do provedor (pode ecoar o prompt ou parte da chave).
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

/** POST JSON. Erros de rede viram `provider_failure`; cancelamento é repassado ao chamador. */
export async function postJson(fetchFn: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, maxBytes: number): Promise<UpstreamHttpResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    throw new GatewayError('provider_failure');
  }
  const text = await readLimited(res, maxBytes, signal);
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/** Mapeia o status HTTP de erro do provedor. Sem repetição e sem o texto do provedor. */
export function upstreamStatusError(status: number): GatewayError {
  if (status === 401 || status === 403) return new GatewayError('provider_unavailable');
  if (status === 413) return new GatewayError('payload_too_large');
  return new GatewayError('provider_failure');
}

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function nonNegInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function usageOf(input: unknown, output: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  const i = nonNegInt(input);
  const o = nonNegInt(output);
  if (i === undefined && o === undefined) return undefined;
  return { ...(i !== undefined ? { inputTokens: i } : {}), ...(o !== undefined ? { outputTokens: o } : {}) };
}
