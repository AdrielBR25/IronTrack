import { toast } from 'sonner';
import { CalendarDecisionError } from '@/modules/planner';
import type { CalendarConflict } from '@/modules/calendar';
import { cleanupDecisions, rememberDecision, removeDecision, showDecisionAgain } from './decisionActions';

// Retorno visual das ações de decisão (IronTrack 2.0 F01/P16). Mensagens iguais nas três telas; um erro nunca grava
// nada pela metade (cada ação é uma transação).

const fail = (e: unknown) => toast.error(e instanceof CalendarDecisionError ? e.message : 'Não foi possível gravar a decisão. Nada foi alterado.');

/** Lembrar "manter planejamento" (ou "ocultar observação") para um conflito exibido. */
export async function rememberFromScreen(date: string, c: CalendarConflict, decision: 'keep_plan' | 'hide_info'): Promise<boolean> {
  try {
    await rememberDecision({ date, conflictId: c.id, decision, expectedFingerprint: c.fingerprint, expectedRevision: c.stored?.revision ?? null });
    toast.success(decision === 'keep_plan' ? 'Decisão lembrada. Nenhum treino foi alterado; o aviso volta se algo mudar.' : 'Observação ocultada enquanto nada mudar. Nenhum treino foi alterado.');
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function showAgainFromScreen(id: string, revision: number): Promise<boolean> {
  try {
    await showDecisionAgain(id, revision);
    toast.success('O aviso voltou a aparecer.');
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function removeFromScreen(id: string, revision: number): Promise<boolean> {
  try {
    await removeDecision(id, revision);
    toast.success('Decisão removida. Nenhum treino foi alterado.');
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function cleanupFromScreen(ids: readonly string[]): Promise<boolean> {
  try {
    const r = await cleanupDecisions(ids);
    toast.success(r.delete.length === 1 ? '1 decisão sem efeito foi limpa.' : `${r.delete.length} decisões sem efeito foram limpas.`);
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}
