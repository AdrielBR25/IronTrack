// Persistência da biblioteca de exercícios e operações do construtor de fichas (IronTrack 2.0 F01/P17).
// Ver docs/BIBLIOTECA_EXERCICIOS.md §13–15. Regras:
//  - personalizados (`customExercises`) e favoritos (`exerciseFavorites`) têm dono (`profileId`) e são validados
//    na gravação; edição, arquivamento e exclusão conferem a revisão que a tela mostrava (concorrência entre abas);
//  - exclusão definitiva só sem referências (fichas ou sessões que vieram do exercício), na MESMA transação;
//  - favoritos têm ID determinístico (`<perfil>~<alvo>`): favoritar em duas abas grava um registro só;
//  - fichas: cada ação é uma operação aplicada à versão gravada, dentro da transação (nunca a ficha inteira da tela),
//    então o que outra aba fez no mesmo treino não é perdido em silêncio;
//  - nada aqui escreve em sessões, metas, planejamento ou histórico. O catálogo é estático (não vai para o banco).
import { db, getSettings } from './db';
import {
  CUSTOM_LIMITS,
  CustomExerciseError,
  FAVORITE_LIMITS,
  WorkoutOpError,
  applyWorkoutOp,
  customExerciseIssues,
  customKey,
  editCustomExercise,
  favoriteId,
  isLibraryKey,
  isReferenced,
  isValidCustomExercise,
  isValidFavorite,
  libraryReferences,
  newCustomExercise,
  setArchived,
  type CustomExercise,
  type CustomFields,
  type ExerciseFavorite,
  type LibraryKey,
  type LibraryReferences,
  type WorkoutOp,
} from '@/modules/exercises';
import type { Routine, Workout } from '@/lib/types';

const pidOrThrow = () => {
  const pid = db.currentProfileId;
  if (!pid) throw new CustomExerciseError('no_profile');
  return pid;
};

const own = <T extends { profileId?: string }>(r: T | undefined): T | undefined => (r && (!r.profileId || r.profileId === db.currentProfileId) ? r : undefined);

export interface StoredCustomExercises {
  exercises: CustomExercise[];
  /** Registros do perfil que não passam na validação (ignorados pela biblioteca). */
  invalidIds: string[];
}

/** Personalizados do perfil local (válidos), em ordem de criação. */
export async function listCustomExercises(): Promise<StoredCustomExercises> {
  const pid = db.currentProfileId;
  if (!pid) return { exercises: [], invalidIds: [] };
  const raw = (await db.customExercises.where('profileId').equals(pid).toArray()) as unknown[];
  const exercises: CustomExercise[] = [];
  const invalidIds: string[] = [];
  for (const r of raw) {
    if (isValidCustomExercise(r)) exercises.push(r);
    else invalidIds.push(String((r as { id?: unknown })?.id ?? ''));
  }
  exercises.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return { exercises, invalidIds };
}

export async function listFavorites(): Promise<ExerciseFavorite[]> {
  const pid = db.currentProfileId;
  if (!pid) return [];
  return ((await db.exerciseFavorites.where('profileId').equals(pid).toArray()) as unknown[]).filter((f): f is ExerciseFavorite => isValidFavorite(f) && f.profileId === pid);
}

/**
 * Cria o personalizado com o ID gerado pela tela uma única vez. Repetir a mesma criação (toque duplo) devolve o
 * registro já gravado em vez de duplicar.
 */
export async function createCustomExercise(id: string, fields: CustomFields, now = Date.now()): Promise<CustomExercise> {
  const pid = pidOrThrow();
  const ex = { ...newCustomExercise(id, fields, now), profileId: pid };
  return db.transaction('rw', db.customExercises, async () => {
    const existing = await db.customExercises.get(id);
    if (existing) return existing;
    if ((await db.customExercises.where('profileId').equals(pid).count()) >= CUSTOM_LIMITS.maxPerProfile) throw new CustomExerciseError('limit');
    await db.customExercises.add(ex);
    return ex;
  });
}

async function currentCustom(id: string): Promise<CustomExercise> {
  const cur = own(await db.customExercises.get(id));
  if (!cur) throw new CustomExerciseError('deleted');
  return cur;
}

const assertValid = (c: CustomExercise) => {
  const issues = customExerciseIssues(c);
  if (issues.length) throw new CustomExerciseError('invalid', issues);
};

/** Edita o modelo personalizado. Fichas e sessões que vieram dele NÃO mudam (são cópias). */
export async function updateCustomExercise(id: string, expectedRevision: number, fields: CustomFields, now = Date.now()): Promise<CustomExercise> {
  return db.transaction('rw', db.customExercises, async () => {
    const cur = await currentCustom(id);
    if (cur.revision !== expectedRevision) throw new CustomExerciseError('changed');
    const next = editCustomExercise(cur, fields, now);
    assertValid(next);
    await db.customExercises.put(next);
    return next;
  });
}

/** Arquiva ou restaura (aplicado à versão gravada; repetir não muda nada). Arquivar nunca apaga referências. */
export async function setCustomArchived(id: string, archived: boolean, now = Date.now()): Promise<CustomExercise> {
  return db.transaction('rw', db.customExercises, async () => {
    const cur = await currentCustom(id);
    const { exercise, changed } = setArchived(cur, archived, now);
    if (changed) await db.customExercises.put(exercise);
    return exercise;
  });
}

