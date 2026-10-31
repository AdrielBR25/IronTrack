// Regras puras da tela do assistente (IronTrack 2.0 F01/P05): validação da pergunta, finalidade,
// rótulos e mensagens de erro. Sem React e sem banco, para testar sem montar a tela.
import { AI_REQUEST_LIMITS, isAIError, type AIContextCategory, type AIErrorCode, type AIPurpose, type ContextExclusionReason } from '@/modules/ai';
import type { AssistantCategory } from '@/integrations/ai/contextSources';
import type { ModelHealth, ProviderHealth } from '@/integrations/ai/assistantService';

export const MAX_QUESTION_CHARS = AI_REQUEST_LIMITS.maxInstructionChars;

export type QuestionCheck = { ok: true; text: string } | { ok: false; error: string };

/** Valida a pergunta antes de preparar qualquer coisa. */
export function validateQuestion(raw: string): QuestionCheck {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: false, error: 'Escreva uma pergunta antes de enviar.' };
  if (text.length > MAX_QUESTION_CHARS)
    return { ok: false, error: `A pergunta pode ter no máximo ${MAX_QUESTION_CHARS.toLocaleString('pt-BR')} caracteres (agora tem ${text.length.toLocaleString('pt-BR')}).` };
  return { ok: true, text };
}

export const CATEGORY_LABEL: Record<AIContextCategory, string> = {
  training_summary: 'Resumo de treinos',
  training_history: 'Histórico de treinos',
  body_measurements: 'Medidas corporais',
  body_evolution: 'Evolução corporal',
  profile_preferences: 'Preferências do perfil',
  training_goals: 'Metas de treino',
  progress_photos: 'Fotos de progresso',
};

export const CATEGORY_HINT: Record<AIContextCategory, string> = {
  training_summary: 'Números dos últimos 28 dias: treinos, séries, volume, consistência e grupos musculares.',
  training_history: 'Até 12 treinos concluídos: data, treino, duração, exercícios e séries feitas.',
  body_measurements: 'Até 12 avaliações: data e medidas numéricas (sem dobras avulsas nem observações).',
  body_evolution: 'Variação de cada medida da primeira à última avaliação.',
  profile_preferences: 'Unidade de peso, dias de treino por semana e objetivo.',
  training_goals: 'Até 10 metas ativas ou pausadas: título, tipo, alvo, progresso calculado e prazo (sem observações).',
  progress_photos: 'Indisponível: fotos nunca são compartilhadas com a IA.',
};

/** Aviso amigável para categoria selecionada sem registros. */
export const NO_DATA_TEXT: Record<AIContextCategory, string> = {
  training_summary: 'Nenhum treino concluído nos últimos 28 dias.',
  training_history: 'Nenhum treino concluído registrado ainda.',
  body_measurements: 'Nenhuma avaliação corporal registrada ainda.',
  body_evolution: 'É preciso ter ao menos duas avaliações com a mesma medida para mostrar evolução.',
  profile_preferences: 'Nenhuma preferência disponível.',
  training_goals: 'Nenhuma meta ativa ou pausada.',
  progress_photos: 'Fotos nunca são compartilhadas.',
};

export const EXCLUSION_LABEL: Record<ContextExclusionReason, string> = {
  not_selected: 'não selecionada',
  blocked: 'bloqueada',
  no_data: 'sem dados',
};

export const PURPOSE_LABEL: Record<AIPurpose, string> = {
  training_review: 'Revisão de treinos',
  body_review: 'Revisão da evolução corporal',
  general_question: 'Pergunta geral',
};

const TRAINING: readonly AIContextCategory[] = ['training_summary', 'training_history', 'training_goals'];
const BODY: readonly AIContextCategory[] = ['body_measurements', 'body_evolution'];

/** Finalidade declarada, derivada das categorias: só treino → treino; só corpo → corpo; resto → geral. */
export function purposeFor(categories: readonly AssistantCategory[]): AIPurpose {
  const personal = categories.filter((c) => c !== 'profile_preferences');
  if (personal.length && personal.every((c) => TRAINING.includes(c))) return 'training_review';
  if (personal.length && personal.every((c) => BODY.includes(c))) return 'body_review';
  return 'general_question';
}

/** Frase para o usuário. Nunca mostra a mensagem original de uma exceção (pode ter dados ou detalhes internos). */
export function friendlyError(e: unknown): { code: AIErrorCode | 'unknown'; message: string } {
  if (isAIError(e)) return { code: e.code, message: e.message };
  return { code: 'unknown', message: 'Algo deu errado ao preparar a solicitação. Nenhum dado foi enviado.' };
}

