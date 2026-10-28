// API pública do planejamento semanal (IronTrack 2.0 F01/P13). Ver docs/PLANEJAMENTO_SEMANAL.md.
// Domínio puro: sem React, sem Dexie, sem rede e sem IA. Lê treinos pela API pública do treinamento, conta sessões
// com as mesmas regras das metas e usa o calendário do analytics. Nunca grava em sessões, rotinas ou rotação.
// Fora deste diretório, importe sempre por '@/modules/planner'.
export type * from './types';
export { isPlanDate, planAddDays, planWeekday, weekOf, weekDates, shiftWeek, sessionDay, WEEKDAY_ORDER } from './calendar';
export { PLAN_SCOPES, PLAN_KINDS, planEntryIssues, isValidPlanEntry, type PlanIssue } from './validation';
export {
  PlanConflictError,
  planForDate,
  currentWeekly,
  slotEntries,
  slotFingerprint,
  sameActivity,
  addActivity,
  setMarker,
  updateActivity,
  removeEntry,
  clearException,
  type PlanConflictKind,
  type PlanContext,
  type PlanChanges,
  type DatePlan,
  type AddActivityInput,
  type SetMarkerInput,
  type UpdateActivityInput,
  type RemoveEntryInput,
} from './operations';
export {
  DAY_STATE_LABEL,
  ACTIVITY_STATUS_LABEL,
  buildWeek,
  matchDay,
  compareWeeks,
  type DayState,
  type ActivityStatus,
  type Availability,
  type PlannedActivity,
  type DaySession,
  type DayView,
  type WeekConsistency,
  type WeekView,
  type WeekComparison,
  type BuildWeekInput,
} from './week';
export { weeklyGoalsForWeek, type WeeklyGoalView } from './goals';
