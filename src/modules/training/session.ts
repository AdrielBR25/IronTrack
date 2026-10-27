import type { RestDefaults, Routine, SessionExercise, SessionSet, SetType, Workout, WorkoutSession } from './types';
import { exerciseKey, uid } from '@/lib/utils';
import { fmtRepRange } from './routineSchema';

// Lógica pura da sessão de treino. Cada operação devolve uma nova sessão,
// que é persistida no IndexedDB a cada alteração (recuperação de sessão).

export interface ExerciseHistoryEntry {
  sessionId: string;
  date: number;
  sets: SessionSet[];
}

/** Sessões concluídas com o exercício, da mais recente para a mais antiga. */
export function historyFor(key: string, sessions: WorkoutSession[], limit = 5): ExerciseHistoryEntry[] {
  const out: ExerciseHistoryEntry[] = [];
  const sorted = sessions.filter((s) => s.status === 'completed').sort((a, b) => b.startedAt - a.startedAt);
  for (const s of sorted) {
    const ex = s.exercises.find((e) => e.exerciseKey === key);
    if (ex && ex.sets.some((x) => x.status === 'done')) {
      out.push({ sessionId: s.id, date: s.startedAt, sets: ex.sets.filter((x) => x.status === 'done') });
      if (out.length >= limit) break;
    }
  }
  return out;
}

function roundPlate(n: number) {
  return Math.round(n / 2.5) * 2.5;
}

function buildSets(
  plannedSets: number,
  warmupSets: number,
  repMin: number,
  repMax: number,
  targetWeight: number | undefined,
  last: SessionSet[] | undefined,
): SessionSet[] {
  const lastNormal = (last ?? []).filter((s) => s.type === 'normal');
  const lastWarm = (last ?? []).filter((s) => s.type === 'warmup');
  const topLastWeight = lastNormal.length ? Math.max(...lastNormal.map((s) => s.weight ?? 0)) : undefined;
  const plannedWeight = targetWeight ?? topLastWeight ?? null;
  const plannedReps = fmtRepRange(repMin, repMax);
  const sets: SessionSet[] = [];
  for (let i = 0; i < warmupSets; i++) {
    const prev = lastWarm[i];
    const base = plannedWeight ?? 0;
    const pct = warmupSets === 1 ? 0.5 : 0.4 + (0.3 * i) / Math.max(1, warmupSets - 1);
    sets.push({
      id: uid(),
      type: 'warmup',
      status: 'pending',
      weight: prev?.weight ?? (base ? roundPlate(base * pct) : null),
      reps: prev?.reps ?? 8,
      plannedWeight: null,
      plannedReps: null,
    });
  }
  for (let i = 0; i < plannedSets; i++) {
    const prev = lastNormal[i] ?? lastNormal[lastNormal.length - 1];
    sets.push({
      id: uid(),
      type: 'normal',
      status: 'pending',
      weight: prev?.weight ?? targetWeight ?? null,
      reps: prev?.reps ?? repMax,
      plannedWeight,
      plannedReps,
    });
  }
  return sets;
}

export function buildSession(routine: Routine, workout: Workout, history: WorkoutSession[], now = Date.now()): WorkoutSession {
  const exercises: SessionExercise[] = workout.exercises.map((t) => {
    const key = exerciseKey(t.name);
    const last = historyFor(key, history, 1)[0];
    return {
      id: uid(),
      exerciseKey: key,
      templateId: t.id,
      name: t.name,
      muscleGroup: t.muscleGroup,
      category: t.category,
      equipment: t.equipment,
      repMin: t.repMin,
      repMax: t.repMax,
      restSec: t.restSec,
      plannedSets: t.sets,
      notes: t.notes,
      sets: buildSets(t.sets, t.warmupSets, t.repMin, t.repMax, t.targetWeight, last?.sets),
    };
  });
  return {
    id: uid(),
    routineId: routine.id,
    workoutId: workout.id,
    workoutLabel: workout.label,
    workoutName: workout.name,
    status: 'active',
    startedAt: now,
    exercises,
    rest: null,
    focusExerciseId: exercises[0]?.id,
    updatedAt: now,
  };
}

