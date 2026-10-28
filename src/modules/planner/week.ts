// Semana planejada × realizada (IronTrack 2.0 F01/P13, docs/PLANEJAMENTO_SEMANAL.md §5–7).
// Puro e determinístico: recebe entradas, sessões, rotinas e o dia de hoje; não grava nada. Sessões contadas são as
// mesmas das metas (`countableSessions`: só concluídas, do perfil, sem repetidas), então o painel e as metas nunca
// divergem. A associação usa só IDs (rotina e treino): nunca nomes, nunca proximidade de horário.
import { countableSessions } from '@/modules/goals';
import type { Routine, WorkoutSession } from '@/modules/training';
import { planWeekday, sessionDay, weekDates, weekOf } from './calendar';
import { planForDate } from './operations';
import type { PlanEntry } from './types';

/** Estado do dia (sempre com texto; nunca "falhou"). */
export type DayState = 'futuro' | 'planejado' | 'concluido' | 'parcial' | 'sem_plano';

export const DAY_STATE_LABEL: Record<DayState, string> = {
  futuro: 'Dia futuro',
  planejado: 'Planejado',
  concluido: 'Concluído',
  parcial: 'Parcialmente realizado',
  sem_plano: 'Sem atividade planejada',
};

/** Situação de cada atividade planejada. */
export type ActivityStatus = 'realizada' | 'em_andamento' | 'pendente' | 'nao_registrada' | 'futura';

export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus, string> = {
  realizada: 'Realizada',
  em_andamento: 'Em andamento',
  pendente: 'Para hoje',
  nao_registrada: 'Sem registro',
  futura: 'Planejada',
};

/** A rotina/treino referenciado ainda existe? (rotina excluída ou treino removido continuam visíveis, com aviso). */
export type Availability = 'ok' | 'routine_missing' | 'workout_missing';

export interface PlannedActivity {
  entry: PlanEntry;
  availability: Availability;
  routineName: string | null;
  /** Rótulo e nome do treino específico; null quando segue a rotação ou o treino não existe mais. */
  workoutLabel: string | null;
  workoutName: string | null;
  /** Segue a rotação: o treino é o próximo da rotação da rotina na hora de treinar. */
  followsRotation: boolean;
  status: ActivityStatus;
  /** Sessão concluída associada (cada sessão conta para no máximo uma atividade). */
  sessionId: string | null;
}

export interface DaySession {
  session: WorkoutSession;
  /** Atividade planejada à qual a sessão foi associada; null = sessão extra (não é erro). */
  entryId: string | null;
}

export interface DayView {
  date: string;
  weekday: number;
  isToday: boolean;
  isPast: boolean;
  isFuture: boolean;
  source: 'exception' | 'recurring' | 'none';
  /** Descanso ou dia livre planejado (sem atividades). */
  marker: 'rest' | 'free' | null;
  activities: PlannedActivity[];
  /** Sessões concluídas no dia (no dia em que aconteceram, mesmo fora do planejado). */
  sessions: DaySession[];
  /** Treino em andamento iniciado neste dia (não conta como concluído). */
  active: WorkoutSession | null;
  state: DayState;
  /** Descanso/dia livre junto com atividades (pode surgir de uma mesclagem de backup): as atividades valem. */
  markerConflict: boolean;
}

export interface WeekConsistency {
  monday: string;
  sunday: string;
  /** Sessões concluídas na semana. */
  sessionsCompleted: number;
  /** Dias distintos com pelo menos uma sessão concluída. */
  daysWithTraining: number;
  /** Atividades de treino planejadas na semana inteira. */
  plannedActivities: number;
  /** Planejadas até hoje (as que já poderiam ter sido feitas). */
  plannedDue: number;
  /** Planejadas até hoje que têm sessão associada. */
  realized: number;
  /** Sessões sem atividade planejada correspondente (extras: não são erro). */
  extraSessions: number;
  /** realized ÷ plannedDue; null quando nada estava planejado até hoje (sem porcentagem inventada). */
  adherence: number | null;
  restDays: number;
  /** A semana já terminou. */
  closed: boolean;
}

export interface WeekView {
  monday: string;
  days: DayView[];
  consistency: WeekConsistency;
}

export interface BuildWeekInput {
  entries: readonly PlanEntry[];
  /** Sessões de qualquer estado (as não concluídas são filtradas aqui). */
  sessions: readonly WorkoutSession[];
  routines: readonly Pick<Routine, 'id' | 'name' | 'workouts' | 'profileId'>[];
  /** Qualquer dia da semana desejada. */
  week: string;
  today: string;
  profileId: string | undefined;
}

function describe(entry: PlanEntry, routines: BuildWeekInput['routines']): Omit<PlannedActivity, 'status' | 'sessionId'> {
  const routine = routines.find((r) => r.id === entry.routineId);
  const followsRotation = entry.workoutId === null;
  if (!routine) return { entry, availability: 'routine_missing', routineName: null, workoutLabel: null, workoutName: null, followsRotation };
  if (followsRotation) return { entry, availability: 'ok', routineName: routine.name, workoutLabel: null, workoutName: null, followsRotation };
  const w = routine.workouts.find((x) => x.id === entry.workoutId);
  if (!w) return { entry, availability: 'workout_missing', routineName: routine.name, workoutLabel: null, workoutName: null, followsRotation };
  return { entry, availability: 'ok', routineName: routine.name, workoutLabel: w.label, workoutName: w.name, followsRotation };
}

