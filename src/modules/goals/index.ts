// API pública das metas de treinamento (IronTrack 2.0 F01/P12). Ver docs/METAS_TREINAMENTO.md.
// Domínio puro e determinístico: sem React, sem Dexie, sem rede, sem IA e sem gravação em sessões. Usa só as APIs
// públicas do treinamento e do analytics (as medidas vêm dos mesmos contratos dos gráficos).
// Fora deste diretório, importe sempre por '@/modules/goals'.
export type * from './types';
export {
  GOAL_TYPES,
  EXERCISE_GOAL_TYPES,
  GOAL_STATUSES,
  GOAL_UNIT_BY_TYPE,
  GOAL_PERIOD_BY_TYPE,
  GOAL_TYPE_LABEL,
  GOAL_STATUS_LABEL,
  GOAL_LIMITS,
  isGoalDate,
  isExerciseGoal,
  exerciseGoalBlocker,
  targetValueError,
  goalFieldErrors,
  goalIssues,
  isValidGoal,
  cleanGoalFields,
  type GoalFields,
  type GoalField,
  type GoalIssue,
} from './validation';
export { GoalRuleError, newGoal, editGoal, applyGoalAction, GOAL_ACTION_LABEL, type GoalAction, type GoalEdit } from './lifecycle';
export {
  exerciseRefAttributes,
  measureFamily,
  goalExerciseOptions,
  optionsForGoalType,
  goalExerciseAvailability,
  goalExerciseMatch,
  type MeasureFamily,
  type GoalExerciseOption,
  type ExerciseAvailability,
  type ExerciseAvailabilityState,
} from './exercises';
export {
  computeGoalProgress,
  countableSessions,
  sessionGoalValue,
  goalMeasurements,
  bestMeasurement,
  type GoalProgress,
  type GoalEvidence,
  type GoalDisplayState,
  type WeekEvaluation,
  type WeeklyProgress,
  type GoalDataQuality,
  type MeasuredGoal,
} from './progress';
export { deriveAchievements, ACHIEVEMENT_TITLE, type Achievement, type AchievementKind } from './achievements';
export {
  evaluateGoals,
  goalsOverview,
  historyReference,
  GOAL_CHART_METRIC,
  goalExerciseKeys,
  relatedGoalsForExercise,
  weeklyFrequencyGoals,
  type GoalEvaluation,
  type GoalsOverview,
  type HistoryReference,
} from './service';
