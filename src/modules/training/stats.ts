import { addDays, startOfWeek, tsToISODate, weekday } from '@/lib/dates';
import type { WorkoutSession } from './types';
import { exerciseVolume, isValidWorkingSet, sessionVolume } from './volume';

export function sessionsInRange(sessions: WorkoutSession[], fromISO: string, toISOExclusive: string) {
  return sessions.filter((s) => {
    const d = tsToISODate(s.startedAt);
    return s.status === 'completed' && d >= fromISO && d < toISOExclusive;
  });
}

export interface WeekStats {
  count: number;
  durationSec: number;
  volume: number;
  prevVolume: number;
  prevCount: number;
  /** Dias (yyyy-mm-dd) da semana atual com treino concluído. */
  doneDays: Set<string>;
}

export function weekStats(sessions: WorkoutSession[], today: string): WeekStats {
  const mon = startOfWeek(today);
  const next = addDays(mon, 7);
  const prevMon = addDays(mon, -7);
  const cur = sessionsInRange(sessions, mon, next);
  const prev = sessionsInRange(sessions, prevMon, mon);
  return {
    count: cur.length,
    durationSec: cur.reduce((a, s) => a + (s.durationSec ?? 0), 0),
    volume: cur.reduce((a, s) => a + sessionVolume(s), 0),
    prevVolume: prev.reduce((a, s) => a + sessionVolume(s), 0),
    prevCount: prev.length,
    doneDays: new Set(cur.map((s) => tsToISODate(s.startedAt))),
  };
}

/** Consistência nas últimas 4 semanas: dias treinados / dias de treino planejados até hoje. */
export function consistency(sessions: WorkoutSession[], today: string, trainingDays: number[], since?: string): { pct: number; done: number; planned: number } {
  let start = addDays(startOfWeek(today), -21);
  // Não conta dias anteriores ao início do uso do app.
  if (since && since > start) start = since;
  let planned = 0;
  for (let d = start; d <= today; d = addDays(d, 1)) if (trainingDays.includes(weekday(d))) planned++;
  const days = new Set(sessionsInRange(sessions, start, addDays(today, 1)).map((s) => tsToISODate(s.startedAt)));
  const done = days.size;
  return { pct: planned ? Math.min(100, Math.round((done / planned) * 100)) : 0, done, planned };
}

export interface WeeklyPoint {
  week: string;
  volume: number;
  count: number;
  sets: number;
  durationSec: number;
}

export function weeklySeries(sessions: WorkoutSession[], today: string, weeks = 12): WeeklyPoint[] {
  const mon = startOfWeek(today);
  const out: WeeklyPoint[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const from = addDays(mon, -7 * i);
    const list = sessionsInRange(sessions, from, addDays(from, 7));
    out.push({
      week: from,
      volume: list.reduce((a, s) => a + sessionVolume(s), 0),
      count: list.length,
      sets: list.reduce((a, s) => a + s.exercises.reduce((b, e) => b + e.sets.filter(isValidWorkingSet).length, 0), 0),
      durationSec: list.reduce((a, s) => a + (s.durationSec ?? 0), 0),
    });
  }
  return out;
}

export function setsByMuscle(sessions: WorkoutSession[], fromISO: string, toISOExclusive: string): { group: string; sets: number }[] {
  const map = new Map<string, number>();
  for (const s of sessionsInRange(sessions, fromISO, toISOExclusive))
    for (const e of s.exercises) {
      const n = e.sets.filter(isValidWorkingSet).length;
      if (n) map.set(e.muscleGroup, (map.get(e.muscleGroup) ?? 0) + n);
    }
  return [...map.entries()].map(([group, sets]) => ({ group, sets })).sort((a, b) => b.sets - a.sets);
}

export interface ExercisePoint {
  date: number;
  maxWeight: number;
  best1RM: number;
  bestReps: number;
  totalReps: number;
  volume: number;
}

export function exerciseSeries(sessions: WorkoutSession[], key: string): ExercisePoint[] {
  const out: ExercisePoint[] = [];
  for (const s of [...sessions].filter((x) => x.status === 'completed').sort((a, b) => a.startedAt - b.startedAt)) {
    const ex = s.exercises.find((e) => e.exerciseKey === key);
    if (!ex) continue;
    const valid = ex.sets.filter(isValidWorkingSet);
    if (!valid.length) continue;
    out.push({
      date: s.startedAt,
      maxWeight: Math.max(...valid.map((v) => v.weight ?? 0)),
      best1RM: Math.max(...valid.map((v) => ((v.weight ?? 0) > 0 ? (v.weight ?? 0) * (1 + (v.reps ?? 0) / 30) : 0))),
      bestReps: Math.max(...valid.map((v) => v.reps ?? 0)),
      totalReps: valid.reduce((a, v) => a + (v.reps ?? 0), 0),
      volume: exerciseVolume(ex),
    });
  }
  return out;
}

export function exerciseCatalog(sessions: WorkoutSession[]): { key: string; name: string; count: number }[] {
  const map = new Map<string, { key: string; name: string; count: number }>();
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    for (const e of s.exercises) {
      if (!e.sets.some(isValidWorkingSet)) continue;
      const cur = map.get(e.exerciseKey) ?? { key: e.exerciseKey, name: e.name, count: 0 };
      cur.count++;
      cur.name = e.name;
      map.set(e.exerciseKey, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}
