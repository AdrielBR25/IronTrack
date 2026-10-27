import { addDays, weekday } from './dates';
import type { DayOverride, RotationPolicy, WorkoutSession } from './types';
import { isValidWorkingSet } from './volume';

// Rotação contínua (A → B → C → A ...). Um ponteiro (nextIndex) indica o próximo
// treino. Ele só muda por ação do usuário: concluir treino (conforme a política),
// pular, reagendar ou corrigir manualmente. Abrir o app nunca avança a rotação.

export type DayPlanKind = 'workout' | 'rest' | 'done';

export interface DayPlan {
  date: string;
  kind: DayPlanKind;
  workoutId?: string;
  source: 'rotation' | 'override' | 'done' | 'off';
}

export function normIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  return ((i % n) + n) % n;
}

/** Novo ponteiro após concluir um treino: segue do treino realizado. */
export function indexAfter(order: string[], completedWorkoutId: string, currentIndex: number): number {
  const i = order.indexOf(completedWorkoutId);
  if (i === -1) return normIndex(currentIndex, order.length);
  return normIndex(i + 1, order.length);
}

export function skipIndex(order: string[], currentIndex: number, steps = 1): number {
  return normIndex(currentIndex + steps, order.length);
}

/** Fração (0–100) de séries válidas concluídas em relação às planejadas. */
export function completionPct(session: WorkoutSession): number {
  let planned = 0;
  let done = 0;
  for (const ex of session.exercises) {
    planned += ex.plannedSets;
    done += Math.min(ex.plannedSets, ex.sets.filter((s) => s.type !== 'warmup' && s.status === 'done').length);
  }
  if (planned === 0) return 0;
  return Math.round((done / planned) * 100);
}

export function shouldAdvance(session: WorkoutSession, policy: RotationPolicy, thresholdPct: number): boolean {
  const anyValid = session.exercises.some((e) => e.sets.some(isValidWorkingSet));
  if (!anyValid) return false;
  if (policy === 'finish') return true;
  return completionPct(session) >= thresholdPct;
}

export interface ProjectInput {
  order: string[];
  nextIndex: number;
  trainingDays: number[];
  overrides: Map<string, DayOverride>;
  /** Treinos concluídos por data (yyyy-mm-dd → workoutId). */
  doneByDate: Map<string, string>;
  start: string;
  days: number;
}

export function projectSchedule(input: ProjectInput): DayPlan[] {
  const { order, trainingDays, overrides, doneByDate, start, days } = input;
  const n = order.length;
  let p = normIndex(input.nextIndex, n);
  const out: DayPlan[] = [];
  for (let k = 0; k < days; k++) {
    const date = addDays(start, k);
    const done = doneByDate.get(date);
    if (done) {
      out.push({ date, kind: 'done', workoutId: done, source: 'done' });
      continue;
    }
    const ov = overrides.get(date);
    if (ov?.kind === 'rest') {
      out.push({ date, kind: 'rest', source: 'override' });
      continue;
    }
    if (ov?.kind === 'workout' && ov.workoutId && order.includes(ov.workoutId)) {
      out.push({ date, kind: 'workout', workoutId: ov.workoutId, source: 'override' });
      p = indexAfter(order, ov.workoutId, p);
      continue;
    }
    if (n > 0 && trainingDays.includes(weekday(date))) {
      out.push({ date, kind: 'workout', workoutId: order[p], source: 'rotation' });
      p = normIndex(p + 1, n);
    } else {
      out.push({ date, kind: 'rest', source: 'off' });
    }
  }
  return out;
}
