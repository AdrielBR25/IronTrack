import type { BodyEntry } from './types';

// Leitura da evolução corporal entre avaliações: qual direção é "boa" para cada
// medida e um resumo em frase simples. Tudo aqui é estimativa (dobras/bioimpedância).

export type BodyMetricKey =
  | 'weightKg'
  | 'bodyFatPct'
  | 'fatMassKg'
  | 'leanMassKg'
  | 'leanPct'
  | 'skinfoldSumMm'
  | 'waistCm'
  | 'abdomenCm'
  | 'hipCm'
  | 'armCm'
  | 'thighCm'
  | 'waistHipRatio'
  | 'bmi'
  | 'armMuscleArea'
  | 'armFatArea';

/** down = cair é bom; up = subir é bom; neutral = depende do objetivo */
export type GoodDirection = 'down' | 'up' | 'neutral';

export interface BodyMetric {
  key: BodyMetricKey;
  label: string;
  short: string;
  unit: string;
  digits: 0 | 1 | 2;
  good: GoodDirection;
  group: 'Composição' | 'Circunferências' | 'Índices';
}

export const BODY_METRICS: BodyMetric[] = [
  { key: 'weightKg', label: 'Peso corporal', short: 'Peso', unit: 'kg', digits: 1, good: 'neutral', group: 'Composição' },
  { key: 'bodyFatPct', label: '% gordura (estimado)', short: '% gordura', unit: '%', digits: 1, good: 'down', group: 'Composição' },
  { key: 'fatMassKg', label: 'Massa gorda', short: 'Massa gorda', unit: 'kg', digits: 1, good: 'down', group: 'Composição' },
  { key: 'leanMassKg', label: 'Massa magra', short: 'Massa magra', unit: 'kg', digits: 1, good: 'up', group: 'Composição' },
  { key: 'leanPct', label: '% massa magra', short: '% magra', unit: '%', digits: 1, good: 'up', group: 'Composição' },
  { key: 'skinfoldSumMm', label: 'Soma de dobras', short: 'Soma de dobras', unit: 'mm', digits: 1, good: 'down', group: 'Composição' },
  { key: 'waistCm', label: 'Cintura', short: 'Cintura', unit: 'cm', digits: 1, good: 'down', group: 'Circunferências' },
  { key: 'abdomenCm', label: 'Abdômen', short: 'Abdômen', unit: 'cm', digits: 1, good: 'down', group: 'Circunferências' },
  { key: 'hipCm', label: 'Quadril', short: 'Quadril', unit: 'cm', digits: 1, good: 'neutral', group: 'Circunferências' },
  { key: 'armCm', label: 'Braço', short: 'Braço', unit: 'cm', digits: 1, good: 'neutral', group: 'Circunferências' },
  { key: 'thighCm', label: 'Coxa', short: 'Coxa', unit: 'cm', digits: 1, good: 'neutral', group: 'Circunferências' },
  { key: 'waistHipRatio', label: 'Razão cintura/quadril', short: 'Cintura/quadril', unit: '', digits: 2, good: 'down', group: 'Índices' },
  { key: 'bmi', label: 'IMC', short: 'IMC', unit: '', digits: 1, good: 'neutral', group: 'Índices' },
  { key: 'armMuscleArea', label: 'Área muscular do braço (AMB)', short: 'AMB', unit: 'cm²', digits: 1, good: 'up', group: 'Índices' },
  { key: 'armFatArea', label: 'Área de gordura do braço (AGB)', short: 'AGB', unit: 'cm²', digits: 1, good: 'down', group: 'Índices' },
];

export const metricByKey = (k: BodyMetricKey) => BODY_METRICS.find((m) => m.key === k)!;

export type Verdict = 'better' | 'worse' | 'same' | 'neutral';

export function verdict(good: GoodDirection, delta: number, eps = 0.05): Verdict {
  if (Math.abs(delta) < eps) return 'same';
  if (good === 'neutral') return 'neutral';
  return (delta < 0) === (good === 'down') ? 'better' : 'worse';
}

export interface MetricChange {
  metric: BodyMetric;
  first: number;
  last: number;
  delta: number;
  /** variação desde a avaliação anterior */
  lastStep: number | null;
  verdict: Verdict;
  series: { date: string; v: number }[];
}

/** Variação de cada medida da primeira à última avaliação em que ela aparece. */
export function metricChanges(entries: BodyEntry[]): MetricChange[] {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const out: MetricChange[] = [];
  for (const metric of BODY_METRICS) {
    const series = sorted.filter((e) => typeof e[metric.key] === 'number').map((e) => ({ date: e.date, v: e[metric.key] as number }));
    if (series.length < 2) continue;
    const first = series[0].v;
    const last = series[series.length - 1].v;
    const delta = last - first;
    out.push({
      metric,
      first,
      last,
      delta,
      lastStep: last - series[series.length - 2].v,
      verdict: verdict(metric.good, delta, metric.digits === 2 ? 0.005 : 0.05),
      series,
    });
  }
  return out;
}

export interface SkinfoldChange {
  site: string;
  first: number;
  last: number;
  delta: number;
}

/** Variação de cada dobra cutânea (mm) entre a primeira e a última avaliação que a mediram. */
export function skinfoldChanges(entries: BodyEntry[]): SkinfoldChange[] {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date)).filter((e) => e.skinfolds);
  const sites = new Set(sorted.flatMap((e) => Object.keys(e.skinfolds!)));
  const out: SkinfoldChange[] = [];
  for (const site of sites) {
    const vals = sorted.map((e) => e.skinfolds![site]).filter((v): v is number => typeof v === 'number');
    if (vals.length < 2) continue;
    out.push({ site, first: vals[0], last: vals[vals.length - 1], delta: vals[vals.length - 1] - vals[0] });
  }
  return out.sort((a, b) => a.delta - b.delta);
}

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const abs = (n: number) => nf.format(Math.abs(n));

/** Frase-resumo da evolução, priorizando composição corporal. */
export function evolutionSummary(changes: MetricChange[]): string | null {
  const get = (k: BodyMetricKey) => changes.find((c) => c.metric.key === k);
  const fat = get('fatMassKg');
  const lean = get('leanMassKg');
  const pct = get('bodyFatPct');
  const waist = get('waistCm');
  const parts: string[] = [];
  if (fat && lean) {
    if (fat.delta < -0.05 && lean.delta > 0.05) parts.push(`Você perdeu ${abs(fat.delta)} kg de gordura e ganhou ${abs(lean.delta)} kg de massa magra (estimativas)`);
    else
      parts.push(
        `Massa gorda ${fat.delta <= 0 ? 'caiu' : 'subiu'} ${abs(fat.delta)} kg e massa magra ${lean.delta >= 0 ? 'subiu' : 'caiu'} ${abs(lean.delta)} kg (estimativas)`,
      );
  } else if (pct) {
    parts.push(`Seu % de gordura estimado ${pct.delta <= 0 ? 'caiu' : 'subiu'} ${abs(pct.delta)} pontos`);
  }
  if (pct && fat && lean) parts.push(`o % de gordura foi de ${nf.format(pct.first)}% para ${nf.format(pct.last)}%`);
  if (waist && Math.abs(waist.delta) >= 0.5) parts.push(`a cintura ${waist.delta < 0 ? 'diminuiu' : 'aumentou'} ${abs(waist.delta)} cm`);
  if (!parts.length) return null;
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}
