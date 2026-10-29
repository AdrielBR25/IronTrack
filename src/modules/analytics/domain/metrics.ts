// Métricas de treino calculadas a partir das sessões concluídas (ver docs/ANALYTICS_TREINAMENTO.md).
// Funções puras e determinísticas. Uma passada normaliza o histórico (O(séries)); cada período
// reaproveita esse índice e só percorre as sessões da janela.
import { LATERALITIES, LOAD_MODES, MODALITIES, isSetSide, isValidAssistanceKg, isValidDistanceM, isValidDurationSec, type SessionExercise, type WorkoutSession } from '@/modules/training';
import { classifyExercise, type ExerciseClassification, type ExplicitExerciseAttributes } from './classification';
import { bodyweightMetrics, cardioMetrics, compareSides, timedMetrics } from './modalities';
import { createMuscleNormalizer, normalizeMuscleGroup, type NormalizedMuscle } from './muscles';
import { canonicalE1rmKg, E1RM_METHOD_ID, E1RM_RANGE_MAX_REPS } from './oneRepMax';
import { computeTrend, type TrendObservation } from './trends';
import { dayNumber, localDate, makeRange, monthStart, nextMonthStart, previousRange, shiftDays, weekStart } from './periods';
import type {
  Bucket,
  CardioObs,
  ConsistencyMetrics,
  DataQuality,
  DateRange,
  ExerciseObs,
  ExercisePoint,
  ExerciseRecords,
  ExerciseSummary,
  FrequencyMetrics,
  MetricDelta,
  ModalityMetrics,
  MuscleDistribution,
  MuscleDistributionRow,
  MuscleGroupSets,
  PeriodComparison,
  RecordMark,
  RepBand,
  SessionObs,
  SetObs,
  Trend,
} from './types';

/**
 * 1RM estimado só para séries de 1 a 12 repetições: acima disso a fórmula de Epley perde precisão. Desde o P09
 * o cálculo vem do contrato canônico (domain/oneRepMax.ts); os resultados são os mesmos do P08.
 */
export const E1RM_MAX_REPS = E1RM_RANGE_MAX_REPS;
/** Sessões anteriores com carga necessárias para declarar um novo recorde de carga. */
export const MIN_PRIOR_SESSIONS_FOR_RECORD = 2;
/** Semanas completas necessárias para avaliar a regularidade. */
export const REGULARITY_MIN_WEEKS = 4;
/** Coeficiente de variação até o qual a frequência é "estável"; até o segundo, "variável". */
export const REGULARITY_STABLE_CV = 0.35;
export const REGULARITY_VARIABLE_CV = 0.75;
/** Acima disto (em dias cobertos), os gráficos agregam por mês em vez de semana. */
export const WEEKLY_BUCKET_MAX_DAYS = 182;

export function repBand(reps: number): RepBand {
  return reps <= 5 ? '1-5' : reps <= E1RM_MAX_REPS ? '6-12' : '13+';
}

const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

// ---------------------------------------------------------------------------------------------
// Normalização

export interface NormalizedHistory {
  sessions: SessionObs[];
  quality: DataQuality;
}

/**
 * Converte sessões em observações. Entram só sessões concluídas com data válida e, nelas, só séries
 * concluídas que não são aquecimento e têm repetições válidas. Sessões em andamento ou descartadas e séries
 * planejadas, puladas ou pendentes nunca contam como realizadas.
 */
/** P10: atributos explícitos válidos da cópia do exercício na sessão (valores fora do vocabulário são ignorados). */
export function explicitOf(ex: Pick<SessionExercise, 'modality' | 'laterality' | 'loadMode'>): ExplicitExerciseAttributes | null {
  const out: ExplicitExerciseAttributes = {};
  if ((MODALITIES as readonly unknown[]).includes(ex.modality)) out.modality = ex.modality;
  if ((LATERALITIES as readonly unknown[]).includes(ex.laterality)) out.laterality = ex.laterality;
  if ((LOAD_MODES as readonly unknown[]).includes(ex.loadMode)) out.loadMode = ex.loadMode;
  return Object.keys(out).length ? out : null;
}

/** Séries de trabalho do exercício na sessão: com repetições, por tempo e de cardio. */
export const workSetsOf = (ex: Pick<ExerciseObs, 'sets' | 'durations' | 'cardio'>) => ex.sets.length + ex.durations.length + (ex.cardio?.sets ?? 0);

