// Validação das entradas do planejamento (IronTrack 2.0 F01/P13). Usada pela persistência (nada inválido é gravado)
// e pela verificação de integridade dos backups (entrada inválida bloqueia a restauração; nada é descartado).
import { isPlanDate } from './calendar';
import type { PlanEntry } from './types';

export const PLAN_SCOPES = ['weekly', 'date'] as const;
export const PLAN_KINDS = ['workout', 'rest', 'free'] as const;

export interface PlanIssue {
  field: string;
  message: string;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
const isTs = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function planEntryIssues(e: unknown): PlanIssue[] {
  const out: PlanIssue[] = [];
  const add = (field: string, message: string) => out.push({ field, message });
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [{ field: 'entry', message: 'Entrada de planejamento não é um objeto.' }];
  const p = e as Partial<PlanEntry> & Record<string, unknown>;
  if (!isId(p.id)) add('id', 'Identificador ausente ou inválido.');
  if (p.profileId !== undefined && p.profileId !== null && !isId(p.profileId)) add('profileId', 'Perfil proprietário inválido.');
  if (!PLAN_SCOPES.includes(p.scope as never)) add('scope', 'Tipo de entrada desconhecido (esperado: recorrente ou data específica).');
  if (!PLAN_KINDS.includes(p.kind as never)) add('kind', 'Atividade desconhecida (esperado: treino, descanso ou dia livre).');
  if (p.scope === 'weekly') {
    if (!Number.isInteger(p.weekday) || (p.weekday as number) < 0 || (p.weekday as number) > 6) add('weekday', 'Dia da semana inválido.');
    if (p.date !== null) add('date', 'Entrada recorrente não pode ter data específica.');
    if (!isPlanDate(p.validFrom)) add('validFrom', 'Início da vigência inválido.');
    if (p.validUntil !== null && !isPlanDate(p.validUntil)) add('validUntil', 'Fim da vigência inválido.');
    else if (p.validUntil !== null && isPlanDate(p.validFrom) && (p.validUntil as string) < (p.validFrom as string)) add('validUntil', 'Fim da vigência anterior ao início.');
    if (typeof p.enabled !== 'boolean') add('enabled', 'Indicador de ativa/pausada inválido.');
  } else if (p.scope === 'date') {
    if (!isPlanDate(p.date)) add('date', 'Data da exceção inválida.');
    if (p.weekday !== null) add('weekday', 'Exceção de data não pode ter dia da semana.');
    if (p.validFrom !== null || p.validUntil !== null) add('validFrom', 'Exceção de data não tem vigência.');
    if (p.enabled !== true) add('enabled', 'Exceção de data precisa estar ativa.');
  }
  if (p.kind === 'workout') {
    if (!isId(p.routineId)) add('routineId', 'Treino planejado sem rotina.');
    if (p.workoutId !== null && !isId(p.workoutId)) add('workoutId', 'Treino específico inválido.');
  } else if (p.kind === 'rest' || p.kind === 'free') {
    if (p.routineId !== null || p.workoutId !== null) add('routineId', 'Descanso e dia livre não têm rotina nem treino.');
  }
  if (p.sourceEntryId !== undefined && p.sourceEntryId !== null && !isId(p.sourceEntryId)) add('sourceEntryId', 'Origem da exceção inválida.');
  if (p.sourceEntryId && p.scope !== 'date') add('sourceEntryId', 'Só exceções de data têm origem.');
  if (!isTs(p.createdAt) || !isTs(p.updatedAt)) add('createdAt', 'Data de criação ou alteração inválida.');
  if (!Number.isInteger(p.revision) || (p.revision as number) < 1) add('revision', 'Versão do registro inválida.');
  return out;
}

export const isValidPlanEntry = (e: unknown): e is PlanEntry => planEntryIssues(e).length === 0;
