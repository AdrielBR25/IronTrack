import type { Equipment } from './types';

// Rótulos de equipamento exibidos na interface (pt-BR).

export const EQUIPMENT_LABEL: Record<Equipment, string> = {
  barbell: 'Barra',
  dumbbell: 'Halteres',
  machine: 'Máquina',
  cable: 'Polia/cabo',
  bodyweight: 'Peso corporal',
  other: 'Outro',
};

/** Dica de como registrar a carga total externa. */
export const EQUIPMENT_HINT: Record<Equipment, string> = {
  barbell: 'barra + anilhas',
  dumbbell: 'soma dos 2 halteres',
  machine: 'carga da máquina',
  cable: 'carga da polia',
  bodyweight: 'carga extra (0 = só corpo)',
  other: 'carga total',
};
