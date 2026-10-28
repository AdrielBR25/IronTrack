// Tipos do motor de análise de treinos (IronTrack 2.0 F01/P08). Ver docs/ANALYTICS_TREINAMENTO.md.
// Só leitura: nada aqui é persistido. Pesos sempre em kg (carga externa); a conversão para lb é da interface.
// Datas de calendário como yyyy-mm-dd no fuso local do aparelho; semanas começam na segunda-feira.
import type { ExerciseClassification } from './classification';
import type { NormalizedMuscle } from './muscles';
import type { E1rmMethodId } from './oneRepMax';

export type PeriodKey = '7d' | '30d' | '60d' | '90d' | 'all';

/** Janela de calendário local, com as duas pontas incluídas. */
export interface DateRange {
  from: string;
  to: string;
  /** Quantidade de dias de calendário da janela (from..to). */
  days: number;
}

export type Confidence = 'alta' | 'media' | 'baixa';

/** Série realizada e aceita nos cálculos (concluída, não é aquecimento, repetições válidas). */
export interface SetObs {
  reps: number;
  /** Carga externa em kg; null quando a série não tem carga válida (peso corporal, vazia ou inválida). */
  load: number | null;
}

export interface ExerciseObs {
  key: string;
  name: string;
  /** Grupo muscular informado na ficha; null quando vazio. */
  muscleGroup: string | null;
  bodyweight: boolean;
  /** Equipamento da ficha, como registrado (P09: usado só pela classificação analítica). */
  equipment: string | null;
  sets: SetObs[];
}

/** Sessão concluída já normalizada (sem IDs, só o necessário para os cálculos). */
export interface SessionObs {
  ts: number;
  date: string;
  /** Segunda-feira da semana local da sessão. */
  week: string;
  exercises: ExerciseObs[];
}

export interface DataQuality {
  /** Sessões concluídas recebidas. */
  completedSessions: number;
  /** Sessões ignoradas (em andamento, descartadas ou com data inválida). */
  ignoredSessions: number;
  /** Séries concluídas descartadas por repetições inválidas (vazias, zero, negativas, não numéricas). */
  invalidRepSets: number;
  /** Séries aceitas cuja carga era inválida (negativa ou não numérica) e ficou fora do volume de carga. */
  invalidLoadSets: number;
}

/** Ponto de um exercício numa sessão. */
export interface ExercisePoint {
  ts: number;
  date: string;
  sets: number;
  /** Séries com carga válida (as que entram no volume de carga). */
  loadedSets: number;
  reps: number;
  /** Volume de carga (kg) só das séries com carga válida. */
  volume: number;
  /** Maior carga válida da sessão (kg); null sem séries com carga. */
  topLoad: number | null;
  /** Repetições da série com a maior carga. */
  topLoadReps: number | null;
  /** Maior carga × repetições numa única série (kg). */
  bestSetVolume: number | null;
  /** Melhor 1RM estimado (só séries de 1 a 12 repetições com carga); null quando não se aplica. */
  e1rm: number | null;
  /** Mais repetições numa série (qualquer carga). */
  bestReps: number;
  /** Mais repetições numa série sem carga (peso corporal). */
  bestUnloadedReps: number | null;
  /** Maior carga por faixa de repetições (séries comparáveis). */
  topLoadByBand: Partial<Record<RepBand, number>>;
}

/** Faixas de repetições usadas para comparar séries equivalentes. */
export type RepBand = '1-5' | '6-12' | '13+';

export type TrendDirection = 'positiva' | 'estavel' | 'queda' | 'insuficiente';

/**
 * Métrica usada na tendência: 1RM estimado (séries com carga de 1 a 12 repetições), maior carga nas séries
 * de 13 ou mais repetições (quando o exercício só tem séries longas) ou repetições (peso corporal sem carga).
 */
export type TrendMetric = 'e1rm' | 'carga_13' | 'reps' | 'duracao' | 'distancia';

