// Tipos do motor de análise de treinos (IronTrack 2.0 F01/P08). Ver docs/ANALYTICS_TREINAMENTO.md.
// Só leitura: nada aqui é persistido. Pesos sempre em kg (carga externa); a conversão para lb é da interface.
// Datas de calendário como yyyy-mm-dd no fuso local do aparelho; semanas começam na segunda-feira.
import type { ExerciseClassification, ExplicitExerciseAttributes } from './classification';
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
  /** P10: lado registrado (só valores válidos; ausente = não informado). */
  side?: Side;
  /** P10: assistência em kg (> 0) registrada na série. */
  assistanceKg?: number;
}

/** P10: registro de cardio de um exercício numa sessão (somas das séries válidas). */
export interface CardioObs {
  durationSec: number | null;
  distanceM: number | null;
  /** Séries de cardio válidas (com duração ou distância). */
  sets: number;
}

export interface ExerciseObs {
  key: string;
  name: string;
  /** Grupo muscular informado na ficha; null quando vazio. */
  muscleGroup: string | null;
  bodyweight: boolean;
  /** Equipamento da ficha, como registrado (P09: usado só pela classificação analítica). */
  equipment: string | null;
  /** Séries com repetições (musculação, peso corporal e exercícios sem modalidade). */
  sets: SetObs[];
  /** P10: atributos gravados no exercício (cópia da sessão); null em registros antigos. */
  explicit: ExplicitExerciseAttributes | null;
  /** P10: durações válidas (s) das séries de exercício por tempo. Repetições nunca viram segundos. */
  durations: number[];
  /** P10: cardio registrado; null quando o exercício não é cardio ou não tem séries válidas. */
  cardio: CardioObs | null;
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
  /** P10: séries concluídas de exercício por tempo ou cardio sem duração/distância válidas (ficam fora de tudo). */
  invalidModalitySets: number;
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
  /** P10: séries com repetições, com lado e assistência (base de compareSides e bodyweightMetrics). */
  setObs: SetObs[];
  /** P10: durações válidas das séries por tempo; maior duração da sessão (null sem duração). */
  durations: number[];
  bestDurationSec: number | null;
  /** P10: cardio da sessão. */
  cardio: CardioObs | null;
}

/** P10: métricas específicas da modalidade, calculadas pelos contratos do P09 só quando a modalidade se aplica. */
export interface ModalityMetrics {
  timed: TimedMetrics | null;
  cardio: CardioMetrics | null;
  sides: SideComparison | null;
  bodyweight: BodyweightMetrics | null;
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
  /** P10: métricas por modalidade no período (tempo, cardio, lados, peso corporal). */
  modality: ModalityMetrics;
  /** P10: séries por tempo ou cardio no período (não entram em `sets` de repetições do exercício). */
  modalitySets: number;
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
  /** `sets` = séries com carga + sem carga + por tempo/cardio (`modalitySets`, P10). */
  totals: PeriodTotals & { loadedSets: number; unloadedSets: number; reps: number; modalitySets: number };
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

// ---------------------------------------------------------------------------------------------
// Contratos por modalidade (P09; implementação em ./modalities.ts)

export type DistanceUnit = 'm' | 'km' | 'mi';
export type Side = 'direito' | 'esquerdo' | 'ambos' | 'desconhecido';
export type BodyweightSetKind = 'somente_corporal' | 'com_carga_adicional' | 'com_assistencia' | 'incompativel';

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

/** Série de peso corporal. `assistanceKg` só existiria no modelo futuro (não há campo hoje). */
export interface BodyweightSetObs {
  reps: number;
  /** Carga adicional externa em kg (cinto, colete, anilha); null sem carga. */
  load: number | null;
  assistanceKg?: number | null;
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
