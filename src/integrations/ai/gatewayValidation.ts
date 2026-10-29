// Validação do endereço do gateway e do formato do token de acesso (IronTrack 2.0 F01/P06). Funções puras, sem rede:
// usadas pelo transporte, pelo endereço automático (gatewayEndpoint.ts) e pela tela, antes de qualquer requisição.

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
