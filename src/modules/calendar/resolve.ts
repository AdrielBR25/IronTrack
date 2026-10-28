// Resolução do calendário unificado (IronTrack 2.0 F01/P14, docs/CALENDARIO_UNIFICADO.md §2–§4, §7–§9).
// Política de precedência (só de APRESENTAÇÃO; nenhum dado é alterado):
//  1. sessões concluídas são fatos e sempre aparecem (no dia em que aconteceram);
//  2. exceção do planejamento define o plano daquele dia;
//  3. planejamento recorrente define o plano (intenção explícita);
//  4. agenda anterior aparece como sugestão quando não há planejamento — e continua visível (sombreada) quando há;
//  5. a rotação futura aparece só como previsão.
// O planejamento de cada dia vem de `buildWeek` (P13), as sessões contadas das metas (P12): nenhuma fórmula paralela.
import { ACTIVITY_STATUS_LABEL, buildWeek, planAddDays, weekDates, weekOf, type DayView } from '@/modules/planner';
import { normIndex } from '@/modules/training';
import { activityText, detectConflicts } from './conflicts';
import { forecastRotation, rotationPointer } from './forecast';
import { FORECAST_HORIZON_DAYS, interpretLegacy } from './legacy';
import type {
  CalendarInput,
  CalendarSummary,
  LegacyDay,
  ResolvedDay,
  ResolvedEntry,
  ResolvedMonth,
  ResolvedWeek,
  RotationForecast,
  UnifiedDayStatus,
} from './types';

export const DAY_STATUS_LABEL: Record<UnifiedDayStatus, string> = {
  done: 'Concluído',
  partial: 'Parcialmente realizado',
  in_progress: 'Em andamento',
  planned: 'Planejado',
  suggested: 'Sugestão da agenda anterior',
  rest: 'Descanso',
  free: 'Dia livre',
  not_recorded: 'Sem registro',
  trained: 'Treino realizado',
  empty: 'Nada planejado',
};

export const CERTAINTY_LABEL: Record<ResolvedEntry['certainty'], string> = {
  fact: 'Realizado',
  explicit: 'Escolhido por você',
  suggestion: 'Sugestão da agenda anterior',
  current: 'Próximo da rotação agora',
  forecast: 'Previsão baseada na rotação atual',
  undetermined: 'Treino a definir pela rotação',
};

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = planAddDays(d, 1)) out.push(d);
  return out;
}

function legacyEntry(l: LegacyDay, routineName: string | null, shadowed: boolean): ResolvedEntry {
  const origin = l.source === 'override' ? 'legacy_override' : l.source === 'off' ? 'legacy_off' : 'legacy_rotation';
  const state = shadowed
    ? 'Agenda anterior (não define o dia)'
    : l.source === 'override'
      ? l.kind === 'rest'
        ? 'Descanso reagendado na agenda anterior'
        : 'Reagendado na agenda anterior'
      : l.kind === 'rest'
        ? 'Descanso na agenda anterior'
        : 'Sugestão da agenda anterior';
  return {
    date: l.date,
    origin,
    kind: l.kind === 'rest' ? 'rest' : 'workout',
    routineId: l.routineId,
    routineName,
    workoutId: l.workoutId,
    workoutLabel: l.workoutLabel,
    workoutName: l.workoutName,
    state,
    certainty: l.certainty,
    sessionId: null,
    planEntryId: null,
    followsRotation: l.source === 'rotation',
    shadowed,
    conflict: false,
  };
}

function dayStatus(plan: DayView, legacy: LegacyDay | null): UnifiedDayStatus {
  const anyActivityActive = plan.activities.some((a) => a.status === 'em_andamento');
  if (plan.source !== 'none') {
    if (plan.activities.length) {
      const done = plan.activities.filter((a) => a.sessionId).length;
      if (done === plan.activities.length) return 'done';
      if (anyActivityActive || (plan.isToday && plan.active)) return 'in_progress';
      if (done > 0) return 'partial';
      return plan.isPast ? 'not_recorded' : 'planned';
    }
    if (plan.sessions.length) return 'trained';
    if (plan.active) return 'in_progress';
    return plan.marker === 'rest' ? 'rest' : 'free';
  }
  if (plan.active && plan.isToday) return 'in_progress';
  if (plan.sessions.length) return 'trained';
  if (plan.active) return 'in_progress';
  if (!plan.isPast && legacy) {
    if (legacy.kind === 'workout') return 'suggested';
    if (legacy.kind === 'rest') return 'rest';
  }
  return 'empty';
}

