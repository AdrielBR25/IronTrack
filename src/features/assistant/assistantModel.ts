// Regras puras da tela do assistente (IronTrack 2.0 F01/P05): validação da pergunta, finalidade,
// rótulos e mensagens de erro. Sem React e sem banco, para testar sem montar a tela.
import { AI_REQUEST_LIMITS, isAIError, type AIContextCategory, type AIErrorCode, type AIPurpose, type ContextExclusionReason } from '@/modules/ai';
import type { AssistantCategory } from '@/integrations/ai/contextSources';

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
  progress_photos: 'Fotos de progresso',
};

export const CATEGORY_HINT: Record<AIContextCategory, string> = {
  training_summary: 'Números dos últimos 28 dias: treinos, séries, volume, consistência e grupos musculares.',
  training_history: 'Até 12 treinos concluídos: data, treino, duração, exercícios e séries feitas.',
  body_measurements: 'Até 12 avaliações: data e medidas numéricas (sem dobras avulsas nem observações).',
  body_evolution: 'Variação de cada medida da primeira à última avaliação.',
  profile_preferences: 'Unidade de peso, dias de treino por semana e objetivo.',
  progress_photos: 'Indisponível: fotos nunca são compartilhadas com a IA.',
};

/** Aviso amigável para categoria selecionada sem registros. */
export const NO_DATA_TEXT: Record<AIContextCategory, string> = {
  training_summary: 'Nenhum treino concluído nos últimos 28 dias.',
  training_history: 'Nenhum treino concluído registrado ainda.',
  body_measurements: 'Nenhuma avaliação corporal registrada ainda.',
  body_evolution: 'É preciso ter ao menos duas avaliações com a mesma medida para mostrar evolução.',
  profile_preferences: 'Nenhuma preferência disponível.',
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

const TRAINING: readonly AIContextCategory[] = ['training_summary', 'training_history'];
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
}
