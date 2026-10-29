// Ciclo de vida das credenciais de acesso: emitir, revogar, substituir (rotação) e listar. Funções
// PURAS sobre o JSON bruto da configuração (sem ler nem gravar arquivos; quem grava, de forma atômica,
// é scripts/token.ts). O token só existe no valor devolvido por `issue`/`rotate`, para ser mostrado UMA
// vez ao operador; na configuração fica apenas o SHA-256. A configuração resultante é sempre validada
// antes de ser devolvida: uma operação nunca produz um arquivo que deixaria o gateway bloqueado.
import { randomBytes } from 'node:crypto';
import { sha256Hex } from './auth.ts';
import { KEY_ID, isIsoInstant, legacyKeyId, validateConfig } from './config.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const CLIENT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface CredentialDeps {
  now?: () => number;
  /** Bytes aleatórios (testes). */
  random?: (n: number) => Buffer;
}

export interface IssueResult {
  config: Obj;
  /** Mostrar uma vez e descartar. Nunca gravar em arquivo ou log. */
  token: string;
  keyId: string;
  expiresAt?: string;
}

export interface CredentialSummary {
  clientId: string;
  keyId: string;
  status: 'ativa' | 'expirada' | 'revogada' | 'titular desligado';
  createdAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Converte "90d", "12h", "30m" em milissegundos. */
export function parseDuration(text: string): number {
  const m = /^(\d{1,5})(m|h|d)$/.exec(text.trim());
  if (!m) throw new CredentialError('Duração inválida: use, por exemplo, 30m, 12h ou 90d.');
  const n = Number(m[1]);
  if (n <= 0) throw new CredentialError('A duração precisa ser maior que zero.');
  return n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

function clone(raw: unknown): Obj {
  if (!isObj(raw)) throw new CredentialError('Configuração inválida: o arquivo precisa conter um objeto JSON.');
  return JSON.parse(JSON.stringify(raw)) as Obj;
}

function checked(cfg: Obj): Obj {
  const r = validateConfig(cfg);
  if (!r.ok) throw new CredentialError(`A configuração resultante seria inválida (${r.errors.join(', ')}). Nada foi alterado.`);
  return cfg;
}

/** Leva titulares no formato do P06 (`tokenSha256` direto) para a lista `credentials`. */
function normalizeClient(c: Obj): Obj[] {
  if (!Array.isArray(c.credentials)) c.credentials = [];
  const list = c.credentials as Obj[];
  if (typeof c.tokenSha256 === 'string') {
    list.unshift({ keyId: legacyKeyId(c.tokenSha256), tokenSha256: c.tokenSha256 });
    delete c.tokenSha256;
  }
  return list;
}

function findCredential(cfg: Obj, keyId: string): { client: Obj; cred: Obj } {
  if (!KEY_ID.test(keyId)) throw new CredentialError('keyId inválido.');
  for (const client of Array.isArray(cfg.clients) ? (cfg.clients as unknown[]) : []) {
    if (!isObj(client)) continue;
    const cred = normalizeClient(client).find((k) => isObj(k) && k.keyId === keyId);
    if (cred) return { client, cred };
  }
  throw new CredentialError(`Credencial ${keyId} não encontrada.`);
}

function newKeyId(cfg: Obj, random: (n: number) => Buffer): string {
  const used = new Set<string>();
  for (const c of Array.isArray(cfg.clients) ? (cfg.clients as unknown[]) : [])
    if (isObj(c)) for (const k of normalizeClient(c)) if (isObj(k) && typeof k.keyId === 'string') used.add(k.keyId);
  for (;;) {
    const id = `k-${random(6).toString('hex')}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Emite uma credencial para o titular (criado ligado se não existir). `expiresAt` opcional (ISO) ou
 * `expiresInMs`. Devolve a nova configuração e o token, que não pode ser recuperado depois.
 */
export function issueCredential(raw: unknown, clientId: string, opts: { expiresAt?: string; expiresInMs?: number } = {}, deps: CredentialDeps = {}): IssueResult {
  const now = (deps.now ?? Date.now)();
  const random = deps.random ?? randomBytes;
  if (!CLIENT_ID.test(clientId)) throw new CredentialError('ID de titular inválido: use letras minúsculas, números, "-" ou "_" (até 40).');
  let expiresAt: string | undefined;
  if (opts.expiresAt !== undefined) {
    if (!isIsoInstant(opts.expiresAt)) throw new CredentialError('Expiração inválida: use data e hora ISO 8601 com fuso, ex.: 2026-12-31T23:59:59Z.');
    expiresAt = opts.expiresAt;
  } else if (opts.expiresInMs !== undefined) expiresAt = iso(now + opts.expiresInMs);
  if (expiresAt !== undefined && Date.parse(expiresAt) <= now) throw new CredentialError('A expiração precisa estar no futuro.');

  const cfg = clone(raw);
  if (!Array.isArray(cfg.clients)) cfg.clients = [];
  const clients = cfg.clients as Obj[];
  let client = clients.find((c) => isObj(c) && c.id === clientId);
  if (!client) {
    client = { id: clientId, enabled: true, credentials: [] };
    clients.push(client);
  }
  const list = normalizeClient(client);
  const token = random(32).toString('base64url');
  const keyId = newKeyId(cfg, random);
  list.push({ keyId, tokenSha256: sha256Hex(token), createdAt: iso(now), ...(expiresAt ? { expiresAt } : {}) });
  return { config: checked(cfg), token, keyId, ...(expiresAt ? { expiresAt } : {}) };
}

/** Revoga uma credencial pelo keyId (fica registrada com `revokedAt`, para auditoria). */
export function revokeCredential(raw: unknown, keyId: string, deps: CredentialDeps = {}): Obj {
  const now = (deps.now ?? Date.now)();
  const cfg = clone(raw);
  const { cred } = findCredential(cfg, keyId);
  if (cred.revokedAt === undefined) cred.revokedAt = iso(now);
  return checked(cfg);
}

/**
 * Substitui uma credencial: emite outra para o mesmo titular e revoga a antiga. Com `graceMs`, a antiga
 * continua aceita até `agora + graceMs` (expiração), para dar tempo de trocar o token no aparelho;
 * sem `graceMs`, a antiga é revogada imediatamente.
 */
export function rotateCredential(raw: unknown, keyId: string, opts: { graceMs?: number; expiresInMs?: number; expiresAt?: string } = {}, deps: CredentialDeps = {}): IssueResult & { replaced: string } {
  const now = (deps.now ?? Date.now)();
  const base = clone(raw);
  const { client, cred } = findCredential(base, keyId);
  if (cred.revokedAt !== undefined) throw new CredentialError(`Credencial ${keyId} já está revogada; emita uma nova com "issue".`);
  if (opts.graceMs && opts.graceMs > 0) {
    const until = now + opts.graceMs;
    const cur = typeof cred.expiresAt === 'string' ? Date.parse(cred.expiresAt) : Infinity;
    cred.expiresAt = iso(Math.min(cur, until));
  } else cred.revokedAt = iso(now);
  const issued = issueCredential(base, client.id as string, { ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}), ...(opts.expiresInMs ? { expiresInMs: opts.expiresInMs } : {}) }, deps);
  return { ...issued, replaced: keyId };
}

/** Lista as credenciais sem hashes nem tokens. */
export function listCredentials(raw: unknown, now: number = Date.now()): CredentialSummary[] {
  const r = validateConfig(raw);
  if (!r.ok) throw new CredentialError(`Configuração inválida (${r.errors.join(', ')}).`);
  return r.config.clients.flatMap((c) =>
    c.credentials.map((k) => ({
      clientId: c.id,
      keyId: k.keyId,
      status: !c.enabled ? 'titular desligado' : k.revokedAt !== undefined ? 'revogada' : k.expiresAt !== undefined && now >= Date.parse(k.expiresAt) ? 'expirada' : 'ativa',
      ...(k.createdAt ? { createdAt: k.createdAt } : {}),
      ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
      ...(k.revokedAt ? { revokedAt: k.revokedAt } : {}),
    })),
  );
}