interface Prepared {
  input: CalendarInput;
  views: Map<string, DayView>;
  legacy: Map<string, LegacyDay>;
  forecasts: Map<string, Record<string, RotationForecast>>;
}

function prepare(input: CalendarInput, from: string, to: string): Prepared {
  const views = new Map<string, DayView>();
  const mondays = new Set([...datesBetween(weekOf(from), to).filter((_, i) => i % 7 === 0), weekOf(input.today)]);
  for (const monday of mondays) {
    const w = buildWeek({ entries: input.entries, sessions: input.sessions, routines: input.routines, week: monday, today: input.today, profileId: input.profileId });
    for (const d of w.days) views.set(d.date, d);
  }
  const legacyRoutine = input.legacy ? input.routines.find((r) => r.id === input.legacy!.routineId) : undefined;
  const pointer = legacyRoutine && legacyRoutine.workouts.length ? rotationPointer(legacyRoutine, input.rotations) : 0;
  const legacy = interpretLegacy(input.legacy, input.routines, input.sessions, pointer, input.profileId, input.today, from, to);
  const forecasts = forecastRotation({
    entries: input.entries,
    routines: input.routines,
    rotations: input.rotations,
    sessions: input.sessions,
    profileId: input.profileId,
    today: input.today,
    todayView: views.get(input.today)!,
    to,
  });
  return { input, views, legacy, forecasts };
}

function compose(p: Prepared, date: string): ResolvedDay {
  const { input } = p;
  const plan = p.views.get(date)!;
  const legacy = p.legacy.get(date) ?? null;
  const routineName = (id: string | null) => input.routines.find((r) => r.id === id)?.name ?? null;

  // Previsões: hoje/futuro pela simulação; realizadas pelo que aconteceu; passado sem registro fica a definir.
  const forecasts: Record<string, RotationForecast> = {};
  const future = p.forecasts.get(date) ?? {};
  for (const a of plan.activities) {
    if (!a.followsRotation || !a.entry.routineId) continue;
    const s = a.sessionId ? plan.sessions.find((x) => x.session.id === a.sessionId)?.session : undefined;
    if (s) forecasts[a.entry.id] = { routineId: a.entry.routineId, workoutId: s.workoutId, workoutLabel: s.workoutLabel, workoutName: s.workoutName, certainty: 'fact' };
    else if (future[a.entry.id]) forecasts[a.entry.id] = future[a.entry.id];
    else forecasts[a.entry.id] = { routineId: a.entry.routineId, workoutId: null, workoutLabel: null, workoutName: null, certainty: 'undetermined' };
  }

  const planOrigin = plan.source === 'exception' ? 'plan_exception' : 'plan_recurring';
  const entries: ResolvedEntry[] = [];
  for (const { session: s, entryId } of plan.sessions) {
    entries.push({
      date,
      origin: 'session',
      kind: 'workout',
      routineId: s.routineId,
      routineName: routineName(s.routineId),
      workoutId: s.workoutId,
      workoutLabel: s.workoutLabel,
      workoutName: s.workoutName,
      state: entryId ? 'Realizada' : plan.source === 'none' ? 'Realizada' : 'Realizada fora do planejado',
      certainty: 'fact',
      sessionId: s.id,
      planEntryId: entryId,
      followsRotation: false,
      shadowed: false,
      conflict: false,
    });
  }
  if (plan.active) {
    const s = plan.active;
    entries.push({
      date,
      origin: 'active_session',
      kind: 'workout',
      routineId: s.routineId,
      routineName: routineName(s.routineId),
      workoutId: s.workoutId,
      workoutLabel: s.workoutLabel,
      workoutName: s.workoutName,
      state: 'Em andamento (ainda não conta como concluída)',
      certainty: 'fact',
      sessionId: null,
      planEntryId: null,
      followsRotation: false,
      shadowed: false,
      conflict: false,
    });
  }
  for (const a of plan.activities) {
    const f = forecasts[a.entry.id];
    entries.push({
      date,
      origin: planOrigin,
      kind: 'workout',
      routineId: a.entry.routineId,
      routineName: a.routineName,
      workoutId: a.followsRotation ? (f?.workoutId ?? null) : a.availability === 'ok' ? a.entry.workoutId : null,
      workoutLabel: a.followsRotation ? (f?.workoutLabel ?? null) : a.workoutLabel,
      workoutName: a.followsRotation ? (f?.workoutName ?? null) : a.workoutName,
      state: ACTIVITY_STATUS_LABEL[a.status],
      certainty: a.followsRotation ? (f?.certainty ?? 'undetermined') : 'explicit',
      sessionId: a.sessionId,
      planEntryId: a.entry.id,
      followsRotation: a.followsRotation,
      shadowed: false,
      conflict: false,
    });
  }
  if (plan.source !== 'none' && plan.activities.length === 0 && plan.marker) {
    const marker = plan.marker;
    entries.push({
      date,
      origin: planOrigin,
      kind: marker,
      routineId: null,
      routineName: null,
      workoutId: null,
      workoutLabel: null,
      workoutName: null,
      state: marker === 'rest' ? 'Descanso planejado' : 'Dia livre',
      certainty: 'explicit',
      sessionId: null,
      planEntryId: null,
      followsRotation: false,
      shadowed: false,
      conflict: false,
    });
  }
  // Agenda anterior: define o dia só sem planejamento e de hoje em diante; senão fica visível, sombreada.
  if (legacy && legacy.kind !== 'done') entries.push(legacyEntry(legacy, routineName(legacy.routineId), plan.source !== 'none' || plan.isPast));

  const pointerWorkout = (routineId: string) => {
    const r = input.routines.find((x) => x.id === routineId);
    if (!r || !r.workouts.length) return null;
    return r.workouts[normIndex(rotationPointer(r, input.rotations), r.workouts.length)];
  };
  const conflicts = detectConflicts({
    date,
    today: input.today,
    entries: input.entries,
    plan,
    legacy,
    forecasts,
    routines: input.routines,
    pointerWorkout,
    hasActiveSession: input.sessions.some((s) => s?.status === 'active' && (!input.profileId || !s.profileId || s.profileId === input.profileId)),
  });
  for (const c of conflicts) {
    for (const e of entries) {
      const isPlan = e.origin === 'plan_exception' || e.origin === 'plan_recurring';
      const isLegacy = e.origin.startsWith('legacy');
      if (c.kind.startsWith('plan_') && (isPlan || isLegacy)) e.conflict = true;
      if (c.kind === 'exception_replaces_recurring' && isPlan) e.conflict = true;
      if (c.kind === 'rotation_differs' && isPlan && !e.followsRotation && !e.sessionId) e.conflict = true;
      if (c.kind === 'session_off_plan' && e.origin === 'session' && !e.planEntryId) e.conflict = true;
    }
  }

  return {
    date,
    weekday: plan.weekday,
    isToday: plan.isToday,
    isPast: plan.isPast,
    isFuture: plan.isFuture,
    plan,
    legacy,
    forecasts,
    origin: plan.source === 'exception' ? 'plan_exception' : plan.source === 'recurring' ? 'plan_recurring' : legacy && !plan.isPast ? 'legacy' : 'none',
    status: dayStatus(plan, legacy),
    entries,
    conflicts,
    hasWarning: conflicts.some((c) => c.severity === 'warning'),
    legacyAgrees: legacyAgreesWithPlan(plan, legacy),
  };
}

