// Configuração da API a partir de variáveis de ambiente (Railway). Nenhum valor secreto é registrado em log: os erros
// citam só o NOME da variável. Ver docs/NUVEM_IMPLANTACAO.md §4 (lista completa, sem valores).
import { readFileSync } from 'node:fs';
import { validateConfig, type GatewayConfig } from '../../ai-gateway/src/config.ts';

export type EmailProvider = 'disabled' | 'resend' | 'test-mailbox';
export type DbSsl = 'disable' | 'require' | 'verify-full';

export interface ApiConfig {
  env: 'production' | 'development' | 'test';
  port: number;
  host: string;
  databaseUrl: string;
  dbSsl: DbSsl;
  dbCa?: string;
  dbPoolMax: number;
  /** Origem pública do app (links dos e-mails) e origens aceitas na checagem CSRF/CORS. */
  appOrigin: string;
  allowedOrigins: string[];
  /** Expressão regular opcional para origens de pré-visualização (ex.: deploy previews da Netlify). */
  allowedOriginPattern: RegExp | null;
  cookieSecure: boolean;
  cookieName: string;
  sessionTtlDays: number;
  sessionIdleDays: number;
  /** Proxies confiáveis à frente da API (Netlify + Railway = 2). Define de onde vem o IP do cliente. */
  trustProxyHops: number;
  /** Segredo para o hash das chaves de limite (IP, e-mail). Nunca registrado. */
  rateLimitSecret: string;
  signupEnabled: boolean;
  email: { provider: EmailProvider; from: string; resendApiKey?: string };
  ai: { config: GatewayConfig | null; errors: string[]; requireVerifiedEmail: boolean; dailyTokenBudget: number; dailyRequests: number; maxConcurrentPerUser: number };
  requestTimeoutMs: number;
  maxBodyBytes: number;
  /** Rotas de teste (caixa de e-mail simulada). Proibido em produção. */
  testMode: boolean;
  accessLog: boolean;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Configuração inválida: ${problems.join('; ')}`);
    this.problems = problems;
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const int = (env: Env, name: string, def: number, min: number, max: number, problems: string[]): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    problems.push(`${name} deve ser inteiro entre ${min} e ${max}`);
    return def;
  }
  return v;
};

function originOk(o: string, env: ApiConfig['env']): boolean {
  try {
    const u = new URL(o);
    if (u.origin !== o) return false;
    if (u.protocol === 'https:') return true;
    return env !== 'production' && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Carrega a configuração de IA (formato do gateway, `clients: []`, sem segredos): AI_CONFIG_JSON > AI_CONFIG_PATH > config/ai.json. */
function loadAiConfig(env: Env): { config: GatewayConfig | null; errors: string[] } {
  let raw: unknown;
  try {
    raw = env.AI_CONFIG_JSON ? JSON.parse(env.AI_CONFIG_JSON) : JSON.parse(readFileSync(env.AI_CONFIG_PATH ?? new URL('../config/ai.json', import.meta.url).pathname, 'utf8'));
  } catch {
    return { config: null, errors: [env.AI_CONFIG_JSON ? 'AI_CONFIG_JSON (JSON inválido)' : 'AI_CONFIG_PATH (arquivo ausente ou JSON inválido)'] };
  }
  const r = validateConfig(raw);
  if (!r.ok) return { config: null, errors: r.errors };
  // Em produção, provedor só por HTTPS (um endereço http só serve para o provedor simulado dos testes, em loopback).
  if (env.NODE_ENV === 'production') {
    const insecure = Object.entries(r.config.providers).filter(([, p]) => p?.baseUrl && !p.baseUrl.startsWith('https://'));
    if (insecure.length) return { config: null, errors: insecure.map(([id]) => `providers.${id}.baseUrl (produção exige https)`) };
  }
  return { config: r.config, errors: [] };
}

export function loadConfig(env: Env = process.env): ApiConfig {
  const problems: string[] = [];
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL ausente ou sem o esquema postgres://');
  let dbHost = '';
  try {
    dbHost = new URL(databaseUrl).hostname;
  } catch {
    /* já reportado */
  }
  const sslRaw = env.DATABASE_SSL;
  // Rede privada do Railway (*.railway.internal) não usa TLS; qualquer outro host exige TLS por padrão.
  const dbSsl: DbSsl = sslRaw === 'disable' || sslRaw === 'require' || sslRaw === 'verify-full' ? sslRaw : dbHost.endsWith('.railway.internal') || ['localhost', '127.0.0.1'].includes(dbHost) ? 'disable' : 'require';
  if (sslRaw && !['disable', 'require', 'verify-full'].includes(sslRaw)) problems.push('DATABASE_SSL deve ser disable, require ou verify-full');

  const appOrigin = (env.APP_ORIGIN ?? '').trim();
  if (!originOk(appOrigin, nodeEnv)) problems.push('APP_ORIGIN deve ser a origem pública do app (ex.: https://irontrack.netlify.app)');
  const extra = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of extra) if (!originOk(o, nodeEnv)) problems.push('ALLOWED_ORIGINS contém uma origem inválida');
  let pattern: RegExp | null = null;
  if (env.ALLOWED_ORIGIN_PATTERN) {
    try {
      const src = env.ALLOWED_ORIGIN_PATTERN;
      if (!src.startsWith('^') || !src.endsWith('$') || !src.startsWith('^https://')) throw new Error('ancorar');
      pattern = new RegExp(src);
    } catch {
      problems.push('ALLOWED_ORIGIN_PATTERN deve ser uma expressão ancorada que comece com ^https:// e termine com $');
    }
  }

  const cookieSecure = env.COOKIE_SECURE === 'false' ? false : true;
  if (!cookieSecure && nodeEnv === 'production') problems.push('COOKIE_SECURE=false é proibido em produção');

  const rateLimitSecret = env.RATE_LIMIT_SECRET ?? '';
  if (rateLimitSecret.length < 32) problems.push('RATE_LIMIT_SECRET deve ter pelo menos 32 caracteres aleatórios');

  const providerRaw = env.EMAIL_PROVIDER ?? 'disabled';
  const provider: EmailProvider = providerRaw === 'resend' || providerRaw === 'test-mailbox' ? providerRaw : 'disabled';
  if (!['disabled', 'resend', 'test-mailbox'].includes(providerRaw)) problems.push('EMAIL_PROVIDER deve ser disabled, resend ou test-mailbox');
  const testMode = env.API_TEST_MODE === '1';
  if (testMode && nodeEnv === 'production') problems.push('API_TEST_MODE é proibido em produção');
  if (provider === 'test-mailbox' && !testMode) problems.push('EMAIL_PROVIDER=test-mailbox exige API_TEST_MODE=1 (e nunca em produção)');
  const from = env.EMAIL_FROM ?? '';
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY || env.RESEND_API_KEY.length < 10) problems.push('RESEND_API_KEY ausente');
    if (!/^[^<>]{0,80}<?[^\s@<>]+@[^\s@<>]+>?$/.test(from)) problems.push('EMAIL_FROM ausente ou inválido (ex.: IronTrack <nao-responda@seu-dominio>)');
  }

  const ai = loadAiConfig(env);

  const cfg: ApiConfig = {
    env: nodeEnv,
    port: int(env, 'PORT', 8080, 0, 65535, problems),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl,
    dbSsl,
    ...(env.DATABASE_SSL_CA ? { dbCa: env.DATABASE_SSL_CA } : {}),
    dbPoolMax: int(env, 'DATABASE_POOL_MAX', 10, 1, 50, problems),
    appOrigin,
    allowedOrigins: [...new Set([appOrigin, ...extra])],
    allowedOriginPattern: pattern,
    cookieSecure,
    cookieName: cookieSecure ? '__Host-irontrack_session' : 'irontrack_session',
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 30, 1, 90, problems),
    sessionIdleDays: int(env, 'SESSION_IDLE_DAYS', 14, 1, 90, problems),
    trustProxyHops: int(env, 'TRUST_PROXY_HOPS', 1, 0, 5, problems),
    rateLimitSecret,
    signupEnabled: env.SIGNUP_ENABLED !== 'false',
    email: { provider, from, ...(env.RESEND_API_KEY ? { resendApiKey: env.RESEND_API_KEY } : {}) },
    ai: {
      ...ai,
      requireVerifiedEmail: env.AI_REQUIRE_VERIFIED_EMAIL !== 'false',
      dailyTokenBudget: int(env, 'AI_DAILY_TOKENS_PER_USER', 20_000, 1, 10_000_000, problems),
      dailyRequests: int(env, 'AI_DAILY_REQUESTS_PER_USER', 50, 1, 100_000, problems),
      maxConcurrentPerUser: int(env, 'AI_MAX_CONCURRENT_PER_USER', 1, 1, 10, problems),
    },
    requestTimeoutMs: int(env, 'REQUEST_TIMEOUT_MS', 30_000, 1_000, 120_000, problems),
    maxBodyBytes: int(env, 'MAX_BODY_BYTES', 4 * 1024 * 1024, 1024, 20 * 1024 * 1024, problems),
    testMode,
    accessLog: env.ACCESS_LOG !== 'off',
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
