// Autenticação por credencial de acesso emitida FORA do cliente: o operador gera um token aleatório
// (scripts/token.ts), guarda só o SHA-256 dele na configuração e entrega o token ao titular por um
// canal privado. O navegador apresenta o token em `Authorization: Bearer`. O UUID do perfil local, a
// origem (CORS) e qualquer campo do corpo NÃO são prova de identidade e não são consultados aqui.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientConfig } from './config.ts';

/** Tokens válidos: 43+ caracteres base64url (≥ 256 bits quando gerados pelo script). */
const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Extrai o token do cabeçalho. Qualquer formato diferente de `Bearer <token>` é recusado. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header);
  return m && TOKEN.test(m[1]) ? m[1] : null;
}

/**
 * Titular da credencial, ou null. Compara os hashes em tempo constante e percorre todos os
 * titulares (sem retorno antecipado) para não revelar qual existe.
 */
export function authenticate(header: string | string[] | undefined, clients: readonly ClientConfig[]): ClientConfig | null {
  const token = bearerToken(header);
  if (!token) return null;
  const got = Buffer.from(sha256Hex(token), 'hex');
  let found: ClientConfig | null = null;
  for (const c of clients) {
    const want = Buffer.from(c.tokenSha256, 'hex');
    if (want.length === got.length && timingSafeEqual(want, got) && c.enabled) found = c;
  }
  return found;
}