/** A agenda anterior diz o mesmo que o planejamento do dia (mesma rotina pela rotação, mesmo treino ou descanso). */
function legacyAgreesWithPlan(plan: DayView, legacy: LegacyDay | null): boolean {
  if (!legacy || plan.source === 'none' || legacy.kind === 'done') return false;
  if (legacy.kind === 'rest') return plan.activities.length === 0 && plan.marker === 'rest';
  return plan.activities.some(
    (a) => a.entry.routineId === legacy.routineId && ((a.followsRotation && legacy.source === 'rotation') || (!a.followsRotation && a.entry.workoutId === legacy.workoutId)),
  );
}

/** Resolve os dias de `from` a `to` (inclusive), sob demanda. Nada é gravado. */
export function resolveRange(input: CalendarInput, from: string, to: string): ResolvedDay[] {
  if (to < from) return [];
  const p = prepare(input, from, to);
  return datesBetween(from, to).map((d) => compose(p, d));
}

export const resolveDay = (input: CalendarInput, date: string): ResolvedDay => resolveRange(input, date, date)[0];

/** Números de um conjunto de dias, com as mesmas definições do planejamento (P13) e as sugestões à parte. */
export function summarize(days: readonly ResolvedDay[]): CalendarSummary {
  const due = days.filter((d) => !d.isFuture);
  return {
    from: days[0]?.date ?? '',
    to: days[days.length - 1]?.date ?? '',
    sessionsCompleted: days.reduce((a, d) => a + d.plan.sessions.length, 0),
    activeDays: days.filter((d) => d.plan.sessions.length > 0).length,
    plannedActivities: days.reduce((a, d) => a + d.plan.activities.length, 0),
    plannedDue: due.reduce((a, d) => a + d.plan.activities.length, 0),
    realized: due.reduce((a, d) => a + d.plan.activities.filter((x) => x.sessionId).length, 0),
    extraSessions: days.reduce((a, d) => a + d.plan.sessions.filter((s) => s.entryId === null).length, 0),
    restDaysPlanned: days.filter((d) => d.plan.marker === 'rest').length,
    legacySuggestions: days.filter((d) => d.origin === 'legacy' && d.legacy?.kind === 'workout').length,
    conflictDays: days.filter((d) => d.hasWarning).length,
  };
}

