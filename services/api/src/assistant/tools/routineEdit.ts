// Edição de fichas proposta pela IA: função pura que aplica as alterações a uma cópia da ficha e descreve o que muda.
// A MESMA função roda ao preparar a proposta (prévia) e na aprovação (sobre a versão atual, que precisa ser a mesma).
import { randomUUID } from 'node:crypto';
import type { PreviewLine, ProposedExercise, ProposedWorkout, RoutineChange } from '../../../../../shared/assistant/protocol.ts';
import { ToolError } from './types.ts';

type Doc = Record<string, unknown>;
interface ExerciseT extends Doc {
  id: string;
  name: string;
}
interface WorkoutT extends Doc {
  id: string;
  label: string;
  name: string;
  exercises: ExerciseT[];
}

const EQUIP: Record<string, string> = { barbell: 'barra', dumbbell: 'halteres', machine: 'máquina', cable: 'polia', bodyweight: 'peso corporal', other: 'outro' };

export function describeExercise(e: Doc): string {
  const reps = e.repMin === e.repMax ? `${e.repMin}` : `${e.repMin}–${e.repMax}`;
  const bits = [`${e.sets}×${reps}`, `descanso ${e.restSec} s`];
  if (typeof e.targetWeight === 'number') bits.push(`carga ${e.targetWeight} kg`);
  if (typeof e.warmupSets === 'number' && e.warmupSets > 0) bits.push(`${e.warmupSets} aquecimento`);
  if (typeof e.equipment === 'string' && EQUIP[e.equipment]) bits.push(EQUIP[e.equipment]);
  return `${e.name} (${e.muscleGroup}) — ${bits.join(', ')}`;
}

export function toTemplate(p: ProposedExercise, id: string = randomUUID()): ExerciseT {
  return {
    id,
    name: p.name,
    muscleGroup: p.muscleGroup,
    category: p.category,
    equipment: p.equipment,
    sets: p.sets,
    repMin: p.repMin,
    repMax: p.repMax,
    restSec: p.restSec,
    warmupSets: p.warmupSets ?? 0,
    ...(typeof p.targetWeight === 'number' ? { targetWeight: p.targetWeight } : {}),
    ...(p.notes ? { notes: p.notes } : {}),
  };
}

export function toWorkout(w: ProposedWorkout, ids?: { workout: string; exercises: string[] }): WorkoutT {
  return {
    id: ids?.workout ?? randomUUID(),
    label: w.label,
    name: w.name,
    ...(w.notes ? { notes: w.notes } : {}),
    exercises: w.exercises.map((e, i) => toTemplate(e, ids?.exercises[i])),
  };
}

/** IDs gerados uma vez na proposta e reutilizados na aprovação (a prévia e o resultado são idênticos). */
export interface GeneratedIds {
  routine?: string;
  workouts: Record<string, { workout: string; exercises: string[] }>;
  exercises: Record<string, string>;
}

export function generateIds(changes: RoutineChange[]): GeneratedIds {
  const ids: GeneratedIds = { workouts: {}, exercises: {} };
  changes.forEach((c, i) => {
    if (c.op === 'add_workout') ids.workouts[i] = { workout: randomUUID(), exercises: c.workout.exercises.map(() => randomUUID()) };
    if (c.op === 'add_exercise') ids.exercises[i] = randomUUID();
  });
  return ids;
}

const workoutTitle = (w: WorkoutT) => `Treino ${w.label} — ${w.name}`;

