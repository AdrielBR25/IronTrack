// Cálculos puros por modalidade (IronTrack 2.0 F01/P09). Ver docs/ANALYTICS_TREINAMENTO.md §16–19.
// Tempo, cardio e lado corporal NÃO existem no banco atual (Dexie v2): estas funções são o contrato para o
// modelo futuro (docs/MODELO_EXERCICIOS_V2.md) e só rodam hoje nos testes, com dados fictícios. Peso corporal
// usa os campos existentes. Nada aqui inventa duração, distância, calorias, frequência cardíaca ou lado.
import { computeTrend, type TrendObservation } from './trends';
import type { Trend } from './types';

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

// ---------------------------------------------------------------------------------------------
// Exercícios por tempo

/** Uma sessão de exercício temporizado: duração de cada série, em segundos (null = não registrada). */
export interface TimedSessionObs {
  date: string;
  durationsSec: readonly (number | null | undefined)[];
}

export interface TimedMetrics {
  available: boolean;
  reason?: 'sem_duracao';
  sessions: number;
  sets: number;
  /** Séries sem duração válida (vazia, zero, negativa ou não numérica): não entram em nada. */
  invalidSets: number;
  longestSec: number | null;
  totalSec: number | null;
  /** Tendência da maior duração por sessão (métrica `duracao`, nunca misturada com carga). */
  trend: Trend;
}

export function timedMetrics(sessions: readonly TimedSessionObs[]): TimedMetrics {
  let sets = 0;
  let invalid = 0;
  let longest: number | null = null;
  let total = 0;
  const obs: TrendObservation[] = [];
  for (const s of sessions) {
    let best: number | null = null;
    for (const d of s.durationsSec) {
      if (!isPos(d)) {
        invalid++;
        continue;
      }
      sets++;
      total += d;
      best = Math.max(best ?? 0, d);
    }
    if (best !== null) {
      obs.push({ date: s.date, value: best });
      longest = Math.max(longest ?? 0, best);
    }
  }
  const trend = computeTrend(obs, 'duracao');
  if (!sets) return { available: false, reason: 'sem_duracao', sessions: 0, sets: 0, invalidSets: invalid, longestSec: null, totalSec: null, trend };
  return { available: true, sessions: obs.length, sets, invalidSets: invalid, longestSec: longest, totalSec: total, trend };
}

// ---------------------------------------------------------------------------------------------
// Cardio

export type DistanceUnit = 'm' | 'km' | 'mi';
export const METERS_PER_MILE = 1609.344;

export function toMeters(value: number, unit: DistanceUnit): number {
  return unit === 'm' ? value : unit === 'km' ? value * 1000 : value * METERS_PER_MILE;
}

export interface CardioEntry {
  date: string;
  durationSec?: number | null;
  distance?: { value: number; unit: DistanceUnit } | null;
}

export interface CardioPoint {
  date: string;
  durationSec: number | null;
  distanceM: number | null;
  /** Segundos por km; só com duração e distância válidas. */
  paceSecPerKm: number | null;
  speedKmh: number | null;
}

export interface CardioMetrics {
  available: boolean;
  reason?: 'sem_dados_de_cardio';
  sessions: number;
  points: CardioPoint[];
  /** Somas só das sessões que registraram o campo (com a contagem ao lado). */
  totalDurationSec: number | null;
  sessionsWithDuration: number;
  totalDistanceM: number | null;
  sessionsWithDistance: number;
  /** Ritmo médio ponderado = duração ÷ distância, só nas sessões com os dois campos. */
  averagePaceSecPerKm: number | null;
  averageSpeedKmh: number | null;
  /** Sessões por semana na janela informada; null com menos de 7 dias. */
  weeklyFrequency: number | null;
  durationTrend: Trend;
  distanceTrend: Trend;
}

