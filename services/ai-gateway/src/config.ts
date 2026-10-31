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
  /**
   * Hotfix 21.2, só Anthropic: esforço (`output_config.effort`) e modo de raciocínio (`thinking.type`). Nos modelos
   * atuais o raciocínio conta no `max_tokens`; com um limite de saída curto, desligá-lo (Haiku 5.5: `disabled`;
   * Sonnet 5.5: `between_tools`) evita resposta vazia cortada no limite. Ausente = padrão do modelo.
   */
  effort?: ModelEffort;
  thinking?: ModelThinking;
}

export const MODEL_EFFORTS = ['low', 'medium', 'high'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];
export const MODEL_THINKING = ['adaptive', 'disabled', 'between_tools'] as const;
export type ModelThinking = (typeof MODEL_THINKING)[number];

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

/**
 * Uma credencial de acesso (token) de um titular. Um titular pode ter várias ao mesmo tempo (ex.: durante
 * uma rotação com período de transição). Só o hash fica aqui; o token é mostrado uma única vez na emissão.
 */
export interface CredentialConfig {
  /** Identificador NÃO secreto da credencial, usado em auditoria, logs e revogação. */
  keyId: string;
  /** SHA-256 (hex) do token de acesso. O token em si nunca fica no servidor nem no repositório. */
  tokenSha256: string;
  /** Emissão (ISO 8601). Informativo. */
  createdAt?: string;
  /** Expiração opcional (ISO 8601). A partir deste instante o token é recusado. */
  expiresAt?: string;
  /** Revogação (ISO 8601). Presente = recusado. Mantido para auditoria. */
  revokedAt?: string;
}

export interface ClientConfig {
  /**
   * Identificador do titular (pseudônimo, não segredo). Não use nome, e-mail ou telefone: os logs usam o
   * `keyId` da credencial, mas o titular aparece no arquivo de configuração.
   */
  id: string;
  /** Desligar o titular recusa todas as credenciais dele. */
  enabled: boolean;
  credentials: CredentialConfig[];
  /** Sobrescreve a cota diária global para este titular. */
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
  /** Solicitações simultâneas ao provedor somando todos os titulares (protege o processo e o gasto). */
  maxConcurrentTotal: number;
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
  maxConcurrentTotal: 8,
  upstreamTimeoutMs: 30_000,
  maxUpstreamResponseBytes: 256 * 1024,
};

/**
 * Tetos aceitos na configuração. Um valor acima disso é erro (o gateway fica bloqueado), para que um
 * zero a mais não transforme um limite em ausência de limite.
 */
