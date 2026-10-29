// Operações do construtor de fichas (P17, docs/BIBLIOTECA_EXERCICIOS.md §9 e §14). Puras.
// Em vez de gravar a ficha inteira que a tela tinha (o que apagaria em silêncio o que outra aba acabou de fazer), cada
// ação é uma OPERAÇÃO aplicada sobre a versão gravada, dentro da transação (src/db/library.ts › mutateWorkout):
//  - adicionar e duplicar sempre preservam o que outra aba fez;
//  - reordenar aplica a ordem conhecida e mantém no fim, na ordem atual, o que a tela ainda não conhecia;
//  - editar, substituir, mover e duplicar exigem que a instância ainda exista (senão: erro, nada gravado);
//  - remover algo já removido não é erro.
// IDs e configurações nunca mudam ao reordenar; duplicar e substituir criam IDs novos.
// P18 (docs/RECONHECIMENTO_EXERCICIOS.md): associar/desassociar a origem, adicionar vários e substituir vários. Essas
// operações conferem a impressão digital (`instanceFingerprint`) que a tela mostrou na prévia: se a instância mudou
// entre a prévia e a confirmação, nada é gravado (erro `changed`). Adicionar/substituir vários é tudo ou nada.
import type { ExerciseTemplate, Workout } from '@/modules/training';
import { hasRef, instanceFingerprint, isValidRef, linkInstance, unlinkInstance, type LibraryRef } from './recognition';
import { libraryKeyOf } from './instance';

export const WORKOUT_LIMITS = { maxExercises: 300 } as const;

export type WorkoutOp =
  | { type: 'add'; exercise: ExerciseTemplate; afterId?: string | null }
  | { type: 'update'; exercise: ExerciseTemplate }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; delta: -1 | 1 }
  | { type: 'reorder'; order: string[] }
  | { type: 'duplicate'; id: string; newId: string }
  | { type: 'replace'; id: string; exercise: ExerciseTemplate; /** P18: impressão digital da prévia (opcional). */ expected?: string }
  | { type: 'meta'; label: string; name: string; notes?: string }
  | { type: 'link'; id: string; expected: string; ref: LibraryRef }
  | { type: 'unlink'; id: string; expected: string }
  | { type: 'addMany'; exercises: ExerciseTemplate[] }
  | { type: 'replaceMany'; pairs: { id: string; expected: string; exercise: ExerciseTemplate }[] };

export type WorkoutOpErrorCode =
  | 'missing_exercise'
  | 'duplicate_id'
  | 'limit'
  | 'missing_workout'
  | 'missing_routine'
  | 'label_taken'
  | 'outdated_app'
  | 'changed'
  | 'already_linked'
  | 'invalid_ref';

export const WORKOUT_OP_MESSAGE: Record<WorkoutOpErrorCode, string> = {
  missing_exercise: 'Este exercício não está mais na ficha (talvez tenha sido removido em outra aba). Nada foi gravado.',
  duplicate_id: 'Já existe um exercício com este identificador na ficha. Nada foi gravado.',
  limit: `A ficha atingiu o limite de ${WORKOUT_LIMITS.maxExercises} exercícios.`,
  missing_workout: 'Este treino não existe mais (talvez tenha sido excluído em outra aba). Nada foi gravado.',
  missing_routine: 'Esta rotina não existe mais (talvez tenha sido excluída em outra aba). Nada foi gravado.',
  label_taken: 'Já existe outro treino com este rótulo na rotina.',
  outdated_app: 'Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.',
  changed: 'Este exercício foi alterado depois da prévia (talvez em outra aba). Nada foi gravado: revise de novo.',
  already_linked: 'Este exercício já tem outra origem na biblioteca. Nada foi sobrescrito: desfaça a associação antes, se quiser trocar.',
  invalid_ref: 'Origem na biblioteca inválida. Nada foi gravado.',
};

