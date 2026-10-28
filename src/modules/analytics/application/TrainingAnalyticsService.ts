// Serviço de análise de treinos: recebe as sessões já lidas (pela camada de dados do app) e devolve
// relatórios por período. Não lê nem grava nada: o índice é montado uma vez por versão do histórico e cada
// troca de período só reagrega a janela pedida. Sem rede, sem IA, sem cache persistente.
import type { WorkoutSession } from '@/modules/training';
import {
  bucketsOf,
  buildExerciseHistories,
  compareWithPrevious,
  consistencyOf,
  coveredRange,
  downsampleMax,
  exerciseSummary,
  frequencyOf,
  muscleDistributionOf,
  muscleGroupsOf,
  normalizeSessions,
  sliceRange,
  totalsOf,
  type ExerciseHistory,
} from '../domain/metrics';
import { createMuscleNormalizer, type NormalizedMuscle } from '../domain/muscles';
import { resolvePeriod } from '../domain/periods';
import type { DataQuality, DateRange, ExercisePoint, PeriodKey, SessionObs, TrainingReport } from '../domain/types';

/** Máximo de pontos por gráfico de exercício; acima disso, mantém o maior valor de cada bloco. */
export const MAX_CHART_POINTS = 120;

export interface ExerciseCatalogItem {
  key: string;
  name: string;
  /** Sessões com o exercício em todo o histórico. */
  sessions: number;
}

export interface TrainingAnalytics {
  firstSessionDate: string | null;
  quality: DataQuality;
  /** Exercícios com séries realizadas, do mais frequente ao menos frequente. */
  catalog: ExerciseCatalogItem[];
  report(period: PeriodKey, today: string): TrainingReport;
  history(key: string): ExerciseHistory | undefined;
  /** Pontos do exercício na janela, reduzidos a no máximo `max` para os gráficos. */
  series(key: string, range: DateRange, value: (p: ExercisePoint) => number | null, max?: number): ExercisePoint[];
}

export function createTrainingAnalytics(input: readonly WorkoutSession[]): TrainingAnalytics {
  const { sessions, quality } = normalizeSessions(input);
  const histories = buildExerciseHistories(sessions);
  const firstSessionDate = sessions[0]?.date ?? null;
  // Um normalizador por índice: cada texto de grupo muscular distinto é dobrado uma vez só.
  const normalize = createMuscleNormalizer();
  const catalog = [...histories.values()]
    .map((h) => ({ key: h.key, name: h.name, sessions: h.points.length }))
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name, 'pt-BR'));

  return {
    firstSessionDate,
    quality,
    catalog,
    history: (key) => histories.get(key),
    series(key, range, value, max = MAX_CHART_POINTS) {
      const h = histories.get(key);
      if (!h) return [];
      return downsampleMax(sliceRange(h.points, range).filter((p) => value(p) !== null), max, value);
    },
    report(period, today) {
      return buildReport(sessions, histories, quality, firstSessionDate, period, today, normalize);
    },
  };
}

function buildReport(
  all: readonly SessionObs[],
  histories: Map<string, ExerciseHistory>,
  quality: DataQuality,
  firstSessionDate: string | null,
  period: PeriodKey,
  today: string,
  normalize: (raw: string | null | undefined) => NormalizedMuscle,
): TrainingReport {
  const range = resolvePeriod(period, today, firstSessionDate);
  const covered = coveredRange(range, firstSessionDate);
  const inPeriod = sliceRange(all, range);
  const totals = totalsOf(inPeriod);
  const { groups, unclassified } = muscleGroupsOf(inPeriod);
  const exercises = [...histories.values()]
    .map((h) => exerciseSummary(h, range))
    .filter((e) => e !== null)
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name, 'pt-BR'));
  return {
    period,
    range,
    covered,
    firstSessionDate,
    hasData: inPeriod.length > 0,
    frequency: frequencyOf(inPeriod, covered),
    consistency: consistencyOf(inPeriod, covered),
    totals,
    buckets: bucketsOf(inPeriod, range, covered),
    muscleGroups: groups,
    muscleDistribution: muscleDistributionOf(inPeriod, normalize),
    unclassifiedSets: unclassified,
    exercises,
    comparison: compareWithPrevious(all, range, period === 'all', firstSessionDate),
    quality,
  };
}

/** Atalho: relatório de um período a partir das sessões. */
export function analyzeTraining(sessions: readonly WorkoutSession[], period: PeriodKey, today: string): TrainingReport {
  return createTrainingAnalytics(sessions).report(period, today);
}