function mapSet(session: WorkoutSession, exId: string, setId: string, fn: (s: SessionSet) => SessionSet): WorkoutSession {
  return {
    ...session,
    updatedAt: Date.now(),
    exercises: session.exercises.map((e) => (e.id !== exId ? e : { ...e, sets: e.sets.map((s) => (s.id === setId ? fn(s) : s)) })),
  };
}

export function updateSet(session: WorkoutSession, exId: string, setId: string, patch: Partial<SessionSet>): WorkoutSession {
  return mapSet(session, exId, setId, (s) => ({ ...s, ...patch }));
}

export function completeSet(session: WorkoutSession, exId: string, setId: string, now = Date.now()): WorkoutSession {
  return { ...mapSet(session, exId, setId, (s) => ({ ...s, status: 'done', completedAt: now })), focusExerciseId: exId };
}

/**
 * Ao concluir uma série, repassa a carga usada para as próximas séries pendentes
 * do mesmo tipo no exercício que ainda não foram editadas manualmente.
 */
export function carryForwardWeight(session: WorkoutSession, exId: string, setId: string): WorkoutSession {
  const ex = session.exercises.find((e) => e.id === exId);
  const done = ex?.sets.find((s) => s.id === setId);
  if (!ex || !done || done.weight === null || done.type === 'drop') return session;
  const idx = ex.sets.indexOf(done);
  return {
    ...session,
    exercises: session.exercises.map((e) =>
      e.id !== exId
        ? e
        : { ...e, sets: e.sets.map((s, i) => (i > idx && s.status === 'pending' && s.type === done.type && !s.edited ? { ...s, weight: done.weight } : s)) },
    ),
  };
}

export function undoSet(session: WorkoutSession, exId: string, setId: string): WorkoutSession {
  const next = mapSet(session, exId, setId, (s) => ({ ...s, status: 'pending', completedAt: undefined }));
  // Desfazer a série que originou o descanso cancela o descanso.
  if (next.rest && next.rest.setId === setId) next.rest = null;
  return next;
}

export function skipSet(session: WorkoutSession, exId: string, setId: string): WorkoutSession {
  return mapSet(session, exId, setId, (s) => ({ ...s, status: 'skipped' }));
}

export function addSet(session: WorkoutSession, exId: string, type: SetType = 'normal'): WorkoutSession {
  return {
    ...session,
    updatedAt: Date.now(),
    exercises: session.exercises.map((e) => {
      if (e.id !== exId) return e;
      const ref = [...e.sets].reverse().find((s) => s.type !== 'warmup') ?? e.sets[e.sets.length - 1];
      const weight = ref?.weight ?? null;
      const set: SessionSet = {
        id: uid(),
        type,
        status: 'pending',
        weight: type === 'drop' && weight ? Math.round((weight * 0.75) / 2.5) * 2.5 : weight,
        reps: ref?.reps ?? e.repMax,
        plannedWeight: null,
        plannedReps: null,
      };
      return { ...e, sets: [...e.sets, set] };
    }),
  };
}

export function removeSet(session: WorkoutSession, exId: string, setId: string): WorkoutSession {
  return {
    ...session,
    updatedAt: Date.now(),
    exercises: session.exercises.map((e) => (e.id !== exId ? e : { ...e, sets: e.sets.filter((s) => s.id !== setId) })),
  };
}

export function substituteExercise(session: WorkoutSession, exId: string, newName: string, history: WorkoutSession[]): WorkoutSession {
  const key = exerciseKey(newName);
  const last = historyFor(key, history, 1)[0];
  return {
    ...session,
    updatedAt: Date.now(),
    exercises: session.exercises.map((e) => {
      if (e.id !== exId) return e;
      const lastNormal = (last?.sets ?? []).filter((s) => s.type === 'normal');
      let n = 0;
      return {
        ...e,
        name: newName,
        exerciseKey: key,
        substitutedFrom: e.substitutedFrom ?? e.name,
        sets: e.sets.map((s) => {
          if (s.status !== 'pending' || s.type === 'warmup') return s;
          const prev = lastNormal[n] ?? lastNormal[lastNormal.length - 1];
          n++;
          return { ...s, weight: prev?.weight ?? null, reps: prev?.reps ?? e.repMax, plannedWeight: prev?.weight ?? null };
        }),
      };
    }),
  };
}

