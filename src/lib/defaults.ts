import type { Settings } from './types';

export const DEFAULT_MUSCLE_GROUPS = [
  'Peito',
  'Costas',
  'Ombros',
  'Bíceps',
  'Tríceps',
  'Antebraço',
  'Quadríceps',
  'Posterior de coxa',
  'Glúteos',
  'Panturrilha',
  'Abdômen',
  'Trapézio',
];

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  userName: '',
  weightUnit: 'kg',
  trainingDays: [1, 2, 3, 4, 5],
  restCompoundSec: 150,
  restIsolationSec: 90,
  restWarmupSec: 60,
  sound: true,
  vibration: true,
  notifications: false,
  theme: 'dark',
  goal: 'hypertrophy',
  weightStep: 2.5,
  repStep: 1,
  progression: {
    increments: { barbell: 2.5, dumbbell: 2, machine: 5, cable: 2.5, bodyweight: 2.5, other: 2.5 },
    minRir: 1,
    maxRpe: 9,
  },
  rotationPolicy: 'finish',
  rotationThreshold: 60,
  muscleGroups: DEFAULT_MUSCLE_GROUPS,
  activeRoutineId: null,
  showEquipmentHint: true,
};

export const GOAL_LABEL: Record<Settings['goal'], string> = {
  hypertrophy: 'Hipertrofia',
  strength: 'Força',
  'fat-loss': 'Emagrecimento',
  general: 'Condicionamento geral',
};