export function normalizeSessions(sessions: readonly WorkoutSession[]): NormalizedHistory {
  const quality: DataQuality = { completedSessions: 0, ignoredSessions: 0, invalidRepSets: 0, invalidLoadSets: 0, invalidModalitySets: 0 };
  const out: SessionObs[] = [];
  for (const s of sessions) {
    if (s?.status !== 'completed' || !Number.isFinite(s.startedAt)) {
      quality.ignoredSessions++;
      continue;
    }
    quality.completedSessions++;
    const byKey = new Map<string, ExerciseObs>();
    for (const ex of s.exercises ?? []) {
      const sets: SetObs[] = [];
      const durations: number[] = [];
      const explicit = explicitOf(ex);
      // P10: tempo e cardio são lidos só quando a modalidade foi gravada no exercício; sem ela, a série é lida
      // como antes (repetições e carga). Nada é deduzido do nome nem de números ambíguos.
      const mode = explicit?.modality === 'timed' || explicit?.modality === 'cardio' ? explicit.modality : null;
      let cardio: CardioObs | null = null;
      for (const set of ex.sets ?? []) {
        if (set.status !== 'done' || set.type === 'warmup') continue;
        if (mode === 'timed') {
          if (isValidDurationSec(set.durationSec)) durations.push(set.durationSec);
          else quality.invalidModalitySets++;
          continue;
        }
        if (mode === 'cardio') {
          const d = isValidDurationSec(set.durationSec) ? set.durationSec : null;
          const m = isValidDistanceM(set.distance) ? set.distance : null;
          if (d === null && m === null) {
            quality.invalidModalitySets++;
            continue;
          }
          cardio ??= { durationSec: null, distanceM: null, sets: 0 };
          cardio.sets++;
          if (d !== null) cardio.durationSec = (cardio.durationSec ?? 0) + d;
          if (m !== null) cardio.distanceM = (cardio.distanceM ?? 0) + m;
          continue;
        }
        if (!isPositiveNumber(set.reps)) {
          quality.invalidRepSets++;
          continue;
        }
        const w = set.weight;
        let load: number | null = null;
        if (isPositiveNumber(w)) load = w;
        else if (w !== null && w !== undefined && w !== 0) quality.invalidLoadSets++;
        const obs: SetObs = { reps: set.reps, load };
        if (isSetSide(set.side)) obs.side = set.side;
        if (isValidAssistanceKg(set.assistanceKg) && set.assistanceKg > 0) obs.assistanceKg = set.assistanceKg;
        sets.push(obs);
      }
      if (!sets.length && !durations.length && !cardio) continue;
      const key = ex.exerciseKey || ex.name.trim().toLowerCase();
      const cur = byKey.get(key);
      // O mesmo exercício duas vezes na sessão (ex.: repetido na ficha) vira uma observação só.
      if (cur) {
        cur.sets.push(...sets);
        cur.durations.push(...durations);
        if (cardio) {
          const c = (cur.cardio ??= { durationSec: null, distanceM: null, sets: 0 });
          c.sets += cardio.sets;
          if (cardio.durationSec !== null) c.durationSec = (c.durationSec ?? 0) + cardio.durationSec;
          if (cardio.distanceM !== null) c.distanceM = (c.distanceM ?? 0) + cardio.distanceM;
        }
      } else
        byKey.set(key, {
          key,
          name: ex.name,
          muscleGroup: ex.muscleGroup?.trim() || null,
          bodyweight: ex.equipment === 'bodyweight',
          equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
          sets,
          explicit,
          durations,
          cardio,
        });
    }
    const date = localDate(s.startedAt);
    out.push({ ts: s.startedAt, date, week: weekStart(date), exercises: [...byKey.values()] });
  }
  out.sort((a, b) => a.ts - b.ts);
  return { sessions: out, quality };
}

// ---------------------------------------------------------------------------------------------
// Pontos por exercício e recordes