export interface Trend {
  direction: TrendDirection;
  metric: TrendMetric;
  /** Observações (sessões) usadas. */
  points: number;
  /** Dias entre a primeira e a última observação. */
  spanDays: number;
  /** Maior intervalo, em dias, entre duas observações seguidas. */
  maxGapDays: number;
  /** Média da primeira e da segunda metade das observações; null quando insuficiente. */
  firstMean: number | null;
  lastMean: number | null;
  /** Variação percentual entre as médias; null quando insuficiente. */
  changePct: number | null;
  /** Limiar aplicado (%): o maior entre o mínimo da métrica e dois erros-padrão da diferença. */
  thresholdPct: number | null;
  confidence: Confidence | null;
  /**
   * Houve uma pausa maior que TREND_LONG_GAP_DAYS entre duas sessões com o exercício. A tendência compara só as
   * sessões realizadas: semanas sem o exercício não contam como queda, mas a interface avisa da pausa.
   */
  longGap: boolean;
  /** Motivo quando a tendência é insuficiente. */
  reason?: 'poucas_sessoes' | 'intervalo_curto' | 'sem_metrica';
}

export interface RecordMark {
  value: number;
  /** Repetições da série (para carga e volume de série). */
  reps?: number;
  /** Carga da série (para repetições). */
  load?: number;
  /** Melhor marca anterior que este recorde superou. */
  previous?: number;
  ts: number;
  date: string;
}

export interface ExerciseRecords {
  /** Sessões com o exercício em todo o histórico. */
  sessions: number;
  maxLoad: RecordMark | null;
  maxSetVolume: RecordMark | null;
  bestE1rm: RecordMark | null;
  maxUnloadedReps: RecordMark | null;
  /**
   * Recordes de carga que superaram a melhor marca anterior (com pelo menos MIN_PRIOR_SESSIONS_FOR_RECORD
   * sessões antes). Histórico em ordem cronológica.
   */
  loadRecordHistory: RecordMark[];
}

export interface ExerciseSummary {
  key: string;
  name: string;
  muscleGroup: string | null;
  bodyweight: boolean;
  /** Grupo muscular normalizado (P09); o texto original continua em `muscleGroup`. */
  muscle: NormalizedMuscle;
  /** Classificação analítica (P09): o que os registros permitem medir. */
  classification: ExerciseClassification;
  /** Método do 1RM estimado (`e1rm`, recordes de 1RM e tendência por 1RM). */
  e1rmMethod: E1rmMethodId;
  /** Valores dentro do período. */
  sessions: number;
  sets: number;
  reps: number;
  volume: number;
  loadedSets: number;
  unloadedSets: number;
  /** Melhores marcas dentro do período (não são recordes absolutos). */
  periodBest: { maxLoad: RecordMark | null; maxSetVolume: RecordMark | null; bestE1rm: RecordMark | null; maxUnloadedReps: RecordMark | null };
  /** Recordes absolutos (todo o histórico). */
  records: ExerciseRecords;
  /** Recorde de carga absoluto batido dentro do período. */
  newLoadRecordInPeriod: RecordMark | null;
  trend: Trend;
}

export interface Bucket {
  /** Início do intervalo: segunda-feira (semana) ou dia 1 (mês). */
  start: string;
  kind: 'week' | 'month';
  /** O intervalo não está todo dentro do período coberto pelo histórico. */
  partial: boolean;
  sessions: number;
  sets: number;
  volume: number;
}

export interface FrequencyMetrics {
  sessions: number;
  distinctDays: number;
  /** Sessões por semana = sessões ÷ (dias cobertos ÷ 7); null quando não há dias cobertos. */
  weeklyAverage: number | null;
  /** Semanas (segunda a domingo) tocadas pelo período coberto. */
  weeks: number;
  activeWeeks: number;
}