/** Aplica as alterações (validando IDs) e devolve a ficha nova e as linhas da prévia agrupadas por treino. */
export function applyRoutineChanges(current: Doc, changes: RoutineChange[], ids: GeneratedIds, now: number): { doc: Doc; sections: { title: string; lines: PreviewLine[] }[] } {
  const doc: Doc = structuredClone(current);
  if (!Array.isArray(doc.workouts)) throw new ToolError('invalid_routine', 'A ficha atual não tem treinos válidos.');
  const workouts = doc.workouts as WorkoutT[];
  const general: PreviewLine[] = [];
  const byWorkout = new Map<string, PreviewLine[]>();
  const push = (w: WorkoutT, l: PreviewLine) => {
    const k = workoutTitle(w);
    byWorkout.set(k, [...(byWorkout.get(k) ?? []), l]);
  };
  const findW = (id: string) => {
    const w = workouts.find((x) => x.id === id);
    if (!w) throw new ToolError('workout_not_found', `Treino ${id} não existe nesta ficha. Consulte a ficha com get_routine e use os IDs exatos.`);
    if (!Array.isArray(w.exercises)) w.exercises = [];
    return w;
  };
  const findE = (w: WorkoutT, id: string) => {
    const e = w.exercises.find((x) => x.id === id);
    if (!e) throw new ToolError('exercise_not_found', `Exercício ${id} não existe no treino ${w.label}. Consulte a ficha com get_routine e use os IDs exatos.`);
    return e;
  };

  changes.forEach((c, i) => {
    switch (c.op) {
      case 'rename_routine':
        general.push({ kind: 'change', text: `Nome da ficha: "${String(doc.name)}" → "${c.name}"` });
        doc.name = c.name;
        break;
      case 'set_description':
        general.push({ kind: 'change', text: c.description ? `Descrição: "${c.description}"` : 'Descrição removida' });
        if (c.description) doc.description = c.description;
        else delete doc.description;
        break;
      case 'add_workout': {
        if (workouts.length >= 7) throw new ToolError('too_many_workouts', 'A ficha já tem 7 treinos (máximo).');
        const w = toWorkout(c.workout, ids.workouts[i]);
        workouts.push(w);
        push(w, { kind: 'add', text: `Novo treino com ${w.exercises.length} exercício(s)` });
        for (const e of w.exercises) push(w, { kind: 'add', text: describeExercise(e) });
        break;
      }
      case 'rename_workout': {
        const w = findW(c.workoutId);
        const before = workoutTitle(w);
        if (c.label) w.label = c.label;
        if (c.name) w.name = c.name;
        general.push({ kind: 'change', text: `${before} → ${workoutTitle(w)}` });
        break;
      }
      case 'remove_workout': {
        const w = findW(c.workoutId);
        if (workouts.length <= 1) throw new ToolError('last_workout', 'Não é possível remover o único treino da ficha.');
        workouts.splice(workouts.indexOf(w), 1);
        general.push({ kind: 'remove', text: `Remover ${workoutTitle(w)} (${w.exercises.length} exercício(s)). O histórico de treinos feitos não é apagado.` });
        break;
      }
      case 'add_exercise': {
        const w = findW(c.workoutId);
        if (w.exercises.length >= 20) throw new ToolError('too_many_exercises', `O treino ${w.label} já tem 20 exercícios (máximo).`);
        const e = toTemplate(c.exercise, ids.exercises[i]);
        const at = Math.min(c.position ?? w.exercises.length, w.exercises.length);
        w.exercises.splice(at, 0, e);
        push(w, { kind: 'add', text: `${describeExercise(e)}${c.position !== undefined ? ` (posição ${at + 1})` : ''}` });
        break;
      }
      case 'update_exercise': {
        const w = findW(c.workoutId);
        const e = findE(w, c.exerciseId);
        const before = describeExercise(e);
        for (const [k, v] of Object.entries(c.changes)) {
          if (v === undefined) continue;
          if (v === null) delete e[k];
          else e[k] = v;
        }
        if (typeof e.repMin === 'number' && typeof e.repMax === 'number' && e.repMax < e.repMin) throw new ToolError('invalid_reps', `Em ${e.name}, repMax ficaria menor que repMin.`);
        push(w, { kind: 'change', text: `${before}\n→ ${describeExercise(e)}` });
        break;
      }
      case 'remove_exercise': {
        const w = findW(c.workoutId);
        const e = findE(w, c.exerciseId);
        w.exercises.splice(w.exercises.indexOf(e), 1);
        push(w, { kind: 'remove', text: describeExercise(e) });
        break;
      }
      case 'move_exercise': {
        const w = findW(c.workoutId);
        const e = findE(w, c.exerciseId);
        const from = w.exercises.indexOf(e);
        w.exercises.splice(from, 1);
        const to = Math.min(c.toIndex, w.exercises.length);
        w.exercises.splice(to, 0, e);
        push(w, { kind: 'change', text: `${e.name}: posição ${from + 1} → ${to + 1}` });
        break;
      }
    }
  });
  doc.updatedAt = now;
  const sections = [...(general.length ? [{ title: 'Ficha', lines: general }] : []), ...[...byWorkout.entries()].map(([title, lines]) => ({ title, lines }))];
  return { doc, sections };
}
