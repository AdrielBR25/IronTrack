// Motor de progresso das metas (IronTrack 2.0 F01/P12). Ver docs/METAS_TREINAMENTO.md §6–9.
// Determinístico e só de leitura: recebe a meta, as sessões já lidas e o dia de hoje (calendário local) e devolve o
// progresso. Nada aqui é gravado (o progresso é sempre recalculado), nada vai para a rede e não há IA.
// As medidas por série vêm do motor de analytics (normalizeSessions + exercisePoint + 1RM canônico), para que metas
// e gráficos usem exatamente as mesmas regras de validade.
import { addDays } from '@/lib/dates';
import { canonicalE1rmKg, exercisePoint, localDate, normalizeSessions, weekStart, type ExercisePoint, type SetObs } from '@/modules/analytics';
import type { WorkoutSession } from '@/modules/training';
import type { GoalUnit, TrainingGoal } from './types';
import { goalExerciseMatch } from './exercises';

/** Tolerância na comparação com o valor desejado (pesos são gravados com até 3 casas; lb → kg gera dízimas). */
const EPS = 1e-6;

export type GoalDisplayState = 'ativa' | 'atingida' | 'pausada' | 'arquivada' | 'prazo_encerrado' | 'nao_iniciada';

export interface GoalEvidence {
  sessionId: string;
  ts: number;
  date: string;
  value: number;
  /** Carga (kg) e repetições da série, quando a medida vem de uma série. */
  load?: number | null;
  reps?: number;
  /** Lado registrado na série (analytics usa 'desconhecido' para valores fora do vocabulário). */
  side?: 'direito' | 'esquerdo' | 'ambos' | 'desconhecido';
}

export interface WeekEvaluation {
  /** Segunda-feira da semana. */
  week: string;
  /** Dias da semana considerados (recortados pelo início, pelo prazo e por hoje). */
  from: string;
  to: string;
  count: number;
  met: boolean;
  /** Dia em que a semana atingiu a meta. */
  metOn: string | null;
  /** Semana incompleta (começou antes do início da meta, é a semana atual ou termina no prazo). */
  partial: boolean;
  /** A meta esteve pausada em algum dia da semana. */
  paused: boolean;
  current: boolean;
}

export interface WeeklyProgress {
  currentWeek: WeekEvaluation | null;
  /** Semanas da vigência da meta, da mais antiga à atual. */
  weeks: WeekEvaluation[];
  /** Semanas em que a meta foi cumprida (inclusive parciais). */
  weeksMet: number;
  /** Semanas completas, sem pausa, já encerradas (base para "x de y"). */
  weeksEvaluated: number;
  firstMet: WeekEvaluation | null;
}

export interface GoalDataQuality {
  /** Sessões concluídas com registros válidos para a meta (a partir do início). */
  matchedSessions: number;
  /** Sessões com o mesmo exercício registrado em outra modalidade (não entram). */
  incompatibleSessions: number;
  /** Sessões em que o exercício foi substituído durante o treino (não entram). */
  substitutedSessions: number;
  /** Sessões repetidas (mesmo ID, ou mesmo início e mesmo treino) contadas uma vez só. */
  duplicateSessions: number;
}

export interface GoalProgress {
  goalId: string;
  unit: GoalUnit;
  target: number;
  /** Valor atual: semana atual (frequência), sessões na janela (quantidade) ou melhor marca desde o início (recorde). */
  current: number | null;
  /** Progresso entre 0 e 1 (sempre finito). */
  fraction: number;
  /** Há registros válidos para a meta a partir do início. */
  hasData: boolean;
  /** Atingida com evidência calculável. Frequência semanal: cumprida na semana atual. */
  achieved: boolean;
  achievedAt: string | null;
  evidence: GoalEvidence | null;
  achievedAfterDeadline: boolean;
  /** A evidência superou todas as marcas anteriores do exercício (recorde pessoal), quando havia marca anterior. */
  personalRecord: boolean;
  /** Prazo efetivo: `targetDate` ou o fim da janela. */
  deadline: string | null;
  deadlinePassed: boolean;
  notStarted: boolean;
  /** Melhor marca antes do início (referência; nunca conta como realização). */
  baseline: GoalEvidence | null;
  displayState: GoalDisplayState;
  weekly: WeeklyProgress | null;
  window: { from: string; to: string; count: number } | null;
  quality: GoalDataQuality;
}

