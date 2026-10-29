import { pickModelFields } from './exerciseModel';
import type { ExerciseModelFields, Routine } from './types';

// Proteção de compatibilidade do modelo de exercícios (IronTrack 2.0 F01/P11, docs/CRONOMETROS_E_CONCORRENCIA.md §7–8).
// Funções puras. O app atual guarda, fora do banco, uma "fotografia" dos campos de modalidade de cada rotina e da
// última gravação que ELE fez. Se a rotina aparece com outro `updatedAt` e sem campos que a fotografia tinha, alguém
// que não conhece esses campos (um app antigo, em outra aba ou depois de voltar a versão) regravou a rotina.
// Isso não impede a perda no app antigo (impossível sem alterar o app antigo ou a versão física do banco); permite
// detectar e devolver os campos com a confirmação da pessoa.

/** Capacidade do modelo de exercícios que este app entende (3 = modalidades do P10). */
export const EXERCISE_MODEL_CAPABILITY = 3;

const MODEL_KEYS = ['modality', 'laterality', 'loadMode', 'secondaryMuscles', 'distanceUnit', 'targetDurationSec', 'targetDistance'] as const;

export interface RoutineModelSnapshot {
  updatedAt: number;
  /** Campos de modalidade por ID de exercício da ficha (só exercícios que têm algum). */
  exercises: Record<string, ExerciseModelFields>;
}
export type ModelSnapshot = Record<string, RoutineModelSnapshot>;

export function snapshotRoutine(r: Pick<Routine, 'updatedAt' | 'workouts'>): RoutineModelSnapshot {
  const exercises: Record<string, ExerciseModelFields> = {};
  for (const w of r.workouts ?? [])
    for (const e of w.exercises ?? []) {
      const f = pickModelFields(e);
      if (Object.keys(f).length) exercises[e.id] = f;
    }
  return { updatedAt: r.updatedAt, exercises };
}

export interface ExerciseModelLoss {
  workoutId: string;
  exerciseId: string;
  name: string;
  /** Campos que existiam na última gravação deste app e sumiram. */
  missing: ExerciseModelFields;
}
export interface RoutineModelLoss {
  routineId: string;
  routineName: string;
  updatedAt: number;
  exercises: ExerciseModelLoss[];
}

/**
 * Rotinas regravadas por outro app com perda de campos de modalidade. Só compara exercícios que ainda existem (com o
 * mesmo ID). Exercício excluído, rotina sem fotografia ou rotina gravada por este app nunca geram alerta.
 */
export function detectModelLoss(snapshot: ModelSnapshot, routines: Routine[]): RoutineModelLoss[] {
  const out: RoutineModelLoss[] = [];
  for (const r of routines) {
    const snap = snapshot[r.id];
    if (!snap || snap.updatedAt === r.updatedAt) continue;
    const exercises: ExerciseModelLoss[] = [];
    for (const w of r.workouts ?? [])
      for (const e of w.exercises ?? []) {
        const before = snap.exercises[e.id];
        if (!before) continue;
        const missing: Record<string, unknown> = {};
        for (const k of MODEL_KEYS) if (before[k] !== undefined && (e as ExerciseModelFields)[k] === undefined) missing[k] = before[k];
        if (Object.keys(missing).length) exercises.push({ workoutId: w.id, exerciseId: e.id, name: e.name, missing: missing as ExerciseModelFields });
      }
    if (exercises.length) out.push({ routineId: r.id, routineName: r.name, updatedAt: r.updatedAt, exercises });
  }
  return out;
}

/** Devolve os campos perdidos, só onde continuam ausentes (nunca sobrescreve um valor presente). */
export function restoreModelFields(r: Routine, loss: RoutineModelLoss): Routine {
  const byId = new Map(loss.exercises.map((x) => [x.exerciseId, x.missing]));
  return {
    ...r,
    workouts: r.workouts.map((w) => ({
      ...w,
      exercises: w.exercises.map((e) => {
        const missing = byId.get(e.id);
        if (!missing) return e;
        const next = { ...e } as Record<string, unknown>;
        for (const [k, v] of Object.entries(missing)) if (next[k] === undefined) next[k] = Array.isArray(v) ? [...v] : v;
        return next as unknown as typeof e;
      }),
    })),
  };
}

/** Os dados já foram usados por um app que entende um modelo mais novo que este? */
export function isNewerCapability(stored: unknown, current = EXERCISE_MODEL_CAPABILITY): boolean {
  return typeof stored === 'number' && Number.isInteger(stored) && stored > current;
}
