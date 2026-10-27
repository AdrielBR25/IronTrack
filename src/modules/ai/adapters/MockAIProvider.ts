// Provedor simulado: roda no aparelho, sem rede, sem chave e sem SDK. Devolve textos fictícios,
// determinísticos e marcados como simulação; serve para testar registro, seleção, permissões,
// cancelamento e erros. Não é usado pela interface do app.
import type { AIProvider } from '../domain/contracts';
import { AIError } from '../domain/errors';
import type { AIModelInfo, AIProviderResult, AIRequest, AIRequestOptions } from '../domain/types';

/**
 * - `echo`: resposta fictícia determinística (padrão);
 * - `fail`: falha do provedor com mensagem interna (o serviço deve escondê-la);
 * - `invalid_response`: resposta fora do contrato;
 * - `overlong`: texto maior que o limite pedido;
 * - `hang`: nunca responde (só termina por cancelamento ou tempo limite).
 */
export type MockBehavior = 'echo' | 'fail' | 'invalid_response' | 'overlong' | 'hang';

export interface MockAIProviderOptions {
  id?: string;
  displayName?: string;
  models?: AIModelInfo[];
  behavior?: MockBehavior;
  /** Atraso simulado em ms antes de responder (respeita cancelamento). */
  latencyMs?: number;
  available?: boolean;
}

export const MOCK_MODELS: AIModelInfo[] = [
  {
    id: 'mock-text',
    displayName: 'Simulado (texto)',
    capabilities: { textGeneration: true, systemMessages: true, structuredOutput: false, imageInput: false, streaming: false, maxInputChars: 32_000, maxOutputTokens: 1_024 },
  },
  {
    id: 'mock-structured',
    displayName: 'Simulado (JSON)',
    capabilities: { textGeneration: true, systemMessages: true, structuredOutput: true, imageInput: false, streaming: false, maxInputChars: 32_000, maxOutputTokens: 1_024 },
  },
  {
    id: 'mock-tiny',
    displayName: 'Simulado (sem mensagem de sistema)',
    capabilities: { textGeneration: true, systemMessages: false, structuredOutput: false, imageInput: false, streaming: false, maxInputChars: 4_000, maxOutputTokens: 64 },
  },
];

export const MOCK_DISCLAIMER = 'Resposta fictícia de simulação: não é orientação de treino, médica ou nutricional.';

/** FNV-1a de 32 bits: assinatura determinística da entrada (não é segurança). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AIError('cancelled'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AIError('cancelled'));
    };
    const timer = Number.isFinite(ms)
      ? setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms)
      : undefined;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class MockAIProvider implements AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind = 'simulated' as const;
  readonly models: readonly AIModelInfo[];
  behavior: MockBehavior;
  private readonly latencyMs: number;
  private available: boolean;
  /** Cópias das solicitações recebidas (só em memória), para os testes conferirem o que chegou. */
  readonly received: AIRequest[] = [];

  constructor(opts: MockAIProviderOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.displayName = opts.displayName ?? 'Provedor simulado';
    this.models = opts.models ?? MOCK_MODELS;
    this.behavior = opts.behavior ?? 'echo';
    this.latencyMs = opts.latencyMs ?? 0;
    this.available = opts.available ?? true;
  }

  setAvailable(v: boolean): void {
    this.available = v;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async generate(request: AIRequest, options: AIRequestOptions = {}): Promise<AIProviderResult> {
    const { signal } = options;
    if (signal?.aborted) throw new AIError('cancelled', this.id);
    this.received.push(structuredClone(request));
    await wait(this.behavior === 'hang' ? Infinity : this.latencyMs, signal);

    const input = request.messages.map((m) => `${m.role}:${m.content}`).join('\n');
    const signature = fnv1a(input);
    switch (this.behavior) {
      case 'fail':
        // Mensagem interna proposital: o serviço não pode repassá-la ao usuário nem aos logs.
        throw new Error(`mock upstream failure ${signature}: ${input.slice(0, 40)}`);
      case 'invalid_response':
        return { modelId: request.modelId, output: { type: 'text', text: 42 }, finishReason: 'stop' } as unknown as AIProviderResult;
      case 'overlong':
        return { modelId: request.modelId, output: { type: 'text', text: `[SIMULAÇÃO] ${'x'.repeat(request.maxOutputTokens * 8)}` }, finishReason: 'stop' };
      default:
        break;
    }
    const text = `[SIMULAÇÃO] Provedor simulado, modelo ${request.modelId}. Mensagens: ${request.messages.length}; caracteres de entrada: ${input.length}; assinatura: ${signature}. ${MOCK_DISCLAIMER}`;
    if (request.responseFormat.type === 'json') {
      const value = { simulated: true, schema: request.responseFormat.schemaName, signature, note: MOCK_DISCLAIMER };
      return { modelId: request.modelId, output: { type: 'json', text: JSON.stringify(value), value }, finishReason: 'stop', usage: { inputTokens: Math.ceil(input.length / 4), outputTokens: 32 } };
    }
    return { modelId: request.modelId, output: { type: 'text', text }, finishReason: 'stop', usage: { inputTokens: Math.ceil(input.length / 4), outputTokens: Math.ceil(text.length / 4) } };
  }
}
