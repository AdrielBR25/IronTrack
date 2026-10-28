// Decisões lembradas sobre divergências (IronTrack 2.0 F01/P16, docs/DECISOES_CALENDARIO.md).
// Camada ÚNICA de decisão, usada pelo Planejamento, pela Início e pela Treinos (nenhuma tela decide sozinha):
//  - aplica uma decisão só a um conflito com a MESMA identidade e a MESMA impressão digital (`applyDecisions`);
//  - avalia a situação de cada decisão guardada (`evaluateDecisions`): valendo, invalidada, resolvida, vencida;
//  - planeja as gravações (`planRemember`, `planShowAgain`, `planRemove`, `planCleanup`), que a persistência executa
//    dentro de uma transação depois de recalcular o dia com os dados atuais.
// Puro: sem banco, sem relógio, sem aleatoriedade. Uma decisão nunca altera planejamento, rotação, sessões ou a
// agenda anterior; também não esconde conflitos novos, diferentes ou futuros ainda desconhecidos.
import {
  CalendarDecisionError,
  DECISION_LIMITS,
  conflictIdentity,
  decisionAllowed,
  decisionRecordId,
  planAddDays,
  scopeOf,
  type CalendarDecision,
  type DecisionConflictKind,
  type DecisionValue,
} from '@/modules/planner';
import { resolveDay, resolveRange } from './resolve';
import type { CalendarConflict, CalendarInput, ConflictKind, ResolvedDay } from './types';

/** Conflitos ainda não reconhecidos do dia (o que as telas apresentam como aviso). */
export const pendingConflicts = (day: ResolvedDay) => day.conflicts.filter((c) => !c.remembered);
export const pendingWarnings = (day: ResolvedDay) => day.conflicts.filter((c) => c.severity === 'warning' && !c.remembered);
export const rememberedConflicts = (day: ResolvedDay) => day.conflicts.filter((c) => c.remembered);

/** Decisão lembrada que a tela pode oferecer para um conflito (null: só "continuar exibindo" e as ações normais). */
export function rememberOption(day: Pick<ResolvedDay, 'isPast'>, c: CalendarConflict): Exclude<DecisionValue, 'show'> | null {
  if (day.isPast) return null;
  if (decisionAllowed(c.kind, c.severity, 'keep_plan')) return 'keep_plan';
  if (decisionAllowed(c.kind, c.severity, 'hide_info')) return 'hide_info';
  return null;
}

// ------------------------------------------------------------------ textos

export const CONFLICT_KIND_LABEL: Record<ConflictKind, string> = {
  plan_vs_legacy_workout: 'Planejamento × agenda anterior (treinos diferentes)',
  plan_rest_vs_legacy_workout: 'Descanso planejado × treino na agenda anterior',
  plan_workout_vs_legacy_rest: 'Treino planejado × descanso na agenda anterior',
  exception_replaces_recurring: 'Exceção substitui o planejamento semanal',
  rotation_differs: 'Planejado × próximo da rotação',
  session_off_plan: 'Treino realizado fora do planejado',
};

export const DECISION_LABEL: Record<DecisionValue, string> = {
  keep_plan: 'Manter o planejamento e não avisar de novo enquanto nada mudar',
  hide_info: 'Ocultar esta observação informativa enquanto nada mudar',
  show: 'Mostrar o aviso de novo',
};

export type DecisionStatus = 'active' | 'showing' | 'invalidated' | 'resolved' | 'expired';

export const DECISION_STATUS_LABEL: Record<DecisionStatus, string> = {
  active: 'Valendo: o aviso fica recolhido',
  showing: 'Sem efeito: você pediu para mostrar de novo',
  invalidated: 'Sem efeito: algo mudou desde a decisão, o aviso voltou',
  resolved: 'Sem efeito: a divergência não existe mais',
  expired: 'Sem efeito: o dia já passou',
};

/** Decisões sem efeito podem ser limpas com segurança (não escondem nada hoje). */
export const isObsolete = (s: DecisionStatus) => s !== 'active';

export interface DecisionView {
  decision: CalendarDecision;
  status: DecisionStatus;
  /** Conflito atual com a mesma identidade (null se não existe mais). */
  current: CalendarConflict | null;
}

/** Intervalo de datas a calcular para avaliar as decisões (hoje → última data; null se nenhuma está por vir). */
export function decisionRange(decisions: readonly CalendarDecision[], today: string): { from: string; to: string } | null {
  const limit = planAddDays(today, DECISION_LIMITS.horizonDays);
  const future = decisions.map((d) => d.date).filter((d) => d >= today && d <= limit);
  if (!future.length) return null;
  return { from: today, to: future.reduce((a, b) => (b > a ? b : a)) };
}

/**
 * Situação de cada decisão contra os dias calculados agora (`days` deve cobrir `decisionRange`). Ordem: datas
 * futuras primeiro (mais próximas antes), depois as vencidas.
 */
