import type { Equipment, WeightUnit } from './types';

export const KG_PER_LB = 0.45359237;

export function toDisplay(kg: number | null | undefined, unit: WeightUnit): number | null {
  if (kg === null || kg === undefined) return null;
  const v = unit === 'kg' ? kg : kg / KG_PER_LB;
  return Math.round(v * 100) / 100;
}

export function fromDisplay(v: number | null | undefined, unit: WeightUnit): number | null {
  if (v === null || v === undefined) return null;
  const kg = unit === 'kg' ? v : v * KG_PER_LB;
  return Math.round(kg * 1000) / 1000;
}

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
