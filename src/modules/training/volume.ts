import type { SessionExercise, SessionSet, WorkoutSession } from './types';
import { isValidDistanceM, isValidDurationSec } from './exerciseModel';

/** Série válida = concluída, não é aquecimento, com repetições > 0. Base de volume, recordes e 1RM antigos. */
export function isValidWorkingSet(s: SessionSet): boolean {
  return s.status === 'done' && s.type !== 'warmup' && (s.reps ?? 0) > 0;
}

/**
 * Série de trabalho concluída para contagem (P10): repetições > 0 ou, sem repetições, duração ou distância
 * válidas (exercícios por tempo e cardio). Registros antigos não têm duração nem distância, então a contagem
 * deles é idêntica à de `isValidWorkingSet`. Não entra em volume, recordes nem 1RM.
 */
export function isCompletedWorkSet(s: SessionSet): boolean {
  if (s.status !== 'done' || s.type === 'warmup') return false;
  return (s.reps ?? 0) > 0 || isValidDurationSec(s.durationSec) || isValidDistanceM(s.distance);
}

/** Volume (kg) de uma série = carga × repetições, apenas para séries válidas. */
export function setVolume(s: SessionSet): number {
  if (!isValidWorkingSet(s)) return 0;
  return (s.weight ?? 0) * (s.reps ?? 0);
}

export function exerciseVolume(ex: SessionExercise): number {
  return ex.sets.reduce((acc, s) => acc + setVolume(s), 0);
}

export function sessionVolume(session: WorkoutSession): number {
  return session.exercises.reduce((acc, ex) => acc + exerciseVolume(ex), 0);
}

export function validSetCount(session: WorkoutSession): number {
  return session.exercises.reduce((acc, ex) => acc + ex.sets.filter(isCompletedWorkSet).length, 0);
}

/** 1RM estimado (Epley). Útil para comparar séries com repetições diferentes. */
export function estimate1RM(weight: number, reps: number): number {
  if (weight <= 0 || reps <= 0) return 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

export interface ExerciseRecord {
  exerciseKey: string;
  name: string;
  maxWeight: number;
  maxWeightReps: number;
  maxWeightDate: number;
  best1RM: number;
  best1RMDate: number;
  maxReps: number;
  maxRepsWeight: number;
  maxRepsDate: number;
  bestSessionVolume: number;
  bestSessionVolumeDate: number;
}

/** Recordes pessoais por exercício a partir das sessões concluídas. */
export function computeRecords(sessions: WorkoutSession[]): Map<string, ExerciseRecord> {
  const map = new Map<string, ExerciseRecord>();
  const sorted = [...sessions].filter((s) => s.status === 'completed').sort((a, b) => a.startedAt - b.startedAt);
  for (const s of sorted) {
    for (const ex of s.exercises) {
      if (!ex.sets.some(isValidWorkingSet)) continue;
      let r = map.get(ex.exerciseKey);
      if (!r) {
        r = {
          exerciseKey: ex.exerciseKey,
          name: ex.name,
          maxWeight: 0,
          maxWeightReps: 0,
          maxWeightDate: 0,
          best1RM: 0,
          best1RMDate: 0,
          maxReps: 0,
          maxRepsWeight: 0,
          maxRepsDate: 0,
          bestSessionVolume: 0,
          bestSessionVolumeDate: 0,
        };
        map.set(ex.exerciseKey, r);
      }
      r.name = ex.name;
      for (const set of ex.sets) {
        if (!isValidWorkingSet(set)) continue;
        const w = set.weight ?? 0;
        const reps = set.reps ?? 0;
        const ts = set.completedAt ?? s.startedAt;
        if (w > r.maxWeight || (w === r.maxWeight && reps > r.maxWeightReps)) {
          r.maxWeight = w;
          r.maxWeightReps = reps;
          r.maxWeightDate = ts;
        }
        const e = estimate1RM(w, reps);
        if (e > r.best1RM) {
          r.best1RM = e;
          r.best1RMDate = ts;
        }
        if (reps > r.maxReps) {
          r.maxReps = reps;
          r.maxRepsWeight = w;
          r.maxRepsDate = ts;
        }
      }
      const vol = exerciseVolume(ex);
      if (vol > r.bestSessionVolume) {
        r.bestSessionVolume = vol;
        r.bestSessionVolumeDate = s.startedAt;
      }
    }
  }
  return map;
}

/** Quais exercícios desta sessão bateram recorde de carga ou 1RM estimado frente ao histórico anterior. */
export function sessionPRs(session: WorkoutSession, previous: WorkoutSession[]): string[] {
  const before = computeRecords(previous.filter((p) => p.id !== session.id && p.startedAt < session.startedAt));
  const prs: string[] = [];
  for (const ex of session.exercises) {
    const valid = ex.sets.filter(isValidWorkingSet);
    if (!valid.length) continue;
    const r = before.get(ex.exerciseKey);
    const maxW = Math.max(...valid.map((s) => s.weight ?? 0));
    const best = Math.max(...valid.map((s) => estimate1RM(s.weight ?? 0, s.reps ?? 0)));
    if (!r) continue; // primeira vez não conta como recorde
    if (maxW > r.maxWeight || best > r.best1RM + 0.01) prs.push(ex.name);
  }
  return prs;
}
