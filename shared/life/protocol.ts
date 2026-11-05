// Contrato do RPG de desenvolvimento pessoal (IronTrack Life — Fase 01, docs/RPG_DESENVOLVIMENTO.md).
// Compartilhado entre a API (que valida e calcula de verdade) e o app (que só exibe). Fórmulas de progressão aqui para
// o app mostrar exatamente o mesmo nível que o servidor grava.
import { z } from 'zod';

export const LIFE_PROTOCOL = 'irontrack.life.v1';

// ------------------------------------------------------------------ atributos, categorias, ícones

export const ATTRIBUTES = ['strength', 'knowledge', 'discipline', 'health', 'spirituality'] as const;
export type Attribute = (typeof ATTRIBUTES)[number];
export const ATTRIBUTE_LABEL: Record<Attribute, string> = {
  strength: 'Força',
  knowledge: 'Conhecimento',
  discipline: 'Disciplina',
  health: 'Saúde',
  spirituality: 'Espiritualidade',
};

/** Tipo da atividade (para conquistas e para os módulos futuros: leitura, Bíblia, nutrição…). */
export const TAGS = ['reading', 'bible', 'study', 'water', 'sleep', 'workout', 'nutrition', 'routine', 'other'] as const;
export type Tag = (typeof TAGS)[number];
export const TAG_LABEL: Record<Tag, string> = {
  reading: 'Leitura',
  bible: 'Bíblia',
  study: 'Estudo',
  water: 'Hidratação',
  sleep: 'Sono',
  workout: 'Treino',
  nutrition: 'Alimentação',
  routine: 'Organização',
  other: 'Outro',
};
/** Atributo sugerido para cada tipo (o usuário pode trocar). */
export const TAG_ATTRIBUTE: Record<Tag, Attribute> = {
  reading: 'knowledge',
  bible: 'spirituality',
  study: 'knowledge',
  water: 'health',
  sleep: 'health',
  workout: 'strength',
  nutrition: 'health',
  routine: 'discipline',
  other: 'discipline',
};

export const ICONS = ['check', 'droplet', 'book', 'book-open', 'graduation', 'dumbbell', 'moon', 'sun', 'heart', 'brain', 'apple', 'list', 'clock', 'flame', 'pen', 'church', 'footprints', 'music', 'leaf', 'target'] as const;
export type IconName = (typeof ICONS)[number];

export const ROUTINE_KINDS = ['morning', 'study', 'training', 'night', 'custom'] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];
export const ROUTINE_KIND_LABEL: Record<RoutineKind, string> = { morning: 'Rotina matinal', study: 'Rotina de estudos', training: 'Rotina de treino', night: 'Rotina noturna', custom: 'Rotina personalizada' };

export const MISSION_TYPES = ['daily', 'weekly', 'custom', 'special'] as const;
export type MissionType = (typeof MISSION_TYPES)[number];
export const MISSION_TYPE_LABEL: Record<MissionType, string> = { daily: 'Diária', weekly: 'Semanal', custom: 'Personalizada', special: 'Especial' };
export const MISSION_METRICS = ['habit_completions', 'habit', 'workouts', 'active_days', 'routine_completions', 'manual', 'nutrition_days'] as const;
export type MissionMetric = (typeof MISSION_METRICS)[number];
export const MISSION_UNITS = ['times', 'minutes', 'pages', 'chapters', 'check'] as const;
export type MissionUnit = (typeof MISSION_UNITS)[number];
export const UNIT_LABEL: Record<MissionUnit, string> = { times: 'vezes', minutes: 'min', pages: 'páginas', chapters: 'capítulos', check: '' };

// ------------------------------------------------------------------ progressão (documentada em docs/RPG_DESENVOLVIMENTO.md §3)

export const MAX_LEVEL = 100;

/** XP para ir do nível L ao L+1: 50·L + 50 (100, 150, 200, …). */
export const xpToNext = (level: number): number => 50 * level + 50;
/** XP acumulado para chegar ao nível L: Σ(50k+50), k=1..L−1 = 25·(L−1)·(L+2). */
export const xpForLevel = (level: number): number => 25 * (level - 1) * (level + 2);

export interface LevelInfo {
  level: number;
  /** XP dentro do nível atual. */
  into: number;
  /** XP do nível atual até o próximo (0 no nível máximo). */
  need: number;
  /** 0–1. */
  progress: number;
}