/** Sessões concluídas do perfil da meta, sem repetidas, em ordem cronológica. */
export function countableSessions(sessions: readonly WorkoutSession[], profileId: string | undefined): { list: WorkoutSession[]; duplicates: number } {
  const ids = new Set<string>();
  const starts = new Set<string>();
  const list: WorkoutSession[] = [];
  let duplicates = 0;
  const sorted = [...sessions].filter((s) => s?.status === 'completed' && Number.isFinite(s.startedAt) && s.startedAt > 0).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  for (const s of sorted) {
    // Isolamento entre perfis: sessão de outro dono nunca conta (registros antigos sem dono pertencem ao perfil principal).
    if (profileId && s.profileId && s.profileId !== profileId) continue;
    const startKey = `${s.startedAt}|${s.workoutId}`;
    if (ids.has(s.id) || starts.has(startKey)) {
      duplicates++;
      continue;
    }
    ids.add(s.id);
    starts.add(startKey);
    list.push(s);
  }
  return { list, duplicates };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const reached = (value: number, target: number) => value + EPS >= target;

function isPausedOn(goal: TrainingGoal, from: string, to: string): boolean {
  return goal.pauses.some((p) => p.from <= to && (p.to === null || p.to >= from));
}

function displayStateOf(goal: TrainingGoal, p: Pick<GoalProgress, 'achieved' | 'deadlinePassed' | 'notStarted'>, recurring: boolean): GoalDisplayState {
  if (goal.status === 'archived') return 'arquivada';
  if (goal.status === 'paused') return 'pausada';
  if (p.notStarted) return 'nao_iniciada';
  if (p.achieved && !recurring) return 'atingida';
  // Prazo vencido sem realização: só informa que o prazo acabou (nunca "fracassada").
  if (p.deadlinePassed && (!p.achieved || recurring)) return 'prazo_encerrado';
  return 'ativa';
}

const emptyQuality = (duplicates: number): GoalDataQuality => ({ matchedSessions: 0, incompatibleSessions: 0, substitutedSessions: 0, duplicateSessions: duplicates });

export function computeGoalProgress(goal: TrainingGoal, sessions: readonly WorkoutSession[], today: string): GoalProgress {
  const { list, duplicates } = countableSessions(sessions, goal.profileId);
  const notStarted = today < goal.startDate;
  const base = {
    goalId: goal.id,
    unit: goal.unit,
    target: goal.targetValue,
    achievedAfterDeadline: false,
    personalRecord: false,
    baseline: null,
    weekly: null,
    window: null,
    notStarted,
  };
  if (goal.type === 'weekly_frequency') return weeklyProgress(goal, list, today, base, duplicates);
  if (goal.type === 'session_count') return windowProgress(goal, list, today, base, duplicates);
  return recordProgress(goal, list, today, base, duplicates);
}

type Base = Pick<GoalProgress, 'goalId' | 'unit' | 'target' | 'achievedAfterDeadline' | 'personalRecord' | 'baseline' | 'weekly' | 'window' | 'notStarted'>;

// ---------------------------------------------------------------------------------------------
// Frequência semanal

function weeklyProgress(goal: TrainingGoal, list: WorkoutSession[], today: string, base: Base, duplicates: number): GoalProgress {
  const end = goal.targetDate && goal.targetDate < today ? goal.targetDate : today;
  const byDate = new Map<string, number>();
  let matched = 0;
  for (const s of list) {
    const d = localDate(s.startedAt);
    if (d < goal.startDate || d > end) continue;
    byDate.set(d, (byDate.get(d) ?? 0) + 1);
    matched++;
  }
  const weeks: WeekEvaluation[] = [];
  if (!base.notStarted) {
    const todayWeek = weekStart(today);
    for (let w = weekStart(goal.startDate); w <= weekStart(end); w = addDays(w, 7)) {
      const sunday = addDays(w, 6);
      const from = w < goal.startDate ? goal.startDate : w;
      const to = sunday > end ? end : sunday;
      let count = 0;
      let metOn: string | null = null;
      for (let d = from; d <= to; d = addDays(d, 1)) {
        count += byDate.get(d) ?? 0;
        if (metOn === null && count >= goal.targetValue) metOn = d;
      }
      weeks.push({ week: w, from, to, count, met: metOn !== null, metOn, partial: from !== w || to !== sunday, paused: isPausedOn(goal, from, to), current: w === todayWeek });
    }
  }
  const currentWeek = weeks.find((w) => w.current) ?? null;
  const firstMet = weeks.find((w) => w.met) ?? null;
  const deadlinePassed = !!goal.targetDate && today > goal.targetDate;
  const achieved = !!currentWeek?.met && !deadlinePassed;
  const progress = {
    ...base,
    current: currentWeek ? currentWeek.count : null,
    fraction: clamp01((currentWeek?.count ?? 0) / goal.targetValue),
    hasData: matched > 0,
    achieved,
    achievedAt: achieved ? currentWeek!.metOn : null,
    evidence: null,
    deadline: goal.targetDate,
    deadlinePassed,
    weekly: {
      currentWeek,
      weeks,
      weeksMet: weeks.filter((w) => w.met).length,
      weeksEvaluated: weeks.filter((w) => !w.partial && !w.paused && !w.current).length,
      firstMet,
    },
    quality: { ...emptyQuality(duplicates), matchedSessions: matched },
  };
  return { ...progress, displayState: displayStateOf(goal, progress, true) };
}

// ---------------------------------------------------------------------------------------------
// Quantidade de sessões numa janela

function windowProgress(goal: TrainingGoal, list: WorkoutSession[], today: string, base: Base, duplicates: number): GoalProgress {
  const days = goal.params.windowDays ?? 1;
  const from = goal.startDate;
  const to = addDays(from, days - 1);
  let count = 0;
  let evidence: GoalEvidence | null = null;
  for (const s of list) {
    const d = localDate(s.startedAt);
    if (d < from || d > to) continue;
    count++;
    if (!evidence && count >= goal.targetValue) evidence = { sessionId: s.id, ts: s.startedAt, date: d, value: count };
  }
  const deadlinePassed = today > to;
  const progress = {
    ...base,
    current: base.notStarted ? null : count,
    fraction: clamp01(count / goal.targetValue),
    hasData: count > 0,
    achieved: !!evidence,
    achievedAt: evidence?.date ?? null,
    evidence,
    deadline: to,
    deadlinePassed,
    window: { from, to, count },
    quality: { ...emptyQuality(duplicates), matchedSessions: count },
  };
  return { ...progress, displayState: displayStateOf(goal, progress, false) };
}

// ---------------------------------------------------------------------------------------------
// Recordes por exercício

/** Melhor medida de uma sessão para a meta (null quando a sessão não tem medida válida para ela). */
export function sessionGoalValue(goal: Pick<TrainingGoal, 'type' | 'params' | 'exercise'>, point: ExercisePoint): Omit<GoalEvidence, 'sessionId' | 'ts' | 'date'> | null {
  const side = goal.params.side;
  const sideOk = (s: SetObs) => !side || s.side === side;
  const bestOf = (sets: SetObs[], value: (s: SetObs) => number | null) => {
    let best: { s: SetObs; v: number } | null = null;
    for (const s of sets) {
      const v = value(s);
      if (v === null || !Number.isFinite(v)) continue;
      // Empate: fica a série com mais carga, depois com mais repetições (descrição mais completa da marca).
      if (!best || v > best.v || (v === best.v && ((s.load ?? 0) > (best.s.load ?? 0) || ((s.load ?? 0) === (best.s.load ?? 0) && s.reps > best.s.reps)))) best = { s, v };
    }
    return best ? { value: best.v, load: best.s.load, reps: best.s.reps, ...(best.s.side ? { side: best.s.side } : {}) } : null;
  };
  // Assistência nunca é carga e nunca se compara com séries só com o corpo.
  const sets = point.setObs.filter((s) => s.assistanceKg === undefined && sideOk(s));
  switch (goal.type) {
    case 'max_load':
      return bestOf(sets, (s) => s.load);
    case 'e1rm':
      return bestOf(sets, (s) => (s.load === null ? null : canonicalE1rmKg(s.load, s.reps)));
    case 'reps': {
      const min = goal.params.minLoadKg;
      return bestOf(sets, (s) => (min === undefined || (s.load !== null && reached(s.load, min)) ? s.reps : null));
    }
    case 'duration': {
      // Exercício por tempo: maior duração de uma série. Cardio: duração somada da sessão.
      const v = goal.exercise?.modality === 'cardio' ? point.cardio?.durationSec : point.bestDurationSec;
      return typeof v === 'number' && v > 0 ? { value: v } : null;
    }
    case 'distance': {
      const v = point.cardio?.distanceM;
      return typeof v === 'number' && v > 0 ? { value: v } : null;
    }
    default:
      return null;
  }
}

/**
 * Medidas da meta em cada sessão com o exercício (todo o histórico, em ordem cronológica). As contagens de sessões
 * incompatíveis e substituídas consideram só as sessões a partir de `countFrom`.
 */
export type MeasuredGoal = Pick<TrainingGoal, 'type' | 'params' | 'exercise' | 'startDate'>;

export function goalMeasurements(goal: MeasuredGoal, list: readonly WorkoutSession[], countFrom = goal.startDate): { values: GoalEvidence[]; incompatible: number; substituted: number } {
  const ref = goal.exercise;
  const values: GoalEvidence[] = [];
  let incompatibleSessions = 0;
  let substitutedSessions = 0;
  if (!ref) return { values, incompatible: 0, substituted: 0 };
  for (const s of list) {
    const matched = [];
    let incompatible = false;
    let substituted = false;
    for (const ex of s.exercises ?? []) {
      const m = goalExerciseMatch(ref, ex);
      if (m === 'match') matched.push({ ...ex, exerciseKey: 'meta' });
      else if (m === 'incompatible') incompatible = true;
      else if (m === 'substituted') substituted = true;
    }
    const d = localDate(s.startedAt);
    if (d >= countFrom) {
      if (incompatible) incompatibleSessions++;
      if (substituted) substitutedSessions++;
    }
    if (!matched.length) continue;
    // Mesmas regras de validade do analytics: só séries concluídas, sem aquecimento, com medidas válidas.
    const obs = normalizeSessions([{ ...s, exercises: matched }]).sessions[0];
    const exObs = obs?.exercises[0];
    if (!obs || !exObs) continue;
    const v = sessionGoalValue(goal, exercisePoint(obs, exObs));
    if (v) values.push({ sessionId: s.id, ts: s.startedAt, date: d, ...v });
  }
  return { values, incompatible: incompatibleSessions, substituted: substitutedSessions };
}

/** Melhor medida (empate: a mais antiga). */
export const bestMeasurement = (xs: readonly GoalEvidence[]) => xs.reduce<GoalEvidence | null>((b, x) => (!b || x.value > b.value + EPS ? x : b), null);

function recordProgress(goal: TrainingGoal, list: WorkoutSession[], today: string, base: Base, duplicates: number): GoalProgress {
  const { values, incompatible, substituted } = goalMeasurements(goal, list);
  const before = values.filter((v) => v.date < goal.startDate);
  const since = values.filter((v) => v.date >= goal.startDate);
  const quality: GoalDataQuality = { matchedSessions: since.length, incompatibleSessions: incompatible, substitutedSessions: substituted, duplicateSessions: duplicates };
  const current = bestMeasurement(since);
  const evidenceIdx = values.findIndex((v) => v.date >= goal.startDate && reached(v.value, goal.targetValue));
  const evidence = evidenceIdx >= 0 ? values[evidenceIdx] : null;
  const prior = evidenceIdx > 0 ? bestMeasurement(values.slice(0, evidenceIdx)) : null;
  const deadlinePassed = !!goal.targetDate && today > goal.targetDate;
  const progress = {
    ...base,
    baseline: bestMeasurement(before),
    current: current?.value ?? null,
    fraction: clamp01((current?.value ?? 0) / goal.targetValue),
    hasData: since.length > 0,
    achieved: !!evidence,
    achievedAt: evidence?.date ?? null,
    evidence,
    achievedAfterDeadline: !!evidence && !!goal.targetDate && evidence.date > goal.targetDate,
    personalRecord: !!evidence && !!prior && evidence.value > prior.value + EPS,
    deadline: goal.targetDate,
    deadlinePassed,
    quality,
  };
  return { ...progress, displayState: displayStateOf(goal, progress, false) };
}
