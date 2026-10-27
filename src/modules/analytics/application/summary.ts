// Resumo agregado para uso FUTURO pelo assistente de IA (ver docs/ANALYTICS_TREINAMENTO.md, seção 14).
// Só indicadores agregados: sem IDs, sem perfil, sem fotos, sem datas exatas, sem histórico de sessões.
// Nada aqui envia dados: o assistente não usa este resumo até existir uma categoria de consentimento
// própria com prévia (o ContextBuilder do módulo de IA não o conhece).
import type { Insight, TrainingReport } from '../domain/types';

export const ANALYTICS_SUMMARY_SCHEMA = 'irontrack.analytics-summary.v1';
/** Máximo de exercícios e de grupos musculares no resumo. */
export const SUMMARY_MAX_EXERCISES = 10;
export const SUMMARY_MAX_GROUPS = 8;

export interface TrainingAnalyticsSummary {
  schema: typeof ANALYTICS_SUMMARY_SCHEMA;
  period: TrainingReport['period'];
  periodDays: number;
  coveredDays: number;
  sessions: number;
  distinctDays: number;
  weeklyAverage: number | null;
  activeWeeks: number;
  weeks: number;
  regularity: TrainingReport['consistency']['regularity'];
  sets: number;
  loadedSets: number;
  unloadedSets: number;
  volumeKg: number;
  comparison: { sessionsPct: number | null; setsPct: number | null; volumePct: number | null } | null;
  muscleGroups: { group: string; sets: number }[];
  exercises: {
    name: string;
    sessions: number;
    sets: number;
    trend: string;
    trendMetric: string;
    changePct: number | null;
    confidence: string | null;
    periodMaxLoadKg: number | null;
    newLoadRecord: boolean;
  }[];
  insights: { type: Insight['type']; title: string }[];
}

const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export function toAnalyticsSummary(report: TrainingReport, insights: readonly Insight[] = []): TrainingAnalyticsSummary {
  const c = report.comparison;
  return {
    schema: ANALYTICS_SUMMARY_SCHEMA,
    period: report.period,
    periodDays: report.range.days,
    coveredDays: report.covered?.days ?? 0,
    sessions: report.totals.sessions,
    distinctDays: report.totals.distinctDays,
    weeklyAverage: r1(report.frequency.weeklyAverage),
    activeWeeks: report.frequency.activeWeeks,
    weeks: report.frequency.weeks,
    regularity: report.consistency.regularity,
    sets: report.totals.sets,
    loadedSets: report.totals.loadedSets,
    unloadedSets: report.totals.unloadedSets,
    volumeKg: Math.round(report.totals.volume),
    comparison: c.available ? { sessionsPct: r1(c.sessions?.pct ?? null), setsPct: r1(c.sets?.pct ?? null), volumePct: r1(c.volume?.pct ?? null) } : null,
    muscleGroups: report.muscleGroups.slice(0, SUMMARY_MAX_GROUPS).map((g) => ({ group: g.group, sets: g.sets })),
    exercises: report.exercises.slice(0, SUMMARY_MAX_EXERCISES).map((e) => ({
      name: e.name,
      sessions: e.sessions,
      sets: e.sets,
      trend: e.trend.direction,
      trendMetric: e.trend.metric,
      changePct: r1(e.trend.changePct),
      confidence: e.trend.confidence,
      periodMaxLoadKg: e.periodBest.maxLoad?.value ?? null,
      newLoadRecord: e.newLoadRecordInPeriod !== null,
    })),
    insights: insights.map((i) => ({ type: i.type, title: i.title })),
  };
}