/** Métricas de cardio. Sem calorias, sem frequência cardíaca e sem avaliação de condicionamento. */
export function cardioMetrics(entries: readonly CardioEntry[], windowDays: number | null = null): CardioMetrics {
  const points: CardioPoint[] = [];
  let dur = 0;
  let dist = 0;
  let nDur = 0;
  let nDist = 0;
  let pairedDur = 0;
  let pairedDist = 0;
  for (const e of entries) {
    const d = isPos(e.durationSec) ? e.durationSec : null;
    const m = e.distance && isPos(e.distance.value) && (['m', 'km', 'mi'] as const).includes(e.distance.unit) ? toMeters(e.distance.value, e.distance.unit) : null;
    if (d === null && m === null) continue;
    if (d !== null) (dur += d), nDur++;
    if (m !== null) (dist += m), nDist++;
    const both = d !== null && m !== null;
    if (both) (pairedDur += d), (pairedDist += m);
    points.push({ date: e.date, durationSec: d, distanceM: m, paceSecPerKm: both ? d / (m / 1000) : null, speedKmh: both ? m / 1000 / (d / 3600) : null });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const durationTrend = computeTrend(points.filter((p) => p.durationSec !== null).map((p) => ({ date: p.date, value: p.durationSec! })), 'duracao');
  const distanceTrend = computeTrend(points.filter((p) => p.distanceM !== null).map((p) => ({ date: p.date, value: p.distanceM! })), 'distancia');
  const paired = pairedDist > 0;
  return {
    available: points.length > 0,
    ...(points.length ? {} : { reason: 'sem_dados_de_cardio' as const }),
    sessions: points.length,
    points,
    totalDurationSec: nDur ? dur : null,
    sessionsWithDuration: nDur,
    totalDistanceM: nDist ? dist : null,
    sessionsWithDistance: nDist,
    averagePaceSecPerKm: paired ? pairedDur / (pairedDist / 1000) : null,
    averageSpeedKmh: paired ? pairedDist / 1000 / (pairedDur / 3600) : null,
    weeklyFrequency: windowDays !== null && windowDays >= 7 ? points.length / (windowDays / 7) : null,
    durationTrend,
    distanceTrend,
  };
}

// ---------------------------------------------------------------------------------------------
// Unilaterais

export type Side = 'direito' | 'esquerdo' | 'ambos' | 'desconhecido';

/** Uma série registrada com lado. Uma série é uma série: nunca vira duas (uma por lado). */
export interface SidedSetObs {
  side: Side | null | undefined;
  reps: number;
  /** kg; null sem carga. */
  load: number | null;
}

export interface SideStats {
  sets: number;
  reps: number;
  volume: number;
  topLoad: number | null;
  bestReps: number | null;
}

export interface SideDelta {
  /** direito − esquerdo. */
  diff: number;
  /** Diferença relativa ao maior dos dois lados (%), null quando ambos são zero. */
  pct: number | null;
}

export interface SideComparison {
  available: boolean;
  reason?: 'sem_lado' | 'um_lado_so';
  direito: SideStats;
  esquerdo: SideStats;
  /** Séries registradas como "ambos" ou sem lado: não são atribuídas a um lado nem duplicadas. */
  ambos: SideStats;
  desconhecido: SideStats;
  /** Diferenças registradas (não é diagnóstico de desequilíbrio). */
  differences: { reps: SideDelta; volume: SideDelta; topLoad: SideDelta | null } | null;
}

const emptySide = (): SideStats => ({ sets: 0, reps: 0, volume: 0, topLoad: null, bestReps: null });
const sideDelta = (r: number, l: number): SideDelta => {
  const ref = Math.max(r, l);
  return { diff: r - l, pct: ref > 0 ? ((r - l) / ref) * 100 : null };
};

export function compareSides(sets: readonly SidedSetObs[]): SideComparison {
  const acc = { direito: emptySide(), esquerdo: emptySide(), ambos: emptySide(), desconhecido: emptySide() };
  for (const s of sets) {
    if (!isPos(s.reps)) continue;
    const side: Side = s.side === 'direito' || s.side === 'esquerdo' || s.side === 'ambos' ? s.side : 'desconhecido';
    const t = acc[side];
    t.sets++;
    t.reps += s.reps;
    t.bestReps = Math.max(t.bestReps ?? 0, s.reps);
    if (isPos(s.load)) {
      t.volume += s.load * s.reps;
      t.topLoad = Math.max(t.topLoad ?? 0, s.load);
    }
  }
  const { direito: r, esquerdo: l } = acc;
  if (!r.sets && !l.sets) return { available: false, reason: 'sem_lado', ...acc, differences: null };
  if (!r.sets || !l.sets) return { available: false, reason: 'um_lado_so', ...acc, differences: null };
  return {
    available: true,
    ...acc,
    differences: {
      reps: sideDelta(r.reps, l.reps),
      volume: sideDelta(r.volume, l.volume),
      topLoad: r.topLoad !== null && l.topLoad !== null ? sideDelta(r.topLoad, l.topLoad) : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Peso corporal

/** Série de peso corporal. `assistanceKg` só existiria no modelo futuro (não há campo hoje). */
export interface BodyweightSetObs {
  reps: number;
  /** Carga adicional externa em kg (cinto, colete, anilha); null sem carga. */
  load: number | null;
  assistanceKg?: number | null;
}

export type BodyweightSetKind = 'somente_corporal' | 'com_carga_adicional' | 'com_assistencia' | 'incompativel';

/** Carga adicional e assistência ao mesmo tempo é incompatível: a série não é interpretada. */
export function bodyweightSetKind(s: BodyweightSetObs): BodyweightSetKind {
  const added = isPos(s.load);
  const assisted = isPos(s.assistanceKg);
  if (added && assisted) return 'incompativel';
  return added ? 'com_carga_adicional' : assisted ? 'com_assistencia' : 'somente_corporal';
}

export interface BodyweightMetrics {
  sets: number;
  reps: number;
  bySetKind: Record<BodyweightSetKind, number>;
  /** Melhor série por condição: repetições só se comparam dentro da mesma condição. */
  bestRepsBodyOnly: number | null;
  bestAddedLoad: { load: number; reps: number } | null;
  bestAssisted: { assistanceKg: number; reps: number } | null;
  /** Peso corporal nunca vira quilos de volume. */
  volumeKg: null;
}

export function bodyweightMetrics(sets: readonly BodyweightSetObs[]): BodyweightMetrics {
  const bySetKind: Record<BodyweightSetKind, number> = { somente_corporal: 0, com_carga_adicional: 0, com_assistencia: 0, incompativel: 0 };
  let n = 0;
  let reps = 0;
  let bestRepsBodyOnly: number | null = null;
  let bestAddedLoad: BodyweightMetrics['bestAddedLoad'] = null;
  let bestAssisted: BodyweightMetrics['bestAssisted'] = null;
  for (const s of sets) {
    if (!isPos(s.reps)) continue;
    const kind = bodyweightSetKind(s);
    bySetKind[kind]++;
    if (kind === 'incompativel') continue;
    n++;
    reps += s.reps;
    if (kind === 'somente_corporal') bestRepsBodyOnly = Math.max(bestRepsBodyOnly ?? 0, s.reps);
    if (kind === 'com_carga_adicional' && (!bestAddedLoad || s.load! > bestAddedLoad.load || (s.load === bestAddedLoad.load && s.reps > bestAddedLoad.reps)))
      bestAddedLoad = { load: s.load!, reps: s.reps };
    // Menos assistência é a condição mais difícil.
    if (kind === 'com_assistencia' && (!bestAssisted || s.assistanceKg! < bestAssisted.assistanceKg || (s.assistanceKg === bestAssisted.assistanceKg && s.reps > bestAssisted.reps)))
      bestAssisted = { assistanceKg: s.assistanceKg!, reps: s.reps };
  }
  return { sets: n, reps, bySetKind, bestRepsBodyOnly, bestAddedLoad, bestAssisted, volumeKg: null };
}
