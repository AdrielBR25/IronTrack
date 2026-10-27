// Gateway seguro de IA do IronTrack (desenvolvimento). Servidor HTTP mínimo (node:http, sem
// framework e sem dependências) com duas rotas autenticadas:
//   GET  /v1/models    → provedores e modelos permitidos (sem dados do usuário)
//   POST /v1/generate  → encaminha UMA solicitação de texto ao provedor escolhido
// Ordem das proteções: configuração válida e ligada → origem (CORS, só para navegador) → rota →
// credencial → limite de requisições → corpo (tamanho, formato) → allowlist de provedor e modelo →
// limites de entrada/saída → chave do provedor no servidor → simultaneidade → cota diária →
// chamada com tempo limite e cancelamento → normalização → resposta sem segredos.
// Logs: só metadados (rota, status, código, titular, provedor, modelo, duração, tokens). Nunca
// prompts, respostas, dados corporais, cabeçalhos ou chaves. Nada é persistido.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { authenticate } from './auth.ts';
import { isProviderId, validateConfig, type ConfigResult, type GatewayConfig, type ProviderId } from './config.ts';
import { GATEWAY_ERRORS, GatewayError, errorBody, isGatewayError, type GatewayErrorCode } from './errors.ts';
import { MemoryUsageStore, estimateTokens, utcDay, type UsageStore } from './limits.ts';
import { PROTOCOL_VERSION, inputChars, parseGenerateRequest, type CatalogResponse, type GenerateResponse } from './protocol.ts';
import { ADAPTERS } from './providers/index.ts';
import { splitSystem, type FetchLike, type UpstreamAdapter } from './providers/types.ts';

/** Evento de log: só metadados. */
export interface GatewayLogEvent {
  ts: string;
  id: string;
  route: string;
  status: number;
  code?: GatewayErrorCode;
  clientId?: string;
  provider?: string;
  model?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
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
  config: GatewayConfig | null;
  configErrors: string[];
  store: UsageStore;
}

const ROUTES: Record<string, string> = { '/v1/models': 'GET', '/v1/generate': 'POST' };

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(new GatewayError('payload_too_large'));
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > max) {
        failed = true;
        reject(new GatewayError('payload_too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', () => !failed && reject(new GatewayError('cancelled')));
  });
}

