// Configuração do gateway: arquivo JSON SEM segredos (allowlists, limites, hashes de credenciais de
// acesso) + variáveis de ambiente com as chaves dos provedores. Qualquer erro de configuração deixa o
// gateway BLOQUEADO (todas as rotas respondem `gateway_disabled`), nunca aberto.

export const PROVIDER_IDS = ['openai', 'anthropic', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export const isProviderId = (v: unknown): v is ProviderId => typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);

export interface ModelConfig {
  /** ID exato do modelo no provedor. Só modelos listados aqui podem ser usados. */
  id: string;
  displayName: string;
  /** Limite de entrada aceito pelo gateway para este modelo (caracteres, todas as mensagens). */
  maxInputChars: number;
  /** Limite de saída aceito pelo gateway para este modelo (tokens). */
  maxOutputTokens: number;
}

export interface ProviderConfig {
  enabled: boolean;
  displayName: string;
  /** Nome da variável de ambiente com a chave (a chave em si nunca fica no arquivo). */
  apiKeyEnv: string;
  /**
   * Endereço base do provedor. Ausente = endereço oficial fixo no adaptador. Só o operador define
   * (nunca o cliente); aceita https ou http em loopback (servidor simulado local nos testes).
   */
  baseUrl?: string;
  /** Anthropic: valor do cabeçalho `anthropic-version` (obrigatório para esse provedor). */
  apiVersion?: string;
  models: ModelConfig[];
}

export interface ClientConfig {
  /** Identificador do titular da credencial (aparece nos logs; não é segredo). */
  id: string;
  /** SHA-256 (hex) do token de acesso. O token em si nunca fica no servidor nem no repositório. */
  tokenSha256: string;
  enabled: boolean;
  /** Sobrescreve a cota diária global para esta credencial. */
  dailyTokenBudget?: number;
}

export interface GatewayLimits {
  maxBodyBytes: number;
  maxMessages: number;
  maxInputChars: number;
  maxOutputTokens: number;
  requestsPerMinute: number;
  dailyTokenBudget: number;
  maxConcurrentPerClient: number;
  upstreamTimeoutMs: number;
  maxUpstreamResponseBytes: number;
}

export interface GatewayConfig {
  /** Interruptor geral. Padrão do exemplo: false (bloqueado). */
  enabled: boolean;
  host: string;
  port: number;
  /** Permite escutar fora do loopback. Só com HTTPS na frente e armazenamento compartilhado de limites. */
  exposeBeyondLoopback: boolean;
  /** Origens que recebem cabeçalhos CORS. CORS NÃO é autenticação: só controla o navegador. */
  allowedOrigins: string[];
  clients: ClientConfig[];
  limits: GatewayLimits;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  maxBodyBytes: 64 * 1024,
  maxMessages: 6,
  maxInputChars: 24_000,
  maxOutputTokens: 1_024,
  requestsPerMinute: 10,
  dailyTokenBudget: 50_000,
  maxConcurrentPerClient: 2,
  upstreamTimeoutMs: 30_000,
  maxUpstreamResponseBytes: 256 * 1024,
};

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const CLIENT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const isLoopbackHost = (h: string) => LOOPBACK.has(h);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export type ConfigResult = { ok: true; config: GatewayConfig } | { ok: false; errors: string[] };

function validUrlBase(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.username || url.password || url.search || url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

function validOrigin(o: unknown): boolean {
  if (typeof o !== 'string' || o === '*' || o === 'null') return false;
  try {
    const u = new URL(o);
    return u.origin === o && (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname)));
  } catch {
    return false;
  }
}

/**
 * Valida a configuração. Erros listam só o caminho do campo (nunca valores). Campos desconhecidos são
 * rejeitados para que um erro de digitação não desligue silenciosamente uma proteção.
 */
