// Decisões lembradas sobre divergências do calendário (IronTrack 2.0 F01/P16, docs/DECISOES_CALENDARIO.md).
// O REGISTRO mora aqui, no planejamento (é uma escolha da pessoa sobre o próprio planejamento e vai para o backup);
// o cálculo — identidade do conflito, impressão digital e efeito na apresentação — é do calendário
// (src/modules/calendar/decisions.ts), que já depende do planejamento. Uma decisão NUNCA altera planejamento,
// rotação, sessões ou agenda anterior: ela só muda como um conflito idêntico é apresentado.
//
// Regras do modelo:
//  - identidade estável e determinística: `<perfil>~<tipo>|<data>|<assunto>`; nada de IDs aleatórios nem nomes;
//  - escopo explícito: `conflict_day` (manter o planejamento neste conflito, neste dia) ou `info_notice` (ocultar
//    uma observação informativa deste dia). Não existe escopo global ("ignorar todos");
//  - `sourceFingerprint`: impressão digital dos dados relevantes do conflito no momento da decisão. Se o conflito
//    atual tiver outra impressão digital, a decisão perde o efeito (o aviso volta);
//  - `revision` para concorrência otimista entre abas.
import { z } from 'zod';
import { isPlanDate } from './calendar';
import { DECISION_CONFLICT_KINDS, DECISION_SCOPES, DECISION_VALUES, type CalendarDecision, type DecisionConflictKind, type DecisionScope, type DecisionValue } from './types';

export const DECISION_LIMITS = {
  /** Decisões guardadas por perfil (as sem efeito podem ser limpas; acima disso a gravação é recusada). */
  maxPerProfile: 200,
  /** Até quantos dias à frente uma decisão pode ser tomada. */
  horizonDays: 400,
  maxSummary: 300,
  maxId: 400,
  maxFingerprint: 64,
} as const;

export const conflictIdentity = (kind: DecisionConflictKind, date: string, subject: string | null) => `${kind}|${date}|${subject ?? ''}`;
export const decisionRecordId = (profileId: string, conflictId: string) => `${profileId}~${conflictId}`;

/** Que decisões fazem sentido para um tipo de conflito (a gravidade decide a ocultação informativa). */
export function decisionAllowed(kind: DecisionConflictKind, severity: 'warning' | 'info', decision: DecisionValue): boolean {
  if (decision === 'show') return true;
  if (decision === 'keep_plan') return kind.startsWith('plan_');
  return severity === 'info' && !kind.startsWith('plan_');
}

export const scopeOf = (decision: DecisionValue, kind: DecisionConflictKind): DecisionScope =>
  decision === 'hide_info' || (decision === 'show' && !kind.startsWith('plan_')) ? 'info_notice' : 'conflict_day';

const idText = z.string().min(1).max(DECISION_LIMITS.maxId);
const ts = z.number().finite().nonnegative();

export const calendarDecisionSchema = z
  .object({
    id: idText,
    profileId: idText,
    conflictId: idText,
    conflictType: z.enum(DECISION_CONFLICT_KINDS),
    scope: z.enum(DECISION_SCOPES),
    date: z.string().refine(isPlanDate, 'data inválida'),
    subject: z.string().min(1).max(200).nullable(),
    decision: z.enum(DECISION_VALUES),
    severity: z.enum(['warning', 'info']),
    sourceFingerprint: z.string().min(1).max(DECISION_LIMITS.maxFingerprint),
    summary: z.string().max(DECISION_LIMITS.maxSummary),
    createdAt: ts,
    updatedAt: ts,
    revision: z.number().int().min(1),
  })
  .superRefine((d, ctx) => {
    if (d.conflictId !== conflictIdentity(d.conflictType, d.date, d.subject)) ctx.addIssue({ code: 'custom', path: ['conflictId'], message: 'identidade do conflito não corresponde ao tipo, à data e ao assunto' });
    if (d.id !== decisionRecordId(d.profileId, d.conflictId)) ctx.addIssue({ code: 'custom', path: ['id'], message: 'identificador não corresponde ao perfil e ao conflito' });
    if (!decisionAllowed(d.conflictType, d.severity, d.decision)) ctx.addIssue({ code: 'custom', path: ['decision'], message: 'decisão não permitida para este tipo de divergência' });
    if (d.scope !== scopeOf(d.decision, d.conflictType)) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'escopo incompatível com a decisão' });
    if (d.updatedAt < d.createdAt) ctx.addIssue({ code: 'custom', path: ['updatedAt'], message: 'alteração anterior à criação' });
  });

/** Problemas de um registro de decisão (lista vazia = válido). Usado na leitura, na gravação e no backup. */
export function calendarDecisionIssues(d: unknown): string[] {
  const r = calendarDecisionSchema.safeParse(d);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || 'decisão'}: ${i.message}`);
}

export const isValidCalendarDecision = (d: unknown): d is CalendarDecision => calendarDecisionSchema.safeParse(d).success;

/** Troca o dono de uma decisão (restauração com transferência de perfil confirmada): o ID acompanha o perfil. */
export function reassignDecision(d: CalendarDecision, profileId: string): CalendarDecision {
  return d.profileId === profileId ? d : { ...d, profileId, id: decisionRecordId(profileId, d.conflictId) };
}

export type CalendarDecisionErrorKind = 'changed' | 'gone' | 'not_allowed' | 'limit' | 'past' | 'horizon' | 'invalid' | 'no_profile' | 'missing';

const MESSAGES: Record<CalendarDecisionErrorKind, string> = {
  changed: 'Esta divergência mudou desde que a tela foi aberta (talvez em outra aba). Nada foi gravado: confira o aviso atualizado.',
  gone: 'Esta divergência não existe mais (o planejamento ou a agenda mudaram). Nada foi gravado.',
  not_allowed: 'Esta decisão não está disponível para este tipo de aviso. Nada foi gravado.',
  limit: `Há decisões demais lembradas (limite de ${DECISION_LIMITS.maxPerProfile}). Limpe as decisões sem efeito em "Decisões lembradas". Nada foi gravado.`,
  past: 'Dias passados não recebem decisões novas. Nada foi gravado.',
  horizon: `Só é possível lembrar decisões para os próximos ${DECISION_LIMITS.horizonDays} dias. Nada foi gravado.`,
  invalid: 'A decisão tem dados inválidos e não foi gravada.',
  no_profile: 'Perfil local não inicializado. Recarregue o app; nada foi gravado.',
  missing: 'Esta decisão já foi removida (talvez em outra aba). Nada foi alterado.',
};

export class CalendarDecisionError extends Error {
  constructor(
    readonly kind: CalendarDecisionErrorKind,
    readonly details: string[] = [],
  ) {
    super(MESSAGES[kind]);
    this.name = 'CalendarDecisionError';
  }
}
