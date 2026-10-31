// Gateway seguro de IA do IronTrack (desenvolvimento). Servidor HTTP mínimo (node:http, sem
// framework e sem dependências) com duas rotas autenticadas:
//   GET  /v1/models    → provedores e modelos permitidos (sem dados do usuário)
//   POST /v1/generate  → encaminha UMA solicitação de texto ao provedor escolhido
// Ordem das proteções: configuração válida e ligada → origem (CORS, só para navegador) → rota →
// credencial (hash, expiração, revogação) → limite de requisições → corpo (tamanho, formato, tempo) →
// allowlist de provedor e modelo → limites de entrada/saída → chave do provedor no servidor →
// simultaneidade (titular e total) → cota diária (reserva) → chamada com tempo limite, cancelamento e sem
// redirecionamentos → normalização → resposta sem segredos → acerto da cota.
// Logs: só metadados (rota conhecida, status, código, keyId da credencial, provedor, modelo, duração,
// tokens). Nunca prompts, respostas, dados corporais, cabeçalhos, caminhos arbitrários ou chaves.
// Nada é persistido. A configuração pode ser recarregada (`reload`) sem reiniciar: credenciais revogadas
// passam a ser recusadas e requisições em andamento com elas são interrompidas.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { authenticate, stillValid } from './auth.ts';
import { validateConfig, type ConfigResult, type GatewayConfig, type ProviderId } from './config.ts';
import { GATEWAY_ERRORS, GatewayError, errorBody, isGatewayError, type GatewayErrorCode } from './errors.ts';
import { runGeneration } from './generation.ts';
import { MemoryUsageStore, type UsageStore } from './limits.ts';
import { GatewayMetrics, type LimitKind, type MetricsSnapshot } from './metrics.ts';
import { PROTOCOL_VERSION, parseGenerateRequest, type CatalogResponse, type GenerateResponse } from './protocol.ts';
import { ADAPTERS } from './providers/index.ts';
import type { FetchLike, UpstreamAdapter } from './providers/types.ts';

/** Evento de log: só metadados. */
export interface GatewayLogEvent {
  ts: string;
  id: string;
  /** Rota conhecida (`GET /v1/models`, `POST /v1/generate`…) ou `outra`: nunca o caminho digitado. */
  route: string;
  status: number;
  code?: GatewayErrorCode;
  /** Identificador NÃO secreto da credencial usada (não é o titular nem o token). */
  keyId?: string;
  provider?: string;
  model?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** De onde vieram os tokens: informados pelo provedor ou estimados pelo gateway. */
  usageSource?: 'reported' | 'estimated';
  /** Qual limite recusou a requisição, quando for o caso. */
  limit?: LimitKind;
}

export interface GatewayOptions {
  /** Configuração bruta (JSON lido do arquivo). Inválida ou ausente = gateway bloqueado. */
  config: unknown;
  /** Variáveis de ambiente com as chaves dos provedores. */
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => number;
  logger?: (e: GatewayLogEvent) => void;
  store?: UsageStore;
  /** Substitui adaptadores (testes). */
  adapters?: Partial<Record<ProviderId, UpstreamAdapter>>;
}

export interface Gateway {
  server: Server;
  /** Configuração efetiva, ou null se inválida (gateway bloqueado). */
  readonly config: GatewayConfig | null;
  readonly configErrors: string[];
  store: UsageStore;
  /**
   * Troca a configuração em execução (atômico: cada requisição usa uma configuração inteira, a antiga ou a
   * nova). Inválida = gateway BLOQUEADO até uma configuração válida (nunca mantém a antiga, que poderia
   * conter uma credencial que o operador quis revogar). Requisições em andamento cuja credencial deixou de
   * valer são interrompidas. Os contadores de limites e cotas são mantidos.
   */
  reload(raw: unknown): ConfigResult;
  /**
   * Encerramento gracioso: para de aceitar conexões, recusa novas requisições (503), espera as em andamento
   * até `graceMs` e interrompe o que restar. Sem novas tentativas.
   */
  shutdown(graceMs?: number): Promise<void>;
  /** Métricas agregadas, sem dados pessoais (só memória; não expostas por HTTP). */
  metrics(): MetricsSnapshot;
  /** Requisições /v1/generate em andamento (diagnóstico e testes). */
  inFlight(): number;
}

const ROUTES: Record<string, string> = { '/v1/models': 'GET', '/v1/generate': 'POST' };
const KNOWN_METHODS = new Set(['GET', 'POST', 'OPTIONS']);