export function skipExercise(session: WorkoutSession, exId: string): WorkoutSession {
  return {
    ...session,
    updatedAt: Date.now(),
    exercises: session.exercises.map((e) =>
      e.id !== exId ? e : { ...e, sets: e.sets.map((s) => (s.status === 'pending' ? { ...s, status: 'skipped' } : s)) },
    ),
  };
}

export interface SetRef {
  exerciseId: string;
  setId: string;
}

/** Próxima série pendente, começando pelo exercício indicado e seguindo a ordem. */
export function nextPending(session: WorkoutSession, fromExerciseId?: string): SetRef | null {
  const exs = session.exercises;
  const start = Math.max(0, fromExerciseId ? exs.findIndex((e) => e.id === fromExerciseId) : 0);
  for (let k = 0; k < exs.length; k++) {
    const e = exs[(start + k) % exs.length];
    const s = e.sets.find((x) => x.status === 'pending');
    if (s) return { exerciseId: e.id, setId: s.id };
  }
  return null;
}

export function setLabel(session: WorkoutSession, ref: SetRef): string {
  const ex = session.exercises.find((e) => e.id === ref.exerciseId);
  if (!ex) return '';
  const set = ex.sets.find((s) => s.id === ref.setId);
  if (!set) return ex.name;
  const sameType = ex.sets.filter((s) => s.type === set.type);
  const n = sameType.indexOf(set) + 1;
  const t = set.type === 'warmup' ? `Aquecimento ${n}` : set.type === 'drop' ? `Drop-set ${n}` : `Série ${n}`;
  return `${ex.name} · ${t}`;
}

/** Descanso após concluir uma série (0 = sem descanso). */
export function restAfter(session: WorkoutSession, done: SetRef, next: SetRef | null, settings: Pick<RestDefaults, 'restWarmupSec'>): number {
  if (!next) return 0;
  const ex = session.exercises.find((e) => e.id === done.exerciseId);
  const set = ex?.sets.find((s) => s.id === done.setId);
  const nextEx = session.exercises.find((e) => e.id === next.exerciseId);
  const nextSet = nextEx?.sets.find((s) => s.id === next.setId);
  if (!ex || !set) return 0;
  if (nextSet?.type === 'drop') return 0;
  if (set.type === 'warmup') return settings.restWarmupSec;
  return ex.restSec;
}

export function sessionProgress(session: WorkoutSession): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const e of session.exercises)
    for (const s of e.sets) {
      if (s.status === 'skipped') continue;
      total++;
      if (s.status === 'done') done++;
    }
  return { done, total };
}

export function finishSession(session: WorkoutSession, now = Date.now(), notes?: string): WorkoutSession {
  return {
    ...session,
    status: 'completed',
    finishedAt: now,
    durationSec: Math.max(0, Math.round((now - session.startedAt) / 1000)),
    notes: notes ?? session.notes,
    rest: null,
    updatedAt: now,
  };
}

/**
 * Sugestões para substituir um exercício durante o treino: primeiro os substitutos
 * cadastrados no modelo do exercício, depois outros exercícios da rotina do mesmo grupo
 * muscular. Sem repetições, no máximo 8.
 */
export function substituteOptions(routine: Routine | undefined, ex: Pick<SessionExercise, 'templateId' | 'muscleGroup' | 'name'>): string[] {
  const templates = routine?.workouts.flatMap((w) => w.exercises) ?? [];
  const tpl = templates.find((t) => t.id === ex.templateId);
  const fromTpl = tpl?.substitutes ?? [];
  const sameGroup = templates.filter((t) => t.muscleGroup === ex.muscleGroup && t.name !== ex.name).map((t) => t.name);
  return [...new Set([...fromTpl, ...sameGroup])].slice(0, 8);
}