export function exercisePoint(session: Pick<SessionObs, 'ts' | 'date'>, ex: ExerciseObs): ExercisePoint {
  let reps = 0;
  let volume = 0;
  let loadedSets = 0;
  let topLoad: number | null = null;
  let topLoadReps: number | null = null;
  let bestSetVolume: number | null = null;
  let e1rm: number | null = null;
  let bestReps = 0;
  let bestUnloadedReps: number | null = null;
  const topLoadByBand: Partial<Record<RepBand, number>> = {};
  for (const s of ex.sets) {
    reps += s.reps;
    bestReps = Math.max(bestReps, s.reps);
    if (s.load === null) {
      // P10: repetições com assistência não se comparam com repetições só com o corpo.
      if (s.assistanceKg === undefined) bestUnloadedReps = Math.max(bestUnloadedReps ?? 0, s.reps);
      continue;
    }
    const v = s.load * s.reps;
    volume += v;
    loadedSets++;
    if (topLoad === null || s.load > topLoad || (s.load === topLoad && s.reps > (topLoadReps ?? 0))) {
      topLoad = s.load;
      topLoadReps = s.reps;
    }
    bestSetVolume = Math.max(bestSetVolume ?? 0, v);
    const est = canonicalE1rmKg(s.load, s.reps);
    if (est !== null) e1rm = Math.max(e1rm ?? 0, est);
    const band = repBand(s.reps);
    topLoadByBand[band] = Math.max(topLoadByBand[band] ?? 0, s.load);
  }
  const durations = ex.durations ?? [];
  return {
    ts: session.ts,
    date: session.date,
    sets: ex.sets.length,
    loadedSets,
    reps,
    volume,
    topLoad,
    topLoadReps,
    bestSetVolume,
    e1rm,
    bestReps,
    bestUnloadedReps,
    topLoadByBand,
    setObs: ex.sets,
    durations,
    bestDurationSec: durations.length ? Math.max(...durations) : null,
    cardio: ex.cardio ?? null,
  };
}

export interface ExerciseHistory {
  key: string;
  name: string;
  muscleGroup: string | null;
  bodyweight: boolean;
  equipment: string | null;
  /** Em ordem cronológica. */
  points: ExercisePoint[];
  records: ExerciseRecords;
  muscle: NormalizedMuscle;
  classification: ExerciseClassification;
  /** P10: atributos explícitos mais recentes (null em exercícios nunca classificados). */
  explicit: ExplicitExerciseAttributes | null;
}

const mark = (p: ExercisePoint, value: number, extra: Partial<RecordMark> = {}): RecordMark => ({ value, ts: p.ts, date: p.date, ...extra });

/**
 * Recordes absolutos. Empates não renovam o recorde (fica a primeira data). Um recorde de carga só entra no
 * histórico de recordes quando supera a melhor marca de pelo menos MIN_PRIOR_SESSIONS_FOR_RECORD sessões
 * anteriores com carga: a primeira sessão não é recorde.
 */
export function computeExerciseRecords(points: readonly ExercisePoint[]): ExerciseRecords {
  const r: ExerciseRecords = { sessions: points.length, maxLoad: null, maxSetVolume: null, bestE1rm: null, maxUnloadedReps: null, loadRecordHistory: [] };
  let loadedSessions = 0;
  for (const p of points) {
    if (p.topLoad !== null) {
      if (!r.maxLoad || p.topLoad > r.maxLoad.value) {
        if (r.maxLoad && loadedSessions >= MIN_PRIOR_SESSIONS_FOR_RECORD)
          r.loadRecordHistory.push(mark(p, p.topLoad, { reps: p.topLoadReps ?? undefined, previous: r.maxLoad.value }));
        r.maxLoad = mark(p, p.topLoad, { reps: p.topLoadReps ?? undefined });
      }
      loadedSessions++;
    }
    if (p.bestSetVolume !== null && (!r.maxSetVolume || p.bestSetVolume > r.maxSetVolume.value)) r.maxSetVolume = mark(p, p.bestSetVolume);
    if (p.e1rm !== null && (!r.bestE1rm || p.e1rm > r.bestE1rm.value)) r.bestE1rm = mark(p, p.e1rm);
    if (p.bestUnloadedReps !== null && (!r.maxUnloadedReps || p.bestUnloadedReps > r.maxUnloadedReps.value)) r.maxUnloadedReps = mark(p, p.bestUnloadedReps);
  }
  return r;
}

/**
 * Classificação a partir dos atributos gravados mais recentes (P10), do equipamento e dos dados registrados em
 * todo o histórico. Duração, distância e lado só contam quando foram registrados de fato.
 */
