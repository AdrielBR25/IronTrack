// Séries dos gráficos de evolução por modalidade (P19). Um ponto por sessão, na data real da sessão, sem valores
// inventados: sessão sem a medida não vira zero, simplesmente não tem ponto. Pausas longas são marcadas para o gráfico
// interromper a linha.
import { TREND_LONG_GAP_DAYS } from '@/modules/analytics';
import { dayNum } from './periods';
import type { ChartMetric, ChartSeries, MeasureFamily, PerfObservation, RecordUnit } from './types';

/** Intervalo (dias) a partir do qual o gráfico mostra a lacuna em vez de ligar os pontos (mesmo limiar do P09). */
export const CHART_GAP_DAYS = TREND_LONG_GAP_DAYS;

export const CHART_METRICS: Record<MeasureFamily, ChartMetric[]> = {
  carga: ['carga', 'repeticoes', 'volume', 'e1rm'],
  corporal: ['repeticoes_corporal', 'carga_adicional', 'assistencia', 'duracao'],
  tempo: ['duracao'],
  cardio: ['distancia', 'duracao_cardio', 'ritmo'],
};

export const CHART_METRIC_LABEL: Record<ChartMetric, string> = {
  carga: 'Carga máxima',
  repeticoes: 'Repetições (melhor série)',
  volume: 'Volume da sessão',
  e1rm: '1RM estimado',
  repeticoes_corporal: 'Repetições só com o corpo',
  carga_adicional: 'Carga adicional',
  assistencia: 'Assistência',
  duracao: 'Duração (melhor série)',
  distancia: 'Distância',
  duracao_cardio: 'Duração',
  ritmo: 'Ritmo',
};

export const CHART_METRIC_UNIT: Record<ChartMetric, RecordUnit> = {
  carga: 'kg',
  repeticoes: 'repeticoes',
  volume: 'kg',
  e1rm: 'kg',
  repeticoes_corporal: 'repeticoes',
  carga_adicional: 'kg',
  assistencia: 'kg',
  duracao: 'segundos',
  distancia: 'metros',
  duracao_cardio: 'segundos',
  ritmo: 'seg_por_km',
};

/** Métricas em que um valor menor representa a condição mais difícil ou mais rápida. */
export const LOWER_IS_BETTER: ReadonlySet<ChartMetric> = new Set(['assistencia', 'ritmo']);

export const metricValue = (o: PerfObservation, metric: ChartMetric): number | null => {
  const m = o.metrics;
  switch (metric) {
    case 'carga':
      return m.topLoadKg;
    case 'repeticoes':
      return m.bestReps;
    case 'volume':
      return m.volumeKg;
    case 'e1rm':
      return m.e1rm?.valueKg ?? null;
    case 'repeticoes_corporal':
      return m.bodyOnlyBestReps;
    case 'carga_adicional':
      return m.addedLoadKg;
    case 'assistencia':
      return m.minAssistanceKg;
    case 'duracao':
      return m.bestDurationSec;
    case 'distancia':
      return m.distanceM;
    case 'duracao_cardio':
      return m.cardioDurationSec;
    case 'ritmo':
      return m.paceSecPerKm;
  }
};

export function buildSeries(obs: readonly PerfObservation[], metric: ChartMetric): ChartSeries {
  const points: ChartSeries['points'] = [];
  for (const o of obs) {
    const v = metricValue(o, metric);
    if (v === null || !Number.isFinite(v)) continue;
    const prev = points[points.length - 1];
    const gapDays = prev ? dayNum(o.date) - dayNum(prev.date) : null;
    points.push({ ts: o.ts, date: o.date, sessionId: o.sessionId, value: v, gapDays, gapBefore: gapDays !== null && gapDays > CHART_GAP_DAYS });
  }
  return { metric, unit: CHART_METRIC_UNIT[metric], lowerIsBetter: LOWER_IS_BETTER.has(metric), points };
}

/** Métricas da família com pelo menos um ponto (as demais não aparecem no seletor). */
export function availableMetrics(family: MeasureFamily, obs: readonly PerfObservation[]): ChartMetric[] {
  return CHART_METRICS[family].filter((m) => obs.some((o) => metricValue(o, m) !== null));
}
