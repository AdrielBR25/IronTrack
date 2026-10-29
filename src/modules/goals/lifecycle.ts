// Criação, edição e transições de estado das metas (IronTrack 2.0 F01/P12). Funções puras: a gravação, com a
// verificação de concorrência, fica em src/db/goals.ts e aplica estas regras sobre o registro lido na transação.
import type { GoalStatus, TrainingGoal } from './types';
import { GOAL_PERIOD_BY_TYPE, GOAL_UNIT_BY_TYPE, cleanGoalFields, goalFieldErrors, goalIssues, type GoalFields } from './validation';

export class GoalRuleError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'GoalRuleError';
  }
}

function assertFields(f: GoalFields) {
  const errors = Object.values(goalFieldErrors(f)) as string[];
  if (errors.length) throw new GoalRuleError('A meta tem campos inválidos e não foi gravada.', errors);
}

/** Monta uma meta nova (ativa, versão 1). O ID é gerado por quem chama, uma única vez por criação. */
export function newGoal(id: string, fields: GoalFields, now: number): TrainingGoal {
  const f = cleanGoalFields(fields);
  assertFields(f);
  const goal: TrainingGoal = {
    id,
    type: f.type,
    title: f.title,
    exercise: f.exercise,
    targetValue: f.targetValue,
    unit: GOAL_UNIT_BY_TYPE[f.type],
    period: GOAL_PERIOD_BY_TYPE[f.type],
    params: f.params,
    startDate: f.startDate,
    targetDate: f.targetDate,
    status: 'active',
    pauses: [],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  const issues = goalIssues(goal);
  if (issues.length) throw new GoalRuleError('A meta tem campos inválidos e não foi gravada.', issues.map((i) => i.message));
  return goal;
}

/** Campos que a edição pode mudar. Tipo e exercício são fixos: mudar o que a meta mede exige uma meta nova. */
export type GoalEdit = Pick<GoalFields, 'title' | 'targetValue' | 'params' | 'startDate' | 'targetDate'>;

export function editGoal(goal: TrainingGoal, edit: GoalEdit, now: number): TrainingGoal {
  const f = cleanGoalFields({ ...edit, type: goal.type, exercise: goal.exercise });
  assertFields(f);
  // Uma pausa não pode começar antes do novo início (a linha do tempo da meta continua coerente).
  if (goal.pauses.some((p) => p.from < f.startDate)) throw new GoalRuleError('O início não pode ser posterior a uma pausa já registrada.');
  return { ...goal, title: f.title, targetValue: f.targetValue, params: f.params, startDate: f.startDate, targetDate: f.targetDate, updatedAt: now, revision: goal.revision + 1 };
}

export type GoalAction = 'pause' | 'resume' | 'archive' | 'unarchive';

export const GOAL_ACTION_LABEL: Record<GoalAction, string> = { pause: 'Pausar', resume: 'Retomar', archive: 'Arquivar', unarchive: 'Restaurar' };

const closeOpenPause = (goal: TrainingGoal, today: string) => goal.pauses.map((p) => (p.to === null ? { ...p, to: today < p.from ? p.from : today } : p));

/**
 * Aplica uma ação ao estado atual. Ações que já estão no estado pedido não mudam nada (`changed: false`): duas abas
 * arquivando ao mesmo tempo resultam num único arquivamento. Ações impossíveis no estado atual lançam erro.
 */
export function applyGoalAction(goal: TrainingGoal, action: GoalAction, today: string, now: number): { goal: TrainingGoal; changed: boolean } {
  const to = (status: GoalStatus, pauses = goal.pauses) => ({ goal: { ...goal, status, pauses, updatedAt: now, revision: goal.revision + 1 }, changed: true });
  switch (action) {
    case 'pause':
      if (goal.status === 'paused') return { goal, changed: false };
      if (goal.status === 'archived') throw new GoalRuleError('Esta meta está arquivada (talvez em outra aba). Restaure-a antes de pausar.');
      return to('paused', [...goal.pauses, { from: today < goal.startDate ? goal.startDate : today, to: null }]);
    case 'resume':
      if (goal.status === 'active') return { goal, changed: false };
      if (goal.status === 'archived') throw new GoalRuleError('Esta meta está arquivada (talvez em outra aba). Use "Restaurar".');
      return to('active', closeOpenPause(goal, today));
    case 'archive':
      if (goal.status === 'archived') return { goal, changed: false };
      return to('archived', closeOpenPause(goal, today));
    case 'unarchive':
      if (goal.status !== 'archived') return { goal, changed: false };
      return to('active');
  }
}