export type ChatRole = 'user' | 'assistant';
export type ChatStatus = 'sending' | 'sent' | 'failed' | 'cancelled' | 'done';

/** Mensagem da conversa. Só na memória da página: não é gravada em lugar nenhum. */
export interface ChatMessage {
  /** ID temporário, válido só nesta página. */
  id: string;
  role: ChatRole;
  text: string;
  status: ChatStatus;
  /** Resposta produzida pelo provedor simulado. */
  simulated?: boolean;
  /** Resposta cortada no limite de saída. */
  truncated?: boolean;
  /** Motivo, quando a pergunta não foi respondida. */
  error?: string;
  /** Categorias autorizadas para esta pergunta (rótulos). */
  categories?: string[];
  /** Pergunta enviada a um provedor remoto: nome do provedor (para o rótulo da mensagem). */
  destination?: string;
  /** Resposta de provedor remoto: nome do provedor e modelo. */
  providerLabel?: string;
  modelId?: string;
  /** P20: resposta do catálogo local (nada foi enviado a nenhuma IA). */
  local?: boolean;
}

// ---------------------------------------------------------------- P20: estado da conexão

/** Estados mostrados ao usuário (P20 §IA): cada um com texto próprio, nunca um "erro" genérico. */
export type AssistantStatus = 'local' | 'connected' | 'no_gateway' | 'unavailable' | 'auth_failure' | 'gateway_unreachable' | 'provider_unavailable' | 'email_unverified';

export const STATUS_INFO: Record<AssistantStatus, { label: string; text: string }> = {
  local: { label: 'Local', text: 'Modo local: respostas simuladas e do catálogo, geradas no aparelho. Nada sai do aparelho.' },
  connected: { label: 'Conectado', text: 'Servidor seguro conectado. Cada pergunta ainda passa pela prévia e pela sua autorização.' },
  no_gateway: { label: 'Servidor não configurado', text: 'O modo remoto precisa do servidor seguro do IronTrack. O modo local continua funcionando.' },
  unavailable: { label: 'Não conectado', text: 'Escolha o provedor, informe o token de acesso ao servidor seguro do IronTrack e conecte. Ou volte ao modo local.' },
  auth_failure: { label: 'Falha de autenticação', text: 'O servidor seguro recusou o token (errado, revogado ou expirado). O token foi esquecido; informe um válido.' },
  gateway_unreachable: { label: 'Servidor inacessível', text: 'Não foi possível contatar o servidor seguro do IronTrack. Confira a internet ou o endereço nas configurações avançadas.' },
  provider_unavailable: { label: 'Provedor indisponível', text: 'O servidor respondeu, mas o provedor escolhido não pode atender agora (sem chave no servidor, chave recusada, cota, faturamento, limite ou falha).' },
  email_unverified: { label: 'Confirme seu e-mail', text: 'A IA real pela conta exige e-mail confirmado. Confirme o e-mail em Minha conta e tente de novo. Nada foi enviado.' },
};

const PROVIDER_CODES: readonly string[] = [
  'provider_unavailable',
  'provider_failure',
  'invalid_response',
  'content_blocked',
  'rate_limited',
  'quota_exceeded',
  'timeout',
  'model_unsupported',
  'provider_auth_failed',
  'provider_forbidden',
  'provider_billing',
  'model_unavailable',
  'provider_unreachable',
];

/**
 * Hotfix 21.2: diagnóstico do provedor na IA pela conta, com texto próprio para cada estado. "ok" só aparece depois que
 * o provedor confirmou (teste ou resposta real); servidor no ar não basta. `env` = variável da chave no irontrack-api.
 */
