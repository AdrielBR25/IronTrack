// Tipos do motor de desempenho por exercício (IronTrack 2.0 F01/P19). Ver docs/DESEMPENHO_EXERCICIOS.md.
// Tudo aqui é derivado das sessões concluídas: nada é persistido, nada vai para backup.
import type { E1rmMethodId } from '@/modules/analytics';
import type { DistanceUnit, ExerciseLaterality, LoadMode, SetSide, SetType } from '@/modules/training';

export type IdentityKind = 'instancia' | 'historico' | 'catalogo' | 'personalizado';

export interface PerformanceIdentity {
  kind: IdentityKind;
  id: string;
  /** `i:` | `h:` | `c:` | `p:` + id. Usada na rota (codificada) e como chave dos índices. */
  key: string;
}

/** Família de medida: decide quais métricas, recordes e gráficos fazem sentido. */
export type MeasureFamily = 'carga' | 'corporal' | 'tempo' | 'cardio';

/**
 * Situação de uma série executada.
 * - `trabalho`: concluída, não é aquecimento, com a medida que a família exige.
 * - `drop`: série de trabalho do tipo drop (conta em volume e totais, fica fora da comparação série a série).
 * - `aquecimento`: concluída como aquecimento; nunca vira recorde nem entra em volume de trabalho.
 * - `incompleta`: concluída sem a medida exigida (ex.: sem repetições); fica fora dos cálculos.
 * - `pulada`: marcada como pulada.
 * Séries pendentes não foram executadas e não aparecem.
 */
export type PerfSetKind = 'trabalho' | 'drop' | 'aquecimento' | 'incompleta' | 'pulada';

export interface PerfSet {
  id: string;
  kind: PerfSetKind;
  type: SetType;
  /** Ordem da série de trabalho normal (1, 2, 3…) na cópia; null para as demais. Por lado em unilaterais. */
  ordinal: number | null;
  side: SetSide | null;
  /** kg; carga externa (musculação) ou adicional (peso corporal). null = sem carga registrada. */
  loadKg: number | null;
  reps: number | null;
  assistanceKg: number | null;
  durationSec: number | null;
  distanceM: number | null;
}

export interface E1rmMark {
  valueKg: number;
  kind: 'direta' | 'estimada';
  loadKg: number;
  reps: number;
  method: E1rmMethodId;
}

/** Medidas de uma identidade numa sessão (todas as cópias da identidade na sessão somadas). */
export interface PerfMetrics {
  workSets: number;
  normalSets: number;
  warmupSets: number;
  incompleteSets: number;
  skippedSets: number;
  /** Musculação. */
  topLoadKg: number | null;
  topLoadReps: number | null;
  /** Maior número de repetições numa série de trabalho válida (com a carga dela em `bestRepsLoadKg`). */
  bestReps: number | null;
  bestRepsLoadKg: number | null;
  totalReps: number | null;
  /** kg × repetições nas séries de trabalho com carga; null quando nenhuma série tem carga. */
  volumeKg: number | null;
  e1rm: E1rmMark | null;
  /** Peso corporal. */
  bodyOnlyBestReps: number | null;
  addedLoadKg: number | null;
  addedLoadReps: number | null;
  /** Menor assistência registrada (menos assistência = condição mais difícil). */
  minAssistanceKg: number | null;
  minAssistanceReps: number | null;
  /** Tempo (e peso corporal com duração). */
  bestDurationSec: number | null;
  totalDurationSec: number | null;
  /** Cardio (somas da sessão). */
  distanceM: number | null;
  cardioDurationSec: number | null;
  /** s/km, só quando duração e distância vieram das mesmas séries. */
  paceSecPerKm: number | null;
  /** Distância usada no ritmo (para faixa de comparação). */
  pacedDistanceM: number | null;
}

export interface PerfObservation {
  sessionId: string;
  ts: number;
  date: string;
  routineId: string;
  workoutId: string;
  workoutLabel: string;
  workoutName: string;
  /** Identidades seguras (instância ou histórico) das cópias somadas. Mais de uma só em visões agregadas. */
  primaryKeys: string[];
  name: string;
  family: MeasureFamily;
  loadMode: LoadMode | null;
  laterality: ExerciseLaterality | null;
  equipment: string | null;
  /** Unidade de exibição da distância gravada no exercício (a distância é sempre em metros). */
  distanceUnit: DistanceUnit | null;
  /** Fim da faixa de repetições planejada (para sugestões), quando válido. */
  repMax: number | null;
  /** Origem registrada na sessão. */
  catalogId: string | null;
  customExerciseId: string | null;
  substitutedFrom: string | null;
  /** Quantas cópias da identidade a sessão tinha (2+ = exercício repetido na ficha). */
  copies: number;
  sets: PerfSet[];
  metrics: PerfMetrics;
}

export type RecordType =
  | 'carga_maxima'
  | 'repeticoes'
  | 'volume_sessao'
  | 'e1rm'
  | 'repeticoes_corporal'
  | 'carga_adicional'
  | 'menor_assistencia'
  | 'duracao'
  | 'distancia'
  | 'duracao_cardio'
  | 'ritmo';

export type RecordUnit = 'kg' | 'repeticoes' | 'segundos' | 'metros' | 'seg_por_km';

export interface RecordEvent {
  type: RecordType;
  value: number;
  unit: RecordUnit;
  date: string;
  ts: number;
  sessionId: string;
  /** Valor anterior superado (null = primeira marca). */
  previous: number | null;
  /** Repetições ou carga de contexto (ex.: carga máxima com 8 repetições). */
  reps?: number;
  loadKg?: number;
  e1rmKind?: 'direta' | 'estimada';
  /** Faixa de distância do ritmo. */
  band?: PaceBand;
}