export function validateConfig(raw: unknown): ConfigResult {
  const errors: string[] = [];
  const err = (path: string) => errors.push(path);
  if (!isObj(raw)) return { ok: false, errors: ['(raiz)'] };
  const known = ['enabled', 'host', 'port', 'exposeBeyondLoopback', 'allowedOrigins', 'clients', 'limits', 'providers', '$comment'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) err(k);

  if (typeof raw.enabled !== 'boolean') err('enabled');
  const host = raw.host ?? '127.0.0.1';
  if (!str(host, 255)) err('host');
  const port = raw.port ?? 8787;
  if (!(typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535)) err('port');
  const expose = raw.exposeBeyondLoopback ?? false;
  if (typeof expose !== 'boolean') err('exposeBeyondLoopback');
  if (typeof host === 'string' && !isLoopbackHost(host) && expose !== true) err('host (fora do loopback exige exposeBeyondLoopback)');

  const origins = raw.allowedOrigins ?? [];
  if (!Array.isArray(origins) || !origins.every(validOrigin)) err('allowedOrigins');

  const limits: GatewayLimits = { ...DEFAULT_LIMITS };
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) err('limits');
    else
      for (const [k, v] of Object.entries(raw.limits)) {
        if (!(k in DEFAULT_LIMITS) || !posInt(v)) err(`limits.${k}`);
        else (limits as unknown as Obj)[k] = v;
      }
  }

  const clients: ClientConfig[] = [];
  if (!Array.isArray(raw.clients)) err('clients');
  else
    raw.clients.forEach((c, i) => {
      if (!isObj(c) || typeof c.id !== 'string' || !CLIENT_ID.test(c.id) || typeof c.tokenSha256 !== 'string' || !HEX64.test(c.tokenSha256) || typeof c.enabled !== 'boolean')
        return err(`clients[${i}]`);
      if (c.dailyTokenBudget !== undefined && !posInt(c.dailyTokenBudget)) return err(`clients[${i}].dailyTokenBudget`);
      clients.push({ id: c.id, tokenSha256: c.tokenSha256, enabled: c.enabled, ...(c.dailyTokenBudget !== undefined ? { dailyTokenBudget: c.dailyTokenBudget as number } : {}) });
    });
  if (new Set(clients.map((c) => c.id)).size !== clients.length || new Set(clients.map((c) => c.tokenSha256)).size !== clients.length) err('clients (duplicados)');

  const providers: GatewayConfig['providers'] = {};
  if (raw.providers !== undefined && !isObj(raw.providers)) err('providers');
  else
    for (const [id, p] of Object.entries((raw.providers as Obj | undefined) ?? {})) {
      const at = `providers.${id}`;
      if (!isProviderId(id)) {
        err(at);
        continue;
      }
      if (!isObj(p) || typeof p.enabled !== 'boolean' || !str(p.displayName, 60) || typeof p.apiKeyEnv !== 'string' || !ENV_NAME.test(p.apiKeyEnv) || p.apiKeyEnv.startsWith('VITE_')) {
        err(at);
        continue;
      }
      if (p.baseUrl !== undefined && (typeof p.baseUrl !== 'string' || !validUrlBase(p.baseUrl))) err(`${at}.baseUrl`);
      if (id === 'anthropic' && !(typeof p.apiVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.apiVersion))) err(`${at}.apiVersion`);
      if (!Array.isArray(p.models) || p.models.length === 0) {
        err(`${at}.models`);
        continue;
      }
      const models: ModelConfig[] = [];
      p.models.forEach((m, i) => {
        if (!isObj(m) || typeof m.id !== 'string' || !MODEL_ID.test(m.id) || !str(m.displayName, 80) || !posInt(m.maxInputChars, 1_000_000) || !posInt(m.maxOutputTokens, 100_000))
          return err(`${at}.models[${i}]`);
        models.push({ id: m.id, displayName: m.displayName, maxInputChars: m.maxInputChars, maxOutputTokens: m.maxOutputTokens });
      });
      if (new Set(models.map((m) => m.id)).size !== models.length) err(`${at}.models (duplicados)`);
      providers[id] = {
        enabled: p.enabled,
        displayName: p.displayName as string,
        apiKeyEnv: p.apiKeyEnv,
        ...(typeof p.baseUrl === 'string' ? { baseUrl: p.baseUrl.replace(/\/+$/, '') } : {}),
        ...(typeof p.apiVersion === 'string' ? { apiVersion: p.apiVersion } : {}),
        models,
      };
    }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      enabled: raw.enabled as boolean,
      host: host as string,
      port: port as number,
      exposeBeyondLoopback: expose as boolean,
      allowedOrigins: origins as string[],
      clients,
      limits,
      providers,
    },
  };
}