/** Lê o corpo com limite de tamanho; termina se o sinal abortar ou o cliente desconectar. */
function readBody(req: IncomingMessage, max: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(new GatewayError('payload_too_large'));
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) return finish(() => reject(new GatewayError('payload_too_large')));
      chunks.push(c);
    });
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
    req.on('error', () => finish(() => reject(new GatewayError('cancelled'))));
    req.on('close', () => finish(() => reject(new GatewayError('cancelled'))));
  });
}

const parse = (raw: unknown): ConfigResult => (raw === undefined ? { ok: false, errors: ['(ausente)'] } : validateConfig(raw));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createGateway(opts: GatewayOptions): Gateway {
  let parsed: ConfigResult = parse(opts.config);
  let cfgNow: GatewayConfig | null = parsed.ok ? parsed.config : null;
  const env = opts.env ?? {};
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? (() => {});
  const store = opts.store ?? new MemoryUsageStore();
  const adapters = { ...ADAPTERS, ...opts.adapters };
  const metrics = new GatewayMetrics(now());
  /** Requisições /v1/generate em andamento: credencial usada e o controle para interrompê-las. */
  const running = new Map<string, { keyId: string; tokenSha256: string; ctrl: AbortController }>();
  /** Chamadas a provedores em andamento, somando todos os titulares. */
  const upstream = { active: 0 };
  let draining = false;

  /** Chaves configuradas: usadas só para chamar o provedor e para garantir que nunca saiam na resposta. */
  const secretOf = (cfg: GatewayConfig | null, id: ProviderId): string | undefined => {
    const p = cfg?.providers[id];
    const v = p ? env[p.apiKeyEnv] : undefined;
    return typeof v === 'string' && v.trim().length >= 8 ? v.trim() : undefined;
  };
  const secrets = (cfg: GatewayConfig | null): string[] => (cfg ? (Object.keys(cfg.providers) as ProviderId[]).map((id) => secretOf(cfg, id)).filter((s): s is string => !!s) : []);

  const catalog = (cfg: GatewayConfig): CatalogResponse => ({
    protocol: PROTOCOL_VERSION,
    providers: (Object.entries(cfg.providers) as [ProviderId, NonNullable<GatewayConfig['providers'][ProviderId]>][])
      .filter(([, p]) => p.enabled)
      .map(([id, p]) => ({ id, displayName: p.displayName, available: !!secretOf(cfg, id), models: p.models.map((m) => ({ id: m.id, displayName: m.displayName, maxInputChars: m.maxInputChars, maxOutputTokens: m.maxOutputTokens })) })),
  });

  async function generate(c: GatewayConfig, req: IncomingMessage, signal: AbortSignal, clientId: string, log: Partial<GatewayLogEvent>): Promise<GenerateResponse> {
    const L = c.limits;
    const ct = String(req.headers['content-type'] ?? '');
    if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(ct)) throw new GatewayError('request_invalid');
    const raw = await readBody(req, L.maxBodyBytes, signal);
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new GatewayError('request_invalid');
    }
    const body = parseGenerateRequest(json, L);
    const client = c.clients.find((x) => x.id === clientId)!;
    return runGeneration(
      { store, adapters, fetch: fetchFn, now, upstream },
      { config: c, body, clientId, dailyBudget: client.dailyTokenBudget ?? L.dailyTokenBudget, maxConcurrent: L.maxConcurrentPerClient, signal, apiKeyFor: (id) => secretOf(c, id), log },
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const cfg = cfgNow; // configuração inteira desta requisição (um reload não a troca no meio)
    const log: Partial<GatewayLogEvent> = { id: randomUUID() };
    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctrl.abort(new GatewayError('cancelled'));
    });

    const origin = req.headers.origin;
    const corsOk = typeof origin === 'string' && !!cfg?.allowedOrigins.includes(origin);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (corsOk) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }

    const send = (status: number, body: unknown, code?: GatewayErrorCode) => {
      if (res.writableEnded || res.destroyed) return;
      let text = JSON.stringify(body);
      // Defesa extra: nenhuma chave de provedor sai numa resposta, aconteça o que acontecer.
      if (secrets(cfg).some((s) => text.includes(s))) {
        status = 500;
        code = 'internal_error';
        text = JSON.stringify(errorBody('internal_error'));
      }
      log.status = status;
      if (code) log.code = code;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(text);
    };
    const fail = (code: GatewayErrorCode) => {
      if (code === 'unauthorized') res.setHeader('www-authenticate', 'Bearer');
      if (code === 'rate_limited') res.setHeader('retry-after', '60');
      if (code === 'payload_too_large' || draining) res.setHeader('connection', 'close');
      send(GATEWAY_ERRORS[code].status, errorBody(code), code);
    };

    let path = '/';
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.invalid');
      path = url.pathname;
      // Só rótulos conhecidos vão para o log: um caminho digitado poderia carregar dados.
      log.route = path in ROUTES && KNOWN_METHODS.has(req.method ?? '') ? `${req.method} ${path}` : 'outra';
      if (draining) return fail('gateway_disabled');
      if (req.method === 'OPTIONS') {
        if (!corsOk || !(path in ROUTES)) return fail('origin_not_allowed');
        res.setHeader('access-control-allow-methods', 'GET, POST');
        res.setHeader('access-control-allow-headers', 'authorization, content-type');
        res.setHeader('access-control-max-age', '600');
        res.statusCode = 204;
        log.status = 204;
        res.end();
        return;
      }
      if (typeof origin === 'string' && !corsOk) return fail('origin_not_allowed');
      if (!cfg || !cfg.enabled) return fail('gateway_disabled');
      if (!(path in ROUTES) || url.search) return fail('not_found');
      if (req.method !== ROUTES[path]) return fail('method_not_allowed');

      const auth = authenticate(req.headers.authorization, cfg.clients, now());
      if (!auth) return fail('unauthorized');
      log.keyId = auth.credential.keyId;
      if ((await store.hit(auth.client.id, now())) > cfg.limits.requestsPerMinute) {
        log.limit = 'requests_per_minute';
        return fail('rate_limited');
      }

      if (path === '/v1/models') return send(200, catalog(cfg));

      running.set(log.id!, { keyId: auth.credential.keyId, tokenSha256: auth.credential.tokenSha256, ctrl });
      // O tempo limite cobre a leitura do corpo e a chamada ao provedor: nada prende o titular para sempre.
      const timer = setTimeout(() => ctrl.abort(new GatewayError('timeout')), cfg.limits.upstreamTimeoutMs);
      try {
        send(200, await generate(cfg, req, ctrl.signal, auth.client.id, log));
      } finally {
        clearTimeout(timer);
        running.delete(log.id!);
      }
    } catch (e) {
      const code: GatewayErrorCode = ctrl.signal.aborted && isGatewayError(ctrl.signal.reason) ? ctrl.signal.reason.code : isGatewayError(e) ? e.code : 'internal_error';
      if (code === 'cancelled') log.status = GATEWAY_ERRORS.cancelled.status;
      fail(code);
      if (code === 'cancelled') log.code = 'cancelled';
    } finally {
      const event: GatewayLogEvent = { ts: new Date(now()).toISOString(), id: log.id!, route: log.route ?? 'outra', status: log.status ?? 0, durationMs: now() - started };
      for (const k of ['code', 'keyId', 'provider', 'model', 'inputTokens', 'outputTokens', 'usageSource', 'limit'] as const) if (log[k] !== undefined) (event as unknown as Record<string, unknown>)[k] = log[k];
      try {
        metrics.record(event);
        logger(event);
      } catch {
        /* log nunca derruba a resposta */
      }
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  // Limites do próprio servidor HTTP contra conexões lentas.
  server.headersTimeout = 10_000;
  server.requestTimeout = (cfgNow?.limits.upstreamTimeoutMs ?? 30_000) + 15_000;
  server.maxHeadersCount = 50;

  return {
    server,
    get config() {
      return cfgNow;
    },
    get configErrors() {
      return parsed.ok ? [] : parsed.errors;
    },
    store,
    reload(raw: unknown): ConfigResult {
      parsed = parse(raw);
      cfgNow = parsed.ok ? parsed.config : null;
      const t = now();
      const usable = cfgNow && cfgNow.enabled ? cfgNow : null;
      for (const r of running.values())
        if (!usable) r.ctrl.abort(new GatewayError('gateway_disabled'));
        else if (!stillValid(usable.clients, r.keyId, r.tokenSha256, t)) r.ctrl.abort(new GatewayError('unauthorized'));
      return parsed;
    },
    async shutdown(graceMs = 10_000): Promise<void> {
      draining = true;
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      const deadline = Date.now() + graceMs;
      while (running.size > 0 && Date.now() < deadline) await sleep(25);
      for (const r of running.values()) r.ctrl.abort(new GatewayError('gateway_disabled'));
      // Dá tempo de as respostas 503 saírem antes de fechar os sockets.
      for (let i = 0; i < 40 && running.size > 0; i++) await sleep(25);
      server.closeAllConnections();
      await closed;
    },
    metrics: () => metrics.snapshot(),
    inFlight: () => running.size,
  };
}