/**
 * Associa as sessões concluídas do dia às atividades planejadas do dia. Primeiro as atividades com treino
 * específico (mesma rotina e mesmo treino), depois as que seguem a rotação (qualquer treino da mesma rotina).
 * Cada sessão serve a no máximo uma atividade; as demais ficam como extras.
 */
export function matchDay(activities: readonly PlanEntry[], sessions: readonly WorkoutSession[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const pass = (pred: (e: PlanEntry) => boolean, fits: (e: PlanEntry, s: WorkoutSession) => boolean) => {
    for (const e of activities.filter(pred)) {
      const s = ordered.find((x) => !used.has(x.id) && fits(e, x));
      if (!s) continue;
      used.add(s.id);
      out.set(e.id, s.id);
    }
  };
  pass(
    (e) => e.workoutId !== null,
    (e, s) => s.routineId === e.routineId && s.workoutId === e.workoutId,
  );
  pass(
    (e) => e.workoutId === null,
    (e, s) => s.routineId === e.routineId,
  );
  return out;
}

export function buildWeek(input: BuildWeekInput): WeekView {
  const monday = weekOf(input.week);
  const dates = weekDates(monday);
  const { list } = countableSessions(input.sessions as WorkoutSession[], input.profileId);
  const byDay = new Map<string, WorkoutSession[]>();
  for (const s of list) {
    const d = sessionDay(s.startedAt);
    if (d < dates[0] || d > dates[6]) continue;
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const ownActive = input.sessions.filter((s) => s?.status === 'active' && (!input.profileId || !s.profileId || s.profileId === input.profileId));
  const days = dates.map((date): DayView => {
    const plan = planForDate(input.entries, date);
    const workouts = plan.entries.filter((e) => e.kind === 'workout');
    const markerEntry = plan.entries.find((e) => e.kind !== 'workout');
    const sessions = byDay.get(date) ?? [];
    const matched = matchDay(workouts, sessions);
    const sessionToEntry = new Map([...matched].map(([e, s]) => [s, e]));
    const active = ownActive.find((s) => sessionDay(s.startedAt) === date) ?? null;
    const isToday = date === input.today;
    const isPast = date < input.today;
    const isFuture = date > input.today;
    const activities = workouts.map((e): PlannedActivity => {
      const base = describe(e, input.routines);
      const sessionId = matched.get(e.id) ?? null;
      const activeHere = !sessionId && !!active && active.routineId === e.routineId && (e.workoutId === null || active.workoutId === e.workoutId);
      const status: ActivityStatus = sessionId ? 'realizada' : activeHere ? 'em_andamento' : isFuture ? 'futura' : isToday ? 'pendente' : 'nao_registrada';
      return { ...base, status, sessionId };
    });
    const done = activities.filter((a) => a.sessionId).length;
    const state: DayState = isFuture ? 'futuro' : activities.length === 0 ? 'sem_plano' : done === activities.length ? 'concluido' : done > 0 ? 'parcial' : 'planejado';
    return {
      date,
      weekday: planWeekday(date),
      isToday,
      isPast,
      isFuture,
      source: plan.source,
      marker: workouts.length === 0 && markerEntry ? (markerEntry.kind as 'rest' | 'free') : null,
      activities,
      sessions: sessions.map((s) => ({ session: s, entryId: sessionToEntry.get(s.id) ?? null })),
      active,
      state,
      markerConflict: workouts.length > 0 && !!markerEntry,
    };
  });
  return { monday, days, consistency: weekConsistency(monday, days, input.today) };
}

function weekConsistency(monday: string, days: DayView[], today: string): WeekConsistency {
  const due = days.filter((d) => !d.isFuture);
  const plannedDue = due.reduce((a, d) => a + d.activities.length, 0);
  const realized = due.reduce((a, d) => a + d.activities.filter((x) => x.sessionId).length, 0);
  const sessionsCompleted = days.reduce((a, d) => a + d.sessions.length, 0);
  return {
    monday,
    sunday: days[6].date,
    sessionsCompleted,
    daysWithTraining: days.filter((d) => d.sessions.length > 0).length,
    plannedActivities: days.reduce((a, d) => a + d.activities.length, 0),
    plannedDue,
    realized,
    extraSessions: days.reduce((a, d) => a + d.sessions.filter((s) => s.entryId === null).length, 0),
    adherence: plannedDue > 0 ? realized / plannedDue : null,
    restDays: days.filter((d) => d.marker === 'rest').length,
    closed: days[6].date < today,
  };
}

export interface WeekComparison {
  sessionsDelta: number;
  daysDelta: number;
}

/** Diferença simples para a semana anterior (sessões e dias; sem pontuação). */
export function compareWeeks(current: WeekConsistency, previous: WeekConsistency): WeekComparison {
  return { sessionsDelta: current.sessionsCompleted - previous.sessionsCompleted, daysDelta: current.daysWithTraining - previous.daysWithTraining };
}