export function classifyHistory(h: Pick<ExerciseHistory, 'equipment' | 'points'> & { explicit?: ExplicitExerciseAttributes | null }): ExerciseClassification {
  let loaded = false;
  let unloaded = false;
  let duration = false;
  let distance = false;
  let side = false;
  for (const p of h.points) {
    if (p.loadedSets > 0) loaded = true;
    if (p.sets > p.loadedSets) unloaded = true;
    if (p.durations?.length || p.cardio?.durationSec != null) duration = true;
    if (p.cardio?.distanceM != null) distance = true;
    if (p.setObs?.some((s) => s.side === 'direito' || s.side === 'esquerdo')) side = true;
  }
  return classifyExercise({ equipment: h.equipment, hasLoadedSets: loaded, hasUnloadedSets: unloaded, hasDuration: duration, hasDistance: distance, hasSide: side, explicit: h.explicit ?? null });
}

export function buildExerciseHistories(sessions: readonly SessionObs[]): Map<string, ExerciseHistory> {
  const map = new Map<string, ExerciseHistory>();
  const normalize = createMuscleNormalizer();
  for (const s of sessions)
    for (const ex of s.exercises) {
      let h = map.get(ex.key);
      if (!h) {
        h = {
          key: ex.key,
          name: ex.name,
          muscleGroup: ex.muscleGroup,
          bodyweight: ex.bodyweight,
          equipment: ex.equipment,
          points: [],
          records: computeExerciseRecords([]),
          muscle: normalizeMuscleGroup(null),
          classification: classifyExercise({ hasLoadedSets: false, hasUnloadedSets: false }),
          explicit: null,
        };
        map.set(ex.key, h);
      }
      // O nome e a classificação mais recentes valem (o exercício pode ter sido renomeado na ficha).
      h.name = ex.name;
      h.muscleGroup = ex.muscleGroup ?? h.muscleGroup;
      h.bodyweight = ex.bodyweight;
      h.equipment = ex.equipment ?? h.equipment;
      // Atributos explícitos: vale a classificação mais recente gravada (registros antigos sem ela não apagam).
      if (ex.explicit) h.explicit = ex.explicit;
      h.points.push(exercisePoint(s, ex));
    }
  for (const h of map.values()) {
    h.records = computeExerciseRecords(h.points);
    h.muscle = normalize(h.muscleGroup);
    h.classification = classifyHistory(h);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Janelas

/** Índice do primeiro item com date >= iso (itens em ordem cronológica). */
function lowerBound<T extends { date: string }>(items: readonly T[], iso: string): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].date < iso) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Itens (em ordem cronológica) com data dentro da janela, por busca binária. */
export function sliceRange<T extends { date: string }>(items: readonly T[], range: DateRange): T[] {
  return items.slice(lowerBound(items, range.from), lowerBound(items, shiftDays(range.to, 1)));
}

export interface Totals {
  sessions: number;
  /** Séries com repetições + séries por tempo/cardio (P10). */
  sets: number;
  reps: number;
  volume: number;
  loadedSets: number;
  unloadedSets: number;
  /** P10: séries por tempo e de cardio (sem repetições; não entram em volume nem em repetições). */
  modalitySets: number;
  distinctDays: number;
}

export function totalsOf(sessions: readonly SessionObs[]): Totals {
  const t: Totals = { sessions: sessions.length, sets: 0, reps: 0, volume: 0, loadedSets: 0, unloadedSets: 0, modalitySets: 0, distinctDays: 0 };
  const days = new Set<string>();
  for (const s of sessions) {
    days.add(s.date);
    for (const ex of s.exercises) {
      const modal = (ex.durations?.length ?? 0) + (ex.cardio?.sets ?? 0);
      t.modalitySets += modal;
      t.sets += modal;
      for (const set of ex.sets) {
        t.sets++;
        t.reps += set.reps;
        if (set.load === null) t.unloadedSets++;
        else {
          t.loadedSets++;
          t.volume += set.load * set.reps;
        }
      }
    }
  }
  t.distinctDays = days.size;
  return t;
}

/** Semanas (segunda-feira) tocadas pela janela. */
export function weeksOf(range: DateRange): string[] {
  const out: string[] = [];
  for (let w = weekStart(range.from); w <= range.to; w = shiftDays(w, 7)) out.push(w);
  return out;
}

