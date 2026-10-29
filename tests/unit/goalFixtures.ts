// Dados fictícios para os testes de metas (P12). Nunca use registros reais do usuário aqui.
import type { ExerciseTemplate, Routine, SessionExercise, SessionSet, WorkoutSession } from '@/lib/types';
import { newGoal, type GoalExerciseRef, type GoalFields, type TrainingGoal } from '@/modules/goals';

export const PROFILE = '11111111-1111-4111-8111-111111111111';
export const OTHER_PROFILE = '22222222-2222-4222-8222-222222222222';

const tpl = (id: string, name: string, over: Partial<ExerciseTemplate> = {}): ExerciseTemplate => ({
  id,
  name,
  muscleGroup: 'Peito',
  category: 'compound',
  equipment: 'barbell',
  sets: 3,
  repMin: 6,
  repMax: 10,
  restSec: 90,
  warmupSets: 0,
  ...over,
});

/** Rotina com um exercício de cada tipo; o supino aparece nos treinos A e B (IDs diferentes). */
export function goalRoutine(id = 'gr', over: Partial<Routine> = {}): Routine {
  return {
    id,
    profileId: PROFILE,
    name: 'Rotina de metas',
    workouts: [
      {
        id: `${id}-A`,
        label: 'A',
        name: 'Treino A',
        exercises: [
          tpl('sup-A', 'Supino reto', { modality: 'resistance', loadMode: 'externa' }),
          tpl('pr', 'Prancha', { modality: 'timed', loadMode: 'corporal', equipment: 'bodyweight', category: 'isolation' }),
          tpl('rem', 'Remada unilateral', { modality: 'resistance', laterality: 'unilateral', equipment: 'dumbbell' }),
        ],
      },
      {
        id: `${id}-B`,
        label: 'B',
        name: 'Treino B',
        exercises: [
          tpl('sup-B', 'Supino reto', { modality: 'resistance', loadMode: 'externa' }),
          tpl('cor', 'Corrida', { modality: 'cardio', distanceUnit: 'km', equipment: 'other' }),
          tpl('bar', 'Barra fixa', { modality: 'bodyweight', loadMode: 'adicional', equipment: 'bodyweight' }),
          tpl('flex', 'Flexão', { modality: 'bodyweight', loadMode: 'corporal', equipment: 'bodyweight' }),
          tpl('leg', 'Leg press'),
        ],
      },
    ],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

/** Outra rotina com um "Supino reto" diferente (mesmo nome, outro exercício). */
export function otherRoutine(): Routine {
  return {
    id: 'outra',
    profileId: PROFILE,
    name: 'Rotina de viagem',
    workouts: [{ id: 'outra-A', label: 'A', name: 'Hotel', exercises: [tpl('sup-X', 'Supino reto', { modality: 'resistance', equipment: 'dumbbell' })] }],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

/** Timestamp local (10h) de uma data yyyy-mm-dd. */
export const at = (date: string, hour = 10) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, hour).getTime();
};

let setN = 0;
export const set = (weight: number | null, reps: number | null, over: Partial<SessionSet> = {}): SessionSet => ({ id: `set-${++setN}`, type: 'normal', status: 'done', weight, reps, ...over });

export function ex(templateId: string | undefined, name: string, sets: SessionSet[], over: Partial<SessionExercise> = {}): SessionExercise {
  return {
    id: `ex-${++setN}`,
    exerciseKey: name.toLowerCase().replace(/\s+/g, '-'),
    templateId,
    name,
    muscleGroup: 'Peito',
    category: 'compound',
    equipment: 'barbell',
    repMin: 6,
    repMax: 10,
    restSec: 90,
    plannedSets: sets.length,
    sets,
    ...over,
  };
}

export const supino = (template: 'sup-A' | 'sup-B' | 'sup-X', sets: SessionSet[], over: Partial<SessionExercise> = {}) =>
  ex(template, 'Supino reto', sets, { modality: 'resistance', loadMode: 'externa', exerciseKey: 'supino-reto', ...over });

export function ses(id: string, date: string, exercises: SessionExercise[] = [], over: Partial<WorkoutSession> = {}): WorkoutSession {
  const startedAt = over.startedAt ?? at(date);
  return {
    id,
    profileId: PROFILE,
    routineId: 'gr',
    workoutId: 'gr-A',
    workoutLabel: 'A',
    workoutName: 'Treino A',
    status: 'completed',
    startedAt,
    finishedAt: startedAt + 3_600_000,
    exercises,
    updatedAt: startedAt + 3_600_000,
    ...over,
  };
}

/** Referência a um exercício da rotina de metas, como o formulário montaria. */
export function refOf(templateIds: string[], over: Partial<GoalExerciseRef> = {}): GoalExerciseRef {
  const r = goalRoutine();
  const all = r.workouts.flatMap((w) => w.exercises);
  const t = all.find((e) => e.id === templateIds[0]);
  return {
    templateIds,
    routineId: 'gr',
    name: t?.name ?? 'Exercício',
    modality: t?.modality ?? null,
    loadMode: t?.loadMode ?? null,
    laterality: t?.laterality ?? null,
    equipment: t?.equipment ?? null,
    distanceUnit: t?.distanceUnit ?? null,
    ...over,
  };
}

export function fields(over: Partial<GoalFields> = {}): GoalFields {
  return { type: 'weekly_frequency', title: 'Meta', exercise: null, targetValue: 3, params: {}, startDate: '2026-03-02', targetDate: null, ...over };
}

let goalN = 0;
export function goal(over: Partial<GoalFields> = {}, extra: Partial<TrainingGoal> = {}): TrainingGoal {
  return { ...newGoal(`goal-${++goalN}`, fields(over), 1_772_000_000_000), profileId: PROFILE, ...extra };
}