export function resolveWeek(input: CalendarInput, anyDay: string): ResolvedWeek {
  const monday = weekOf(anyDay);
  const dates = weekDates(monday);
  const days = resolveRange(input, dates[0], dates[6]);
  const consistency = buildWeek({ entries: input.entries, sessions: input.sessions, routines: input.routines, week: monday, today: input.today, profileId: input.profileId }).consistency;
  return { monday, days, consistency, summary: summarize(days) };
}

// ------------------------------------------------------------------ meses

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Mês (yyyy-mm) de uma data. */
export const monthOf = (date: string) => date.slice(0, 7);

export function shiftMonth(month: string, n: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Mês inválido: ${month}`);
  const total = +m[1] * 12 + (+m[2] - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Primeiro e último dia do mês. */
export function monthBounds(month: string): { first: string; last: string } {
  const first = `${month}-01`;
  return { first, last: planAddDays(`${shiftMonth(month, 1)}-01`, -1) };
}

/** Grade do mês (semanas de segunda a domingo). Resolve só os dias exibidos; nenhum registro é criado. */
export function resolveMonth(input: CalendarInput, month: string): ResolvedMonth {
  const { first, last } = monthBounds(month);
  const start = weekOf(first);
  const end = planAddDays(weekOf(last), 6);
  const days = resolveRange(input, start, end).map((d) => ({ ...d, inMonth: d.date >= first && d.date <= last }));
  const weeks: ResolvedMonth['weeks'] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push({ monday: days[i].date, days: days.slice(i, i + 7) });
  return { month, weeks, summary: summarize(days.filter((d) => d.inMonth)) };
}

// ------------------------------------------------------------------ Início e Treinos

/** Linhas que definem o dia (sem as sessões e sem o que ficou sombreado). */
export const primaryEntries = (day: ResolvedDay): ResolvedEntry[] => day.entries.filter((e) => !e.shadowed && e.origin !== 'session' && e.origin !== 'active_session');

/** Próxima atividade de treino depois de hoje (planejada ou sugerida), dentro de `days` dias. */
export function nextActivity(input: CalendarInput, days = FORECAST_HORIZON_DAYS * 2): { day: ResolvedDay; entry: ResolvedEntry } | null {
  const from = planAddDays(input.today, 1);
  for (const day of resolveRange(input, from, planAddDays(input.today, days))) {
    if (day.status !== 'planned' && day.status !== 'suggested') continue;
    const entry = primaryEntries(day).find((e) => e.kind === 'workout');
    if (entry) return { day, entry };
  }
  return null;
}

/** Texto de uma linha resolvida (rotina/treino ou marcador), com a previsão identificada como tal. */
export function entryText(e: ResolvedEntry): string {
  if (e.kind === 'rest') return 'Descanso';
  if (e.kind === 'free') return 'Dia livre';
  const w = e.workoutLabel ? `Treino ${e.workoutLabel}${e.workoutName ? ` · ${e.workoutName}` : ''}` : null;
  if (e.origin === 'session' || e.origin === 'active_session') return w ?? 'Treino';
  if (e.followsRotation) {
    if (e.certainty === 'undetermined' || !w) return `${e.routineName ?? 'Rotina'}: treino a definir pela rotação`;
    return w;
  }
  if (e.origin.startsWith('legacy') && !w) return 'Dia de treino';
  return w ?? (e.routineName ? `${e.routineName}: treino removido da rotina` : 'Rotina excluída');
}

/** Reexporta o texto de atividade usado nos avisos (mesma redação em todas as telas). */
export { activityText };

/** Estado da rotação de uma rotina (só leitura do ponteiro). */
export function rotationStatus(input: Pick<CalendarInput, 'routines' | 'rotations'>, routineId: string | null) {
  const routine = input.routines.find((r) => r.id === routineId);
  if (!routine || !routine.workouts.length) return null;
  const index = rotationPointer(routine, input.rotations);
  return { routine, index, next: routine.workouts[index], order: routine.workouts.map((w) => w.label) };
}
