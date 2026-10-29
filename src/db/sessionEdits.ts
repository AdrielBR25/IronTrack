import { db } from './db';
import type { WorkoutSession } from '@/lib/types';
import { canResume, describeSessionChanges, resumeTiming, validateSessionEdit, withRevision, type EditIssue } from '@/modules/training';

// Gravação das edições de treinos finalizados e da retomada (IronTrack 2.0 F01/P20, docs/EDICAO_HISTORICO.md e
// docs/RETOMADA_TREINOS.md). Toda operação lê o registro DENTRO da transação de escrita (serializada pelo IndexedDB entre
// abas) e compara com a versão que a tela abriu (`updatedAt`). Se outra aba, uma restauração de backup ou a retomada
// mudou o treino nesse meio-tempo, nada é gravado (sem sobrescrita silenciosa): a tela avisa e oferece recarregar.
// O ID da sessão, o perfil, o início e os horários de finalização nunca são trocados por uma edição.

export type EditSaveResult =
  | { status: 'saved'; session: WorkoutSession }
  | { status: 'unchanged'; session: WorkoutSession }
  | { status: 'conflict'; reason: 'changed' | 'missing' | 'not-completed'; current: WorkoutSession | null }
  | { status: 'invalid'; issues: EditIssue[] };

/** Campos que a edição do histórico pode mudar; o resto vem do registro gravado. */
function applyEditable(fresh: WorkoutSession, draft: WorkoutSession): WorkoutSession {
  return { ...fresh, exercises: draft.exercises, durationSec: draft.durationSec, notes: draft.notes };
}

const sameContent = (a: WorkoutSession, b: WorkoutSession) => JSON.stringify([a.exercises, a.durationSec ?? null, a.notes ?? '']) === JSON.stringify([b.exercises, b.durationSec ?? null, b.notes ?? '']);

/**
 * Grava as correções de um treino concluído sem retomá-lo: continua concluído, mesma duração (salvo correção explícita),
 * mesmo ID. Recordes, gráficos, metas e calendário são calculados a partir das sessões na leitura, então refletem a
 * correção sem duplicar nada. Uma revisão com o estado anterior é guardada.
 */
export async function saveCompletedSessionEdit(base: WorkoutSession, draft: WorkoutSession, now = Date.now()): Promise<EditSaveResult> {
  if (draft.id !== base.id) return { status: 'conflict', reason: 'missing', current: null };
  return db.transaction('rw', db.sessions, async () => {
    const fresh = await db.sessions.get(base.id);
    if (!fresh) return { status: 'conflict', reason: 'missing', current: null };
    if (fresh.status !== 'completed') return { status: 'conflict', reason: 'not-completed', current: fresh };
    if (fresh.updatedAt !== base.updatedAt) return { status: 'conflict', reason: 'changed', current: fresh };
    const next = applyEditable(fresh, draft);
    const issues = validateSessionEdit(next);
    if (issues.length) return { status: 'invalid', issues };
    if (sameContent(fresh, next)) return { status: 'unchanged', session: fresh };
    const written = withRevision({ ...next, updatedAt: Math.max(now, fresh.updatedAt + 1) }, fresh, 'edit', describeSessionChanges(fresh, next), now);
    await db.sessions.put(written);
    return { status: 'saved', session: written };
  });
}

export type ResumeResult =
  | { status: 'resumed'; session: WorkoutSession }
  /** A mesma sessão já está ativa (retomada em outra aba): não há um segundo cronômetro, só abrir o treino. */
  | { status: 'already-active'; session: WorkoutSession }
  | { status: 'other-active'; other: WorkoutSession }
  | { status: 'conflict'; reason: 'changed' | 'missing' | 'not-completed'; current: WorkoutSession | null }
  | { status: 'invalid'; issues: EditIssue[] };

/**
 * Volta um treino concluído ao estado ativo (P20 §14): o relógio recomeça da duração acumulada, sem contar o intervalo
 * em que o treino ficou finalizado. Só um treino ativo por vez. `draft` (opcional) são correções feitas na tela de edição
 * antes de tocar em "Continuar": entram na mesma transação, validadas.
 */
export async function resumeCompletedSession(base: WorkoutSession, draft: WorkoutSession | null = null, now = Date.now()): Promise<ResumeResult> {
  return db.transaction('rw', db.sessions, async () => {
    const fresh = await db.sessions.get(base.id);
    if (!fresh) return { status: 'conflict', reason: 'missing', current: null };
    if (fresh.status === 'active') return { status: 'already-active', session: fresh };
    if (!canResume(fresh)) return { status: 'conflict', reason: 'not-completed', current: fresh };
    if (fresh.updatedAt !== base.updatedAt) return { status: 'conflict', reason: 'changed', current: fresh };
    const other = await db.sessions.where('status').equals('active').first();
    if (other && other.id !== fresh.id) return { status: 'other-active', other };
    const edited = draft ? applyEditable(fresh, draft) : fresh;
    const issues = validateSessionEdit(edited);
    if (draft && issues.length) return { status: 'invalid', issues };
    const resumed = resumeTiming(edited, now);
    const summary = [...(draft ? describeSessionChanges(fresh, edited) : []), 'Treino retomado.'];
    const written = withRevision({ ...resumed, updatedAt: Math.max(now, fresh.updatedAt + 1) }, fresh, 'resume', summary, now);
    await db.sessions.put(written);
    return { status: 'resumed', session: written };
  });
}

/**
 * Restaura o conteúdo de uma revisão anterior (exercícios, duração e observações) como uma NOVA revisão: nada do
 * histórico de revisões é apagado. Só em treino concluído e na versão que a tela conhece.
 */
export async function restoreSessionRevision(base: WorkoutSession, revision: number, now = Date.now()): Promise<EditSaveResult> {
  return db.transaction('rw', db.sessions, async () => {
    const fresh = await db.sessions.get(base.id);
    if (!fresh) return { status: 'conflict', reason: 'missing', current: null };
    if (fresh.status !== 'completed') return { status: 'conflict', reason: 'not-completed', current: fresh };
    if (fresh.updatedAt !== base.updatedAt) return { status: 'conflict', reason: 'changed', current: fresh };
    const rev = (fresh.revisions ?? []).find((r) => r.revision === revision);
    if (!rev) return { status: 'conflict', reason: 'changed', current: fresh };
    const next: WorkoutSession = { ...fresh, exercises: rev.before.exercises, durationSec: rev.before.durationSec, notes: rev.before.notes };
    if (rev.before.durationSec === undefined) delete next.durationSec;
    if (rev.before.notes === undefined) delete next.notes;
    const issues = validateSessionEdit(next);
    if (issues.length) return { status: 'invalid', issues };
    const written = withRevision({ ...next, updatedAt: Math.max(now, fresh.updatedAt + 1) }, fresh, 'restore', [`Restaurada a versão anterior à revisão ${revision}.`, ...describeSessionChanges(fresh, next)], now);
    await db.sessions.put(written);
    return { status: 'saved', session: written };
  });
}

/** Texto do aviso de conflito (tela de edição e de detalhes). */
export function conflictMessage(reason: 'changed' | 'missing' | 'not-completed'): string {
  if (reason === 'missing') return 'Este treino não existe mais neste aparelho (foi excluído ou substituído por uma restauração de backup). Nada foi gravado.';
  if (reason === 'not-completed') return 'Este treino foi retomado em outra aba e está em andamento. Nada foi gravado; abra o treino em andamento.';
  return 'Este treino foi alterado em outra aba (ou por uma restauração de backup) depois que você abriu a edição. Nada foi gravado: recarregue para ver a versão atual.';
}
