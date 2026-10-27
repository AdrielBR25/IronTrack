// Autenticação por credencial de acesso emitida FORA do cliente: o operador gera um token aleatório
// (scripts/token.ts), guarda só o SHA-256 dele na configuração e entrega o token ao titular por um
// canal privado. O navegador apresenta o token em `Authorization: Bearer`. O UUID do perfil local, a
// origem (CORS) e qualquer campo do corpo NÃO são prova de identidade e não são consultados aqui.
// Cada credencial tem um `keyId` não secreto (auditoria/revogação), expiração opcional e revogação.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientConfig, CredentialConfig } from './config.ts';

/** Tokens válidos: 43+ caracteres base64url (≥ 256 bits quando gerados pelo script). */
const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Extrai o token do cabeçalho. Qualquer formato diferente de `Bearer <token>` é recusado. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header);
  return m && TOKEN.test(m[1]) ? m[1] : null;
}

/** A credencial aceita token neste instante? (titular ligado, não revogada, não expirada) */
export function credentialUsable(client: ClientConfig, cred: CredentialConfig, now: number): boolean {
  if (!client.enabled || cred.revokedAt !== undefined) return false;
  return cred.expiresAt === undefined || now < Date.parse(cred.expiresAt);
}

export interface AuthResult {
  client: ClientConfig;
  credential: CredentialConfig;
}

/**
 * Titular e credencial, ou null. Compara os hashes em tempo constante e percorre TODAS as credenciais
 * (sem retorno antecipado) para não revelar, pelo tempo, qual existe nem por que foi recusada.
 */
export function authenticate(header: string | string[] | undefined, clients: readonly ClientConfig[], now: number = Date.now()): AuthResult | null {
  const token = bearerToken(header);
  if (!token) return null;
  const got = Buffer.from(sha256Hex(token), 'hex');
  let found: AuthResult | null = null;
  for (const client of clients)
    for (const credential of client.credentials) {
      const want = Buffer.from(credential.tokenSha256, 'hex');
      const match = want.length === got.length && timingSafeEqual(want, got);
      if (match && credentialUsable(client, credential, now)) found = { client, credential };
    }
  return found;
}

/**
 * Depois de recarregar a configuração: a credencial usada por uma requisição em andamento continua
 * válida? (mesmo keyId, mesmo hash, titular ligado, não revogada, não expirada)
 */
export function stillValid(clients: readonly ClientConfig[], keyId: string, tokenSha256: string, now: number): boolean {
  for (const client of clients) for (const c of client.credentials) if (c.keyId === keyId && c.tokenSha256 === tokenSha256 && credentialUsable(client, c, now)) return true;
  return false;
}
