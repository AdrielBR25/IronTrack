// Classificação de tendência explicável (ver docs/ANALYTICS_TREINAMENTO.md, seção 8).
// Divide as observações do período em duas metades cronológicas e compara as médias. A mudança só conta
// quando supera o maior entre um limiar mínimo fixo e o ruído natural das próprias sessões, medido como
// dois erros-padrão da diferença entre as médias (quanto mais as sessões oscilam, maior o limiar).
import { dayNumber } from './periods';
import type { Confidence, Trend, TrendMetric } from './types';

/** Mínimo de sessões com a métrica para classificar. Duas sessões isoladas nunca bastam. */
export const TREND_MIN_POINTS = 4;
/** Mínimo de dias entre a primeira e a última observação. */
export const TREND_MIN_SPAN_DAYS = 14;
/** Limiar mínimo de variação (%) por métrica: abaixo dele a mudança é tratada como estabilidade. */
export const TREND_BASE_THRESHOLD_PCT: Record<TrendMetric, number> = { e1rm: 2.5, carga_13: 2.5, reps: 5 };
/** Quantos erros-padrão a diferença entre as médias precisa superar. */
export const TREND_NOISE_SE = 2;

export interface TrendObservation {
  date: string;
  value: number;
}

const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;

/** Variância amostral (n − 1); zero com uma observação. */
function variance(v: readonly number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1);
}

function confidenceFor(points: number, spanDays: number, maxGapDays: number): Confidence {
  if (points >= 8 && spanDays >= 28 && maxGapDays <= 21) return 'alta';
  if (points >= 6 && maxGapDays <= 28) return 'media';
  return 'baixa';
}

export function computeTrend(observations: readonly TrendObservation[], metric: TrendMetric): Trend {
  const obs = observations.filter((o) => Number.isFinite(o.value) && o.value > 0);
  const n = obs.length;
  const days = obs.map((o) => dayNumber(o.date));
  const spanDays = n ? days[n - 1] - days[0] : 0;
  let maxGapDays = 0;
  for (let i = 1; i < n; i++) maxGapDays = Math.max(maxGapDays, days[i] - days[i - 1]);
  const base = { metric, points: n, spanDays, maxGapDays, firstMean: null, lastMean: null, changePct: null, thresholdPct: null, confidence: null };
  if (n === 0) return { ...base, direction: 'insuficiente', reason: 'sem_metrica' };
  if (n < TREND_MIN_POINTS) return { ...base, direction: 'insuficiente', reason: 'poucas_sessoes' };
  if (spanDays < TREND_MIN_SPAN_DAYS) return { ...base, direction: 'insuficiente', reason: 'intervalo_curto' };

  // Metades do mesmo tamanho; com quantidade ímpar, a observação do meio fica de fora.
  const half = Math.floor(n / 2);
  const first = obs.slice(0, half).map((o) => o.value);
  const last = obs.slice(n - half).map((o) => o.value);
  const firstMean = mean(first);
  const lastMean = mean(last);
  const changePct = ((lastMean - firstMean) / firstMean) * 100;
  const se = Math.sqrt(variance(first) / half + variance(last) / half);
  const noisePct = ((TREND_NOISE_SE * se) / firstMean) * 100;
  const thresholdPct = Math.max(TREND_BASE_THRESHOLD_PCT[metric], noisePct);
  const direction = changePct > thresholdPct ? 'positiva' : changePct < -thresholdPct ? 'queda' : 'estavel';
  return { ...base, direction, firstMean, lastMean, changePct, thresholdPct, confidence: confidenceFor(n, spanDays, maxGapDays) };
}
