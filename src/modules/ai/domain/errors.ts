// Erros padronizados do módulo de IA. A mensagem é sempre a frase fixa do código, pensada para o
// usuário: nunca carrega texto do provedor, do prompt, do contexto ou de exceções internas.

export type AIErrorCode =
  | 'provider_not_found'
  | 'provider_duplicate'
  | 'provider_invalid'
  | 'provider_unavailable'
  | 'model_unsupported'
  | 'capability_unsupported'
  | 'permission_denied'
  | 'context_invalid'
  | 'request_invalid'
  | 'cancelled'
  | 'timeout'
  | 'provider_failure'
  | 'invalid_response'
  | 'access_denied'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'gateway_unreachable'
  | 'content_blocked';

export const AI_ERROR_MESSAGES: Record<AIErrorCode, string> = {
  provider_not_found: 'O provedor de IA escolhido não está disponível neste aparelho.',
  provider_duplicate: 'Já existe um provedor de IA registrado com este identificador.',
  provider_invalid: 'A configuração do provedor de IA é inválida.',
  provider_unavailable: 'O provedor de IA escolhido não pode ser usado agora (sem chave no servidor, chave recusada ou sem permissão).',
  model_unsupported: 'O modelo escolhido não é oferecido por este provedor.',
  capability_unsupported: 'O modelo escolhido não suporta este tipo de solicitação.',
  permission_denied: 'Nenhum dado foi enviado: falta a sua autorização para esta solicitação.',
  context_invalid: 'Os dados selecionados para a IA são inválidos ou excedem o limite.',
  request_invalid: 'A solicitação para a IA é inválida ou excede o limite.',
  cancelled: 'A solicitação para a IA foi cancelada.',
  timeout: 'A IA demorou demais para responder e a solicitação foi encerrada.',
  provider_failure: 'O provedor de IA falhou ao responder. Nenhuma nova tentativa foi feita.',
  invalid_response: 'O provedor de IA devolveu uma resposta inválida.',
  access_denied: 'O servidor seguro do IronTrack recusou o acesso: o token pode estar errado, revogado ou expirado. Confira o token de acesso.',
  rate_limited: 'Limite de uso atingido (muitas solicitações, cota ou faturamento da conta no provedor). Aguarde um pouco e tente de novo.',
  quota_exceeded: 'A cota de uso de IA desta credencial acabou por hoje.',
  gateway_unreachable: 'Não foi possível contatar o servidor seguro do IronTrack (gateway de IA). Verifique a internet e o endereço.',
  content_blocked: 'O provedor de IA recusou ou bloqueou esta resposta.',
};

export class AIError extends Error {
  readonly code: AIErrorCode;
  /** Provedor envolvido, quando houver (identificador público, nunca credencial). */
  readonly providerId?: string;

  constructor(code: AIErrorCode, providerId?: string) {
    super(AI_ERROR_MESSAGES[code]);
    this.name = 'AIError';
    this.code = code;
    this.providerId = providerId;
  }

  /** Serialização segura para logs: só o código, o provedor e a mensagem fixa. */
  toJSON(): { name: string; code: AIErrorCode; providerId?: string; message: string } {
    return { name: this.name, code: this.code, providerId: this.providerId, message: this.message };
  }
}

export const isAIError = (e: unknown): e is AIError => e instanceof AIError;

/** Converte qualquer falha em `AIError` sem carregar a mensagem original (pode ter dados sensíveis). */
export function toAIError(e: unknown, fallback: AIErrorCode, providerId?: string): AIError {
  if (isAIError(e)) return e.providerId || !providerId ? e : new AIError(e.code, providerId);
  return new AIError(fallback, providerId);
}