export function frequencyOf(sessions: readonly SessionObs[], covered: DateRange | null): FrequencyMetrics {
  if (!covered) return { sessions: 0, distinctDays: 0, weeklyAverage: null, weeks: 0, activeWeeks: 0 };
  const weeks = weeksOf(covered);
  const active = new Set(sessions.map((s) => s.week));
  return {
    sessions: sessions.length,
    distinctDays: new Set(sessions.map((s) => s.date)).size,
    // Com menos de 7 dias cobertos a média semanal seria uma extrapolação: não é calculada.
    weeklyAverage: covered.days >= 7 ? sessions.length / (covered.days / 7) : null,
    weeks: weeks.length,
    activeWeeks: weeks.filter((w) => active.has(w)).length,
  };
}

/**
 * Regularidade = coeficiente de variação (desvio-padrão populacional ÷ média) das sessões por semana, só nas
 * semanas completas dentro do período coberto. Semanas sem treino entram como zero, sem penalidade extra.
 */
export function consistencyOf(sessions: readonly SessionObs[], covered: DateRange | null): ConsistencyMetrics {
  const none: ConsistencyMetrics = { completeWeeks: 0, activeCompleteWeeks: 0, variation: null, regularity: 'insuficiente' };
  if (!covered) return none;
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.week, (counts.get(s.week) ?? 0) + 1);
  const complete = weeksOf(covered).filter((w) => w >= covered.from && shiftDays(w, 6) <= covered.to);
  const values = complete.map((w) => counts.get(w) ?? 0);
  const active = values.filter((v) => v > 0).length;
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  if (values.length < REGULARITY_MIN_WEEKS || mean === 0) return { ...none, completeWeeks: values.length, activeCompleteWeeks: active };
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  const variation = sd / mean;
  return {
    completeWeeks: values.length,
    activeCompleteWeeks: active,
    variation,
    regularity: variation <= REGULARITY_STABLE_CV ? 'estavel' : variation <= REGULARITY_VARIABLE_CV ? 'variavel' : 'muito_variavel',
  };
}

/** Séries, sessões e volume por semana (até WEEKLY_BUCKET_MAX_DAYS dias) ou por mês. */
export function bucketsOf(sessions: readonly SessionObs[], range: DateRange, covered: DateRange | null): Bucket[] {
  if (!covered) return [];
  const kind: Bucket['kind'] = covered.days > WEEKLY_BUCKET_MAX_DAYS ? 'month' : 'week';
  const starts: string[] = [];
  if (kind === 'week') starts.push(...weeksOf(covered));
  else for (let m = monthStart(covered.from); m <= covered.to; m = nextMonthStart(m)) starts.push(m);
  const end = (start: string) => (kind === 'week' ? shiftDays(start, 6) : shiftDays(nextMonthStart(start), -1));
  const buckets: Bucket[] = starts.map((start) => ({ start, kind, partial: start < covered.from || end(start) > range.to, sessions: 0, sets: 0, volume: 0 }));
  const index = new Map(starts.map((s, i) => [s, i]));
  for (const s of sessions) {
    const b = buckets[index.get(kind === 'week' ? s.week : monthStart(s.date))!];
    if (!b) continue;
    const t = totalsOf([s]);
    b.sessions++;
    b.sets += t.sets;
    b.volume += t.volume;
  }
  return buckets;
}

export function muscleGroupsOf(sessions: readonly SessionObs[]): { groups: MuscleGroupSets[]; unclassified: number } {
  const map = new Map<string, number>();
  let unclassified = 0;
  for (const s of sessions)
    for (const ex of s.exercises) {
      const n = workSetsOf(ex);
      if (ex.muscleGroup) map.set(ex.muscleGroup, (map.get(ex.muscleGroup) ?? 0) + n);
      else unclassified += n;
    }
  const groups = [...map.entries()].map(([group, sets]) => ({ group, sets })).sort((a, b) => b.sets - a.sets || a.group.localeCompare(b.group));
  return { groups, unclassified };
}

/**
 * Séries por grupo normalizado. Cada série conta uma vez, no grupo principal da ficha (o modelo atual não tem
 * grupos secundários e nada é repetido em outros músculos). Textos desconhecidos e ambíguos ficam à parte.
 */
