// Transporte HTTP do assistente até o gateway seguro (IronTrack 2.0 F01/P06). É o ÚNICO arquivo do
// app que faz requisições de rede para IA, e só é chamado por ação do usuário: "Conectar" (catálogo,
// sem dados pessoais) e "Autorizar e executar" (a solicitação exata que ele viu na prévia).
// O endereço e o token de acesso ficam só na memória (closure); nada vai para storage, IndexedDB,
// backup ou logs. Sem redirecionamentos (um redirect poderia levar os dados a outro destino), sem
// cookies, sem cabeçalho Referer e com limite de tamanho da resposta.
import { AIError } from '@/modules/ai';
import { CSRF_HEADER, CSRF_VALUE } from '@shared/api/errors.ts';
import type { GatewayTransport } from '@/modules/ai/adapters/GatewayAIProvider';
// Validação pura (sem rede) mora em gatewayValidation.ts, para a tela e o endereço automático não dependerem do transporte.
import { validateGatewayUrl } from './gatewayValidation';
export { isAccessTokenFormat, validateGatewayUrl, type GatewayUrlCheck } from './gatewayValidation';

/** Tamanho máximo aceito de uma resposta do gateway. */
export const MAX_GATEWAY_RESPONSE_BYTES = 256 * 1024;

async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new AIError('invalid_response');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel();
      throw new AIError('invalid_response');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface GatewayTransportOptions {
  origin: string;
  token: string;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

export function createGatewayTransport(opts: GatewayTransportOptions): GatewayTransport {
  const check = validateGatewayUrl(opts.origin);
  if (!check.ok) throw new AIError('provider_invalid');
  const origin = check.origin;
  const token = opts.token;
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const max = opts.maxResponseBytes ?? MAX_GATEWAY_RESPONSE_BYTES;

  return async (req) => {
    if (req.path !== '/v1/models' && req.path !== '/v1/generate') throw new AIError('request_invalid');
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (req.method === 'POST') headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(`${origin}${req.path}`, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        mode: 'cors',
      });
    } catch {
      if (req.signal?.aborted) throw new AIError('cancelled');
      throw new AIError('gateway_unreachable');
    }
    let text: string;
    try {
      text = await readLimited(res, max);
    } catch (e) {
      if (req.signal?.aborted) throw new AIError('cancelled');
      throw e instanceof AIError ? e : new AIError('gateway_unreachable');
    }
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  };
}

/**
 * P21: IA pela conta. Mesma origem do app (proxy da Netlify para a API na Railway), caminho fixo `/api/v1/ai`, cookie
 * de sessão HttpOnly enviado pelo navegador (o app não vê o token), cabeçalho anti-CSRF e as mesmas proteções do
 * transporte acima (sem redirecionamento, sem Referer, resposta limitada). As chaves dos provedores ficam só na Railway.
 */
export const ACCOUNT_AI_BASE = '/api/v1/ai';

export function createAccountTransport(opts: { fetchImpl?: typeof fetch; maxResponseBytes?: number } = {}): GatewayTransport {
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const max = opts.maxResponseBytes ?? MAX_GATEWAY_RESPONSE_BYTES;
  return async (req) => {
    const path = req.path === '/v1/models' ? '/models' : req.path === '/v1/generate' ? '/generate' : null;
    if (!path) throw new AIError('request_invalid');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (req.method === 'POST') {
      headers['content-type'] = 'application/json';
      headers[CSRF_HEADER] = CSRF_VALUE;
    }
    let res: Response;
    try {
      res = await doFetch(`${ACCOUNT_AI_BASE}${path}`, {
        method: req.method,
        headers,
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        credentials: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        mode: 'same-origin',
      });
    } catch {
      if (req.signal?.aborted) throw new AIError('cancelled');
      throw new AIError('gateway_unreachable');
    }
    let text: string;
    try {
      text = await readLimited(res, max);
    } catch (e) {
      if (req.signal?.aborted) throw new AIError('cancelled');
      throw e instanceof AIError ? e : new AIError('gateway_unreachable');
    }
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  };
}
