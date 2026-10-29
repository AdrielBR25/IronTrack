// Tipos de dados do módulo de IA (IronTrack 2.0 F01/P04). Puros: sem React, sem Dexie,
// sem rede. Nada aqui é persistido nem entra no backup. Ver docs/IA_ARQUITETURA.md.

/** Valor JSON (respostas estruturadas futuras). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Capacidades declaradas de um modelo. Cada modelo declara as suas: não se presume que todos os
 * modelos de um provedor (nem de provedores diferentes) façam as mesmas coisas.
 */
export interface AICapabilities {
  /** Gera texto a partir de mensagens. */
  textGeneration: boolean;
  /** Aceita mensagem de sistema separada. */
  systemMessages: boolean;
  /** Pode devolver JSON conforme um esquema (ainda não usado pelo app). */
  structuredOutput: boolean;
  /** Aceita imagens na entrada (não usado: fotos ficam bloqueadas). */
  imageInput: boolean;
  /** Pode transmitir a resposta aos poucos (não usado nesta etapa). */
  streaming: boolean;
  /** Tamanho máximo da entrada, em caracteres (todas as mensagens somadas). */
  maxInputChars: number;
  /** Limite máximo de saída aceito pelo modelo, em tokens. */
  maxOutputTokens: number;
}

/** Capacidades booleanas que uma solicitação pode exigir. */
export type AICapabilityFlag = { [K in keyof AICapabilities]: AICapabilities[K] extends boolean ? K : never }[keyof AICapabilities];

export interface AIModelInfo {
  id: string;
  displayName: string;
  capabilities: AICapabilities;
}

/** Onde o provedor executa. `simulated` não sai do aparelho e não usa rede. */
export type AIProviderKind = 'remote' | 'local' | 'simulated';

export type AIMessageRole = 'system' | 'user' | 'assistant';

export interface AIMessage {
  role: AIMessageRole;
  content: string;
}

/** Formato pedido da resposta. `json` existe no contrato, mas exige `structuredOutput`. */
export type AIResponseFormat = { type: 'text' } | { type: 'json'; schemaName: string };

/** Solicitação já validada, como o adaptador a recebe. */
export interface AIRequest {
  modelId: string;
  messages: readonly AIMessage[];
  /** Limite de saída em tokens, já conferido com o modelo. */
  maxOutputTokens: number;
  responseFormat: AIResponseFormat;
}

export interface AIRequestOptions {
  /** Cancelamento. O adaptador deve parar e rejeitar com `cancelled`. */
  signal?: AbortSignal;
}

export type AIOutput = { type: 'text'; text: string } | { type: 'json'; text: string; value: JsonValue };

export type AIFinishReason = 'stop' | 'length';

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** O que o adaptador devolve. O serviço confere em tempo de execução antes de usar. */
export interface AIProviderResult {
  modelId: string;
  output: AIOutput;
  finishReason: AIFinishReason;
  usage?: AIUsage;
}

/** Metadados da execução, preenchidos pelo serviço (não pelo adaptador). */
export interface AIExecutionMetadata {
  requestId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  simulated: boolean;
  /** A saída foi cortada no limite pedido. */
  truncated: boolean;
}

/** Resposta normalizada entregue a quem chamou o serviço. Só leitura: não altera dados. */
export interface AIResponse {
  providerId: string;
  modelId: string;
  output: AIOutput;
  finishReason: AIFinishReason;
  usage?: AIUsage;
  metadata: AIExecutionMetadata;
}
