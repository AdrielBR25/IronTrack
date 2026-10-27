// Modelos de domínio do IronTrack. Pesos são sempre armazenados em kg
// (carga total externa do exercício); a conversão para lb acontece só na interface.

export type ExerciseCategory = 'compound' | 'isolation';
export type Equipment = 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight' | 'other';
export type SetType = 'warmup' | 'normal' | 'drop';
export type SetStatus = 'pending' | 'done' | 'skipped';

export interface ExerciseTemplate {
  id: string;
  name: string;
  muscleGroup: string;
  category: ExerciseCategory;
  equipment: Equipment;
  sets: number;
  repMin: number;
  repMax: number;
  /** Descanso em segundos. */
  restSec: number;
  warmupSets: number;
  /** Carga planejada em kg (opcional). */
  targetWeight?: number;
  notes?: string;
  substitutes?: string[];
}

export interface Workout {
  id: string;
  /** Letra/rótulo curto: A, B, C... */
  label: string;
  name: string;
  notes?: string;
  exercises: ExerciseTemplate[];
}

export interface Routine {
  id: string;
  /** Perfil proprietário (ver docs/PERFIL_LOCAL.md). Ausente só em registros legados ainda não migrados. */
  profileId?: string;
  name: string;
  description?: string;
  workouts: Workout[];
  createdAt: number;
  updatedAt: number;
}

export interface SessionSet {
  id: string;
  type: SetType;
  status: SetStatus;
  /** kg */
  weight: number | null;
  reps: number | null;
  plannedWeight?: number | null;
  plannedReps?: string | null;
  rpe?: number | null;
  rir?: number | null;
  note?: string;
  completedAt?: number;
  /** Peso alterado manualmente nesta série (não recebe propagação automática). */
  edited?: boolean;
}

export interface SessionExercise {
  id: string;
  exerciseKey: string;
  templateId?: string;
  name: string;
  muscleGroup: string;
  category: ExerciseCategory;
  equipment: Equipment;
  repMin: number;
  repMax: number;
  restSec: number;
  plannedSets: number;
  notes?: string;
  /** Nome original quando o exercício foi substituído durante o treino. */
  substitutedFrom?: string;
  sets: SessionSet[];
}

export interface RestState {
  /** Duração total em ms (após ajustes). */
  durationMs: number;
  /** Timestamp (ms) em que termina, quando rodando. */
  endsAt: number;
  /** Quando pausado, quanto falta em ms; null quando rodando. */
  pausedRemainingMs: number | null;
  /** Descrição da próxima série. */
  nextLabel: string;
  exerciseId: string;
  setId: string;
  notified?: boolean;
}

export type SessionStatus = 'active' | 'completed' | 'discarded';

export interface WorkoutSession {
  id: string;
  /** Perfil proprietário, explícito: o treino continua com dono mesmo se a rotina for excluída. */
  profileId?: string;
  routineId: string;
  workoutId: string;
  workoutLabel: string;
  workoutName: string;
  status: SessionStatus;
  startedAt: number;
  finishedAt?: number;
  durationSec?: number;
  notes?: string;
  exercises: SessionExercise[];
  rest?: RestState | null;
  /** Último exercício em foco (para retomar a sessão). */
  focusExerciseId?: string;
  /** Se este treino avançou a rotação ao ser concluído. */
  advancedRotation?: boolean;
  updatedAt: number;
}

export interface RotationState {
  routineId: string;
  /** Índice (na ordem dos treinos da rotina) do próximo treino. */
  nextIndex: number;
  updatedAt: number;
}

export type DayOverrideKind = 'rest' | 'workout';

export interface DayOverride {
  routineId: string;
  /** yyyy-mm-dd (data local) */
  date: string;
  kind: DayOverrideKind;
  workoutId?: string;
}

export interface BodyEntry {
  id: string;
  /** Perfil proprietário. */
  profileId?: string;
  date: string;
  weightKg?: number | null;
  bodyFatPct?: number | null;
  waistCm?: number | null;
  abdomenCm?: number | null;
  armCm?: number | null;
  thighCm?: number | null;
  hipCm?: number | null;
  heightM?: number | null;
  bmi?: number | null;
  fatMassKg?: number | null;
  leanMassKg?: number | null;
  leanPct?: number | null;
  waistHipRatio?: number | null;
  bodyDensity?: number | null;
  skinfoldSumMm?: number | null;
  armMuscleArea?: number | null;
  armFatArea?: number | null;
  /** dobras cutâneas (mm), pelo nome do relatório */
  skinfolds?: Record<string, number>;
  /** outras circunferências (cm) sem campo próprio */
  circumferences?: Record<string, number>;
  source?: 'pdf' | 'manual' | 'json';
  notes?: string;
  createdAt: number;
}

export interface ProgressPhoto {
  id: string;
  /** Perfil proprietário, explícito: fotos órfãs legítimas não ficam sem dono. Deve ser o mesmo da avaliação. */
  profileId?: string;
  entryId: string;
  /** data URL (jpeg comprimido) */
  dataUrl: string;
  createdAt: number;
}

export type WeightUnit = 'kg' | 'lb';
export type ThemeMode = 'dark' | 'light' | 'system';
export type FitnessGoal = 'hypertrophy' | 'strength' | 'fat-loss' | 'general';
export type RotationPolicy = 'finish' | 'threshold';

export interface ProgressionPrefs {
  /** Incrementos de carga em kg por tipo de equipamento. */
  increments: Record<Equipment, number>;
  /** RIR mínimo para considerar a série "com técnica e margem" (null = ignorar). */
  minRir: number;
  /** RPE máximo compatível. */
  maxRpe: number;
}

export interface Settings {
  id: 'settings';
  userName: string;
  weightUnit: WeightUnit;
  /** Dias de treino (0=domingo ... 6=sábado). */
  trainingDays: number[];
  restCompoundSec: number;
  restIsolationSec: number;
  restWarmupSec: number;
  sound: boolean;
  vibration: boolean;
  notifications: boolean;
  theme: ThemeMode;
  goal: FitnessGoal;
  /** Passo dos botões +/− de peso, na unidade exibida. */
  weightStep: number;
  repStep: number;
  progression: ProgressionPrefs;
  rotationPolicy: RotationPolicy;
  /** % mínimo de séries válidas concluídas para avançar (política threshold). */
  rotationThreshold: number;
  muscleGroups: string[];
  activeRoutineId: string | null;
  /** Mostrar observação de equipamento no peso (barra/halteres/máquina). */
  showEquipmentHint: boolean;
}

/**
 * Perfil local: identidade estável dos dados neste navegador. O ID é aleatório (UUID v4),
 * gerado uma única vez e nunca derivado de nome, aparelho, navegador ou data.
 * Não é conta, login nem identidade do aparelho.
 */
export interface LocalProfile {
  id: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  /** Perfil principal. Nesta versão existe exatamente um. */
  isDefault: boolean;
}

/** Coleções com proprietário explícito (`profileId`). As demais herdam o dono (ver docs/PERFIL_LOCAL.md). */
export const OWNED_COLLECTIONS = ['routines', 'sessions', 'bodyEntries', 'photos'] as const;
export type OwnedCollection = (typeof OWNED_COLLECTIONS)[number];

/** Retrato completo dos dados locais (conteúdo do backup e entrada da verificação de integridade). */
export interface DataSnapshot {
  settings: Settings | null;
  routines: Routine[];
  sessions: WorkoutSession[];
  rotations: RotationState[];
  overrides: DayOverride[];
  bodyEntries: BodyEntry[];
  photos: ProgressPhoto[];
}

export type CollectionName = keyof DataSnapshot;
