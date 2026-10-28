// Operações do construtor de fichas (P17, docs/BIBLIOTECA_EXERCICIOS.md §9 e §14). Puras.
// Em vez de gravar a ficha inteira que a tela tinha (o que apagaria em silêncio o que outra aba acabou de fazer), cada
// ação é uma OPERAÇÃO aplicada sobre a versão gravada, dentro da transação (src/db/library.ts › mutateWorkout):
//  - adicionar e duplicar sempre preservam o que outra aba fez;
//  - reordenar aplica a ordem conhecida e mantém no fim, na ordem atual, o que a tela ainda não conhecia;
//  - editar, substituir, mover e duplicar exigem que a instância ainda exista (senão: erro, nada gravado);
//  - remover algo já removido não é erro.
// IDs e configurações nunca mudam ao reordenar; duplicar e substituir criam IDs novos.
import type { ExerciseTemplate, Workout } from '@/modules/training';

export const WORKOUT_LIMITS = { maxExercises: 300 } as const;

export type WorkoutOp =
  | { type: 'add'; exercise: ExerciseTemplate; afterId?: string | null }
  | { type: 'update'; exercise: ExerciseTemplate }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; delta: -1 | 1 }
  | { type: 'reorder'; order: string[] }
  | { type: 'duplicate'; id: string; newId: string }
  | { type: 'replace'; id: string; exercise: ExerciseTemplate }
  | { type: 'meta'; label: string; name: string; notes?: string };

export type WorkoutOpErrorCode = 'missing_exercise' | 'duplicate_id' | 'limit' | 'missing_workout' | 'missing_routine' | 'label_taken' | 'outdated_app';

export const WORKOUT_OP_MESSAGE: Record<WorkoutOpErrorCode, string> = {
  missing_exercise: 'Este exercício não está mais na ficha (talvez tenha sido removido em outra aba). Nada foi gravado.',
  duplicate_id: 'Já existe um exercício com este identificador na ficha. Nada foi gravado.',
  limit: `A ficha atingiu o limite de ${WORKOUT_LIMITS.maxExercises} exercícios.`,
  missing_workout: 'Este treino não existe mais (talvez tenha sido excluído em outra aba). Nada foi gravado.',
  missing_routine: 'Esta rotina não existe mais (talvez tenha sido excluída em outra aba). Nada foi gravado.',
  label_taken: 'Já existe outro treino com este rótulo na rotina.',
  outdated_app: 'Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.',
};

export class WorkoutOpError extends Error {
  constructor(readonly code: WorkoutOpErrorCode) {
    super(WORKOUT_OP_MESSAGE[code]);
    this.name = 'WorkoutOpError';
  }
}

export interface OpResult {
  workout: Workout;
  /** false quando a operação não mudou nada (ex.: remover algo já removido, mover o primeiro para cima). */
  changed: boolean;
}

const idx = (w: Workout, id: string) => w.exercises.findIndex((e) => e.id === id);

/** Aplica a operação sobre a versão atual do treino. `siblings` = rótulos dos outros treinos (só para `meta`). */
export function applyWorkoutOp(w: Workout, op: WorkoutOp, siblingsLabels: readonly string[] = []): OpResult {
  const list = [...w.exercises];
  switch (op.type) {
    case 'add': {
      if (list.some((e) => e.id === op.exercise.id)) {
        // Repetir a mesma adição (toque duplo, reenvio) não duplica.
        return { workout: w, changed: false };
      }
      if (list.length >= WORKOUT_LIMITS.maxExercises) throw new WorkoutOpError('limit');
      const at = op.afterId ? idx(w, op.afterId) : -1;
      if (at >= 0) list.splice(at + 1, 0, op.exercise);
      else list.push(op.exercise);
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'update': {
      const i = idx(w, op.exercise.id);
      if (i < 0) throw new WorkoutOpError('missing_exercise');
      list[i] = op.exercise;
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'remove': {
      const i = idx(w, op.id);
      if (i < 0) return { workout: w, changed: false };
      list.splice(i, 1);
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'move': {
      const i = idx(w, op.id);
      if (i < 0) throw new WorkoutOpError('missing_exercise');
      const j = i + op.delta;
      if (j < 0 || j >= list.length) return { workout: w, changed: false };
      [list[i], list[j]] = [list[j], list[i]];
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'reorder': {
      const pos = new Map(op.order.map((id, n) => [id, n]));
      const known = list.filter((e) => pos.has(e.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
      const unknown = list.filter((e) => !pos.has(e.id));
      const next = [...known, ...unknown];
      const changed = next.some((e, n) => e.id !== list[n].id);
      return { workout: changed ? { ...w, exercises: next } : w, changed };
    }
    case 'duplicate': {
      const i = idx(w, op.id);
      if (i < 0) throw new WorkoutOpError('missing_exercise');
      if (list.some((e) => e.id === op.newId)) return { workout: w, changed: false };
      if (list.length >= WORKOUT_LIMITS.maxExercises) throw new WorkoutOpError('limit');
      list.splice(i + 1, 0, duplicateInstance(list[i], op.newId));
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'replace': {
      const i = idx(w, op.id);
      if (i < 0) {
        // Já substituído por esta mesma operação (reenvio): nada a fazer.
        if (list.some((e) => e.id === op.exercise.id)) return { workout: w, changed: false };
        throw new WorkoutOpError('missing_exercise');
      }
      if (op.exercise.id === op.id || list.some((e) => e.id === op.exercise.id)) throw new WorkoutOpError('duplicate_id');
      list[i] = op.exercise;
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'meta': {
      const label = op.label.trim().toUpperCase().slice(0, 4) || w.label;
      if (siblingsLabels.includes(label)) throw new WorkoutOpError('label_taken');
      const name = op.name.trim() || w.name;
      const notes = op.notes?.trim() || undefined;
      if (label === w.label && name === w.name && notes === (w.notes || undefined)) return { workout: w, changed: false };
      return { workout: { ...w, label, name, notes }, changed: true };
    }
  }
}

/** Cópia independente de uma instância: ID novo, mesmas configurações e mesma origem na biblioteca. */
export function duplicateInstance(t: ExerciseTemplate, newId: string): ExerciseTemplate {
  const copy: ExerciseTemplate = { ...t, id: newId };
  if (t.substitutes) copy.substitutes = [...t.substitutes];
  if (t.secondaryMuscles) copy.secondaryMuscles = [...t.secondaryMuscles];
  return copy;
}
