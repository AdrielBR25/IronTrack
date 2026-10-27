// Contrato que todo adaptador de provedor de IA implementa (OpenAI, Anthropic, Gemini,
// Ollama e o simulado). O resto do app conhece só este contrato, nunca o adaptador.
import type { AIModelInfo, AIProviderKind, AIProviderResult, AIRequest, AIRequestOptions } from './types';

export interface AIProvider {
  /** Identificador estável, minúsculo (ex.: "mock", "openai"). Único no registro. */
  readonly id: string;
  readonly displayName: string;
  readonly kind: AIProviderKind;
  /** Modelos oferecidos, cada um com as próprias capacidades. */
  readonly models: readonly AIModelInfo[];
  /**
   * Se o provedor pode atender agora (configurado, alcançável). Não deve enviar dados do usuário.
   * Ausente = sempre disponível.
   */
  isAvailable?(): boolean | Promise<boolean>;
  /**
   * Executa a solicitação. Deve respeitar `options.signal`, não repetir a requisição sozinho e
   * rejeitar com `AIError` (ou qualquer erro, que o serviço converte em `provider_failure`).
   */
  generate(request: AIRequest, options?: AIRequestOptions): Promise<AIProviderResult>;
}

/** Visão pública de um provedor registrado: o que a interface pode listar, sem internals. */
export interface AIProviderDescriptor {
  id: string;
  displayName: string;
  kind: AIProviderKind;
  models: AIModelInfo[];
}
