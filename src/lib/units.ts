import type { WeightUnit } from './types';

// Conversão de unidades de peso. Convenção: o valor persistido é sempre kg;
// lb existe só na exibição e na digitação.

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
