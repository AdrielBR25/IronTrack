// Referências de um exercício da biblioteca nas fichas e no histórico (P17, docs/BIBLIOTECA_EXERCICIOS.md §8).
// Só pela origem gravada (`catalogId`/`customExerciseId`); nunca por nome. Usado para restringir a exclusão definitiva
// de um personalizado e para avisar que editar o modelo não muda fichas nem sessões já gravadas.
import type { Routine, WorkoutSession } from '@/modules/training';
import { libraryKeyOf } from './instance';
import type { LibraryKey } from './types';

export interface LibraryReferences {
  /** Instâncias em fichas (duas no mesmo treino contam duas). */
  templates: number;
  /** Treinos (sessões, de qualquer estado) que têm uma cópia do exercício. */
  sessions: number;
}

export function libraryReferences(key: LibraryKey, routines: readonly Routine[], sessions: readonly WorkoutSession[]): LibraryReferences {
  let templates = 0;
  for (const r of routines) for (const w of r.workouts ?? []) for (const t of w.exercises ?? []) if (libraryKeyOf(t) === key) templates++;
  let n = 0;
  for (const s of sessions) if ((s.exercises ?? []).some((e) => libraryKeyOf(e) === key)) n++;
  return { templates, sessions: n };
}

export const isReferenced = (r: LibraryReferences) => r.templates > 0 || r.sessions > 0;
