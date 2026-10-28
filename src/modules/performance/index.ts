// API pública do desempenho por exercício (IronTrack 2.0 F01/P19). Ver docs/DESEMPENHO_EXERCICIOS.md.
// Puro e determinístico: sem React, sem Dexie, sem rede, sem IA, sem gravação. Lê sessões já carregadas e devolve
// identidades, observações, recordes, séries de gráfico, comparações e observações de tendência.
// Fora deste diretório, importe sempre por '@/modules/performance'.
export type * from './types';
export {
  AGGREGATE_NOTICE,
  IDENTITY_KIND_LABEL,
  identityKey,
  identityPath,
  measureFamilyOf,
  parseIdentityKey,
  resolveIdentity,
  stableHash,
  type ResolvedIdentity,
} from './identity';
export { classifySets, metricsOf, observationOf } from './observations';
export { MIN_PRIOR_SESSIONS_FOR_RECORD, PACE_BANDS, PACE_BAND_LABEL, RECORD_LABEL, RECORD_SPECS, computeRecords, paceBand } from './records';
export { PERF_PERIOD_DAYS, PERF_PERIOD_KEYS, PERF_PERIOD_LABEL, isPerfPeriodKey, perfRange, inPerfRange, type PerfPeriodKey } from './periods';
export { CHART_GAP_DAYS, CHART_METRICS, CHART_METRIC_LABEL, CHART_METRIC_UNIT, LOWER_IS_BETTER, availableMetrics, buildSeries, metricValue } from './series';
export {
  PROGRESSION_STREAK,
  RECENT_WINDOW,
  STABILITY_MIN_SESSIONS,
  STABILITY_MIN_SPAN_DAYS,
  SUGGESTION_NOTICE,
  observationsFor,
  perfTrend,
  stabilityOf,
  suggestionsFor,
  trendMetricFor,
} from './insights';
export { ISSUE_LABEL, compareSessions, compareSets, compatibilityIssues } from './compare';
export {
  buildPerformanceIndex,
  isAggregate,
  isCountedSession,
  performanceOverview,
  primaryKeyOf,
  type BuildOptions,
  type PerformanceOverview,
  type PeriodRecordEvent,
  type TrackedRow,
  type TrackedStatus,
} from './engine';
