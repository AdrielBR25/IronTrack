// Serviço de aplicação das metas (IronTrack 2.0 F01/P12): avalia todas as metas de uma vez, resume a visão geral,
// oferece referências reais do histórico ao formulário e liga metas aos indicadores da página de desempenho.
// Puro: recebe metas, sessões e o dia de hoje; não grava, não acessa rede e não usa IA.
import { addDays } from '@/lib/dates';
import { localDate, weekStart } from '@/modules/analytics';
import type { WorkoutSession } from '@/modules/training';
import { deriveAchievements, type Achievement } from './achievements';
import { goalExerciseMatch } from './exercises';
import { bestMeasurement, computeGoalProgress, countableSessions, goalMeasurements, type GoalEvidence, type GoalProgress } from './progress';
import type { GoalExerciseRef, GoalParams, GoalType, TrainingGoal } from './types';

export interface GoalEvaluation {
  goal: TrainingGoal;
  progress: GoalProgress;
}

export interface GoalsOverview {
  evaluations: GoalEvaluation[];
  /** Ativas ou pausadas ainda não atingidas (frequência semanal fica sempre aqui enquanto vigente). */
  inProgress: GoalEvaluation[];
  achieved: GoalEvaluation[];
  archived: GoalEvaluation[];
  /** Prazos de hoje em diante das metas não atingidas e não arquivadas, do mais próximo ao mais distante. */
  upcomingDeadlines: GoalEvaluation[];
  achievements: Achievement[];
  counts: { active: number; paused: number; achieved: number; archived: number };
}

const byCreation = (a: GoalEvaluation, b: GoalEvaluation) => b.goal.createdAt - a.goal.createdAt || a.goal.id.localeCompare(b.goal.id);

export function evaluateGoals(goals: readonly TrainingGoal[], sessions: readonly WorkoutSession[], today: string): GoalEvaluation[] {
  return goals.map((goal) => ({ goal, progress: computeGoalProgress(goal, sessions, today) }));
}

export function goalsOverview(goals: readonly TrainingGoal[], sessions: readonly WorkoutSession[], today: string): GoalsOverview {
  const evaluations = evaluateGoals(goals, sessions, today).sort(byCreation);
  const archived = evaluations.filter((e) => e.goal.status === 'archived');
  const live = evaluations.filter((e) => e.goal.status !== 'archived');
  const isDone = (e: GoalEvaluation) => e.goal.period !== 'semanal' && e.progress.achieved;
  const achieved = live.filter(isDone);
  const inProgress = live.filter((e) => !isDone(e));
  const upcomingDeadlines = inProgress
    .filter((e) => e.progress.deadline !== null && e.progress.deadline >= today && e.goal.status === 'active')
    .sort((a, b) => a.progress.deadline!.localeCompare(b.progress.deadline!) || byCreation(a, b));
  return {
    evaluations,
    inProgress,
    achieved,
    archived,
    upcomingDeadlines,
    achievements: deriveAchievements(evaluations),
    counts: {
      active: live.filter((e) => e.goal.status === 'active').length,
      paused: live.filter((e) => e.goal.status === 'paused').length,
      achieved: evaluations.filter(isDone).length,
      archived: archived.length,
    },
  };
}

/** Referência real do histórico para o formulário (nunca uma sugestão de valor). */
export interface HistoryReference {
  /** Melhor marca já registrada para o exercício e o tipo (metas por exercício). */
  best: GoalEvidence | null;
  /** Sessões nas últimas semanas completas (frequência semanal), da mais antiga à mais recente. */
  recentWeeks: { week: string; count: number }[];
  /** Sessões concluídas nos últimos N dias (quantidade de sessões), N = janela informada. */
  recentWindow: { days: number; count: number } | null;
}

export function historyReference(
  input: { type: GoalType; exercise: GoalExerciseRef | null; params: GoalParams; profileId?: string },
  sessions: readonly WorkoutSession[],
  today: string,
): HistoryReference {
  const { list } = countableSessions(sessions, input.profileId);
  const out: HistoryReference = { best: null, recentWeeks: [], recentWindow: null };
  if (input.type === 'weekly_frequency') {
    const thisWeek = weekStart(today);
    for (let i = 4; i >= 1; i--) {
      const w = addDays(thisWeek, -7 * i);
      const end = addDays(w, 6);
      out.recentWeeks.push({ week: w, count: list.filter((s) => {
        const d = localDate(s.startedAt);
        return d >= w && d <= end;
      }).length });
    }
    return out;
  }
  if (input.type === 'session_count') {
    const days = input.params.windowDays;
    if (days && days > 0) {
      const from = addDays(today, -(days - 1));
      out.recentWindow = { days, count: list.filter((s) => localDate(s.startedAt) >= from && localDate(s.startedAt) <= today).length };
    }
    return out;
  }
  if (!input.exercise) return out;
  out.best = bestMeasurement(goalMeasurements({ type: input.type, exercise: input.exercise, params: input.params, startDate: '0001-01-01' }, list).values);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Integração com a página de desempenho (analytics)

/** Métrica do gráfico por exercício que corresponde a cada tipo de meta (mesmos nomes da página de desempenho). */
export const GOAL_CHART_METRIC: Partial<Record<GoalType, 'topLoad' | 'e1rm' | 'bestReps' | 'duration' | 'distance'>> = {
  max_load: 'topLoad',
  e1rm: 'e1rm',
  reps: 'bestReps',
  duration: 'duration',
  distance: 'distance',
};

/**
 * Chaves de exercício do analytics (`exerciseKey`) em que a meta tem registros associados pelo ID da ficha.
 * Nunca usa o nome da meta: sem registros associados, a meta não aparece em nenhum gráfico.
 */
export function goalExerciseKeys(goal: TrainingGoal, sessions: readonly WorkoutSession[]): Set<string> {
  const keys = new Set<string>();
  if (!goal.exercise) return keys;
  for (const s of sessions) {
    if (s?.status !== 'completed') continue;
    if (goal.profileId && s.profileId && s.profileId !== goal.profileId) continue;
    for (const ex of s.exercises ?? []) if (goalExerciseMatch(goal.exercise, ex) === 'match' && ex.exerciseKey) keys.add(ex.exerciseKey);
  }
  return keys;
}

/** Metas não arquivadas ligadas a um exercício da página de desempenho. */
export function relatedGoalsForExercise(evaluations: readonly GoalEvaluation[], sessions: readonly WorkoutSession[], exerciseKey: string): GoalEvaluation[] {
  return evaluations.filter((e) => e.goal.status !== 'archived' && e.goal.exercise && goalExerciseKeys(e.goal, sessions).has(exerciseKey));
}

/** Metas de frequência semanal não arquivadas (resumo semanal da página de desempenho). */
export const weeklyFrequencyGoals = (evaluations: readonly GoalEvaluation[]) => evaluations.filter((e) => e.goal.type === 'weekly_frequency' && e.goal.status !== 'archived');
