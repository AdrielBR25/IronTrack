// Contrato HTTP entre o IronTrack (GatewayAIProvider) e o gateway. Validação estrita: campos
// desconhecidos são recusados, de modo que o cliente NÃO consegue indicar endpoint, URL, cabeçalho,
// chave, ferramenta ou parâmetro extra do provedor.
import { GatewayError } from './errors.ts';
import type { GatewayLimits } from './config.ts';

export const PROTOCOL_VERSION = 'irontrack.ai-gateway.v1';

export type WireRole = 'system' | 'user' | 'assistant';
export interface WireMessage {
  role: WireRole;
  content: string;
}

/** POST /v1/generate */
export interface GenerateRequest {
  provider: string;
  model: string;
  messages: WireMessage[];
  maxOutputTokens: number;
}

export interface GenerateResponse {
  provider: string;
  model: string;
  output: { type: 'text'; text: string };
  finishReason: 'stop' | 'length';
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** GET /v1/models */
export interface CatalogResponse {
  protocol: typeof PROTOCOL_VERSION;
  providers: {
    id: string;
    displayName: string;
    /** false = provedor permitido, mas sem chave configurada no servidor. */
    available: boolean;
    models: { id: string; displayName: string; maxInputChars: number; maxOutputTokens: number }[];
  }[];
}

const ROLES: readonly string[] = ['system', 'user', 'assistant'];
const KEYS = ['provider', 'model', 'messages', 'maxOutputTokens'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Valida o corpo. Regras: só as chaves do contrato; 1..maxMessages mensagens; `system` só na primeira
 * posição; a última é do usuário; conteúdo texto não vazio; maxOutputTokens inteiro positivo.
 * Limites de tamanho (entrada/saída) são conferidos depois, contra o modelo escolhido.
 */
export function parseGenerateRequest(body: unknown, limits: GatewayLimits): GenerateRequest {
  const bad = () => new GatewayError('request_invalid');
  if (!isObj(body)) throw bad();
  if (Object.keys(body).some((k) => !KEYS.includes(k))) throw bad();
  const { provider, model, messages, maxOutputTokens } = body;
  if (typeof provider !== 'string' || !/^[a-z]{2,20}$/.test(provider)) throw bad();
  if (typeof model !== 'string' || model.length === 0 || model.length > 100) throw bad();
  if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) throw bad();
  if (!Array.isArray(messages) || messages.length === 0) throw bad();
  if (messages.length > limits.maxMessages) throw new GatewayError('payload_too_large');
  const out: WireMessage[] = messages.map((m, i) => {
    if (!isObj(m) || Object.keys(m).some((k) => k !== 'role' && k !== 'content')) throw bad();
    if (typeof m.role !== 'string' || !ROLES.includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) throw bad();
    if (m.role === 'system' && i !== 0) throw bad();
    return { role: m.role as WireRole, content: m.content };
  });
  if (out[out.length - 1].role !== 'user') throw bad();
  return { provider, model, messages: out, maxOutputTokens: maxOutputTokens as number };
}

export const inputChars = (messages: readonly WireMessage[]) => messages.reduce((a, m) => a + m.content.length, 0);
