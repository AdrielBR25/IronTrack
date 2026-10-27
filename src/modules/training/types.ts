// Modelos do domínio de treinamento. Pesos são sempre armazenados em kg
// (carga total externa do exercício); a conversão para lb acontece só na interface.
// Formato persistido no IndexedDB e nos backups: não altere campos sem migração.

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

export type RotationPolicy = 'finish' | 'threshold';

export interface ProgressionPrefs {
  /** Incrementos de carga em kg por tipo de equipamento. */
  increments: Record<Equipment, number>;
  /** RIR mínimo para considerar a série "com técnica e margem" (null = ignorar). */
  minRir: number;
  /** RPE máximo compatível. */
  maxRpe: number;
}

/** Descansos padrão em segundos (subconjunto das configurações usado pelas regras de treino). */
export interface RestDefaults {
  restCompoundSec: number;
  restIsolationSec: number;
  restWarmupSec: number;
}
