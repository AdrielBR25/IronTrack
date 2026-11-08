// Contrato da integração Life (Fase 06, docs/INTEGRACAO_LIFE.md): "Minha Semana" (agenda unificada), painel inicial
// personalizável e "Minha Evolução". Compartilhado entre a API (que monta e valida) e o app (que só exibe).
//
// Princípio da agenda: ela NÃO copia registros. Cada item é derivado do registro original (treino planejado, refeição,
// hábito, missão, meta de estudo, plano bíblico, item de rotina) e identificado por uma chave estável (`key`). A agenda
// só grava o que não existe em lugar nenhum: atividades personalizadas (`planner_items`) e ajustes de horário/ordem/
// situação de um item derivado (`planner_overrides`). Nada é marcado como concluído só porque o horário passou.
import { z } from 'zod';

export const PLANNER_PROTOCOL = 'irontrack.life.planner.v1';

export const AGENDA_CATEGORIES = ['workout', 'meal', 'habit', 'mission', 'study', 'reading', 'bible', 'routine', 'custom', 'rest', 'free'] as const;
export type AgendaCategory = (typeof AGENDA_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<AgendaCategory, string> = {
  workout: 'Treino',
  meal: 'Refeição',
  habit: 'Hábito',
  mission: 'Missão',
  study: 'Estudo',
  reading: 'Leitura',
  bible: 'Bíblia',
  routine: 'Rotina',
  custom: 'Atividade',
  rest: 'Descanso',
  free: 'Período livre',
};

/**
 * Situação de um item na agenda.
 *  - planned: previsto (inclusive se o horário já passou: nunca vira "concluído" sozinho);
 *  - in_progress: há um registro em andamento (treino ativo, cronômetro de leitura/estudo);
 *  - done: existe o registro real (treino concluído, refeição consumida, hábito cumprido…) ou a pessoa marcou a
 *    atividade personalizada como feita;
 *  - missed: a PESSOA marcou como não realizado;
 *  - paused: o registro de origem está pausado (hábito, plano bíblico) ou a pessoa pausou o item.
 */
export const AGENDA_STATUS = ['planned', 'in_progress', 'done', 'missed', 'paused'] as const;
export type AgendaStatus = (typeof AGENDA_STATUS)[number];
export const STATUS_LABEL: Record<AgendaStatus, string> = { planned: 'Planejado', in_progress: 'Em andamento', done: 'Concluído', missed: 'Não realizado', paused: 'Pausado' };

export const hhmmSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use HH:MM');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD');

export interface AgendaItem {
  /** Chave estável do item na data (ex.: `habit:<id>`, `meal:<id>`, `custom:<id>`). */
  key: string;
  category: AgendaCategory;
  title: string;
  subtitle: string | null;
  date: string;
  startTime: string | null;
  durationMin: number | null;
  status: AgendaStatus;
  /** De onde veio a situação: registro real, marcação da pessoa ou só o planejamento. */
  statusSource: 'record' | 'user' | 'plan';
  /** Registro de origem (o item nunca é cópia dele). */
  source: { module: 'training' | 'nutrition' | 'life' | 'knowledge' | 'bible' | 'planner'; kind: string; id: string };
  /** Rota do app para abrir o registro. */
  link: string | null;
  /** Horário/ordem vieram de um ajuste feito na agenda (o registro original não mudou). */
  adjusted: boolean;
  position: number;
  /** O que a agenda permite mexer neste item. */
  can: { move: boolean; mark: AgendaStatus[]; edit: boolean; remove: boolean };
  /** Só atividades personalizadas. */
  notes?: string | null;
  version?: number;
}

export interface AgendaConflict {
  date: string;
  a: string;
  b: string;
  /** Minutos sobrepostos. */
  overlapMin: number;
  text: string;
}

export interface AgendaDay {
  date: string;
  weekday: number;
  isToday: boolean;
  isPast: boolean;
  rest: boolean;
  items: AgendaItem[];
  /** Minutos com horário previstos (itens não concluídos e não marcados como não realizados contam). */
  load: { plannedMin: number; count: number; overloaded: boolean };
  conflicts: AgendaConflict[];
}

export interface WeekAgendaView {
  protocol: typeof PLANNER_PROTOCOL;
  timezone: string;
  today: string;
  start: string;
  days: AgendaDay[];
}

// ------------------------------------------------------------------ escrita

export const CUSTOM_CATEGORIES = ['custom', 'study', 'reading', 'bible', 'workout', 'meal', 'rest', 'free'] as const;
export type CustomCategory = (typeof CUSTOM_CATEGORIES)[number];

export const plannerItemInputSchema = z
  .object({
    /** Idempotência: o app gera uma vez por formulário; reenviar devolve o mesmo item. */
    clientId: z.string().uuid(),
    date: dateSchema,
    startTime: hhmmSchema.nullish(),
    durationMin: z.number().int().min(5).max(720).nullish(),
    title: z.string().trim().min(1).max(80),
    category: z.enum(CUSTOM_CATEGORIES).default('custom'),
    notes: z.string().trim().max(300).nullish(),
  })
  .strict();
