// API pública do calendário unificado (IronTrack 2.0 F01/P14). Ver docs/CALENDARIO_UNIFICADO.md.
// Domínio puro: sem React, sem Dexie, sem rede, sem relógio e sem IA. Combina, só para EXIBIR, as sessões reais, o
// planejamento semanal (P13), a agenda anterior (dias de treino + reagendamentos) e o ponteiro da rotação. Nunca
// grava, nunca avança a rotação, nunca cria sessões. Fora deste diretório, importe sempre por '@/modules/calendar'.
export type * from './types';
export { FORECAST_HORIZON_DAYS, LEGACY_PROJECTION_LIMIT, daysBetween, interpretLegacy } from './legacy';
export { forecastRotation, rotationPointer, type ForecastInput } from './forecast';
export { detectConflicts, legacyText, workoutText, type ConflictInput } from './conflicts';
export {
  CERTAINTY_LABEL,
  DAY_STATUS_LABEL,
  activityText,
  entryText,
  monthBounds,
  monthOf,
  nextActivity,
  primaryEntries,
  resolveDay,
  resolveMonth,
  resolveRange,
  resolveWeek,
  rotationStatus,
  shiftMonth,
  summarize,
} from './resolve';
export { conflictCounts, groupConflicts, type ConflictAction, type ConflictGroup, type ConflictGroupDay } from './conflictCenter';
export { decisionMatches } from './decisionMatch';
export {
  CONFLICT_KIND_LABEL,
  DECISION_LABEL,
  DECISION_STATUS_LABEL,
  decisionRange,
  evaluateDecisions,
  evaluateDecisionsFor,
  isObsolete,
  pendingConflicts,
  pendingWarnings,
  planCleanup,
  planRemember,
  planRemove,
  planShowAgain,
  rememberOption,
  rememberedConflicts,
  type DecisionStatus,
  type DecisionView,
  type RememberRequest,
} from './decisions';
export { fingerprintOf } from './fingerprint';