export function evaluateDecisions(decisions: readonly CalendarDecision[], days: readonly ResolvedDay[], today: string, profileId: string | undefined): DecisionView[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: DecisionView[] = [];
  for (const d of decisions) {
    if (!profileId || d.profileId !== profileId) continue;
    const day = byDate.get(d.date);
    const current = day?.conflicts.find((c) => c.id === d.conflictId) ?? null;
    let status: DecisionStatus;
    if (d.date < today) status = 'expired';
    else if (!current) status = 'resolved';
    else if (current.fingerprint !== d.sourceFingerprint || !decisionAllowed(current.kind, current.severity, d.decision)) status = 'invalidated';
    else if (d.decision === 'show') status = 'showing';
    else status = 'active';
    out.push({ decision: d, status, current });
  }
  return out.sort((a, b) => (a.status === 'expired') === (b.status === 'expired') ? a.decision.date.localeCompare(b.decision.date) || a.decision.id.localeCompare(b.decision.id) : a.status === 'expired' ? 1 : -1);
}

// ------------------------------------------------------------------ gravações (planejadas aqui, executadas em transação)

export interface RememberRequest {
  date: string;
  conflictId: string;
  decision: Exclude<DecisionValue, 'show'>;
  /** Impressão digital do conflito que a tela mostrava. Diferente da atual → `changed` (nada gravado). */
  expectedFingerprint: string;
  /** Revisão da decisão que a tela conhecia (null: a tela não via decisão para este conflito). */
  expectedRevision: number | null;
}

/**
 * Nova decisão (ou atualização) a partir do calendário RECALCULADO com os dados atuais. Recusa se a divergência mudou,
 * sumiu, não admite a decisão, está no passado ou além do horizonte. Repetir a mesma decisão (outra aba, toque duplo)
 * não grava de novo: devolve `null`.
 */
export function planRemember(input: CalendarInput, existing: CalendarDecision | undefined, req: RememberRequest, now: number): CalendarDecision | null {
  const pid = input.profileId;
  if (!pid) throw new CalendarDecisionError('no_profile');
  if (req.date < input.today) throw new CalendarDecisionError('past');
  if (req.date > planAddDays(input.today, DECISION_LIMITS.horizonDays)) throw new CalendarDecisionError('horizon');
  const day = resolveDay({ ...input, decisions: [] }, req.date);
  const c = day.conflicts.find((x) => x.id === req.conflictId);
  if (!c) throw new CalendarDecisionError('gone');
  if (c.fingerprint !== req.expectedFingerprint) throw new CalendarDecisionError('changed');
  if (!decisionAllowed(c.kind, c.severity, req.decision)) throw new CalendarDecisionError('not_allowed');
  const kind = c.kind as DecisionConflictKind;
  if (existing && existing.decision === req.decision && existing.sourceFingerprint === c.fingerprint) return null;
  if ((existing?.revision ?? null) !== req.expectedRevision) throw new CalendarDecisionError('changed');
  const conflictId = conflictIdentity(kind, req.date, c.subject);
  return {
    id: decisionRecordId(pid, conflictId),
    profileId: pid,
    conflictId,
    conflictType: kind,
    scope: scopeOf(req.decision, kind),
    date: req.date,
    subject: c.subject,
    decision: req.decision,
    severity: c.severity,
    sourceFingerprint: c.fingerprint,
    summary: c.message.slice(0, DECISION_LIMITS.maxSummary),
    createdAt: existing?.createdAt ?? now,
    updatedAt: Math.max(now, (existing?.updatedAt ?? 0) + (existing ? 1 : 0)),
    revision: (existing?.revision ?? 0) + 1,
  };
}

/** "Voltar a mostrar aviso": a decisão fica registrada sem efeito (pode ser removida ou limpa depois). */
export function planShowAgain(existing: CalendarDecision | undefined, expectedRevision: number, now: number): CalendarDecision | null {
  if (!existing) throw new CalendarDecisionError('missing');
  if (existing.decision === 'show') return null;
  if (existing.revision !== expectedRevision) throw new CalendarDecisionError('changed');
  return { ...existing, decision: 'show', scope: scopeOf('show', existing.conflictType), updatedAt: Math.max(now, existing.updatedAt + 1), revision: existing.revision + 1 };
}

/** Remover uma decisão: só a versão que a tela mostrava (outra aba pode ter mudado). */
export function planRemove(existing: CalendarDecision | undefined, expectedRevision: number): string {
  if (!existing) throw new CalendarDecisionError('missing');
  if (existing.revision !== expectedRevision) throw new CalendarDecisionError('changed');
  return existing.id;
}

/**
 * Limpar decisões sem efeito. Reavalia com os dados atuais: só apaga as pedidas que CONTINUAM sem efeito (uma que
 * voltou a valer em outra aba é mantida). Devolve os IDs a apagar.
 */
export function planCleanup(input: CalendarInput, decisions: readonly CalendarDecision[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const chosen = decisions.filter((d) => wanted.has(d.id));
  const views = evaluateDecisionsFor(input, chosen);
  return views.filter((v) => isObsolete(v.status)).map((v) => v.decision.id);
}

/** Avalia decisões calculando só as datas delas (usado nas transações e na lista "Decisões lembradas"). */
export function evaluateDecisionsFor(input: CalendarInput, decisions: readonly CalendarDecision[]): DecisionView[] {
  const own = decisions.filter((d) => d.profileId === input.profileId);
  const range = decisionRange(own, input.today);
  // Um único cálculo do intervalo (no máximo o horizonte), sem materializar nada.
  const days = range ? resolveRange({ ...input, decisions: [] }, range.from, range.to) : [];
  return evaluateDecisions(own, days, input.today, input.profileId);
}
