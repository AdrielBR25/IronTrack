// Dados fictícios do modelo de exercícios v3 (P10): tempo, cardio, unilateral e peso corporal.
// Nunca use registros reais do usuário aqui.
import type { ExerciseTemplate, Routine, SessionExercise, SessionSet, WorkoutSession } from '@/lib/types';
import { routine, session, snapshot } from './fixtures';
import type { DataSnapshot } from '@/lib/types';

export const tpl = (id: string, over: Partial<ExerciseTemplate> = {}): ExerciseTemplate => ({
  id,
  name: `Exercício ${id}`,
  muscleGroup: 'Peito',
  category: 'compound',
  equipment: 'barbell',
  sets: 3,
  repMin: 8,
  repMax: 12,
  restSec: 60,
  warmupSets: 0,
  ...over,
});

export const PLANK = tpl('prancha', { name: 'Prancha', muscleGroup: 'Abdômen', equipment: 'bodyweight', modality: 'timed', loadMode: 'corporal', targetDurationSec: 45 });
export const RUN = tpl('corrida', { name: 'Corrida', muscleGroup: 'Cardio', equipment: 'other', sets: 1, modality: 'cardio', distanceUnit: 'km', targetDurationSec: 1800, targetDistance: 5000 });
export const LUNGE = tpl('afundo', { name: 'Afundo', muscleGroup: 'Quadríceps', equipment: 'dumbbell', modality: 'resistance', laterality: 'unilateral', secondaryMuscles: ['Glúteos'] });
export const PULLUP = tpl('barra', { name: 'Barra fixa assistida', muscleGroup: 'Costas', equipment: 'machine', modality: 'bodyweight', loadMode: 'assistida' });
export const DIP = tpl('paralelas', { name: 'Paralelas', muscleGroup: 'Tríceps', equipment: 'bodyweight', modality: 'bodyweight', loadMode: 'adicional' });

/** Rotina com um treino de cada modalidade (mais um exercício antigo, sem metadados). */
export function modelRoutine(id = 'r1'): Routine {
  const r = routine(id);
  // Cópias: os testes alteram registros sem contaminar as constantes.
  r.workouts[0].exercises = structuredClone([r.workouts[0].exercises[0], PLANK, RUN, LUNGE, PULLUP, DIP]);
  return r;
}

let n = 0;
export function sx(t: ExerciseTemplate, sets: Partial<SessionSet>[]): SessionExercise {
  const { id: _id, sets: _n, warmupSets: _w, targetWeight: _t, substitutes: _s, ...rest } = t;
  return {
    ...rest,
    id: `${t.id}-x${++n}`,
    exerciseKey: t.id,
    templateId: t.id,
    plannedSets: t.sets,
    sets: sets.map((s, i) => ({ id: `${t.id}-s${n}-${i}`, type: 'normal', status: 'done', weight: null, reps: null, completedAt: 1_700_000_100_000, ...s })),
  };
}

/** Sessão concluída com todas as modalidades registradas. */
export function modelSession(id: string, startedAt = 1_700_000_000_000, over: Partial<WorkoutSession> = {}): WorkoutSession {
  return session(id, {
    startedAt,
    finishedAt: startedAt + 3_600_000,
    exercises: [
      sx(PLANK, [{ durationSec: 45 }, { durationSec: 60 }]),
      sx(RUN, [{ durationSec: 1500, distance: 5000 }]),
      sx(LUNGE, [
        { side: 'direito', weight: 20, reps: 10 },
        { side: 'esquerdo', weight: 20, reps: 9 },
      ]),
      sx(PULLUP, [{ assistanceKg: 25, reps: 8 }]),
      sx(DIP, [{ weight: 10, reps: 8 }, { weight: null, reps: 12 }]),
    ],
    ...over,
  });
}

/** Retrato com dados antigos e dados do modelo v3. */
export function modelSnapshot(): DataSnapshot {
  const d = snapshot();
  d.routines = [modelRoutine()];
  d.sessions.push(modelSession('m1'), modelSession('m2', 1_700_200_000_000));
  return d;
}
