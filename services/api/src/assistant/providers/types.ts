// Contrato interno dos provedores do assistente (com ferramentas e streaming). O núcleo (engine.ts) só conhece este
// contrato: um novo provedor implementa `ChatProvider` sem duplicar contexto, ferramentas, limites ou persistência.
import type { FetchLike } from '../../../../ai-gateway/src/providers/types.ts';

export type { FetchLike };

/** Definição de ferramenta enviada ao modelo (JSON Schema dos argumentos). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Itens da conversa de um turno. `opaque` guarda itens próprios do provedor (ex.: raciocínio criptografado da OpenAI)
 * que precisam voltar exatamente como vieram dentro do mesmo turno; nunca são gravados no banco.
 */
export type ChatItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string; raw?: unknown }
  | { type: 'tool_result'; callId: string; output: string }
  | { type: 'opaque'; raw: unknown };

export interface ChatRequest {
  model: string;
  instructions: string;
  input: ChatItem[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  reasoningEffort?: string;
}

export interface ChatContext {
  apiKey: string;
  fetch: FetchLike;
  signal: AbortSignal;
  baseUrl: string;
  maxResponseBytes: number;
}

export interface ChatResult {
  text: string;
  toolCalls: { callId: string; name: string; arguments: string }[];
  /** Itens de saída para reenviar ao provedor na próxima rodada do mesmo turno. */
  outputItems: ChatItem[];
  finish: 'stop' | 'length' | 'tool_calls';
  usage: { inputTokens: number; outputTokens: number };
}

export interface ChatProvider {
  readonly id: string;
  readonly defaultBaseUrl: string;
  /** Uma rodada: o texto chega aos poucos por `onText`; o resultado traz as chamadas de ferramenta. */
  stream(req: ChatRequest, ctx: ChatContext, onText: (delta: string) => void): Promise<ChatResult>;
  /** Diagnóstico sem custo (chave aceita e modelo liberado). */
  check(model: string, ctx: ChatContext): Promise<void>;
}
