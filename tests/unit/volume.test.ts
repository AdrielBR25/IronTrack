import { describe, expect, it } from 'vitest';
import { computeRecords, estimate1RM, exerciseVolume, sessionPRs, sessionVolume, setVolume } from '@/lib/volume';
import type { SessionSet, WorkoutSession } from '@/lib/types';

const set = (p: Partial<SessionSet>): SessionSet => ({ id: Math.random().toString(), type: 'normal', status: 'done', weight: 50, reps: 10, ...p });

function mk(id: string, startedAt: number, sets: SessionSet[]): WorkoutSession {
  return {
    id, routineId: 'r', workoutId: 'A', workoutLabel: 'A', workoutName: 'A', status: 'completed', startedAt, updatedAt: 0,
    exercises: [{ id: 'e', exerciseKey: 'supino', name: 'Supino', muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', repMin: 6, repMax: 10, restSec: 150, plannedSets: 3, sets }],
  };
}

describe('volume', () => {
  it('conta só séries válidas: concluídas, sem aquecimento', () => {
    expect(setVolume(set({}))).toBe(500);
    expect(setVolume(set({ type: 'warmup' }))).toBe(0);
    expect(setVolume(set({ status: 'pending' }))).toBe(0);
    expect(setVolume(set({ status: 'skipped' }))).toBe(0);
    expect(setVolume(set({ type: 'drop', weight: 30, reps: 8 }))).toBe(240);
    expect(setVolume(set({ reps: 0 }))).toBe(0);
  });
  it('soma por exercício e por sessão', () => {
    const s = mk('1', 1, [set({ type: 'warmup', weight: 20 }), set({}), set({ reps: 8 }), set({ weight: 52.5, reps: 6 })]);
    expect(exerciseVolume(s.exercises[0])).toBe(500 + 400 + 315);
    expect(sessionVolume(s)).toBe(1215);
  });
  it('1RM estimado (Epley)', () => {
    expect(estimate1RM(100, 1)).toBe(100);
    expect(estimate1RM(100, 10)).toBeCloseTo(133.33, 1);
    expect(estimate1RM(0, 10)).toBe(0);
  });
  it('recordes e PRs da sessão', () => {
    const a = mk('1', 1, [set({ weight: 50, reps: 10 })]);
    const b = mk('2', 2, [set({ weight: 55, reps: 6 })]);
    const rec = computeRecords([a, b]).get('supino')!;
    expect(rec.maxWeight).toBe(55);
    expect(rec.maxReps).toBe(10);
    expect(sessionPRs(b, [a])).toEqual(['Supino']);
    expect(sessionPRs(a, [])).toEqual([]);
  });
});