function levelOf(xp: number, cumulative: (l: number) => number, step: (l: number) => number): LevelInfo {
  const x = Math.max(0, Math.floor(xp));
  let level = 1;
  while (level < MAX_LEVEL && cumulative(level + 1) <= x) level++;
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, into: x - cumulative(MAX_LEVEL), need: 0, progress: 1 };
  const into = x - cumulative(level);
  const need = step(level);
  return { level, into, need, progress: need ? into / need : 1 };
}

export const levelFromXp = (xp: number): LevelInfo => levelOf(xp, xpForLevel, xpToNext);

/** Atributos sobem mais rápido (escala menor): 30·L + 30 por nível; acumulado 15·(L−1)·(L+2). */
export const attributeLevelFromXp = (xp: number): LevelInfo =>
  levelOf(
    xp,
    (l) => 15 * (l - 1) * (l + 2),
    (l) => 30 * l + 30,
  );

export const TITLES: readonly { level: number; title: string }[] = [
  { level: 1, title: 'Iniciante' },
  { level: 3, title: 'Aprendiz' },
  { level: 5, title: 'Determinado' },
  { level: 10, title: 'Persistente' },
  { level: 15, title: 'Disciplinado' },
  { level: 20, title: 'Veterano' },
  { level: 30, title: 'Mestre da rotina' },
  { level: 40, title: 'Exemplo de constância' },
  { level: 50, title: 'Lenda' },
];
export const titleForLevel = (level: number): string => [...TITLES].reverse().find((t) => level >= t.level)!.title;
export const unlockedTitles = (level: number): string[] => TITLES.filter((t) => level >= t.level).map((t) => t.title);

/** Limites de recompensa (o servidor aplica; o app usa para os controles). */
export const REWARD = {
  habit: { min: 5, max: 50, default: 10 },
  workout: { base: 40, perSet: 2, maxBonus: 30 },
  routineBonus: 10,
  mission: {
    daily: { min: 10, max: 50 },
    weekly: { min: 30, max: 150 },
    custom: { min: 10, max: 100 },
    special: { min: 50, max: 300 },
  },
  achievement: 30,
  /** Bônus único pelos treinos anteriores à ativação: 5 XP por treino, até 500. */
  legacyPerWorkout: 5,
  legacyMax: 500,
  /** Teto diário (habit, mission, workout, routine, nutrition). Conquistas e o bônus de histórico ficam fora. */
  dailyCap: 400,
} as const;

/** Recompensa padrão de uma missão personalizada/especial (a IA não escolhe XP: o servidor calcula). */
export function defaultMissionXp(type: MissionType, unit: MissionUnit, target: number, days: number): number {
  const lim = REWARD.mission[type];
  const effort = unit === 'minutes' ? target / 10 : unit === 'pages' ? target / 5 : unit === 'check' ? 2 : target;
  const raw = Math.round(10 + effort * 3 + Math.max(0, days - 1) * 3);
  return Math.min(lim.max, Math.max(lim.min, raw));
}

// ------------------------------------------------------------------ conquistas

export const ACHIEVEMENTS = [
  { code: 'first_mission', title: 'Primeira missão', description: 'Conclua sua primeira missão.', attribute: 'discipline', module: null },
  { code: 'habit_week', title: 'Primeira semana de hábitos', description: 'Cumpra hábitos em 7 dias diferentes.', attribute: 'discipline', module: null },
  { code: 'ten_workouts', title: 'Dez treinos concluídos', description: 'Conclua 10 treinos (o histórico conta).', attribute: 'strength', module: null },
  { code: 'reading_100', title: 'Primeiros 100 minutos de leitura', description: 'Some 100 minutos de leitura (sessões, hábitos ou missões de leitura).', attribute: 'knowledge', module: 'reading' },
  { code: 'streak_7', title: 'Sete dias de consistência', description: 'Mantenha 7 dias seguidos de atividades concluídas.', attribute: 'discipline', module: null },
  { code: 'nutrition_week', title: 'Uma semana de diário alimentar', description: 'Registre o diário alimentar em 7 dias diferentes.', attribute: 'health', module: 'nutrition' },
  { code: 'first_book', title: 'Primeiro livro concluído', description: 'Conclua um livro da sua biblioteca.', attribute: 'knowledge', module: 'reading' },
  { code: 'study_10h', title: 'Dez horas de estudo', description: 'Some 10 horas em sessões de estudo.', attribute: 'knowledge', module: 'reading' },
] as const satisfies readonly { code: string; title: string; description: string; attribute: Attribute; module: string | null }[];
export type AchievementCode = (typeof ACHIEVEMENTS)[number]['code'];