export interface ConsistencyMetrics {
  /** Semanas completas (inteiras dentro do período coberto) usadas na regularidade. */
  completeWeeks: number;
  activeCompleteWeeks: number;
  /** Coeficiente de variação das sessões por semana nas semanas completas; null quando insuficiente. */
  variation: number | null;
  regularity: 'estavel' | 'variavel' | 'muito_variavel' | 'insuficiente';
}

export interface MuscleGroupSets {
  group: string;
  sets: number;
}

export interface MuscleDistributionRow {
  /** Chave de agrupamento (id canônico ou texto dobrado). */
  key: string;
  /** Nome exibido (canônico, ou o texto da ficha). */
  group: string;
  sets: number;
  /** Textos originais da ficha que caíram nesta linha, sem alteração. */
  originals: string[];
}

/**
 * Séries por grupo muscular normalizado (P09). Cada série conta uma vez, no grupo principal informado na ficha:
 * o modelo atual tem um grupo só por exercício, e o volume nunca é repetido em músculos secundários.
 */
export interface MuscleDistribution {
  /** Grupos reconhecidos (classificação confiável). */
  groups: MuscleDistributionRow[];
  /** Textos fora da tabela de sinônimos: mantidos como digitados, fora do gráfico principal. */
  unrecognized: MuscleDistributionRow[];
  /** Regiões amplas ou vários grupos no mesmo texto ("Pernas", "Peito e tríceps"): não atribuídos. */
  ambiguous: MuscleDistributionRow[];
  /** Séries de exercícios sem grupo informado. */
  emptySets: number;
}

export interface PeriodTotals {
  sessions: number;
  sets: number;
  volume: number;
  distinctDays: number;
}

export interface MetricDelta {
  current: number;
  previous: number;
  diff: number;
  /** null quando o anterior é zero (percentual não é definido). */
  pct: number | null;
}

export interface PeriodComparison {
  available: boolean;
  reason?: 'periodo_total' | 'historico_insuficiente';
  previous: DateRange | null;
  sessions: MetricDelta | null;
  sets: MetricDelta | null;
  volume: MetricDelta | null;
  distinctDays: MetricDelta | null;
}

export interface TrainingReport {
  period: PeriodKey;
  range: DateRange;
  /** Parte do período coberta pelo histórico (começa na primeira sessão quando ela é posterior ao início). */
  covered: DateRange | null;
  /** Data local da primeira sessão concluída de todo o histórico. */
  firstSessionDate: string | null;
  hasData: boolean;
  frequency: FrequencyMetrics;
  consistency: ConsistencyMetrics;
  totals: PeriodTotals & { loadedSets: number; unloadedSets: number; reps: number };
  buckets: Bucket[];
  /** Séries por grupo, pelo texto exato da ficha (P08, mantido por compatibilidade). */
  muscleGroups: MuscleGroupSets[];
  /** Séries por grupo normalizado (P09): é o que a tela mostra. */
  muscleDistribution: MuscleDistribution;
  /** Séries de exercícios sem grupo muscular informado. */
  unclassifiedSets: number;
  exercises: ExerciseSummary[];
  comparison: PeriodComparison;
  quality: DataQuality;
}

export type InsightType = 'frequencia' | 'volume' | 'carga' | 'recorde' | 'consistencia' | 'dados';
export type InsightTone = 'positivo' | 'neutro' | 'informativo';

export interface InsightEvidence {
  label: string;
  value: number;
  unit?: 'sessoes' | 'series' | 'kg' | 'pct' | 'semanas' | 'dias' | 'reps' | 'exercicios';
}

export interface Insight {
  /** Estável para a mesma regra e o mesmo alvo (ex.: 'carga.tendencia.supino'). */
  id: string;
  type: InsightType;
  tone: InsightTone;
  title: string;
  description: string;
  period: PeriodKey;
  range: DateRange;
  /** Métrica de origem no relatório (ex.: 'comparison.sessions'). */
  metric: string;
  evidence: InsightEvidence[];
  confidence: Confidence | null;
}
