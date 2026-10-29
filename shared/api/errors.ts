// Códigos de erro da API do IronTrack (Prompt 21). A resposta HTTP traz só o código e uma frase fixa em pt-BR:
// nunca pilha, SQL, configuração, e-mail de terceiros ou segredo. O app mostra a frase (ou uma própria).

export const API_ERRORS = {
  bad_request: { status: 400, message: 'Solicitação inválida.' },
  validation_failed: { status: 422, message: 'Alguns campos não são válidos.' },
  unauthenticated: { status: 401, message: 'Sua sessão expirou ou não existe. Entre novamente.' },
  invalid_credentials: { status: 401, message: 'E-mail ou senha incorretos.' },
  forbidden: { status: 403, message: 'Acesso negado.' },
  csrf_failed: { status: 403, message: 'Solicitação bloqueada por segurança (origem não confirmada). Recarregue a página.' },
  email_not_verified: { status: 403, message: 'Confirme seu e-mail para usar este recurso.' },
  account_mismatch: { status: 409, message: 'Os dados pendentes deste aparelho pertencem a outra conta. Nada foi enviado.' },
  not_found: { status: 404, message: 'Não encontrado.' },
  method_not_allowed: { status: 405, message: 'Método não permitido.' },
  signup_unavailable: { status: 409, message: 'Não foi possível criar a conta com esses dados. Se você já tem conta, entre ou recupere a senha.' },
  token_invalid: { status: 400, message: 'O link é inválido, expirou ou já foi usado. Peça um novo.' },
  weak_password: { status: 422, message: 'A senha não atende aos requisitos.' },
  payload_too_large: { status: 413, message: 'Dados maiores que o limite permitido.' },
  rate_limited: { status: 429, message: 'Muitas tentativas. Aguarde um pouco e tente de novo.' },
  email_not_configured: { status: 503, message: 'O envio de e-mails ainda não foi configurado neste servidor. Este recurso está indisponível por enquanto.' },
  email_failed: { status: 502, message: 'Não foi possível enviar o e-mail agora. Tente novamente em alguns minutos.' },
  import_invalid: { status: 422, message: 'O conteúdo da importação é inválido. Nada foi gravado.' },
  import_state: { status: 409, message: 'Esta importação não está mais disponível para esta ação.' },
  service_unavailable: { status: 503, message: 'Serviço temporariamente indisponível.' },
  timeout: { status: 504, message: 'O servidor demorou demais para responder.' },
  internal_error: { status: 500, message: 'Erro interno. Nada foi alterado.' },
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;

export interface ApiErrorBody {
  error: { code: ApiErrorCode | string; message: string; fields?: Record<string, string> };
}

/** Cabeçalho exigido em toda alteração (proteção CSRF junto com a checagem de origem). */
export const CSRF_HEADER = 'x-irontrack-csrf';
export const CSRF_VALUE = '1';
