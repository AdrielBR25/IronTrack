// Contrato do Assistente IA central (Fase 00, docs/IA_CENTRAL.md). Compartilhado entre a API (que valida de verdade)
// e o app (que só exibe). Nada aqui tem segredo, URL de provedor ou chave.
import { z } from 'zod';

export const ASSISTANT_PROTOCOL = 'irontrack.assistant.v1';
/** Versão do aviso de processamento de dados. Mudou o texto de forma relevante → sobe o número e o app mostra de novo. */
export const ASSISTANT_NOTICE_VERSION = 1;
export const MAX_USER_MESSAGE_CHARS = 8000;
export const MAX_TITLE_CHARS = 120;
export const MAX_MEMORY_CHARS = 500;
export const MAX_MEMORIES = 50;

// ------------------------------------------------------------------ fichas de treino (mesmo vocabulário do app)
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other'] as const;
export const CATEGORY = ['compound', 'isolation'] as const;

const name = (max: number) => z.string().trim().min(1).max(max);

/** Exercício proposto pela IA para uma ficha. Os limites seguem o editor de fichas do app. */
export const proposedExerciseSchema = z
  .object({
    name: name(80),
    muscleGroup: name(40),
    category: z.enum(CATEGORY),
    equipment: z.enum(EQUIPMENT),
    sets: z.number().int().min(1).max(20),
    repMin: z.number().int().min(1).max(100),
    repMax: z.number().int().min(1).max(100),
    restSec: z.number().int().min(0).max(900),
    warmupSets: z.number().int().min(0).max(5).default(0),
    targetWeight: z.number().min(0).max(1000).nullish(),
    notes: z.string().trim().max(300).nullish(),
  })
  .strict()
  .refine((e) => e.repMax >= e.repMin, { message: 'repMax menor que repMin', path: ['repMax'] });
export type ProposedExercise = z.infer<typeof proposedExerciseSchema>;

export const proposedWorkoutSchema = z
  .object({
    label: name(4),
    name: name(60),
    notes: z.string().trim().max(300).nullish(),
    exercises: z.array(proposedExerciseSchema).min(1).max(20),
  })
  .strict();
export type ProposedWorkout = z.infer<typeof proposedWorkoutSchema>;

export const createRoutineArgsSchema = z
  .object({
    name: name(60),
    description: z.string().trim().max(300).nullish(),
    workouts: z.array(proposedWorkoutSchema).min(1).max(7),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict();
export type CreateRoutineArgs = z.infer<typeof createRoutineArgsSchema>;

/** Campos de um exercício da ficha que a IA pode alterar. */
export const exercisePatchSchema = z
  .object({
    name: name(80).optional(),
    muscleGroup: name(40).optional(),
    sets: z.number().int().min(1).max(20).optional(),
    repMin: z.number().int().min(1).max(100).optional(),
    repMax: z.number().int().min(1).max(100).optional(),
    restSec: z.number().int().min(0).max(900).optional(),
    warmupSets: z.number().int().min(0).max(5).optional(),
    targetWeight: z.number().min(0).max(1000).nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });

export const routineChangeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename_routine'), name: name(60) }).strict(),
  z.object({ op: z.literal('set_description'), description: z.string().trim().max(300) }).strict(),
  z.object({ op: z.literal('add_workout'), workout: proposedWorkoutSchema }).strict(),
  z.object({ op: z.literal('rename_workout'), workoutId: name(200), label: name(4).optional(), name: name(60).optional() }).strict(),
  z.object({ op: z.literal('remove_workout'), workoutId: name(200) }).strict(),
  z.object({ op: z.literal('add_exercise'), workoutId: name(200), exercise: proposedExerciseSchema, position: z.number().int().min(0).max(50).optional() }).strict(),
  z.object({ op: z.literal('update_exercise'), workoutId: name(200), exerciseId: name(200), changes: exercisePatchSchema }).strict(),
  z.object({ op: z.literal('remove_exercise'), workoutId: name(200), exerciseId: name(200) }).strict(),
  z.object({ op: z.literal('move_exercise'), workoutId: name(200), exerciseId: name(200), toIndex: z.number().int().min(0).max(50) }).strict(),
]);
export type RoutineChange = z.infer<typeof routineChangeSchema>;