/** Corre `p` mas termina assim que o sinal abortar (mesmo se o adaptador ignorar o sinal). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export function createGateway(opts: GatewayOptions): Gateway {
  const parsed: ConfigResult = opts.config === undefined ? { ok: false, errors: ['(ausente)'] } : validateConfig(opts.config);
  const cfg = parsed.ok ? parsed.config : null;
  const env = opts.env ?? {};
  const fetchFn: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? (() => {});
  const store = opts.store ?? new MemoryUsageStore();
  const adapters = { ...ADAPTERS, ...opts.adapters };

  /** Chaves configuradas: usadas só para chamar o provedor e para garantir que nunca saiam na resposta. */
  const secretOf = (id: ProviderId): string | undefined => {
    const p = cfg?.providers[id];
    const v = p ? env[p.apiKeyEnv] : undefined;
    return typeof v === 'string' && v.trim().length >= 8 ? v.trim() : undefined;
  };
  const secrets = (): string[] => (cfg ? (Object.keys(cfg.providers) as ProviderId[]).map(secretOf).filter((s): s is string => !!s) : []);

  const catalog = (): CatalogResponse => ({
    protocol: PROTOCOL_VERSION,
    providers: cfg
      ? (Object.entries(cfg.providers) as [ProviderId, NonNullable<GatewayConfig['providers'][ProviderId]>][])
          .filter(([, p]) => p.enabled)
          .map(([id, p]) => ({ id, displayName: p.displayName, available: !!secretOf(id), models: p.models.map((m) => ({ ...m })) }))
      : [],
  });

  async function generate(req: IncomingMessage, signal: AbortSignal, clientId: string, log: Partial<GatewayLogEvent>): Promise<GenerateResponse> {
    const c = cfg!;
    const L = c.limits;
    const ct = String(req.headers['content-type'] ?? '');
    if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(ct)) throw new GatewayError('request_invalid');
    const raw = await readBody(req, L.maxBodyBytes);
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new GatewayError('request_invalid');
    }
    const body = parseGenerateRequest(json, L);
    if (!isProviderId(body.provider) || !c.providers[body.provider]?.enabled) throw new GatewayError('provider_not_allowed');
    const pid = body.provider;
    const pcfg = c.providers[pid]!;
    log.provider = pid;
    const model = pcfg.models.find((m) => m.id === body.model);
    if (!model) throw new GatewayError('model_not_allowed');
    log.model = model.id;
    const chars = inputChars(body.messages);
    if (chars > Math.min(L.maxInputChars, model.maxInputChars)) throw new GatewayError('payload_too_large');
    if (body.maxOutputTokens > Math.min(L.maxOutputTokens, model.maxOutputTokens)) throw new GatewayError('request_invalid');
    const apiKey = secretOf(pid);
    if (!apiKey) throw new GatewayError('provider_unavailable');

    if (!(await store.acquire(clientId, L.maxConcurrentPerClient))) throw new GatewayError('rate_limited');
    try {
      const client = c.clients.find((x) => x.id === clientId)!;
      const day = utcDay(now());
      const reserved = estimateTokens(chars) + body.maxOutputTokens;
      if (!(await store.reserve(clientId, day, reserved, client.dailyTokenBudget ?? L.dailyTokenBudget))) throw new GatewayError('quota_exceeded');
      const adapter = adapters[pid];
      const result = await raceAbort(
        adapter.generate(
          { model: model.id, ...splitSystem(body.messages), maxOutputTokens: body.maxOutputTokens },
          { apiKey, fetch: fetchFn, signal, baseUrl: pcfg.baseUrl ?? adapter.defaultBaseUrl, maxResponseBytes: L.maxUpstreamResponseBytes, ...(pcfg.apiVersion ? { apiVersion: pcfg.apiVersion } : {}) },
        ),
        signal,
      );
      // Conferência final do formato devolvido pelo adaptador.
      if (!result || typeof result.text !== 'string' || (result.finishReason !== 'stop' && result.finishReason !== 'length')) throw new GatewayError('invalid_response');
      const maxChars = body.maxOutputTokens * 4;
      const cut = result.text.length > maxChars;
      const inTok = result.usage?.inputTokens ?? estimateTokens(chars);
      const outTok = result.usage?.outputTokens ?? estimateTokens(Math.min(result.text.length, maxChars));
      // Falhas mantêm a reserva (o provedor pode ter cobrado); sucesso troca a reserva pelo consumo real.
      await store.settle(clientId, day, reserved, inTok + outTok);
      log.inputTokens = inTok;
      log.outputTokens = outTok;
      return {
        provider: pid,
        model: model.id,
        output: { type: 'text', text: cut ? result.text.slice(0, maxChars) : result.text },
        finishReason: cut ? 'length' : result.finishReason,
        ...(result.usage ? { usage: { ...result.usage } } : {}),
      };
    } finally {
      await store.release(clientId);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
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
    if (corsOk) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
    }

    const send = (status: number, body: unknown, code?: GatewayErrorCode) => {
      if (res.writableEnded || res.destroyed) return;
      let text = JSON.stringify(body);
      // Defesa extra: nenhuma chave de provedor sai numa resposta, aconteça o que acontecer.
      if (secrets().some((s) => text.includes(s))) {
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
      if (code === 'payload_too_large') res.setHeader('connection', 'close');
      send(GATEWAY_ERRORS[code].status, errorBody(code), code);
    };

    let path = '/';
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.invalid');
      path = url.pathname;
      log.route = `${req.method} ${path}`;
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

      const client = authenticate(req.headers.authorization, cfg.clients);
      if (!client) return fail('unauthorized');
      log.clientId = client.id;
      if ((await store.hit(client.id, now())) > cfg.limits.requestsPerMinute) return fail('rate_limited');

      if (path === '/v1/models') return send(200, catalog());

      const timer = setTimeout(() => ctrl.abort(new GatewayError('timeout')), cfg.limits.upstreamTimeoutMs);
      try {
        send(200, await generate(req, ctrl.signal, client.id, log));
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const code: GatewayErrorCode = ctrl.signal.aborted && isGatewayError(ctrl.signal.reason) ? ctrl.signal.reason.code : isGatewayError(e) ? e.code : 'internal_error';
      if (code === 'cancelled') log.status = GATEWAY_ERRORS.cancelled.status;
      fail(code);
      if (code === 'cancelled') log.code = 'cancelled';
    } finally {
      const event: GatewayLogEvent = { ts: new Date(now()).toISOString(), id: log.id!, route: log.route ?? `${req.method} ${path}`, status: log.status ?? 0, durationMs: now() - started };
      for (const k of ['code', 'clientId', 'provider', 'model', 'inputTokens', 'outputTokens'] as const) if (log[k] !== undefined) (event as unknown as Record<string, unknown>)[k] = log[k];
      try {
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
  server.requestTimeout = (cfg?.limits.upstreamTimeoutMs ?? 30_000) + 15_000;
  server.maxHeadersCount = 50;

  return { server, config: cfg, configErrors: parsed.ok ? [] : parsed.errors, store };
}