export function providerHealthInfo(status: ProviderHealth, name: string, env = 'ANTHROPIC_API_KEY'): { label: string; text: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' } {
  switch (status) {
    case 'ok':
      return { label: `${name} disponível`, text: `${name} confirmou a chave do servidor. Cada pergunta ainda passa pela prévia e pela sua autorização.`, tone: 'ok' };
    case 'unverified':
      return { label: `${name}: chave configurada, ainda não testada`, text: 'O servidor do IronTrack está no ar e tem a chave, mas o provedor ainda não confirmou. Toque em Testar (sem custo) ou envie uma pergunta.', tone: 'neutral' };
    case 'missing_key':
      return { label: `${name} indisponível: sem chave no servidor`, text: `Quem administra o servidor precisa configurar a variável ${env} no serviço irontrack-api da Railway e implantar de novo. A chave nunca é colada neste app.`, tone: 'warn' };
    case 'invalid_key_format':
      return { label: `${name} indisponível: chave com formato inválido`, text: `A variável ${env} existe no servidor, mas o valor não tem o formato de uma chave de API (chave de administração, aspas ou espaços a mais?). Corrija na Railway e implante de novo.`, tone: 'bad' };
    case 'auth_failed':
      return { label: `${name} recusou a chave`, text: `A chave em ${env} é inválida ou foi revogada. Gere outra no console do provedor, troque na Railway e implante de novo.`, tone: 'bad' };
    case 'forbidden':
      return { label: `${name}: chave sem permissão`, text: 'A chave do servidor não tem permissão para este recurso ou modelo. Confira o workspace e as permissões da chave no console do provedor.', tone: 'bad' };
    case 'billing':
      return { label: `${name}: créditos ou faturamento`, text: 'O provedor recusou por falta de créditos ou problema de faturamento. Quem administra a conta no provedor precisa adicionar créditos ou regularizar o pagamento.', tone: 'warn' };
    case 'rate_limited':
      return { label: `${name}: limite de uso atingido`, text: 'O provedor recusou por limite de requisições ou de tokens da conta. Aguarde um pouco e tente de novo.', tone: 'warn' };
    case 'network':
      return { label: `${name}: falha de rede`, text: 'O servidor do IronTrack não conseguiu falar com o provedor a tempo. Tente de novo em instantes.', tone: 'warn' };
  }
}

/** Hotfix 21.2: frase do resultado do "Testar" (consulta sem custo feita pelo servidor). */
export function testResultText(t: { result: string; status?: ProviderHealth; modelStatus?: ModelHealth }, name: string, modelName: string): string {
  if (t.result === 'ok')
    return t.status === 'billing'
      ? `Chave aceita e ${modelName} liberado, mas a última pergunta foi recusada por créditos/faturamento: isso só é confirmado numa resposta real.`
      : `Teste ok: ${name} aceitou a chave do servidor e ${modelName} está liberado. Nenhum token foi cobrado; créditos são confirmados na primeira pergunta.`;
  if (t.result === 'not_supported') return `O servidor não tem um teste sem custo para ${name}. Envie uma pergunta para confirmar.`;
  if (t.result === 'model_unavailable') return `${modelName} não existe ou não está liberado para a chave do servidor. Escolha outro modelo.`;
  if (t.status) return providerHealthInfo(t.status, name).text;
  return 'O teste falhou. Tente de novo em instantes.';
}

/** Hotfix 21.2: efeito de uma falha de execução no diagnóstico do provedor (sem nova consulta ao servidor). */
export function healthAfterError(code: string): ProviderHealth | 'model_unavailable' | null {
  const map: Record<string, ProviderHealth | 'model_unavailable'> = {
    provider_auth_failed: 'auth_failed',
    provider_forbidden: 'forbidden',
    provider_billing: 'billing',
    provider_unreachable: 'network',
    model_unavailable: 'model_unavailable',
  };
  return map[code] ?? null;
}

/** Estado da conexão a partir do modo, do gateway e da última falha de execução. Puro. */
export function assistantStatus(i: { mode: 'simulated' | 'remote'; hasEndpoint?: boolean; gatewayStatus: 'disconnected' | 'connecting' | 'connected' | 'error'; gatewayErrorCode?: string; providerAvailable?: boolean | null; lastRunErrorCode?: string | null }): AssistantStatus {
  if (i.mode === 'simulated') return 'local';
  if (i.gatewayStatus !== 'connected' && (i.hasEndpoint === false || i.gatewayErrorCode === 'no_gateway')) return 'no_gateway';
  if (i.gatewayStatus === 'error') return i.gatewayErrorCode === 'access_denied' ? 'auth_failure' : i.gatewayErrorCode === 'gateway_unreachable' ? 'gateway_unreachable' : 'unavailable';
  if (i.gatewayStatus !== 'connected') return 'unavailable';
  if (i.providerAvailable === false) return 'provider_unavailable';
  if (i.lastRunErrorCode === 'gateway_unreachable') return 'gateway_unreachable';
  if (i.lastRunErrorCode === 'email_not_verified') return 'email_unverified';
  if (i.lastRunErrorCode && PROVIDER_CODES.includes(i.lastRunErrorCode)) return 'provider_unavailable';
  return 'connected';
}