export const updateRoutineArgsSchema = z
  .object({
    routineId: name(200),
    changes: z.array(routineChangeSchema).min(1).max(40),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict();
export type UpdateRoutineArgs = z.infer<typeof updateRoutineArgsSchema>;

export const savePreferenceArgsSchema = z.object({ content: z.string().trim().min(3).max(MAX_MEMORY_CHARS) }).strict();

// ------------------------------------------------------------------ visões devolvidas ao app

export type ActionKind =
  | 'create_routine'
  | 'update_routine'
  | 'save_preference'
  | 'create_habit'
  | 'update_habit'
  | 'create_life_routine'
  | 'update_life_routine'
  | 'create_missions'
  | 'update_mission'
  // Fase 02: alimentação
  | 'create_meal'
  | 'update_meal'
  | 'add_meal_items'
  | 'create_food'
  | 'update_nutrition_goals'
  | 'create_meal_plan'
  | 'update_meal_plan'
  // Fase 04: conhecimento
  | 'create_book'
  | 'update_book_progress'
  | 'create_subject'
  | 'create_topics'
  | 'create_study_plan'
  | 'update_knowledge_goals'
  | 'schedule_knowledge_routine';
export type ActionStatus = 'pending' | 'applied' | 'rejected' | 'expired' | 'failed' | 'reverted';
/** Onde a proposta aplicada gravou (para o app abrir o item). */
export type ActionCollection = 'routines' | 'memories' | 'habits' | 'life_routines' | 'missions' | 'meals' | 'foods' | 'nutrition_goals' | 'meal_plan' | 'books' | 'subjects' | 'knowledge_goals' | 'knowledge_sessions';
/** Prazo para desfazer uma proposta aplicada (Fase 01). */
export const UNDO_WINDOW_HOURS = 168;

/** Uma linha da prévia: o que muda, em linguagem do app. */
export interface PreviewLine {
  kind: 'add' | 'remove' | 'change' | 'info';
  text: string;
}

export interface PreviewSection {
  title: string;
  lines: PreviewLine[];
}

export interface ActionView {
  id: string;
  kind: ActionKind;
  status: ActionStatus;
  title: string;
  /** Justificativa dada pela IA (é sugestão, não fato). */
  rationale: string | null;
  preview: PreviewSection[];
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** Depois de aplicada: o que foi gravado (para o app abrir a ficha). */
  result: { collection: ActionCollection; entityId: string } | null;
  /** Motivo da falha ao aplicar (frase fixa). */
  error: string | null;
  /** Fase 01: aplicada, dentro do prazo e com o necessário para desfazer. */
  undoable: boolean;
  revertedAt: string | null;
}

export interface ToolUseView {
  name: string;
  label: string;
  kind: 'read' | 'write';
  ok: boolean;
}

export type MessageRole = 'user' | 'assistant' | 'event';

export interface MessageView {
  id: string;
  role: MessageRole;
  content: string;
  status: 'complete' | 'error' | 'cancelled';
  createdAt: string;
  model: string | null;
  tools: ToolUseView[];
  actionIds: string[];
  /** Fase 03: marca de anexos (a imagem em si nunca é guardada). */
  attachments: { type: 'image'; stored: false }[];
}

export interface ConversationSummaryView {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationView extends ConversationSummaryView {
  /** Resumo automático das mensagens antigas (gerado pela IA; não é registro). */
  summary: string | null;
  messages: MessageView[];
  actions: ActionView[];
}

export interface MemoryView {
  id: string;
  content: string;
  source: 'user' | 'ai_approved';
  createdAt: string;
}

export interface AssistantModelView {
  id: string;
  displayName: string;
  description: string;
}

export type AssistantAvailability = 'ok' | 'disabled' | 'missing_key' | 'invalid_key_format' | 'auth_failed' | 'email_not_verified';

export interface AssistantStatusView {
  protocol: typeof ASSISTANT_PROTOCOL;
  availability: AssistantAvailability;
  provider: { id: string; displayName: string; health: string; checkedAt: string | null } | null;
  models: AssistantModelView[];
  defaultModel: string | null;
  notice: { version: number; acceptedVersion: number | null; acceptedAt: string | null };
  limits: { messagesPerDay: number; tokensPerDay: number; messagesPerMinute: number; maxMessageChars: number };
  usage: { day: string; messages: number; tokens: number };
  modules: ModuleView[];
}

export interface ModuleView {
  id: string;
  name: string;
  status: 'available' | 'planned';
}

// ------------------------------------------------------------------ eventos do streaming (text/event-stream)

export type StreamEvent =
  | { type: 'start'; conversationId: string; userMessage: MessageView; title: string; created: boolean }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; label: string; kind: 'read' | 'write'; state: 'start' | 'end'; ok?: boolean }
  | { type: 'proposal'; action: ActionView }
  | { type: 'done'; message: MessageView; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; code: string; message: string; message_id?: string };

export const MAX_ATTACHMENTS = 1;
export const messageAttachmentSchema = z
  .object({
    type: z.literal('image'),
    purpose: z.enum(['meal', 'label']).default('meal'),
    // Até PHOTO_LIMITS.maxBytes (3,5 MB) em base64.
    dataUrl: z.string().min(32).max(4_700_064),
  })
  .strict();
/** Corpo máximo da mensagem com foto (texto + imagem em base64); abaixo dos 5 MB do Caddy do irontrack-web. */
export const MAX_MESSAGE_BODY_BYTES = 4_900_000;

export const sendMessageSchema = z
  .object({
    content: z.string().max(MAX_USER_MESSAGE_CHARS * 2),
    model: z.string().max(80).optional(),
    timezone: z.string().max(64).optional(),
    /**
     * Fase 03: até 1 foto de refeição por mensagem (data URL JPEG/PNG, já reduzida no aparelho). A foto é usada só
     * nesta resposta (ferramenta analyze_meal_photo) e NÃO é guardada: o histórico registra apenas que houve foto.
     */
    attachments: z.array(messageAttachmentSchema).max(MAX_ATTACHMENTS).optional(),
  })
  .strict();

export const ASSISTANT_ERROR_MESSAGES: Record<string, string> = {
  assistant_disabled: 'O assistente está desativado neste servidor.',
  provider_unavailable: 'A IA não está configurada no servidor (falta a chave da OpenAI no irontrack-api).',
  provider_auth_failed: 'A OpenAI recusou a chave configurada no servidor.',
  provider_billing: 'A conta da OpenAI do servidor está sem créditos ou com problema de faturamento.',
  provider_forbidden: 'A chave do servidor não tem permissão para este modelo.',
  provider_rate_limited: 'A OpenAI limitou as solicitações agora. Tente de novo em instantes.',
  provider_unreachable: 'Não foi possível falar com a OpenAI agora. Tente de novo.',
  provider_failure: 'A OpenAI não conseguiu responder agora. Tente de novo.',
  model_unavailable: 'O modelo escolhido não está disponível para a chave do servidor.',
  model_not_allowed: 'Modelo não permitido.',
  content_filtered: 'A resposta foi bloqueada pelo filtro de conteúdo do provedor.',
  invalid_response: 'O provedor devolveu uma resposta inválida.',
  timeout: 'A IA demorou demais para responder. Tente de novo.',
  cancelled: 'Resposta interrompida.',
  rate_limited: 'Muitas mensagens em pouco tempo. Aguarde um minuto.',
  daily_limit: 'Você atingiu o limite diário do assistente. Ele volta amanhã.',
  busy: 'Aguarde a resposta anterior terminar.',
  message_empty: 'Escreva uma mensagem.',
  message_too_long: `Mensagem longa demais (máximo de ${MAX_USER_MESSAGE_CHARS.toLocaleString('pt-BR')} caracteres).`,
  notice_required: 'Leia e confirme o aviso de processamento de dados antes de usar o assistente.',
  email_not_verified: 'Confirme seu e-mail para usar o assistente.',
  not_found: 'Conversa ou ação não encontrada.',
  action_not_pending: 'Esta proposta já foi decidida ou expirou.',
  action_stale: 'A ficha mudou depois da proposta. Peça uma nova proposta ao assistente.',
  action_invalid: 'A proposta não passou na validação. Nada foi alterado.',
  action_not_undoable: 'Esta alteração não pode mais ser desfeita (prazo encerrado ou sem suporte).',
  action_undo_stale: 'O item mudou depois da alteração da IA. Desfaça manualmente para não perder o que mudou.',
  action_undo_blocked: 'Uma das missões já foi concluída; desfazer apagaria XP legítimo. Cancele manualmente as outras.',
  memory_limit: 'Limite de memórias atingido. Apague alguma antes de salvar outra.',
  internal_error: 'Erro interno. Nada foi alterado.',
  // Fase 03: fotos
  photo_notice_required: 'Confirme o aviso sobre o envio de fotos antes da primeira análise.',
  photo_invalid: 'Não consegui ler esta imagem. Use uma foto JPEG ou PNG.',
  photo_too_large: 'Foto grande demais. Tente outra ou tire uma nova.',
  photo_too_small: 'A imagem é pequena demais para identificar os alimentos.',
  photo_daily_limit: 'Você atingiu o limite de análises de foto de hoje. Registre manualmente ou tente amanhã.',
  photo_busy: 'Aguarde a análise anterior terminar.',
  photo_purpose_planned: 'A leitura de rótulos por foto ainda não está disponível.',
  vision_disabled: 'A análise de fotos está desativada neste servidor.',
  vision_model_unsupported: 'O modelo configurado no servidor não aceita imagens. Ajuste o modelo de análise de fotos.',
  vision_incomplete: 'A IA não conseguiu concluir a análise desta foto. Tente de novo ou registre manualmente.',
  payload_too_large: 'Foto grande demais para enviar.',
};