// ------------------------------------------------------------------ entradas (validadas no servidor)

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort());

export const habitInputSchema = z
  .object({
    name: trimmed(60),
    description: optText(300),
    attribute: z.enum(ATTRIBUTES),
    tag: z.enum(TAGS).default('other'),
    icon: z.enum(ICONS).default('check'),
    frequency: z.enum(['daily', 'weekly']),
    days: days.default([0, 1, 2, 3, 4, 5, 6]),
    timesPerWeek: z.number().int().min(1).max(7).nullish(),
    goalKind: z.enum(['check', 'count', 'duration']),
    goalTarget: z.number().int().min(1).max(1440).default(1),
    goalUnit: optText(20),
    preferredTime: z.string().regex(HHMM).nullish(),
    xp: z.number().int().min(REWARD.habit.min).max(REWARD.habit.max).default(REWARD.habit.default),
  })
  .strict()
  .refine((h) => h.frequency !== 'weekly' || !!h.timesPerWeek, { message: 'Informe quantas vezes por semana.', path: ['timesPerWeek'] })
  .transform((h) => ({ ...h, goalTarget: h.goalKind === 'check' ? 1 : h.goalTarget, timesPerWeek: h.frequency === 'weekly' ? h.timesPerWeek! : null }));
export type HabitInput = z.output<typeof habitInputSchema>;

