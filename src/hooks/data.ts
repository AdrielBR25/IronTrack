import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { db, mergeSettings } from '@/db/db';
import type { DayOverride, LocalProfile, Routine, Settings, WorkoutSession } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { projectSchedule, type DayPlan } from '@/modules/training';
import { todayISO, tsToISODate } from '@/lib/dates';

export function useSettings(): Settings {
  const s = useLiveQuery(() => db.settings.get('settings'), []);
  return useMemo(() => (s ? mergeSettings(s) : DEFAULT_SETTINGS), [s]);
}

/** Perfil local atual (undefined enquanto carrega). */
export function useCurrentProfile(): LocalProfile | undefined {
  return useLiveQuery(async () => (db.currentProfileId ? db.profiles.get(db.currentProfileId) : undefined), []);
}

export function useSettingsLoaded(): boolean {
  return useLiveQuery(async () => true, []) ?? false;
}

export function useRoutines(): Routine[] | undefined {
  return useLiveQuery(() => db.routines.orderBy('updatedAt').reverse().toArray(), []);
}

export function useActiveRoutine(): { routine: Routine | null | undefined; settings: Settings } {
  const settings = useSettings();
  const routine = useLiveQuery(async () => {
    const s = await db.settings.get('settings');
    const id = s?.activeRoutineId;
    if (id) {
      const r = await db.routines.get(id);
      if (r) return r;
    }
    return (await db.routines.toCollection().first()) ?? null;
  }, []);
  return { routine, settings };
}

/** Rotina pelo ID (undefined enquanto carrega ou se não existe). */
export function useRoutine(id: string | undefined): Routine | undefined {
  return useLiveQuery(() => (id ? db.routines.get(id) : undefined), [id]);
}

/** Sessão pelo ID (undefined enquanto carrega ou se não existe). */
export function useSession(id: string | undefined): WorkoutSession | undefined {
  return useLiveQuery(() => (id ? db.sessions.get(id) : undefined), [id]);
}

export function useActiveSession(): WorkoutSession | null | undefined {
  return useLiveQuery(async () => (await db.sessions.where('status').equals('active').first()) ?? null, []);
}

export function useCompletedSessions(): WorkoutSession[] | undefined {
  return useLiveQuery(() => db.sessions.where('status').equals('completed').sortBy('startedAt'), []);
}

export function useRotation(routineId: string | undefined) {
  return useLiveQuery(async () => {
    if (!routineId) return null;
    const rot = (await db.rotations.get(routineId)) ?? { routineId, nextIndex: 0, updatedAt: 0 };
    const overrides = await db.overrides.where('routineId').equals(routineId).toArray();
    return { rot, overrides };
  }, [routineId]);
}

/** Agenda projetada a partir de hoje (considera treinos já concluídos hoje). */
export function useSchedule(routine: Routine | null | undefined, settings: Settings, days = 14): { plan: DayPlan[]; nextIndex: number; overrides: DayOverride[] } | null {
  const rotation = useRotation(routine?.id);
  const today = useToday();
  const todayDone = useLiveQuery(async () => {
    if (!routine) return [] as WorkoutSession[];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return db.sessions.where('startedAt').aboveOrEqual(start.getTime()).filter((s) => s.status === 'completed' && s.routineId === routine.id).toArray();
  }, [routine?.id, today]);
  return useMemo(() => {
    if (!routine || !rotation || !todayDone) return null;
    const done = new Map<string, string>();
    for (const s of todayDone) done.set(tsToISODate(s.startedAt), s.workoutId);
    const ov = new Map(rotation.overrides.map((o) => [o.date, o]));
    const plan = projectSchedule({
      order: routine.workouts.map((w) => w.id),
      nextIndex: rotation.rot.nextIndex,
      trainingDays: settings.trainingDays,
      overrides: ov,
      doneByDate: done,
      start: today,
      days,
    });
    return { plan, nextIndex: rotation.rot.nextIndex, overrides: rotation.overrides };
  }, [routine, rotation, todayDone, settings.trainingDays, today, days]);
}

/** Data de hoje que se atualiza à meia-noite / ao voltar para o app. */
export function useToday(): string {
  const [d, setD] = useState(todayISO());
  useEffect(() => {
    const check = () => setD(todayISO());
    const id = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return d;
}

/** Relógio para redesenho; o valor real vem sempre de Date.now(). */
export function useNow(intervalMs = 250, enabled = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [intervalMs, enabled]);
  return now;
}
