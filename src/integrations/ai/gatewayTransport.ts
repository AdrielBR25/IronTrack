// Transporte HTTP do assistente até o gateway seguro (IronTrack 2.0 F01/P06). É o ÚNICO arquivo do
// app que faz requisições de rede para IA, e só é chamado por ação do usuário: "Conectar" (catálogo,
// sem dados pessoais) e "Autorizar e executar" (a solicitação exata que ele viu na prévia).
// O endereço e o token de acesso ficam só na memória (closure); nada vai para storage, IndexedDB,
// backup ou logs. Sem redirecionamentos (um redirect poderia levar os dados a outro destino), sem
// cookies, sem cabeçalho Referer e com limite de tamanho da resposta.
import { AIError } from '@/modules/ai';
import type { GatewayTransport } from '@/modules/ai/adapters/GatewayAIProvider';

/** Tamanho máximo aceito de uma resposta do gateway. */
export const MAX_GATEWAY_RESPONSE_BYTES = 256 * 1024;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type GatewayUrlCheck = { ok: true; origin: string } | { ok: false; error: string };

/**
 * Valida o endereço digitado. Aceita HTTPS ou, só para desenvolvimento, HTTP em loopback. Sem
 * usuário/senha, caminho, parâmetros ou fragmento: as rotas são fixas.
 */
export function validateGatewayUrl(input: string): GatewayUrlCheck {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, error: 'Informe o endereço do gateway.' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'Endereço inválido.' };
  }
  if (u.username || u.password) return { ok: false, error: 'O endereço não pode conter usuário ou senha.' };
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return { ok: false, error: 'Use só a origem do gateway, sem caminho nem parâmetros.' };
  if (u.protocol === 'https:') return { ok: true, origin: u.origin };
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return { ok: true, origin: u.origin };
  return { ok: false, error: 'Use HTTPS (HTTP só é aceito para um gateway neste aparelho, em localhost).' };
}

/** Formato do token de acesso emitido pelo operador do gateway (base64url, 43+ caracteres). */
export const isAccessTokenFormat = (t: string) => /^[A-Za-z0-9_-]{43,256}$/.test(t);

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