/** Campos editáveis de um hábito (inclui pausar/retomar/arquivar). */
export const habitPatchSchema = z
  .object({
    name: trimmed(60).optional(),
    description: optText(300).optional(),
    attribute: z.enum(ATTRIBUTES).optional(),
    tag: z.enum(TAGS).optional(),
    icon: z.enum(ICONS).optional(),
    frequency: z.enum(['daily', 'weekly']).optional(),
    days: days.optional(),
    timesPerWeek: z.number().int().min(1).max(7).nullish(),
    goalKind: z.enum(['check', 'count', 'duration']).optional(),
    goalTarget: z.number().int().min(1).max(1440).optional(),
    goalUnit: optText(20).optional(),
    preferredTime: z.string().regex(HHMM).nullish(),
    xp: z.number().int().min(REWARD.habit.min).max(REWARD.habit.max).optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type HabitPatch = z.infer<typeof habitPatchSchema>;

const routineItemBase = z.object({
  title: trimmed(80),
  startTime: z.string().regex(HHMM).nullish(),
  durationMin: z.number().int().min(1).max(600).nullish(),
  habitId: z.string().uuid().nullish(),
  missionId: z.string().uuid().nullish(),
});
const oneLink = (i: { habitId?: string | null; missionId?: string | null }) => !(i.habitId && i.missionId);
export const routineItemInputSchema = routineItemBase.strict().refine(oneLink, { message: 'Vincule a um hábito OU a uma missão.', path: ['missionId'] });
const routineItemPatchSchema = routineItemBase.extend({ id: z.string().uuid().optional() }).strict().refine(oneLink, { message: 'Vincule a um hábito OU a uma missão.', path: ['missionId'] });
export type RoutineItemInput = z.infer<typeof routineItemInputSchema>;

export const routineInputSchema = z
  .object({
    name: trimmed(60),
    kind: z.enum(ROUTINE_KINDS),
    days: days.default([0, 1, 2, 3, 4, 5, 6]),
    items: z.array(routineItemInputSchema).min(1).max(30),
  })
  .strict();
export type RoutineInput = z.infer<typeof routineInputSchema>;

export const routinePatchSchema = z
  .object({
    name: trimmed(60).optional(),
    kind: z.enum(ROUTINE_KINDS).optional(),
    days: days.optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
    /** Substitui a lista de atividades inteira (na ordem dada). Itens com `id` existente são mantidos. */
    items: z.array(routineItemPatchSchema).min(1).max(30).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type RoutinePatch = z.infer<typeof routinePatchSchema>;

export const missionInputSchema = z
  .object({
    type: z.enum(['custom', 'special']),
    title: trimmed(80),
    description: optText(300),
    metric: z.enum(['manual', 'habit', 'workouts', 'habit_completions']),
    habitId: z.string().uuid().nullish(),
    unit: z.enum(MISSION_UNITS).default('times'),
    tag: z.enum(TAGS).default('other'),
    target: z.number().int().min(1).max(100000),
    attribute: z.enum(ATTRIBUTES),
    startsOn: isoDateSchema.nullish(),
    /** Prazo (inclusive). Especial: 3–90 dias de duração. */
    endsOn: isoDateSchema,
    /** Só o app (pessoa) pode escolher, dentro dos limites; a IA nunca escolhe XP. */
    xp: z.number().int().min(5).max(300).nullish(),
  })
  .strict()
  .refine((m) => m.metric !== 'habit' || !!m.habitId, { message: 'Escolha o hábito.', path: ['habitId'] })
  .transform((m) => ({ ...m, target: m.unit === 'check' ? 1 : m.target, habitId: m.metric === 'habit' ? m.habitId! : null }));
export type MissionInput = z.output<typeof missionInputSchema>;

export const missionPatchSchema = z
  .object({
    title: trimmed(80).optional(),
    description: optText(300).optional(),
    target: z.number().int().min(1).max(100000).optional(),
    endsOn: isoDateSchema.optional(),
    status: z.enum(['active', 'paused', 'cancelled']).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type MissionPatch = z.infer<typeof missionPatchSchema>;

export const habitLogSchema = z.object({ date: isoDateSchema.optional(), amount: z.number().int().min(0).max(10000) }).strict();
export const missionEntrySchema = z.object({ date: isoDateSchema.optional(), amount: z.number().int().min(1).max(10000), note: optText(200) }).strict();
export const routineCheckSchema = z.object({ date: isoDateSchema.optional(), done: z.boolean() }).strict();
export const profilePatchSchema = z
  .object({
    timezone: z.string().min(1).max(64).optional(),
    selectedTitle: z.string().max(60).nullable().optional(),
    weeklyWorkoutTarget: z.number().int().min(1).max(7).nullable().optional(),
  })
  .strict();

// ------------------------------------------------------------------ visões devolvidas ao app

export interface AttributeView {
  attribute: Attribute;
  label: string;
  xp: number;
  level: LevelInfo;
}

export interface ProfileView {
  timezone: string;
  today: string;
  activatedAt: string;
  totalXp: number;
  level: LevelInfo;
  title: string;
  titles: string[];
  selectedTitle: string | null;
  attributes: AttributeView[];
  streak: { current: number; best: number; activeToday: boolean; restToday: boolean };
  xpToday: number;
  dailyCap: number;
  weeklyWorkoutTarget: number | null;
}

export interface HabitView {
  id: string;
  name: string;
  description: string | null;
  attribute: Attribute;
  tag: Tag;
  icon: IconName;
  frequency: 'daily' | 'weekly';
  days: number[];
  timesPerWeek: number | null;
  goalKind: 'check' | 'count' | 'duration';
  goalTarget: number;
  goalUnit: string | null;
  preferredTime: string | null;
  xp: number;
  status: 'active' | 'paused' | 'archived';
  startDate: string;
  version: number;
  /** Hoje: previsto, quanto foi feito, se cumpriu. */
  today: { scheduled: boolean; amount: number; completed: boolean };
  /** Semana atual: cumprimentos (para os semanais) e sequência do hábito. */
  week: { completions: number };
  streak: number;
}

export interface RoutineItemView {
  id: string;
  position: number;
  title: string;
  startTime: string | null;
  durationMin: number | null;
  habitId: string | null;
  missionId: string | null;
  /** Hoje. */
  done: boolean;
}

export interface RoutineView {
  id: string;
  name: string;
  kind: RoutineKind;
  days: number[];
  status: 'active' | 'paused' | 'archived';
  version: number;
  scheduledToday: boolean;
  completedToday: boolean;
  items: RoutineItemView[];
}

export interface MissionView {
  id: string;
  type: MissionType;
  origin: 'system' | 'user' | 'ai';
  title: string;
  description: string | null;
  metric: MissionMetric;
  habitId: string | null;
  unit: MissionUnit;
  tag: Tag;
  target: number;
  progress: number;
  attribute: Attribute;
  xp: number;
  startsOn: string;
  endsOn: string;
  status: 'active' | 'completed' | 'expired' | 'paused' | 'cancelled';
  completedAt: string | null;
  version: number;
}

export interface MissionEntryView {
  id: string;
  date: string;
  amount: number;
  note: string | null;
  createdAt: string;
  fromRoutine: boolean;
}

export interface XpEventView {
  id: string;
  kind: 'grant' | 'reversal';
  source: 'habit' | 'mission' | 'workout' | 'routine' | 'achievement' | 'legacy' | 'nutrition' | 'knowledge';
  attribute: Attribute | null;
  amount: number;
  requested: number;
  day: string;
  reason: string;
  reversed: boolean;
  createdAt: string;
}

export interface AchievementView {
  code: AchievementCode;
  title: string;
  description: string;
  attribute: Attribute;
  unlockedAt: string | null;
  /** Progresso atual / meta (null quando o módulo ainda não tem dados reais). */
  progress: { value: number; target: number } | null;
  /** false = depende de um módulo/dado que ainda não existe na conta. */
  available: boolean;
}

/** O que mudou com uma ação (para as animações discretas do app). */
export interface RewardOutcome {
  xpGained: number;
  xpReverted: number;
  events: { amount: number; attribute: Attribute | null; reason: string; capped: boolean }[];
  levelUp: { from: number; to: number } | null;
  missionsCompleted: { id: string; title: string }[];
  achievements: { code: string; title: string }[];
}

export interface NextActivityView {
  routineId: string;
  routineName: string;
  itemId: string;
  title: string;
  startTime: string | null;
  durationMin: number | null;
}

export interface WorkoutSummaryView {
  total: number;
  thisWeek: number;
  last: { id: string; date: string; name: string | null } | null;
  weeklyTarget: number;
}

export interface DashboardView {
  protocol: typeof LIFE_PROTOCOL;
  displayName: string;
  profile: ProfileView;
  missionsToday: MissionView[];
  missionsWeek: MissionView[];
  missionsCustom: MissionView[];
  habitsToday: HabitView[];
  dayProgress: { done: number; total: number };
  nextActivities: NextActivityView[];
  workouts: WorkoutSummaryView;
  recentAchievements: AchievementView[];
  /** Espaços reservados (módulos futuros: só contratos, sem dados). */
  upcomingModules: { id: 'nutrition' | 'reading' | 'bible'; name: string; status: 'planned' }[];
  outcome: RewardOutcome | null;
}

/** Contratos reservados para os módulos futuros (Fase 01 só declara; nada é implementado). */
export const FUTURE_MODULES = [
  { id: 'nutrition', name: 'Alimentação', status: 'planned', contract: 'irontrack.life.nutrition.v0', notes: 'refeições, macros, foto da refeição (reconhecimento) → eventos meal_logged' },
  { id: 'meal_photo', name: 'Refeição por foto', status: 'planned', contract: 'irontrack.life.mealPhoto.v0', notes: 'anexos do assistente (attachments) → proposta de registro de refeição' },
  { id: 'reading', name: 'Leitura e estudos', status: 'available', contract: 'irontrack.life.knowledge.v1', notes: 'Fase 04: livros, matérias, sessões com cronômetro, metas (shared/knowledge/protocol.ts)' },
  { id: 'bible', name: 'Bíblia e reflexões', status: 'planned', contract: 'irontrack.life.bible.v0', notes: 'planos de leitura, capítulos, reflexões → eventos bible_chapter' },
  { id: 'long_term_goals', name: 'Metas de longo prazo', status: 'planned', contract: 'irontrack.life.longGoals.v0', notes: 'metas de meses/anos decompostas em missões especiais' },
] as const;

/**
 * Evento que um módulo futuro enviará ao motor de recompensas (contrato reservado). Hoje só hábitos, missões, rotinas
 * e treinos geram eventos; nenhum módulo externo chama o motor.
 */
export interface FutureRewardEvent {
  module: (typeof FUTURE_MODULES)[number]['id'];
  /** Identidade estável do evento (idempotência). */
  key: string;
  day: string;
  tag: Tag;
  amount: number;
  unit: MissionUnit;
}
