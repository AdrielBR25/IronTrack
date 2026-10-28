// Tipos compartilhados do IronTrack. Os modelos de cada domínio ficam no próprio módulo
// (src/modules/training/types.ts, src/modules/body/types.ts, src/lib/profile.ts) e são
// reexportados aqui para manter os imports existentes de '@/lib/types'.
// Aqui ficam só os tipos que cruzam domínios: configurações do app e o retrato dos dados.
// Os módulos de domínio não importam este arquivo (evita dependência circular).
import type { DayOverride, ProgressionPrefs, Routine, RotationPolicy, RotationState, WorkoutSession } from '@/modules/training/types';
import type { BodyEntry, ProgressPhoto } from '@/modules/body/types';
import type { TrainingGoal } from '@/modules/goals/types';

export type * from '@/modules/training/types';
export type * from '@/modules/body/types';
export type * from '@/modules/goals/types';
export type { LocalProfile } from './profile';

export type WeightUnit = 'kg' | 'lb';
export type ThemeMode = 'dark' | 'light' | 'system';
export type FitnessGoal = 'hypertrophy' | 'strength' | 'fat-loss' | 'general';

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
 * Coleções com proprietário explícito (`profileId`). As demais herdam o dono (ver docs/PERFIL_LOCAL.md).
 * P12: metas (`goals`, Dexie v3). A migração v1 → v2 usa a lista congelada da época (db.ts › V2_OWNED_TABLES).
 */
export const OWNED_COLLECTIONS = ['routines', 'sessions', 'bodyEntries', 'photos', 'goals'] as const;
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
  /** P12: metas de treinamento (backup v4; vazio em backups antigos). */
  goals: TrainingGoal[];
}

export type CollectionName = keyof DataSnapshot;