export const MAX_LIMITS: GatewayLimits = {
  maxBodyBytes: 1024 * 1024,
  maxMessages: 50,
  maxInputChars: 1_000_000,
  maxOutputTokens: 100_000,
  requestsPerMinute: 600,
  dailyTokenBudget: 100_000_000,
  maxConcurrentPerClient: 20,
  maxConcurrentTotal: 200,
  upstreamTimeoutMs: 300_000,
  maxUpstreamResponseBytes: 8 * 1024 * 1024,
};

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const CLIENT_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const KEY_ID = /^[a-z0-9][a-z0-9_-]{2,39}$/;
/** Data/hora ISO 8601 completa com fuso (ex.: 2026-11-30T12:00:00Z). */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
export const isIsoInstant = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));
/** keyId derivado para credenciais no formato antigo (P06: `tokenSha256` direto no titular). */
export const legacyKeyId = (sha: string) => `legacy-${sha.slice(0, 12)}`;
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
        if (!(k in DEFAULT_LIMITS) || !posInt(v, MAX_LIMITS[k as keyof GatewayLimits])) err(`limits.${k}`);
        else (limits as unknown as Obj)[k] = v;
      }
  }

  const clients: ClientConfig[] = [];
  if (!Array.isArray(raw.clients)) err('clients');
  else
    raw.clients.forEach((c, i) => {
      const at = `clients[${i}]`;
      if (!isObj(c) || typeof c.id !== 'string' || !CLIENT_ID.test(c.id) || typeof c.enabled !== 'boolean') return err(at);
      for (const k of Object.keys(c)) if (!['id', 'enabled', 'tokenSha256', 'credentials', 'dailyTokenBudget'].includes(k)) return err(`${at}.${k}`);
      if (c.dailyTokenBudget !== undefined && !posInt(c.dailyTokenBudget, MAX_LIMITS.dailyTokenBudget)) return err(`${at}.dailyTokenBudget`);
      const creds: CredentialConfig[] = [];
      // Formato do P06: um hash direto no titular. Continua aceito (vira uma credencial sem expiração).
      if (c.tokenSha256 !== undefined) {
        if (typeof c.tokenSha256 !== 'string' || !HEX64.test(c.tokenSha256)) return err(at);
        creds.push({ keyId: legacyKeyId(c.tokenSha256), tokenSha256: c.tokenSha256 });
      }
      if (c.credentials !== undefined) {
        if (!Array.isArray(c.credentials)) return err(`${at}.credentials`);
        let bad = false;
        c.credentials.forEach((k, j) => {
          const kat = `${at}.credentials[${j}]`;
          if (!isObj(k) || typeof k.keyId !== 'string' || !KEY_ID.test(k.keyId) || typeof k.tokenSha256 !== 'string' || !HEX64.test(k.tokenSha256)) return ((bad = true), err(kat));
          if (Object.keys(k).some((x) => !['keyId', 'tokenSha256', 'createdAt', 'expiresAt', 'revokedAt'].includes(x))) return ((bad = true), err(kat));
          for (const f of ['createdAt', 'expiresAt', 'revokedAt'] as const) if (k[f] !== undefined && !isIsoInstant(k[f])) return ((bad = true), err(`${kat}.${f}`));
          creds.push({
            keyId: k.keyId,
            tokenSha256: k.tokenSha256,
            ...(k.createdAt !== undefined ? { createdAt: k.createdAt as string } : {}),
            ...(k.expiresAt !== undefined ? { expiresAt: k.expiresAt as string } : {}),
            ...(k.revokedAt !== undefined ? { revokedAt: k.revokedAt as string } : {}),
          });
        });
        if (bad) return;
      }
      if (creds.length === 0) return err(`${at}.credentials`);
      clients.push({ id: c.id, enabled: c.enabled, credentials: creds, ...(c.dailyTokenBudget !== undefined ? { dailyTokenBudget: c.dailyTokenBudget as number } : {}) });
    });
  const allCreds = clients.flatMap((c) => c.credentials);
  if (new Set(clients.map((c) => c.id)).size !== clients.length) err('clients (titulares duplicados)');
  if (new Set(allCreds.map((k) => k.keyId)).size !== allCreds.length || new Set(allCreds.map((k) => k.tokenSha256)).size !== allCreds.length) err('clients (credenciais duplicadas)');

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
      // Servidor simulado em http://localhost é só para desenvolvimento: um gateway exposto fala HTTPS.
      else if (typeof p.baseUrl === 'string' && expose === true && !p.baseUrl.startsWith('https://')) err(`${at}.baseUrl (http só sem exposeBeyondLoopback)`);
      if (id === 'anthropic' && !(typeof p.apiVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.apiVersion))) err(`${at}.apiVersion`);
      if (!Array.isArray(p.models) || p.models.length === 0) {
        err(`${at}.models`);
        continue;
      }
      const models: ModelConfig[] = [];
      p.models.forEach((m, i) => {
        if (!isObj(m) || typeof m.id !== 'string' || !MODEL_ID.test(m.id) || !str(m.displayName, 80) || !posInt(m.maxInputChars, MAX_LIMITS.maxInputChars) || !posInt(m.maxOutputTokens, MAX_LIMITS.maxOutputTokens))
          return err(`${at}.models[${i}]`);
        if (m.effort !== undefined && (id !== 'anthropic' || !(MODEL_EFFORTS as readonly unknown[]).includes(m.effort))) return err(`${at}.models[${i}].effort`);
        if (m.thinking !== undefined && (id !== 'anthropic' || !(MODEL_THINKING as readonly unknown[]).includes(m.thinking))) return err(`${at}.models[${i}].thinking`);
        // Combinações que a API recusa com 400 (referência de 2026-10-31): Opus 5.5 e Sonnet 5.5 não aceitam `disabled`;
        // `between_tools` só existe no Sonnet 5.5.
        if (m.thinking === 'disabled' && /^claude-(opus|sonnet)-5-5/.test(m.id)) return err(`${at}.models[${i}].thinking (disabled não é aceito por ${m.id})`);
        if (m.thinking === 'between_tools' && !/^claude-sonnet-5-5/.test(m.id)) return err(`${at}.models[${i}].thinking (between_tools só no claude-sonnet-5-5)`);
        models.push({
          id: m.id,
          displayName: m.displayName,
          maxInputChars: m.maxInputChars,
          maxOutputTokens: m.maxOutputTokens,
          ...(m.effort !== undefined ? { effort: m.effort as ModelEffort } : {}),
          ...(m.thinking !== undefined ? { thinking: m.thinking as ModelThinking } : {}),
        });
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
