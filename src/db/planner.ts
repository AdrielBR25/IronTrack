// Persistência do planejamento semanal (IronTrack 2.0 F01/P13). Ver docs/PLANEJAMENTO_SEMANAL.md §7 e §9.
// Cada gravação lê as entradas do perfil e aplica a regra pura (src/modules/planner) na MESMA transação de escrita
// do IndexedDB, que o navegador serializa entre abas: a conferência de revisão/impressão digital e a gravação são
// atômicas. O planejamento só escreve na tabela `planEntries`: nunca em sessões, rotinas, rotação ou metas.
import { db } from './db';
import { todayISO } from '@/lib/dates';
import { uid } from '@/lib/utils';
import type { PlanEntry } from '@/lib/types';
import {
  addActivity,
  clearException,
  removeEntry,
  setMarker,
  updateActivity,
  type AddActivityInput,
  type PlanChanges,
  type PlanContext,
  type RemoveEntryInput,
  type SetMarkerInput,
  type UpdateActivityInput,
} from '@/modules/planner';

export { PlanConflictError } from '@/modules/planner';

/** Entradas do perfil local (todas as vigências; a tela resolve o que vale em cada data). */
export async function listPlanEntries(): Promise<PlanEntry[]> {
  const pid = db.currentProfileId;
  return pid ? db.planEntries.where('profileId').equals(pid).toArray() : [];
}

export interface PlanClock {
  today?: string;
  now?: number;
  newId?: () => string;
}

const ctxOf = (c: PlanClock = {}): PlanContext => ({ today: c.today ?? todayISO(), now: c.now ?? Date.now(), newId: c.newId ?? uid });

async function run(rule: (all: PlanEntry[], ctx: PlanContext) => PlanChanges, clock?: PlanClock): Promise<PlanEntry | null> {
  const ctx = ctxOf(clock);
  return db.transaction('rw', db.planEntries, async () => {
    const all = await listPlanEntries();
    const { put, delete: del, result } = rule(all, ctx);
    // Só apaga entradas do próprio perfil (a regra só enxerga essas).
    if (del.length) await db.planEntries.bulkDelete(del);
    if (put.length) await db.planEntries.bulkPut(put);
    return result ? ((await db.planEntries.get(result.id)) ?? result) : null;
  });
}

/** Planeja um treino num dia da semana (modelo) ou numa data (exceção). Repetir o mesmo envio não duplica. */
export const addPlanActivity = (input: AddActivityInput, clock?: PlanClock) => run((all, ctx) => addActivity(all, input, ctx), clock);

/** Descanso ou dia livre (substitui as atividades do lugar, depois da confirmação na tela). */
export const setPlanMarker = (input: SetMarkerInput, clock?: PlanClock) => run((all, ctx) => setMarker(all, input, ctx), clock);

/** Troca rotina/treino, muda de dia ou pausa/retoma (modelo) — sempre a partir de hoje. */
export const updatePlanActivity = (input: UpdateActivityInput, clock?: PlanClock) => run((all, ctx) => updateActivity(all, input, ctx), clock);

/** Remove do modelo (de hoje em diante) ou só de uma data. Já removida em outra aba: não é erro. */
export const removePlanEntry = (input: RemoveEntryInput, clock?: PlanClock) => run((all, ctx) => removeEntry(all, input, ctx), clock);

/** Desfaz as exceções de uma data (volta ao modelo recorrente). */
export const clearPlanException = (input: { date: string; expected?: string }, clock?: PlanClock) => run((all, ctx) => clearException(all, input, ctx), clock);
