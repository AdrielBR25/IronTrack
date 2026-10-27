import type { BodyEntry } from './types';
import type { GoodDirection } from './bodyEvolution';

// Liga cada região do mapa anatômico às medidas que existem para ela
// (circunferências em cm e dobras cutâneas em mm).

export type RegionId = 'chest' | 'arm' | 'side' | 'abs' | 'waist' | 'hip' | 'thigh' | 'calf' | 'triceps' | 'back';

export interface RegionMeasure {
  id: string;
  label: string;
  unit: string;
  kind: 'circ' | 'fold' | 'other';
  good: GoodDirection;
  get: (e: BodyEntry) => number | undefined;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function fold(id: string, label: string, match: RegExp): RegionMeasure {
  return {
    id: `fold:${id}`,
    label: `Dobra ${label}`,
    unit: 'mm',
    kind: 'fold',
    good: 'down',
    get: (e) => {
      if (!e.skinfolds) return undefined;
      const k = Object.keys(e.skinfolds).find((n) => match.test(norm(n)));
      return k ? num(e.skinfolds[k]) : undefined;
    },
  };
}

function field(key: keyof BodyEntry, label: string, unit: string, kind: RegionMeasure['kind'], good: GoodDirection): RegionMeasure {
  return { id: `field:${String(key)}`, label, unit, kind, good, get: (e) => num(e[key]) };
}

export interface Region {
  id: RegionId;
  label: string;
  views: ('front' | 'back')[];
  measures: RegionMeasure[];
}

export const REGIONS: Region[] = [
  { id: 'chest', label: 'Peitoral', views: ['front'], measures: [fold('torax', 'torácica', /^(torax|peitoral)/)] },
  {
    id: 'arm',
    label: 'Braço / bíceps',
    views: ['front'],
    measures: [
      field('armCm', 'Circunferência do braço', 'cm', 'circ', 'neutral'),
      fold('biceps', 'bicipital', /^biceps/),
      field('armMuscleArea', 'Área muscular do braço', 'cm²', 'other', 'up'),
      field('armFatArea', 'Área de gordura do braço', 'cm²', 'other', 'down'),
    ],
  },
  { id: 'side', label: 'Lateral (axilar)', views: ['front'], measures: [fold('axilar', 'axilar média', /^axilar/)] },
  { id: 'abs', label: 'Abdômen', views: ['front'], measures: [field('abdomenCm', 'Circunferência do abdômen', 'cm', 'circ', 'down'), fold('abdominal', 'abdominal', /^abdominal/)] },
  { id: 'waist', label: 'Cintura', views: ['front'], measures: [field('waistCm', 'Circunferência da cintura', 'cm', 'circ', 'down')] },
  { id: 'hip', label: 'Quadril', views: ['front', 'back'], measures: [field('hipCm', 'Circunferência do quadril', 'cm', 'circ', 'neutral'), fold('suprailiaca', 'suprailíaca', /^supra/)] },
  { id: 'thigh', label: 'Coxa', views: ['front', 'back'], measures: [field('thighCm', 'Circunferência da coxa', 'cm', 'circ', 'neutral'), fold('coxa', 'da coxa', /^coxa/)] },
  { id: 'calf', label: 'Panturrilha', views: ['front', 'back'], measures: [fold('panturrilha', 'da panturrilha', /^panturrilha/)] },
  { id: 'triceps', label: 'Tríceps', views: ['back'], measures: [fold('triceps', 'tricipital', /^triceps/), field('armCm', 'Circunferência do braço', 'cm', 'circ', 'neutral')] },
  { id: 'back', label: 'Costas (subescapular)', views: ['back'], measures: [fold('subescapular', 'subescapular', /^subescapular/)] },
];

export const regionById = (id: RegionId) => REGIONS.find((r) => r.id === id)!;

export interface Comparison {
  measure: RegionMeasure;
  before: { date: string; v: number };
  now: { date: string; v: number };
  delta: number;
  series: { date: string; v: number }[];
}

/** Compara a medida entre a avaliação base (primeira ou penúltima) e a mais recente. */
export function compare(entries: BodyEntry[], m: RegionMeasure, base: 'first' | 'previous'): Comparison | null {
  const series = [...entries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({ date: e.date, v: m.get(e) }))
    .filter((p): p is { date: string; v: number } => p.v !== undefined);
  if (series.length < 2) return null;
  const now = series[series.length - 1];
  const before = base === 'first' ? series[0] : series[series.length - 2];
  return { measure: m, before, now, delta: now.v - before.v, series };
}

/** Medidas da região que têm pelo menos 2 registros. */
export function availableMeasures(entries: BodyEntry[], r: Region) {
  return r.measures.filter((m) => entries.filter((e) => m.get(e) !== undefined).length >= 2);
}

/**
 * Escala do contorno "antes" relativa ao "agora" (=1). A diferença é ampliada
 * para ficar visível: circunferências mudam poucos %, dobras mudam muito.
 */
export function beforeScale(c: Comparison): number {
  if (c.now.v <= 0 || c.before.v <= 0) return 1;
  const ratio = c.before.v / c.now.v;
  const k = c.measure.kind === 'circ' ? 4 : 0.35;
  return Math.min(1.4, Math.max(0.7, Math.pow(ratio, k)));
}