export class WorkoutOpError extends Error {
  constructor(
    readonly code: WorkoutOpErrorCode,
    /** Exercício envolvido (nome), para mensagens de operações em lote. */
    readonly subject?: string,
  ) {
    super(subject ? `${subject}: ${WORKOUT_OP_MESSAGE[code]}` : WORKOUT_OP_MESSAGE[code]);
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
      // P18: o formulário não edita a origem. A gravada prevalece, para que uma edição aberta antes de outra aba associar
      // (ou desassociar) não desfaça isso em silêncio.
      list[i] = withRefOf(op.exercise, list[i]);
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
      if (op.expected !== undefined && instanceFingerprint(list[i]) !== op.expected) throw new WorkoutOpError('changed', list[i].name);
      list[i] = op.exercise;
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'link': {
      if (!isValidRef(op.ref)) throw new WorkoutOpError('invalid_ref');
      const i = idx(w, op.id);
      if (i < 0) throw new WorkoutOpError('missing_exercise');
      const cur = list[i];
      // Repetir a mesma associação (toque duplo, outra aba que associou igual) não muda nada.
      if (hasRef(cur, op.ref)) return { workout: w, changed: false };
      // Nunca sobrescreve uma origem existente.
      if (libraryKeyOf(cur)) throw new WorkoutOpError('already_linked', cur.name);
      if (instanceFingerprint(cur) !== op.expected) throw new WorkoutOpError('changed', cur.name);
      list[i] = linkInstance(cur, op.ref);
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'unlink': {
      const i = idx(w, op.id);
      if (i < 0) throw new WorkoutOpError('missing_exercise');
      const cur = list[i];
      if (!libraryKeyOf(cur) && cur.catalogVersion === undefined) return { workout: w, changed: false };
      if (instanceFingerprint(cur) !== op.expected) throw new WorkoutOpError('changed', cur.name);
      list[i] = unlinkInstance(cur);
      return { workout: { ...w, exercises: list }, changed: true };
    }
    case 'addMany': {
      const ids = op.exercises.map((e) => e.id);
      if (new Set(ids).size !== ids.length) throw new WorkoutOpError('duplicate_id');
      const fresh = op.exercises.filter((e) => !list.some((x) => x.id === e.id));
      // Reenvio da mesma confirmação (toque duplo): tudo já está lá.
      if (!fresh.length) return { workout: w, changed: false };
      if (fresh.length !== op.exercises.length) throw new WorkoutOpError('duplicate_id');
      if (list.length + fresh.length > WORKOUT_LIMITS.maxExercises) throw new WorkoutOpError('limit');
      return { workout: { ...w, exercises: [...list, ...fresh] }, changed: true };
    }
    case 'replaceMany': {
      const newIds = op.pairs.map((p) => p.exercise.id);
      if (new Set(newIds).size !== newIds.length || new Set(op.pairs.map((p) => p.id)).size !== op.pairs.length) throw new WorkoutOpError('duplicate_id');
      const done = op.pairs.filter((p) => idx(w, p.id) < 0 && list.some((e) => e.id === p.exercise.id)).length;
      // Reenvio da mesma confirmação: todas as trocas já estão gravadas.
      if (op.pairs.length && done === op.pairs.length) return { workout: w, changed: false };
      for (const p of op.pairs) {
        const i = idx(w, p.id);
        if (i < 0) throw new WorkoutOpError('missing_exercise', p.exercise.name);
        if (instanceFingerprint(list[i]) !== p.expected) throw new WorkoutOpError('changed', list[i].name);
        if (p.exercise.id === p.id || list.some((e) => e.id === p.exercise.id)) throw new WorkoutOpError('duplicate_id', p.exercise.name);
        list[i] = p.exercise;
      }
      return { workout: { ...w, exercises: list }, changed: op.pairs.length > 0 };
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

/** A instância editada com a origem que está gravada (a edição de configuração nunca muda a origem). */
function withRefOf(next: ExerciseTemplate, stored: ExerciseTemplate): ExerciseTemplate {
  const out = unlinkInstance(next);
  if (stored.catalogId !== undefined) out.catalogId = stored.catalogId;
  if (stored.catalogVersion !== undefined) out.catalogVersion = stored.catalogVersion;
  if (stored.customExerciseId !== undefined) out.customExerciseId = stored.customExerciseId;
  return out;
}

/** Cópia independente de uma instância: ID novo, mesmas configurações e mesma origem na biblioteca. */
export function duplicateInstance(t: ExerciseTemplate, newId: string): ExerciseTemplate {
  const copy: ExerciseTemplate = { ...t, id: newId };
  if (t.substitutes) copy.substitutes = [...t.substitutes];
  if (t.secondaryMuscles) copy.secondaryMuscles = [...t.secondaryMuscles];
  return copy;
}
