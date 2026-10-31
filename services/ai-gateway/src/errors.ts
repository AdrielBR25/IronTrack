// Erros normalizados do gateway. A resposta HTTP carrega só o código e uma frase fixa: nunca o
// texto do provedor, a pilha, a configuração, o prompt ou a credencial.

export type GatewayErrorCode =
  | 'gateway_disabled'
  | 'not_found'
  | 'method_not_allowed'
  | 'origin_not_allowed'
  | 'unauthorized'
  | 'request_invalid'
  | 'payload_too_large'
  | 'provider_not_allowed'
  | 'model_not_allowed'
  | 'provider_unavailable'
  | 'provider_auth_failed'
  | 'provider_forbidden'
  | 'provider_billing'
  | 'model_unavailable'
  | 'provider_unreachable'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'provider_rate_limited'
  | 'timeout'
  | 'cancelled'
  | 'provider_failure'
  | 'content_filtered'
  | 'invalid_response'
  | 'internal_error';

export const GATEWAY_ERRORS: Record<GatewayErrorCode, { status: number; message: string }> = {
  gateway_disabled: { status: 503, message: 'O gateway de IA está desativado ou sem configuração válida.' },
  not_found: { status: 404, message: 'Rota inexistente.' },
  method_not_allowed: { status: 405, message: 'Método não permitido.' },
  origin_not_allowed: { status: 403, message: 'Origem não permitida.' },
  unauthorized: { status: 401, message: 'Credencial de acesso ausente ou inválida.' },
  request_invalid: { status: 400, message: 'Solicitação inválida.' },
  payload_too_large: { status: 413, message: 'Solicitação maior que o limite permitido.' },
  provider_not_allowed: { status: 403, message: 'Provedor não permitido neste gateway.' },
  model_not_allowed: { status: 403, message: 'Modelo não permitido neste gateway.' },
  provider_unavailable: { status: 503, message: 'O provedor escolhido não está configurado neste gateway.' },
  // Hotfix 21.2: recusas do provedor separadas por causa (a frase é fixa; o texto do provedor nunca é repassado).
  provider_auth_failed: { status: 503, message: 'O provedor recusou a chave configurada no servidor (inválida ou revogada).' },
  provider_forbidden: { status: 503, message: 'A chave configurada no servidor não tem permissão para este recurso do provedor.' },
  provider_billing: { status: 503, message: 'O provedor recusou por falta de créditos ou problema de faturamento da conta.' },
  model_unavailable: { status: 503, message: 'O modelo não existe ou não está liberado para a chave configurada no servidor.' },
  provider_unreachable: { status: 502, message: 'Não foi possível contatar o provedor (falha de rede). Nenhuma nova tentativa foi feita.' },
  rate_limited: { status: 429, message: 'Muitas solicitações. Aguarde um pouco.' },
  quota_exceeded: { status: 429, message: 'A cota de uso desta credencial acabou por hoje.' },
  provider_rate_limited: { status: 429, message: 'O provedor recusou por limite de uso ou cota da conta. Nenhuma nova tentativa foi feita.' },
  timeout: { status: 504, message: 'O provedor demorou demais para responder.' },
  cancelled: { status: 499, message: 'Solicitação cancelada.' },
  provider_failure: { status: 502, message: 'O provedor falhou ao responder. Nenhuma nova tentativa foi feita.' },
  content_filtered: { status: 502, message: 'O provedor recusou ou bloqueou a resposta.' },
  invalid_response: { status: 502, message: 'O provedor devolveu uma resposta inválida.' },
  internal_error: { status: 500, message: 'Erro interno do gateway.' },
};

export interface ReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  /** Uso informado pelo provedor numa resposta 2xx recusada/inválida (o provedor cobrou). */
  readonly usage?: ReportedUsage;
  constructor(code: GatewayErrorCode, usage?: ReportedUsage) {
    super(GATEWAY_ERRORS[code].message);
    this.name = 'GatewayError';
    this.code = code;
    if (usage) this.usage = usage;
  }
}

export const isGatewayError = (e: unknown): e is GatewayError => e instanceof GatewayError;

/** Corpo JSON de erro: só código e frase fixa. */
export const errorBody = (code: GatewayErrorCode) => ({ error: { code, message: GATEWAY_ERRORS[code].message } });
