// Contrato interno dos adaptadores de provedores do gateway (lado servidor).
import type { WireMessage } from '../protocol.ts';

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

/** Solicitação já validada e autorizada pelo gateway. */
export interface UpstreamRequest {
  model: string;
  /** Instrução de sistema (extraída da primeira mensagem, se houver). */
  system?: string;
  /** Só user/assistant, terminando em user. */
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
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
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface UpstreamAdapter {
  readonly id: 'openai' | 'anthropic' | 'gemini';
  /** Endereço oficial fixo. O cliente nunca escolhe o endereço. */
  readonly defaultBaseUrl: string;
  generate(req: UpstreamRequest, ctx: UpstreamContext): Promise<UpstreamResult>;
}

/** Separa a instrução de sistema das demais mensagens. */
export function splitSystem(messages: readonly WireMessage[]): Pick<UpstreamRequest, 'system' | 'messages'> {
  const [first, ...rest] = messages;
  if (first?.role === 'system') return { system: first.content, messages: rest as UpstreamRequest['messages'] };
  return { messages: messages as UpstreamRequest['messages'] };
}
