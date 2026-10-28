// Contratos do calendário unificado (IronTrack 2.0 F01/P14). Ver docs/CALENDARIO_UNIFICADO.md.
// Visão CALCULADA, nunca persistida: cada dia é resolvido sob demanda a partir de quatro fontes que continuam
// independentes — sessões reais, planejamento semanal (`planEntries`), agenda anterior (`Settings.trainingDays` +
// `overrides` da rotina ativa) e o ponteiro da rotação. Nada aqui grava, avança a rotação ou cria sessões.
import type { DayOverride, Routine, RotationState, WorkoutSession } from '@/modules/training';
import type { DayView, PlanEntry, WeekConsistency } from '@/modules/planner';

/** Agenda anterior (P01–P12): dias de treino das Configurações + reagendamentos da rotina ativa. */
export interface LegacySchedule {
  routineId: string;
  trainingDays: readonly number[];
  overrides: readonly DayOverride[];
}

export type CalendarRoutine = Pick<Routine, 'id' | 'name' | 'workouts' | 'profileId'>;

export interface CalendarInput {
  /** Dia local de hoje (yyyy-mm-dd). */
  today: string;
  profileId: string | undefined;
  entries: readonly PlanEntry[];
  /** Sessões de qualquer estado (só as concluídas do perfil contam; a em andamento aparece à parte). */
  sessions: readonly WorkoutSession[];
  routines: readonly CalendarRoutine[];
  rotations: readonly RotationState[];
  /** null: sem rotina ativa com treinos (não há agenda anterior a mostrar). */
  legacy: LegacySchedule | null;
}

/**
 * De onde vem uma informação do dia. Ordem de precedência de apresentação (§4 do documento):
 * sessão real > exceção do planejamento > planejamento recorrente > agenda anterior > previsão da rotação.
 */
export type CalendarOrigin =
  | 'session'
  | 'active_session'
  | 'plan_exception'
  | 'plan_recurring'
  | 'legacy_override'
  | 'legacy_rotation'
  | 'legacy_off';

export type CalendarActivityKind = 'workout' | 'rest' | 'free';

/**
 * Grau de certeza do que é mostrado:
 * - `fact`: sessão concluída (aconteceu);
 * - `explicit`: o usuário escolheu (planejamento ou reagendamento na agenda anterior);
 * - `suggestion`: dedução da agenda anterior (dia de treino nas Configurações) sem escolha para aquele dia;
 * - `current`: ponteiro atual da rotação (o próximo, se nada mudar antes);
 * - `forecast`: simulação a partir da rotação atual (pode mudar);
 * - `undetermined`: não há dados para dizer qual treino ("Treino a definir pela rotação").
 */
export type Certainty = 'fact' | 'explicit' | 'suggestion' | 'current' | 'forecast' | 'undetermined';

/** Treino previsto para uma atividade que "segue a rotação" (ou para um dia de treino da agenda anterior). */
export interface RotationForecast {
  routineId: string;
  workoutId: string | null;
  workoutLabel: string | null;
  workoutName: string | null;
  certainty: Extract<Certainty, 'current' | 'forecast' | 'undetermined' | 'fact'>;
}

/** Interpretação da agenda anterior para uma data. */
export interface LegacyDay {
  date: string;
  /** `done`: a agenda anterior considera o dia feito (treino concluído hoje). */
  kind: 'workout' | 'rest' | 'done';
  source: 'override' | 'rotation' | 'off' | 'done';
  routineId: string;
  /** Treino indicado (null quando não dá para saber: dias passados ou além do horizonte da previsão). */
  workoutId: string | null;
  workoutLabel: string | null;
  workoutName: string | null;
  /** `explicit` (reagendamento), `current` (hoje, pelo ponteiro), `forecast`, `undetermined`, `suggestion` (passado). */
  certainty: Certainty;
}

export type ConflictKind =
  | 'plan_vs_legacy_workout'
  | 'plan_rest_vs_legacy_workout'
  | 'plan_workout_vs_legacy_rest'
  | 'exception_replaces_recurring'
  | 'rotation_differs'
  | 'session_off_plan';

