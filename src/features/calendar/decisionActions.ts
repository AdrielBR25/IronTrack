// Ações sobre decisões lembradas (IronTrack 2.0 F01/P16, docs/DECISOES_CALENDARIO.md §6–7, §12). Junta a
// persistência (transação em src/db/calendarDecisions.ts) com as regras puras do calendário: dentro da transação, o dia
// é RECALCULADO com os dados atuais e a decisão só é gravada se a divergência for a mesma que a tela mostrava. Usado
// pelo Planejamento, pela Início e pela Treinos — uma única camada, nenhuma tela decide sozinha.
import { listCalendarDecisions, mutateCalendarDecisions, removeInvalidDecisions, type DecisionSources } from '@/db/calendarDecisions';
import { todayISO } from '@/lib/dates';
import { planCleanup, planRemember, planRemove, planShowAgain, type CalendarInput, type RememberRequest } from '@/modules/calendar';

export interface DecisionClock {
  today?: string;
  now?: number;
}

const inputOf = (s: DecisionSources, today: string): CalendarInput => ({
  today,
  profileId: s.profileId,
  entries: s.entries,
  sessions: s.sessions,
  routines: s.routines,
  rotations: s.rotations,
  legacy: s.legacy,
});

/** Lembrar "manter planejamento" ou "ocultar observação" para UM conflito, num dia. Idempotente. */
export async function rememberDecision(req: RememberRequest, clock: DecisionClock = {}) {
  const today = clock.today ?? todayISO();
  const now = clock.now ?? Date.now();
  return mutateCalendarDecisions(({ sources, stored }) => {
    const existing = stored.decisions.find((d) => d.conflictId === req.conflictId);
    const next = planRemember(inputOf(sources, today), existing, req, now);
    return { put: next ? [next] : [], delete: [] };
  });
}

/** "Voltar a mostrar aviso" (a decisão fica registrada sem efeito). */
export async function showDecisionAgain(id: string, expectedRevision: number, clock: DecisionClock = {}) {
  const now = clock.now ?? Date.now();
  return mutateCalendarDecisions(({ stored }) => {
    const next = planShowAgain(
      stored.decisions.find((d) => d.id === id),
      expectedRevision,
      now,
    );
    return { put: next ? [next] : [], delete: [] };
  });
}

/** Remover uma decisão (só a versão que a tela mostrava). */
export async function removeDecision(id: string, expectedRevision: number) {
  return mutateCalendarDecisions(({ stored }) => ({ put: [], delete: [planRemove(stored.decisions.find((d) => d.id === id), expectedRevision)] }));
}

/** Limpar decisões sem efeito: reavaliadas na transação; uma que voltou a valer em outra aba é mantida. */
export async function cleanupDecisions(ids: readonly string[], clock: DecisionClock = {}) {
  const today = clock.today ?? todayISO();
  return mutateCalendarDecisions(({ sources, stored }) => ({ put: [], delete: planCleanup(inputOf(sources, today), stored.decisions, ids) }));
}

export { listCalendarDecisions, removeInvalidDecisions };
