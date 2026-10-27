// Provedor remoto via gateway seguro (IronTrack 2.0 F01/P06). O navegador NUNCA fala direto com
// OpenAI, Anthropic ou Gemini e nunca vê chaves de provedor: envia a solicitação já autorizada ao
// gateway (services/ai-gateway), que autentica a credencial de acesso, aplica limites e repassa.
// Este adaptador não faz rede por conta própria: recebe um `transport` da raiz de composição
// (src/integrations/ai), que conhece o endereço e o token. Aqui só há mapeamento de contrato.
import type { AIProvider } from '../domain/contracts';
import { AIError, type AIErrorCode } from '../domain/errors';
import type { AIModelInfo, AIProviderResult, AIRequest, AIRequestOptions } from '../domain/types';

/** Versão do protocolo do gateway (ver services/ai-gateway/src/protocol.ts). */
export const GATEWAY_PROTOCOL = 'irontrack.ai-gateway.v1';

export interface GatewayHttpResult {
  status: number;
  /** Corpo já lido e limitado pelo transporte. */
  body: unknown;
}

/**
 * Transporte HTTP injetado. Só aceita as duas rotas do contrato; o cliente não escolhe endereço,
 * cabeçalho nem provedor de destino além do que o gateway permite. Deve rejeitar com
 * `AIError('gateway_unreachable')` em falha de rede e `AIError('cancelled')` se o sinal abortar.
 */
export type GatewayTransport = (req: { method: 'GET'; path: '/v1/models'; signal?: AbortSignal } | { method: 'POST'; path: '/v1/generate'; body: unknown; signal?: AbortSignal }) => Promise<GatewayHttpResult>;

export interface GatewayProviderEntry {
  id: string;
  displayName: string;
  /** false = permitido no gateway, mas sem chave configurada no servidor. */
  available: boolean;
  models: AIModelInfo[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const PROVIDER_ID = /^[a-z][a-z0-9-]{1,19}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Converte o catálogo do gateway em provedores e modelos. Campos fora do contrato são ignorados;
 * entradas inválidas são descartadas. Capacidades remotas: só texto, com sistema; sem JSON, imagem
 * ou streaming nesta etapa (não se presume que todos os modelos façam o mesmo).
 */
export function parseGatewayCatalog(body: unknown): GatewayProviderEntry[] {
  if (!isObj(body) || body.protocol !== GATEWAY_PROTOCOL || !Array.isArray(body.providers)) throw new AIError('invalid_response');
  const out: GatewayProviderEntry[] = [];
  for (const p of body.providers.slice(0, 10)) {
    if (!isObj(p) || typeof p.id !== 'string' || !PROVIDER_ID.test(p.id) || p.id === 'mock' || !shortText(p.displayName, 60) || typeof p.available !== 'boolean' || !Array.isArray(p.models)) continue;
    const models: AIModelInfo[] = [];
    for (const m of p.models.slice(0, 20)) {
      if (!isObj(m) || typeof m.id !== 'string' || !MODEL_ID.test(m.id) || !shortText(m.displayName, 80) || !posInt(m.maxInputChars) || !posInt(m.maxOutputTokens)) continue;
      if (models.some((x) => x.id === m.id)) continue;
      models.push({
        id: m.id,
        displayName: m.displayName,
        capabilities: { textGeneration: true, systemMessages: true, structuredOutput: false, imageInput: false, streaming: false, maxInputChars: m.maxInputChars, maxOutputTokens: m.maxOutputTokens },
      });
    }
    if (models.length && !out.some((x) => x.id === p.id)) out.push({ id: p.id, displayName: p.displayName, available: p.available, models });
  }
  return out;
}

/** Código de erro do gateway → código do app. Nunca usa a mensagem do servidor. */
export function gatewayErrorCode(status: number, body: unknown): AIErrorCode {
  const code = isObj(body) && isObj(body.error) && typeof body.error.code === 'string' ? body.error.code : '';
  const map: Record<string, AIErrorCode> = {
    unauthorized: 'access_denied',
    origin_not_allowed: 'access_denied',
    gateway_disabled: 'provider_unavailable',
    provider_not_allowed: 'provider_unavailable',
    provider_unavailable: 'provider_unavailable',
    model_not_allowed: 'model_unsupported',
    request_invalid: 'request_invalid',
    payload_too_large: 'request_invalid',
    rate_limited: 'rate_limited',
    // P07: limite/cota da conta no próprio provedor (distinto do limite do gateway no servidor).
    provider_rate_limited: 'rate_limited',
    quota_exceeded: 'quota_exceeded',
    timeout: 'timeout',
    content_filtered: 'content_blocked',
    invalid_response: 'invalid_response',
    provider_failure: 'provider_failure',
  };
  if (map[code]) return map[code];
  if (status === 401 || status === 403) return 'access_denied';
  if (status === 429) return 'rate_limited';
  if (status === 504) return 'timeout';
  return 'provider_failure';
}

export interface GatewayAIProviderOptions {
  entry: GatewayProviderEntry;
  transport: GatewayTransport;
  /** Endereço público do gateway (origem), para a prévia. */
  gatewayOrigin: string;
}

export class GatewayAIProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind = 'remote' as const;
  readonly models: readonly AIModelInfo[];
  readonly destination: string;
  private readonly available: boolean;
  private readonly transport: GatewayTransport;

  constructor(opts: GatewayAIProviderOptions) {
    this.id = opts.entry.id;
    this.displayName = opts.entry.displayName;
    this.models = opts.entry.models;
    this.available = opts.entry.available;
    this.transport = opts.transport;
    this.destination = `${opts.gatewayOrigin} → ${opts.entry.displayName}`;
  }

  /** Disponibilidade informada pelo catálogo. Não faz rede e não envia dados. */
  isAvailable(): boolean {
    return this.available;
  }

  async generate(request: AIRequest, options: AIRequestOptions = {}): Promise<AIProviderResult> {
    if (options.signal?.aborted) throw new AIError('cancelled', this.id);
    if (request.responseFormat.type !== 'text') throw new AIError('capability_unsupported', this.id);
    const body = {
      provider: this.id,
      model: request.modelId,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      maxOutputTokens: request.maxOutputTokens,
    };
    const res = await this.transport({ method: 'POST', path: '/v1/generate', body, signal: options.signal });
    if (res.status !== 200) throw new AIError(gatewayErrorCode(res.status, res.body), this.id);
    const b = res.body;
    if (!isObj(b) || b.provider !== this.id || b.model !== request.modelId || !isObj(b.output) || b.output.type !== 'text' || typeof b.output.text !== 'string')
      throw new AIError('invalid_response', this.id);
    if (b.finishReason !== 'stop' && b.finishReason !== 'length') throw new AIError('invalid_response', this.id);
    const u = isObj(b.usage) ? b.usage : {};
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const usage = { ...(ok(u.inputTokens) ? { inputTokens: u.inputTokens } : {}), ...(ok(u.outputTokens) ? { outputTokens: u.outputTokens } : {}) };
    return { modelId: request.modelId, output: { type: 'text', text: b.output.text }, finishReason: b.finishReason, ...(Object.keys(usage).length ? { usage } : {}) };
  }
}
