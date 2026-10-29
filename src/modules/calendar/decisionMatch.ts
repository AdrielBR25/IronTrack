// Aplicação das decisões lembradas a um dia calculado (IronTrack 2.0 F01/P16, docs/DECISOES_CALENDARIO.md §3–5).
// Separado de ./decisions.ts para o cálculo do dia (./resolve.ts) não depender das operações de gravação.
import { decisionAllowed, type CalendarDecision, type DecisionValue } from '@/modules/planner';
import type { CalendarConflict } from './types';

/** Decisões do perfil por identidade do conflito (as de outro perfil nunca entram). */
export function decisionIndex(decisions: readonly CalendarDecision[] | undefined, profileId: string | undefined): Map<string, CalendarDecision> {
  const map = new Map<string, CalendarDecision>();
  if (!decisions || !profileId) return map;
  for (const d of decisions) if (d.profileId === profileId) map.set(d.conflictId, d);
  return map;
}

/** Uma decisão vale para o conflito: mesma identidade, mesma impressão digital, decisão compatível e não "mostrar". */
export function decisionMatches(d: CalendarDecision | undefined, c: CalendarConflict): d is CalendarDecision & { decision: Exclude<DecisionValue, 'show'> } {
  return !!d && d.decision !== 'show' && d.conflictId === c.id && d.sourceFingerprint === c.fingerprint && decisionAllowed(c.kind, c.severity, d.decision);
}

/** Marca os conflitos reconhecidos (muta a lista recém-criada pelo cálculo do dia). */
export function applyDecisions(conflicts: CalendarConflict[], index: Map<string, CalendarDecision>) {
  if (!index.size) return;
  for (const c of conflicts) {
    const d = index.get(c.id);
    if (d) c.stored = { id: d.id, revision: d.revision, decision: d.decision };
    if (decisionMatches(d, c)) c.remembered = { decisionId: d.id, decision: d.decision, decidedAt: d.updatedAt, revision: d.revision };
  }
}