export function muscleDistributionOf(sessions: readonly SessionObs[], normalize = createMuscleNormalizer()): MuscleDistribution {
  const rows = new Map<string, MuscleDistributionRow & { match: NormalizedMuscle['match'] }>();
  let emptySets = 0;
  for (const s of sessions)
    for (const ex of s.exercises) {
      const m = normalize(ex.muscleGroup);
      const n = workSetsOf(ex);
      if (!m.key) {
        emptySets += n;
        continue;
      }
      let row = rows.get(m.key);
      if (!row) rows.set(m.key, (row = { key: m.key, group: m.label, sets: 0, originals: [], match: m.match }));
      row.sets += n;
      const original = m.original.trim();
      if (!row.originals.includes(original)) row.originals.push(original);
    }
  const sorted = [...rows.values()].sort((a, b) => b.sets - a.sets || a.group.localeCompare(b.group, 'pt-BR'));
  const pick = (match: NormalizedMuscle['match']) =>
    sorted.filter((r) => r.match === match).map(({ key, group, sets, originals }) => ({ key, group, sets, originals: [...originals].sort((a, b) => a.localeCompare(b, 'pt-BR')) }));
  return { groups: pick('canonico'), unrecognized: pick('nao_reconhecido'), ambiguous: pick('ambiguo'), emptySets };
}

function delta(current: number, previous: number): MetricDelta {
  return { current, previous, diff: current - previous, pct: previous > 0 ? ((current - previous) / previous) * 100 : null };
}

/**
 * Comparação com a janela anterior de mesma duração. Só existe quando o histórico cobre a janela anterior
 * inteira (primeira sessão no início dela ou antes); senão os períodos não seriam equivalentes.
 */
export function compareWithPrevious(all: readonly SessionObs[], range: DateRange, isTotalPeriod: boolean, firstSessionDate: string | null): PeriodComparison {
  const empty = { previous: null, sessions: null, sets: null, volume: null, distinctDays: null };
  if (isTotalPeriod) return { available: false, reason: 'periodo_total', ...empty };
  const previous = previousRange(range);
  if (!firstSessionDate || firstSessionDate > previous.from) return { available: false, reason: 'historico_insuficiente', ...empty, previous };
  const cur = totalsOf(sliceRange(all, range));
  const prev = totalsOf(sliceRange(all, previous));
  return {
    available: true,
    previous,
    sessions: delta(cur.sessions, prev.sessions),
    sets: delta(cur.sets, prev.sets),
    volume: delta(cur.volume, prev.volume),
    distinctDays: delta(cur.distinctDays, prev.distinctDays),
  };
}

// ---------------------------------------------------------------------------------------------
// Exercícios no período

/**
 * Escolhe a métrica de tendência com mais observações (1RM estimado, carga em séries longas ou repetições).
 * Uma tendência usa uma métrica só: nunca mistura 1RM com repetições, nem carga com duração. Em peso corporal
 * (`loadMetrics: false`, P09) a carga registrada é só a adicional, então só repetições sem carga são comparadas.
 */
export function trendFor(points: readonly ExercisePoint[], opts: { loadMetrics?: boolean } = {}): Trend {
  const loadMetrics = opts.loadMetrics ?? true;
  const series: Record<'e1rm' | 'carga_13' | 'reps', TrendObservation[]> = { e1rm: [], carga_13: [], reps: [] };
  for (const p of points) {
    if (loadMetrics && p.e1rm !== null) series.e1rm.push({ date: p.date, value: p.e1rm });
    const long = p.topLoadByBand['13+'];
    if (loadMetrics && long !== undefined) series.carga_13.push({ date: p.date, value: long });
    if (p.bestUnloadedReps !== null) series.reps.push({ date: p.date, value: p.bestUnloadedReps });
  }
  const candidates = loadMetrics ? (['e1rm', 'carga_13', 'reps'] as const) : (['reps'] as const);
  const metric = candidates.reduce<'e1rm' | 'carga_13' | 'reps'>((best, m) => (series[m].length > series[best].length ? m : best), candidates[0]);
  return computeTrend(series[metric], metric);
}

function bestOf(points: readonly ExercisePoint[], pick: (p: ExercisePoint) => number | null, extra?: (p: ExercisePoint) => Partial<RecordMark>): RecordMark | null {
  let best: RecordMark | null = null;
  for (const p of points) {
    const v = pick(p);
    if (v !== null && (!best || v > best.value)) best = mark(p, v, extra?.(p));
  }
  return best;
}