export type PlannerItemInput = z.infer<typeof plannerItemInputSchema>;

export const plannerItemPatchSchema = z
  .object({
    date: dateSchema.optional(),
    startTime: hhmmSchema.nullable().optional(),
    durationMin: z.number().int().min(5).max(720).nullable().optional(),
    title: z.string().trim().min(1).max(80).optional(),
    notes: z.string().trim().max(300).nullable().optional(),
    status: z.enum(['planned', 'done', 'missed', 'paused']).optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nada para alterar' });

/** Ajuste de um item derivado (o registro de origem nunca muda por aqui). */
export const overrideInputSchema = z
  .object({
    key: z.string().min(3).max(120).regex(/^[a-z_]+:[A-Za-z0-9_.:|-]+$/),
    date: dateSchema,
    startTime: hhmmSchema.nullable().optional(),
    durationMin: z.number().int().min(5).max(720).nullable().optional(),
    position: z.number().int().min(0).max(999).nullable().optional(),
    /** Só a pessoa marca "não realizado" ou "pausado"; null volta à situação derivada do registro. */
    status: z.enum(['missed', 'paused']).nullable().optional(),
  })
  .strict();
export type OverrideInput = z.infer<typeof overrideInputSchema>;

export const reorderSchema = z.object({ date: dateSchema, keys: z.array(z.string().min(3).max(120)).min(1).max(60) }).strict();

// ------------------------------------------------------------------ conflitos e carga (função pura, usada na API e nos testes)

export const OVERLOAD_MINUTES = 600;
export const OVERLOAD_ITEMS = 14;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const addMinutes = (t: string, m: number) => {
  const x = Math.min(24 * 60 - 1, toMin(t) + m);
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

/** Itens que ocupam horário de verdade (feitos e não realizados não disputam a agenda). */
const occupies = (i: Pick<AgendaItem, 'status' | 'startTime' | 'category'>) => !!i.startTime && i.status !== 'missed' && i.status !== 'done' && i.category !== 'free';

/**
 * Conflitos de horário entre itens com início e duração no mesmo dia. Itens sem duração ocupam 15 min. Descanso e
 * período livre não conflitam com refeições/hábitos rápidos (só com o que dura ≥ 30 min).
 */
export function findConflicts(items: Pick<AgendaItem, 'key' | 'title' | 'date' | 'startTime' | 'durationMin' | 'status' | 'category'>[]): AgendaConflict[] {
  const timed = items.filter(occupies).map((i) => ({ i, s: toMin(i.startTime!), e: toMin(i.startTime!) + Math.max(15, i.durationMin ?? 15) })).sort((a, b) => a.s - b.s || a.i.key.localeCompare(b.i.key));
  const out: AgendaConflict[] = [];
  for (let x = 0; x < timed.length; x++) {
    for (let y = x + 1; y < timed.length; y++) {
      const A = timed[x];
      const B = timed[y];
      if (B.s >= A.e) break;
      if (A.i.date !== B.i.date) continue;
      const short = (v: typeof A) => (v.i.durationMin ?? 15) < 30;
      if ((A.i.category === 'rest' && short(B)) || (B.i.category === 'rest' && short(A))) continue;
      const overlap = Math.min(A.e, B.e) - B.s;
      if (overlap <= 0) continue;
      out.push({ date: A.i.date, a: A.i.key, b: B.i.key, overlapMin: overlap, text: `${A.i.title} (${A.i.startTime}) e ${B.i.title} (${B.i.startTime}) se sobrepõem em ${overlap} min` });
    }
  }
  return out;
}

export function dayLoad(items: Pick<AgendaItem, 'status' | 'startTime' | 'durationMin' | 'category'>[]): AgendaDay['load'] {
  const active = items.filter((i) => i.status !== 'missed' && i.category !== 'rest' && i.category !== 'free');
  const plannedMin = active.filter((i) => i.status !== 'done').reduce((n, i) => n + (i.durationMin ?? 0), 0);
  return { plannedMin, count: active.length, overloaded: plannedMin > OVERLOAD_MINUTES || active.length > OVERLOAD_ITEMS };
}

// ------------------------------------------------------------------ painel inicial

export const HOME_CARDS = ['character', 'today', 'next_activities', 'workout', 'nutrition', 'next_meal', 'knowledge', 'next_study', 'bible', 'week_goals', 'suggestions', 'ai', 'achievements'] as const;
export type HomeCardId = (typeof HOME_CARDS)[number];
export const HOME_CARD_LABEL: Record<HomeCardId, string> = {
  character: 'Nível e XP no topo',
  today: 'Missões e hábitos de hoje',
  next_activities: 'Próxima atividade',
  workout: 'Treino do dia',
  nutrition: 'Alimentação de hoje',
  next_meal: 'Próxima refeição',
  knowledge: 'Leitura e estudos de hoje',
  next_study: 'Próximo estudo ou leitura',
  bible: 'Versículo do dia',
  week_goals: 'Meta da semana',
  suggestions: 'Sugestões',
  ai: 'Atalho da IA',
  achievements: 'Conquistas recentes',
};
/**
 * Fase 08: o padrão mostra só o essencial (personagem, hoje, próxima atividade, treino, meta, IA e versículo). Os
 * resumos de alimentação/estudos, sugestões e conquistas ficam desligados até a pessoa ligar em "Personalizar".
 * Layouts já salvos são respeitados como estão; cartões novos entram no fim com este padrão.
 */
export const HOME_CARDS_HIDDEN_BY_DEFAULT: readonly HomeCardId[] = ['nutrition', 'next_meal', 'knowledge', 'next_study', 'suggestions', 'achievements'];
export const DEFAULT_HOME_LAYOUT: { id: HomeCardId; visible: boolean }[] = HOME_CARDS.map((id) => ({ id, visible: !HOME_CARDS_HIDDEN_BY_DEFAULT.includes(id) }));

export const homeLayoutSchema = z
  .object({
    /** 0 = ainda não salvo nesta conta. */
    version: z.number().int().min(0).optional(),
    cards: z
      .array(z.object({ id: z.enum(HOME_CARDS), visible: z.boolean() }).strict())
      .min(1)
      .max(HOME_CARDS.length)
      .refine((a) => new Set(a.map((c) => c.id)).size === a.length, { message: 'cartão repetido' }),
  })
  .strict();

/** Completa um layout salvo com os cartões que ainda não existiam quando ele foi salvo. */
export function normalizeLayout(saved: { id: string; visible: boolean }[] | null | undefined): { id: HomeCardId; visible: boolean }[] {
  const seen = new Set<string>();
  const out: { id: HomeCardId; visible: boolean }[] = [];
  for (const c of saved ?? []) {
    if ((HOME_CARDS as readonly string[]).includes(c.id) && !seen.has(c.id)) {
      seen.add(c.id);
      out.push({ id: c.id as HomeCardId, visible: !!c.visible });
    }
  }
  for (const d of DEFAULT_HOME_LAYOUT) if (!seen.has(d.id)) out.push(d);
  return out;
}

export interface HomeLayoutView {
  cards: { id: HomeCardId; visible: boolean }[];
  version: number;
}

/** Resumo do dia para o painel (só leitura; cada número vem do módulo de origem). */
export interface TodayView {
  protocol: typeof PLANNER_PROTOCOL;
  today: string;
  now: string;
  workout: { status: 'planned' | 'in_progress' | 'done' | 'rest' | 'none'; title: string | null; link: string } | null;
  nextMeal: { title: string; time: string | null; kcal: number | null; link: string } | null;
  nextStudy: { title: string; time: string | null; category: 'study' | 'reading' | 'bible'; status: AgendaStatus; link: string } | null;
  weekGoals: { title: string; module: 'training' | 'knowledge' | 'bible' | 'life'; done: number; target: number; unit: string; link: string }[];
  upcoming: AgendaItem[];
  suggestions: { text: string; link: string | null }[];
  layout: HomeLayoutView;
}

// ------------------------------------------------------------------ Minha Evolução

export const EVOLUTION_PERIODS = ['week', 'month', 'last7', 'last30'] as const;
export type EvolutionPeriod = (typeof EVOLUTION_PERIODS)[number];

export interface EvolutionMetric {
  id: string;
  module: 'training' | 'nutrition' | 'life' | 'knowledge' | 'bible';
  label: string;
  unit: string;
  /** null = sem registros no período (ausência de dado, NUNCA zero de desempenho). */
  value: number | null;
  previous: number | null;
  /** Diferença em relação ao período anterior, quando os dois têm dados. */
  delta: number | null;
  detail: string | null;
}

export interface EvolutionInsight {
  tone: 'positive' | 'neutral' | 'attention';
  text: string;
  /** Em que se baseia (para não parecer opinião). */
  basis: string;
}

export interface EvolutionView {
  protocol: typeof PLANNER_PROTOCOL;
  period: { kind: EvolutionPeriod; from: string; to: string; label: string; days: number };
  previous: { from: string; to: string; label: string };
  metrics: EvolutionMetric[];
  /** Série diária simples para os gráficos (minutos de leitura/estudo, treinos, refeições registradas). */
  daily: { date: string; workouts: number; knowledgeMin: number; bibleMin: number; mealsLogged: number; habitsDone: number; xp: number }[];
  loads: { exercise: string; first: number; last: number; sessions: number }[];
  insights: EvolutionInsight[];
  /** Módulos sem nenhum registro no período (mostrados como "sem dados", não como desempenho ruim). */
  missing: string[];
  notes: string[];
}
