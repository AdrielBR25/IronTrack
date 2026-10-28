// Dados fictícios para testes de integridade, backup e migração.
// Nunca use medidas ou registros reais do usuário aqui.
import type { BodyEntry, DataSnapshot, ProgressPhoto, Routine, RotationState, SessionExercise, Settings, WorkoutSession } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/defaults';

export const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8=';

export function routine(id = 'r1', over: Partial<Routine> = {}): Routine {
  const ex = (wid: string, n: number) => ({
    id: `${wid}-e${n}`,
    name: `Exercício ${wid}${n}`,
    muscleGroup: 'Peito',
    category: 'compound' as const,
    equipment: 'barbell' as const,
    sets: 3,
    repMin: 6,
    repMax: 10,
    restSec: 120,
    warmupSets: 0,
  });
  return {
    id,
    name: `Rotina ${id}`,
    workouts: ['A', 'B', 'C'].map((l) => ({ id: `${id}-${l}`, label: l, name: `Treino ${l}`, exercises: [ex(`${id}-${l}`, 1), ex(`${id}-${l}`, 2)] })),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function sessionExercise(id: string, weight: number): SessionExercise {
  return {
    id: `${id}-x`,
    exerciseKey: 'supino',
    name: 'Supino',
    muscleGroup: 'Peito',
    category: 'compound',
    equipment: 'barbell',
    repMin: 6,
    repMax: 10,
    restSec: 120,
    plannedSets: 1,
    sets: [{ id: `${id}-s1`, type: 'normal', status: 'done', weight, reps: 8, completedAt: 1_700_000_100_000 }],
  };
}

export function session(id: string, over: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    id,
    routineId: 'r1',
    workoutId: 'r1-A',
    workoutLabel: 'A',
    workoutName: 'Treino A',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_360_000,
    durationSec: 360,
    exercises: [sessionExercise(id, 60)],
    updatedAt: 1_700_000_360_000,
    ...over,
  };
}

export function entry(id: string, over: Partial<BodyEntry> = {}): BodyEntry {
  return { id, date: '2026-01-10', weightKg: 80, waistCm: 85, bodyFatPct: 18, source: 'manual', createdAt: 1_700_000_000_000, ...over };
}

export function photo(id: string, entryId: string, over: Partial<ProgressPhoto> = {}): ProgressPhoto {
  return { id, entryId, dataUrl: PHOTO, createdAt: 1_700_000_000_000, ...over };
}

export function rotation(routineId = 'r1', nextIndex = 1): RotationState {
  return { routineId, nextIndex, updatedAt: 1_700_000_000_000 };
}

export function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, activeRoutineId: 'r1', ...over, id: 'settings' };
}

export function snapshot(over: Partial<DataSnapshot> = {}): DataSnapshot {
  return {
    settings: settings(),
    routines: [routine()],
    sessions: [session('s1'), session('s2', { workoutId: 'r1-B', workoutLabel: 'B', workoutName: 'Treino B', startedAt: 1_700_100_000_000, finishedAt: 1_700_100_300_000 })],
    rotations: [rotation()],
    overrides: [{ routineId: 'r1', date: '2026-01-12', kind: 'workout', workoutId: 'r1-C' }, { routineId: 'r1', date: '2026-01-13', kind: 'rest' }],
    bodyEntries: [entry('b1'), entry('b2', { date: '2026-02-10', weightKg: 79 })],
    photos: [photo('p1', 'b1'), photo('p2', 'b2')],
    goals: [],
    planEntries: [],
    ...over,
  };
}

export function backupOf(data: DataSnapshot) {
  return { app: 'irontrack' as const, kind: 'backup' as const, schemaVersion: 1, exportedAt: '2026-01-15T12:00:00.000Z', data };
}