/** `warning`: divergência relevante (aviso visível) · `info`: explicação disponível nos detalhes do dia. */
export type ConflictSeverity = 'warning' | 'info';

export interface CalendarConflict {
  kind: ConflictKind;
  severity: ConflictSeverity;
  /** Texto compreensível, pronto para exibir. */
  message: string;
  /** Rótulos dos dois lados (para "Ver detalhes"). */
  planLabel: string | null;
  otherLabel: string | null;
}

/** Uma linha resolvida do dia (o "contrato" da visão unificada). */
export interface ResolvedEntry {
  date: string;
  origin: CalendarOrigin;
  kind: CalendarActivityKind;
  routineId: string | null;
  routineName: string | null;
  workoutId: string | null;
  workoutLabel: string | null;
  workoutName: string | null;
  /** Estado em texto (ex.: "Realizada", "Planejada", "Sugestão da agenda anterior", "Previsão"). */
  state: string;
  certainty: Certainty;
  /** Sessão que comprova a realização (só sessões concluídas). */
  sessionId: string | null;
  /** Atividade do planejamento associada (para sessões: null = extra, fora do planejado). */
  planEntryId: string | null;
  /** A atividade segue a rotação (o treino exibido é previsão, não escolha). */
  followsRotation: boolean;
  /** Informação de uma fonte de menor precedência mantida visível, mas que não define o dia. */
  shadowed: boolean;
  /** Esta linha participa de algum conflito do dia. */
  conflict: boolean;
}

export type UnifiedDayStatus = 'done' | 'partial' | 'in_progress' | 'planned' | 'suggested' | 'rest' | 'free' | 'not_recorded' | 'trained' | 'empty';

export interface ResolvedDay {
  date: string;
  weekday: number;
  isToday: boolean;
  isPast: boolean;
  isFuture: boolean;
  /** Dia do planejamento (P13), exatamente como o painel semanal o calcula. */
  plan: DayView;
  /** Agenda anterior para a data (null sem rotina ativa com treinos). */
  legacy: LegacyDay | null;
  /** Previsão por atividade do planejamento que segue a rotação (chave: ID da entrada). */
  forecasts: Record<string, RotationForecast>;
  /** Origem que define o dia (sessões reais à parte). */
  origin: 'plan_exception' | 'plan_recurring' | 'legacy' | 'none';
  status: UnifiedDayStatus;
  entries: ResolvedEntry[];
  conflicts: CalendarConflict[];
  /** Há conflito com severidade `warning`. */
  hasWarning: boolean;
  /**
   * P15: a agenda anterior indica o mesmo que o planejamento (ex.: depois de importar a agenda anterior). As telas
   * mostram a atividade uma vez só e dizem "a agenda anterior indica o mesmo".
   */
  legacyAgrees: boolean;
}

export interface CalendarSummary {
  from: string;
  to: string;
  /** Mesmos números do planejamento (P13): sessões contadas pelas regras das metas. */
  sessionsCompleted: number;
  activeDays: number;
  /** Só atividades EXPLICITAMENTE planejadas (sugestões da agenda anterior ficam de fora). */
  plannedActivities: number;
  plannedDue: number;
  realized: number;
  extraSessions: number;
  restDaysPlanned: number;
  /** Dias (de hoje em diante) sem planejamento em que a agenda anterior sugere treino: informados à parte. */
  legacySuggestions: number;
  /** Dias com divergência relevante entre as fontes. */
  conflictDays: number;
}

export interface ResolvedWeek {
  monday: string;
  days: ResolvedDay[];
  /** Consistência calculada pelo planejamento (P13), sem fórmula nova. */
  consistency: WeekConsistency;
  summary: CalendarSummary;
}

export interface ResolvedMonth {
  /** yyyy-mm */
  month: string;
  /** Semanas (segunda → domingo) que cobrem o mês; dias de fora do mês vêm com `inMonth: false`. */
  weeks: { monday: string; days: (ResolvedDay & { inMonth: boolean })[] }[];
  summary: CalendarSummary;
}