export function exerciseSummary(h: ExerciseHistory, range: DateRange): ExerciseSummary | null {
  const pts = sliceRange(h.points, range);
  if (!pts.length) return null;
  let sets = 0;
  let reps = 0;
  let volume = 0;
  let loaded = 0;
  for (const p of pts) {
    sets += p.sets;
    reps += p.reps;
    volume += p.volume;
    loaded += p.loadedSets;
  }
  const recordInPeriod = [...h.records.loadRecordHistory].reverse().find((r) => r.date >= range.from && r.date <= range.to) ?? null;
  // O recorde batido no período só vale se ainda for o recorde absoluto (não foi superado depois).
  const newLoadRecordInPeriod = recordInPeriod && h.records.maxLoad && recordInPeriod.value === h.records.maxLoad.value ? recordInPeriod : null;
  return {
    key: h.key,
    name: h.name,
    muscleGroup: h.muscleGroup,
    bodyweight: h.bodyweight,
    muscle: h.muscle,
    classification: h.classification,
    e1rmMethod: E1RM_METHOD_ID,
    sessions: pts.length,
    sets,
    reps,
    volume,
    loadedSets: loaded,
    unloadedSets: sets - loaded,
    periodBest: {
      maxLoad: bestOf(pts, (p) => p.topLoad, (p) => ({ reps: p.topLoadReps ?? undefined })),
      maxSetVolume: bestOf(pts, (p) => p.bestSetVolume),
      bestE1rm: bestOf(pts, (p) => p.e1rm),
      maxUnloadedReps: bestOf(pts, (p) => p.bestUnloadedReps),
    },
    records: h.records,
    newLoadRecordInPeriod,
    ...modalityOf(h.classification, pts, range),
  };
}

/**
 * P10: métricas por modalidade com os contratos do P09 (timedMetrics, cardioMetrics, compareSides,
 * bodyweightMetrics) e a tendência na métrica própria da modalidade. Uma tendência usa uma métrica só: tempo não
 * se mistura com repetições, cardio não se mistura com carga.
 */
function modalityOf(c: ExerciseClassification, pts: readonly ExercisePoint[], range: DateRange): { modality: ModalityMetrics; modalitySets: number; trend: Trend } {
  const has = (m: ExerciseClassification['modalities'][number]) => c.modalities.includes(m);
  const sets = pts.flatMap((p) => p.setObs ?? []);
  const timed = has('timed') ? timedMetrics(pts.filter((p) => p.durations?.length).map((p) => ({ date: p.date, durationsSec: p.durations }))) : null;
  const cardio = has('cardio')
    ? cardioMetrics(
        pts.filter((p) => p.cardio).map((p) => ({ date: p.date, durationSec: p.cardio!.durationSec, distance: p.cardio!.distanceM !== null ? { value: p.cardio!.distanceM, unit: 'm' as const } : null })),
        range.days,
      )
    : null;
  const sides = c.laterality === 'unilateral' ? compareSides(sets.map((s) => ({ side: s.side, reps: s.reps, load: s.load }))) : null;
  const bodyweight = has('bodyweight') ? bodyweightMetrics(sets.map((s) => ({ reps: s.reps, load: s.load, assistanceKg: s.assistanceKg ?? null }))) : null;
  const modalitySets = pts.reduce((a, p) => a + (p.durations?.length ?? 0) + (p.cardio?.sets ?? 0), 0);
  let trend: Trend;
  if (timed) trend = timed.trend;
  else if (cardio) trend = cardio.sessionsWithDistance >= cardio.sessionsWithDuration && cardio.sessionsWithDistance > 0 ? cardio.distanceTrend : cardio.durationTrend;
  else trend = trendFor(pts, { loadMetrics: !has('bodyweight') });
  return { modality: { timed, cardio, sides, bodyweight }, modalitySets, trend };
}

/** Reduz uma série longa a no máximo `max` pontos, mantendo o maior valor de cada bloco consecutivo. */
export function downsampleMax<T>(points: readonly T[], max: number, value: (p: T) => number | null): T[] {
  if (points.length <= max) return [...points];
  const size = Math.ceil(points.length / max);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size);
    out.push(chunk.reduce((best, p) => ((value(p) ?? -Infinity) > (value(best) ?? -Infinity) ? p : best), chunk[0]));
  }
  return out;
}

export function coveredRange(range: DateRange, firstSessionDate: string | null): DateRange | null {
  if (!firstSessionDate || firstSessionDate > range.to) return null;
  return firstSessionDate > range.from ? makeRange(firstSessionDate, range.to) : range;
}

export const daysBetween = (a: string, b: string) => dayNumber(b) - dayNumber(a);
