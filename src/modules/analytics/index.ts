// API pública do motor de análise de treinos (IronTrack 2.0 F01/P08). Ver docs/ANALYTICS_TREINAMENTO.md.
// Puro e determinístico: sem React, sem Dexie, sem rede, sem IA, sem gravação. Recebe as sessões já lidas
// (WorkoutSession do domínio de treinamento) e devolve relatórios, insights e um resumo agregado.
// Fora deste diretório, importe sempre por '@/modules/analytics'.
export type * from './domain/types';
export { PERIOD_DAYS, PERIOD_KEYS, resolvePeriod, previousRange, weekStart, localDate } from './domain/periods';
export {
  E1RM_MAX_REPS,
  MIN_PRIOR_SESSIONS_FOR_RECORD,
  REGULARITY_MIN_WEEKS,
  REGULARITY_STABLE_CV,
  REGULARITY_VARIABLE_CV,
  WEEKLY_BUCKET_MAX_DAYS,
  repBand,
  normalizeSessions,
  computeExerciseRecords,
  downsampleMax,
  type ExerciseHistory,
} from './domain/metrics';
export { TREND_MIN_POINTS, TREND_MIN_SPAN_DAYS, TREND_BASE_THRESHOLD_PCT, TREND_NOISE_SE, TREND_LONG_GAP_DAYS, computeTrend } from './domain/trends';
// P09: normalização muscular, classificação, contrato canônico de 1RM e cálculos puros por modalidade.
export { MUSCLE_LABEL, foldMuscleText, normalizeMuscleGroup, createMuscleNormalizer, type MuscleGroupId, type MuscleMatch, type NormalizedMuscle } from './domain/muscles';
export {
  classifyExercise,
  supportsLoadMetrics,
  type ClassificationInput,
  type ExerciseClassification,
  type ExerciseModality,
  type ExplicitExerciseAttributes,
  type Laterality,
  type LoadKind,
} from './domain/classification';
export {
  E1RM_METHOD,
  E1RM_METHOD_ID,
  E1RM_MIN_REPS,
  E1RM_RANGE_MAX_REPS,
  KG_PER_LB,
  canonicalE1rm,
  canonicalE1rmKg,
  compareWithLegacyChart,
  fromKg,
  legacyChartE1rm,
  sameMethodOnly,
  toKg,
  type E1rmComparison,
  type E1rmMethod,
  type E1rmMethodId,
  type E1rmRejection,
  type E1rmResult,
  type LoadUnit,
} from './domain/oneRepMax';
export {
  METERS_PER_MILE,
  bodyweightMetrics,
  bodyweightSetKind,
  cardioMetrics,
  compareSides,
  timedMetrics,
  toMeters,
  type BodyweightMetrics,
  type BodyweightSetKind,
  type BodyweightSetObs,
  type CardioEntry,
  type CardioMetrics,
  type CardioPoint,
  type DistanceUnit,
  type Side,
  type SideComparison,
  type SidedSetObs,
  type SideStats,
  type TimedMetrics,
  type TimedSessionObs,
} from './domain/modalities';
export { muscleDistributionOf, trendFor, classifyHistory } from './domain/metrics';
// P12: medida de um exercício numa sessão, reutilizada pelo motor de metas (mesmas regras de validade dos gráficos).
export { exercisePoint } from './domain/metrics';
export {
  INDICATOR_GUIDE,
  UNAVAILABLE_ANALYSIS_TEXT,
  LOAD_KIND_LABEL,
  exerciseAnalyses,
  type AnalysisAvailability,
  type AnalysisKind,
  type IndicatorGuide,
} from './application/indicators';
export { createTrainingAnalytics, analyzeTraining, MAX_CHART_POINTS, type TrainingAnalytics, type ExerciseCatalogItem } from './application/TrainingAnalyticsService';
export { buildInsights, VOLUME_SIMILAR_PCT, MAX_PER_KIND } from './application/InsightsEngine';
export { toAnalyticsSummary, ANALYTICS_SUMMARY_SCHEMA, type TrainingAnalyticsSummary } from './application/summary';
