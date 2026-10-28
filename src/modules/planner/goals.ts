// Metas semanais no painel de planejamento (IronTrack 2.0 F01/P13, docs/PLANEJAMENTO_SEMANAL.md §6).
// Nenhuma fórmula nova: o progresso vem do motor de metas do P12 (`computeGoalProgress`), e o painel só escolhe a
// semana exibida e as anteriores. Descanso planejado não entra em nenhum cálculo de meta.
import { computeGoalProgress, type TrainingGoal, type WeekEvaluation } from '@/modules/goals';
import type { WorkoutSession } from '@/modules/training';
import { weekOf } from './calendar';

export interface WeeklyGoalView {
  goal: TrainingGoal;
  /** Avaliação da semana exibida pelo motor de metas; null se a meta não vigorava nela ou se a semana é futura. */
  week: WeekEvaluation | null;
  /** Até 4 semanas anteriores à exibida (mais antiga primeiro), como o motor de metas as avaliou. */
  history: WeekEvaluation[];
  /** Estado de exibição da meta hoje (ativa, pausada, prazo encerrado…). */
  displayState: ReturnType<typeof computeGoalProgress>['displayState'];
}

export function weeklyGoalsForWeek(goals: readonly TrainingGoal[], sessions: readonly WorkoutSession[], week: string, today: string): WeeklyGoalView[] {
  const monday = weekOf(week);
  return goals
    .filter((g) => g.type === 'weekly_frequency' && g.status !== 'archived')
    .map((goal) => {
      const p = computeGoalProgress(goal, sessions, today);
      const weeks = p.weekly?.weeks ?? [];
      return {
        goal,
        week: weeks.find((w) => w.week === monday) ?? null,
        history: weeks.filter((w) => w.week < monday).slice(-4),
        displayState: p.displayState,
      };
    });
}