export interface PerfRecord extends RecordEvent {
  /** Sessões posteriores que igualaram o valor (empate não renova o recorde). */
  ties: { date: string; sessionId: string }[];
}

export type PaceBand = 'ate_1km' | '1_3km' | '3_5km' | '5_10km' | '10_21km' | 'acima_21km';

export type ChartMetric =
  | 'carga'
  | 'repeticoes'
  | 'volume'
  | 'e1rm'
  | 'repeticoes_corporal'
  | 'carga_adicional'
  | 'assistencia'
  | 'duracao'
  | 'distancia'
  | 'duracao_cardio'
  | 'ritmo';

export interface ChartPoint {
  ts: number;
  date: string;
  sessionId: string;
  value: number;
  /** Dias desde o ponto anterior (null no primeiro). */
  gapDays: number | null;
  /** Pausa longa antes deste ponto: o gráfico interrompe a linha. */
  gapBefore: boolean;
  note?: string;
}

export interface ChartSeries {
  metric: ChartMetric;
  unit: RecordUnit;
  /** Menor é melhor (ritmo, assistência). */
  lowerIsBetter: boolean;
  points: ChartPoint[];
}

export type TrendDirectionP = 'positiva' | 'estavel' | 'queda' | 'insuficiente';

export interface PerfTrend {
  metric: ChartMetric;
  direction: TrendDirectionP;
  points: number;
  spanDays: number;
  changePct: number | null;
  thresholdPct: number | null;
  reason: 'poucas_sessoes' | 'intervalo_curto' | 'sem_metrica' | null;
  longGap: boolean;
}

export type ObservationKind =
  | 'carga_maior'
  | 'mais_repeticoes_mesma_carga'
  | 'repeticoes_maior'
  | 'volume_maior'
  | 'distancia_maior'
  | 'ritmo_melhor'
  | 'duracao_maior'
  | 'tendencia_positiva'
  | 'abaixo_do_inicio'
  | 'variacao'
  | 'estavel'
  | 'insuficiente'
  | 'outra_modalidade';

export interface PerfObservationNote {
  kind: ObservationKind;
  text: string;
  /** Critério usado, em linguagem simples. */
  criterion: string;
  /** Sessões que motivaram a observação. */
  sessionIds: string[];
  /** Entra em "Sua evolução recente" (comparação mensurável e favorável). */
  recentProgress: boolean;
}

export interface StabilityResult {
  state: 'estavel' | 'variando' | 'sem_registros' | 'poucas_sessoes' | 'incompativel';
  comparableSessions: number;
  spanDays: number;
  criterion: string;
}

export interface Suggestion {
  id: 'progressao_gradual' | 'revisar_meta_repeticoes' | 'comparar_antes_de_mudar';
  text: string;
  /** Registros que motivaram a sugestão. */
  basis: string;
  sessionIds: string[];
}

export interface ComparedMetric {
  key: string;
  label: string;
  unit: RecordUnit;
  a: number | null;
  b: number | null;
  diff: number | null;
  pct: number | null;
  lowerIsBetter: boolean;
  missing: 'a' | 'b' | 'ambos' | null;
}

export type CompatibilityIssue = 'familia_diferente' | 'modo_de_carga_diferente' | 'lateralidade_diferente' | 'instancias_diferentes' | 'faixa_de_distancia_diferente' | 'mesma_sessao';

export interface SetPairRow {
  ordinal: number;
  side: SetSide | null;
  a: PerfSet | null;
  b: PerfSet | null;
  state: 'comparavel' | 'ausente_a' | 'ausente_b' | 'incompleta';
  loadDiffKg: number | null;
  repsDiff: number | null;
  durationDiffSec: number | null;
}

export interface SetComparison {
  available: boolean;
  reason: 'familia_diferente' | 'sem_series_normais' | 'lados_nao_registrados' | 'cardio' | null;
  rows: SetPairRow[];
  /** Séries fora da comparação (aquecimento, drop, incompletas, puladas) por sessão. */
  excluded: { a: number; b: number };
}

export interface SessionComparison {
  a: PerfObservation;
  b: PerfObservation;
  compatible: boolean;
  issues: CompatibilityIssue[];
  metrics: ComparedMetric[];
  sets: SetComparison;
  /** Resumo neutro; só afirma diferença favorável quando as condições são equivalentes. */
  summary: string;
}

export interface IdentityHistory {
  identity: PerformanceIdentity;
  /** Nome mais recente registrado. */
  name: string;
  family: MeasureFamily;
  loadMode: LoadMode | null;
  laterality: ExerciseLaterality | null;
  equipment: string | null;
  /** Observações compatíveis (mesma família da mais recente), em ordem cronológica. */
  observations: PerfObservation[];
  /** Observações de outra família (modalidade alterada): listadas, nunca comparadas. */
  otherFamily: PerfObservation[];
  historicReason: 'sem_ficha' | 'substituido' | 'isolado' | null;
  routineId: string | null;
  workoutLabel: string | null;
  workoutName: string | null;
  /** Visão agregada: identidades seguras que a compõem. Identidade segura: visões agregadas em que aparece. */
  members: string[];
  aggregates: string[];
  /** Instância/histórico: IDs da ficha cobertos (para metas). */
  templateIds: string[];
  catalogId: string | null;
  customExerciseId: string | null;
  records: PerfRecord[];
  recordEvents: RecordEvent[];
}

export interface PerformanceIndex {
  identities: Map<string, IdentityHistory>;
  /** Sessões concluídas consideradas (do perfil), ordenadas por data. */
  sessions: { id: string; ts: number; date: string }[];
  firstDate: string | null;
  ignoredSessions: number;
}
