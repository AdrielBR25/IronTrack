// Formato de escrita das entradas do catálogo (P17/P18): campos opcionais com padrão e os textos de segurança comuns.
// Só usado dentro de '@/modules/exercises/catalog' (fica fora do pacote principal junto com o catálogo).
import type { CatalogExercise } from '../types';

export type Entry = Omit<CatalogExercise, 'source' | 'version' | 'since' | 'aliases' | 'secondaryMuscles' | 'tags' | 'commonMistakes'> &
  Partial<Pick<CatalogExercise, 'version' | 'since' | 'aliases' | 'secondaryMuscles' | 'tags' | 'commonMistakes'>>;

export const PAIN = 'Interrompa se sentir dor (diferente do esforço muscular).';
export const LOAD = 'Use uma carga que permita manter a técnica em todas as repetições.';
