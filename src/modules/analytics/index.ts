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
export { TREND_MIN_POINTS, TREND_MIN_SPAN_DAYS, TREND_BASE_THRESHOLD_PCT, TREND_NOISE_SE, computeTrend } from './domain/trends';
export { createTrainingAnalytics, analyzeTraining, MAX_CHART_POINTS, type TrainingAnalytics, type ExerciseCatalogItem } from './application/TrainingAnalyticsService';
export { buildInsights, VOLUME_SIMILAR_PCT, MAX_PER_KIND } from './application/InsightsEngine';
export { toAnalyticsSummary, ANALYTICS_SUMMARY_SCHEMA, type TrainingAnalyticsSummary } from './application/summary';
