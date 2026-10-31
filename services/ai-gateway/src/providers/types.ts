// Contrato interno dos adaptadores de provedores do gateway (lado servidor).
import type { ModelEffort, ModelThinking } from '../config.ts';
import type { WireMessage } from '../protocol.ts';

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'manual' }) => Promise<Response>;

/** Solicitação já validada e autorizada pelo gateway. */
export interface UpstreamRequest {
  model: string;
  /** Instrução de sistema (extraída da primeira mensagem, se houver). */
  system?: string;
  /** Só user/assistant, terminando em user. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  /** Só Anthropic (ver ModelConfig). */
  effort?: ModelEffort;
  thinking?: ModelThinking;
}

export interface UpstreamContext {
  apiKey: string;
  fetch: FetchLike;
  signal: AbortSignal;
  /** Endereço base (oficial do adaptador, ou o definido pelo operador). */
  baseUrl: string;
  maxResponseBytes: number;
  apiVersion?: string;
}

export interface UpstreamResult {
  text: string;
  finishReason: 'stop' | 'length';
  /** Uso informado pelo provedor. `outputTokens` inclui tokens de raciocínio quando o provedor os cobra como saída. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface UpstreamAdapter {
  readonly id: 'openai' | 'anthropic' | 'gemini';
  /** Endereço oficial fixo. O cliente nunca escolhe o endereço. */
  readonly defaultBaseUrl: string;
  generate(req: UpstreamRequest, ctx: UpstreamContext): Promise<UpstreamResult>;
  /**
   * Hotfix 21.2: diagnóstico SEM custo (nenhum token gerado): confere se a chave é aceita e se o modelo existe e está
   * liberado para ela. Resolve sem valor quando ok; rejeita com GatewayError normalizado. Ausente = sem diagnóstico.
   */
  check?(model: string, ctx: UpstreamContext): Promise<void>;
}

/** Separa a instrução de sistema das demais mensagens. */
export function splitSystem(messages: readonly WireMessage[]): Pick<UpstreamRequest, 'system' | 'messages'> {
  const [first, ...rest] = messages;
  if (first?.role === 'system') return { system: first.content, messages: rest as UpstreamRequest['messages'] };
  return { messages: messages as UpstreamRequest['messages'] };
}