/** Onde o personalizado é usado (fichas e treinos), lido do banco. */
export async function customExerciseReferences(id: string): Promise<LibraryReferences> {
  return db.transaction('r', db.routines, db.sessions, async () => libraryReferences(customKey(id), await db.routines.toArray(), await db.sessions.toArray()));
}

/**
 * Exclusão definitiva: só se o exercício não tiver referências em fichas nem no histórico (conferido na MESMA
 * transação) e ainda estiver na versão confirmada. Remove junto o favorito do próprio perfil. Excluir algo que já não
 * existe não é erro.
 */
export async function deleteCustomExercise(id: string, expectedRevision: number): Promise<'deleted' | 'already-deleted'> {
  return db.transaction('rw', [db.customExercises, db.exerciseFavorites, db.routines, db.sessions], async () => {
    const cur = own(await db.customExercises.get(id));
    if (!cur) return 'already-deleted';
    if (cur.revision !== expectedRevision) throw new CustomExerciseError('changed');
    const refs = libraryReferences(customKey(id), await db.routines.toArray(), await db.sessions.toArray());
    if (isReferenced(refs)) throw new CustomExerciseError('in_use', [`${refs.templates} uso(s) em fichas`, `${refs.sessions} treino(s) no histórico`]);
    await db.customExercises.delete(id);
    const pid = db.currentProfileId;
    if (pid) await db.exerciseFavorites.delete(favoriteId(pid, customKey(id)));
    return 'deleted';
  });
}

/** Liga ou desliga o favorito. Idempotente (ID determinístico); seguro com várias abas. */
export async function setFavorite(target: LibraryKey, on: boolean, now = Date.now()): Promise<boolean> {
  const pid = pidOrThrow();
  if (!isLibraryKey(target)) throw new CustomExerciseError('invalid', ['alvo do favorito inválido']);
  const id = favoriteId(pid, target);
  return db.transaction('rw', db.exerciseFavorites, async () => {
    const existing = await db.exerciseFavorites.get(id);
    if (!on) {
      if (existing) await db.exerciseFavorites.delete(id);
      return false;
    }
    if (existing) return true;
    if ((await db.exerciseFavorites.where('profileId').equals(pid).count()) >= FAVORITE_LIMITS.maxPerProfile) throw new CustomExerciseError('limit');
    await db.exerciseFavorites.add({ id, profileId: pid, target, createdAt: now });
    return true;
  });
}

/** Remove um favorito pelo ID (ex.: favorito de um exercício que não existe mais). */
export async function removeFavoriteRecord(id: string): Promise<void> {
  await db.transaction('rw', db.exerciseFavorites, async () => {
    const f = own(await db.exerciseFavorites.get(id));
    if (f) await db.exerciseFavorites.delete(id);
  });
}

/** Metas do perfil ligadas a um exercício da ficha (por ID). Só leitura: metas nunca são redirecionadas. */
export async function goalsLinkedTo(templateId: string): Promise<number> {
  const pid = db.currentProfileId;
  if (!pid) return 0;
  const goals = await db.goals.where('profileId').equals(pid).toArray();
  return goals.filter((g) => g.status !== 'archived' && g.exercise?.templateIds.includes(templateId)).length;
}

export interface WorkoutMutation {
  routine: Routine;
  workout: Workout;
  changed: boolean;
}

/**
 * Aplica uma operação do construtor de fichas sobre a versão GRAVADA do treino, numa transação de escrita (que o
 * navegador serializa entre abas). Não muda a ordem nem a quantidade de treinos, então a rotação não é tocada. Ao
 * adicionar ou substituir por um personalizado, confere na mesma transação que ele existe e não foi arquivado.
 */
export async function mutateWorkout(routineId: string, workoutId: string, op: WorkoutOp, now = Date.now()): Promise<WorkoutMutation> {
  return db.transaction('rw', [db.routines, db.customExercises], async () => {
    const r = await db.routines.get(routineId);
    if (!r) throw new WorkoutOpError('missing_routine');
    const w = r.workouts.find((x) => x.id === workoutId);
    if (!w) throw new WorkoutOpError('missing_workout');
    if (op.type === 'add' || op.type === 'replace') {
      const cid = op.exercise.customExerciseId;
      if (cid) {
        const c = own(await db.customExercises.get(cid));
        if (!c) throw new CustomExerciseError('deleted');
        if (c.archivedAt !== null) throw new CustomExerciseError('archived');
      }
    }
    const siblings = r.workouts.filter((x) => x.id !== w.id).map((x) => x.label);
    const { workout, changed } = applyWorkoutOp(w, op, siblings);
    if (!changed) return { routine: r, workout: w, changed };
    const next: Routine = { ...r, workouts: r.workouts.map((x) => (x.id === w.id ? workout : x)), updatedAt: Math.max(now, r.updatedAt + 1) };
    await db.routines.put(next);
    return { routine: next, workout, changed };
  });
}

/** Configurações (descansos padrão e grupos) usadas ao criar instâncias. */
export async function libraryDefaults() {
  const s = await getSettings();
  return { muscleGroups: s.muscleGroups, rest: { restCompoundSec: s.restCompoundSec, restIsolationSec: s.restIsolationSec } };
}
