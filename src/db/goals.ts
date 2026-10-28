// Persistência das metas de treinamento (IronTrack 2.0 F01/P12). Ver docs/METAS_TREINAMENTO.md §3 e §11.
// Toda gravação lê o registro atual e aplica a regra pura na MESMA transação de escrita do IndexedDB (que o
// navegador serializa entre abas). Edição e exclusão conferem a versão (`revision`) que a tela mostrava:
// nada é sobrescrito em silêncio. Metas nunca escrevem em sessões, rotinas ou qualquer outra tabela.
import { db } from './db';
import { todayISO } from '@/lib/dates';
import type { TrainingGoal } from '@/lib/types';
import { applyGoalAction, editGoal, goalIssues, GoalRuleError, newGoal, type GoalAction, type GoalEdit, type GoalFields } from '@/modules/goals';

export type GoalConflictKind = 'changed' | 'deleted' | 'exists';

/** A meta mudou (ou sumiu) desde que a tela a leu. `current` é a versão gravada, quando existe. */
export class GoalConflictError extends Error {
  constructor(
    readonly kind: GoalConflictKind,
    readonly current: TrainingGoal | null,
  ) {
    super(
      kind === 'deleted'
        ? 'Esta meta foi excluída (talvez em outra aba). Nada foi gravado.'
        : kind === 'exists'
          ? 'Já existe uma meta diferente com este identificador. Nada foi gravado.'
          : 'Esta meta foi alterada em outra aba. Nada foi gravado: confira a versão atual e tente de novo.',
    );
    this.name = 'GoalConflictError';
  }
}

function assertValid(goal: TrainingGoal) {
  const issues = goalIssues(goal);
  if (issues.length) throw new GoalRuleError('A meta tem campos inválidos e não foi gravada.', issues.map((i) => i.message));
}

/** Perfil dono da meta: só o perfil principal deste aparelho grava metas. */
function ownGoal(g: TrainingGoal | undefined): TrainingGoal | undefined {
  return g && (!g.profileId || g.profileId === db.currentProfileId) ? g : undefined;
}

/** Metas do perfil local, mais recentes primeiro. */
export async function listGoals(): Promise<TrainingGoal[]> {
  const pid = db.currentProfileId;
  const all = pid ? await db.goals.where('profileId').equals(pid).toArray() : [];
  return all.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export async function getGoal(id: string): Promise<TrainingGoal | undefined> {
  return ownGoal(await db.goals.get(id));
}

/**
 * Cria a meta com o ID gerado pela tela uma única vez. Repetir a mesma criação (toque duplo, duas abas com o mesmo
 * envio) devolve a meta já gravada em vez de duplicar.
 */
export async function createGoal(id: string, fields: GoalFields, now = Date.now()): Promise<TrainingGoal> {
  const goal = newGoal(id, fields, now);
  return db.transaction('rw', db.goals, async () => {
    const existing = await db.goals.get(id);
    if (existing) {
      if (sameFields(existing, goal)) return existing;
      throw new GoalConflictError('exists', existing);
    }
    await db.goals.add(goal);
    return (await db.goals.get(id))!;
  });
}

const fieldsOf = (g: TrainingGoal) => JSON.stringify([g.type, g.title, g.exercise, g.targetValue, g.params, g.startDate, g.targetDate]);
const sameFields = (a: TrainingGoal, b: TrainingGoal) => fieldsOf(a) === fieldsOf(b);

async function currentOrThrow(id: string): Promise<TrainingGoal> {
  const cur = ownGoal(await db.goals.get(id));
  if (!cur) throw new GoalConflictError('deleted', null);
  return cur;
}

/** Edita os campos permitidos, só se a meta ainda estiver na versão que a tela mostrava. */
export async function updateGoal(id: string, expectedRevision: number, edit: GoalEdit, now = Date.now()): Promise<TrainingGoal> {
  return db.transaction('rw', db.goals, async () => {
    const cur = await currentOrThrow(id);
    if (cur.revision !== expectedRevision) throw new GoalConflictError('changed', cur);
    const next = editGoal(cur, edit, now);
    assertValid(next);
    await db.goals.put(next);
    return next;
  });
}

/**
 * Pausar, retomar, arquivar ou restaurar. A ação é aplicada sobre a versão gravada (não sobre a da tela), então
 * nunca desfaz uma edição feita em outra aba; repetir uma ação já aplicada não muda nada.
 */
export async function setGoalStatus(id: string, action: GoalAction, today = todayISO(), now = Date.now()): Promise<TrainingGoal> {
  return db.transaction('rw', db.goals, async () => {
    const cur = await currentOrThrow(id);
    const { goal, changed } = applyGoalAction(cur, action, today, now);
    if (!changed) return cur;
    assertValid(goal);
    await db.goals.put(goal);
    return goal;
  });
}

/**
 * Exclui a meta confirmada pelo usuário. Se ela mudou desde a confirmação, nada é apagado (a tela mostra a versão
 * nova). Excluir uma meta que já não existe (excluída em outra aba) não é erro.
 */
export async function deleteGoal(id: string, expectedRevision: number): Promise<'deleted' | 'already-deleted'> {
  return db.transaction('rw', db.goals, async () => {
    const cur = ownGoal(await db.goals.get(id));
    if (!cur) return 'already-deleted';
    if (cur.revision !== expectedRevision) throw new GoalConflictError('changed', cur);
    await db.goals.delete(id);
    return 'deleted';
  });
}
