// Modelo do planejamento semanal (IronTrack 2.0 F01/P13). Ver docs/PLANEJAMENTO_SEMANAL.md §1–3.
// Formato persistido no IndexedDB (tabela `planEntries`, Dexie v4) e nos backups (v5): não altere campos sem migração.
//
// Uma entrada é UMA atividade (ou marcador de descanso/dia livre) num "lugar" da agenda:
//  - `weekly`: modelo recorrente, toda semana no dia `weekday`, com vigência [`validFrom`, `validUntil`];
//  - `date`: exceção de uma data específica. Se uma data tem pelo menos uma exceção, as exceções SUBSTITUEM o modelo
//    recorrente naquele dia inteiro (o modelo não muda). Nada é gerado para datas futuras: o modelo é resolvido sob
//    demanda, então não existem registros "infinitos".
// O planejamento nunca grava em sessões, rotinas, rotação ou metas.

export type PlanScope = 'weekly' | 'date';

/** `workout`: treino de uma rotina · `rest`: descanso · `free`: dia livre (sem nada planejado, de propósito). */
export type PlanKind = 'workout' | 'rest' | 'free';

export interface PlanEntry {
  /** UUID estável (gerado uma vez pela tela; repetir a mesma gravação não duplica). */
  id: string;
  /** Perfil proprietário (preenchido pelo banco na criação). */
  profileId?: string;
  scope: PlanScope;
  /** Dia da semana do modelo recorrente (0 = domingo … 6 = sábado, como `Settings.trainingDays`); null em exceções. */
  weekday: number | null;
  /** Data local (yyyy-mm-dd) da exceção; null no modelo recorrente. */
  date: string | null;
  kind: PlanKind;
  /** Rotina (ficha) planejada; só em `workout`. */
  routineId: string | null;
  /** Treino específico da rotina (A, B, C…). null = "o próximo da rotação" daquela rotina. Só em `workout`. */
  workoutId: string | null;
  /** Entrada recorrente pausada (ignorada na agenda, preservada). Exceções são sempre `true`. */
  enabled: boolean;
  /** Recorrente: primeiro dia de vigência (o dia em que foi criada ou alterada). null em exceções. */
  validFrom: string | null;
  /** Recorrente: último dia de vigência (inclusive), definido ao alterar ou remover; null = sem fim. */
  validUntil: string | null;
  /** Exceção criada a partir de uma entrada recorrente ("só neste dia"): ID da entrada de origem. */
  sourceEntryId?: string | null;
  createdAt: number;
  updatedAt: number;
  /** Versão do registro (concorrência otimista entre abas). Começa em 1. */
  revision: number;
}

/** Lugar da agenda que uma operação altera. */
export type PlanSlot = { scope: 'weekly'; weekday: number } | { scope: 'date'; date: string };

/** Dados de uma atividade planejada (o que a tela informa). */
export interface PlanActivityInput {
  routineId: string;
  /** null = seguir a rotação da rotina. */
  workoutId: string | null;
}

// ------------------------------------------------------------------ decisões lembradas do calendário (P16)
// Ver ./decisions.ts e docs/DECISOES_CALENDARIO.md. Persistidas na tabela `calendarDecisions` (Dexie v5) e no backup (v6).

/** Tipos de conflito do calendário (os mesmos de `ConflictKind` do calendário). */
export const DECISION_CONFLICT_KINDS = [
  'plan_vs_legacy_workout',
  'plan_rest_vs_legacy_workout',
  'plan_workout_vs_legacy_rest',
  'exception_replaces_recurring',
  'rotation_differs',
  'session_off_plan',
] as const;
export type DecisionConflictKind = (typeof DECISION_CONFLICT_KINDS)[number];

/**
 * `keep_plan`: manter o planejamento atual e não avisar de novo enquanto nada mudar (só divergências
 * planejamento × agenda anterior) · `hide_info`: ocultar uma observação informativa · `show`: voltar a mostrar
 * (a decisão continua registrada, sem efeito, até ser removida ou limpa).
 */
export const DECISION_VALUES = ['keep_plan', 'hide_info', 'show'] as const;
export type DecisionValue = (typeof DECISION_VALUES)[number];

export const DECISION_SCOPES = ['conflict_day', 'info_notice'] as const;
export type DecisionScope = (typeof DECISION_SCOPES)[number];

/** Uma decisão lembrada (tabela `calendarDecisions`, Dexie v5; backup v6). */
export interface CalendarDecision {
  /** `decisionRecordId(profileId, conflictId)`. */
  id: string;
  profileId: string;
  /** Identidade do conflito sem o perfil: `conflictIdentity(conflictType, date, subject)`. */
  conflictId: string;
  conflictType: DecisionConflictKind;
  scope: DecisionScope;
  /** Dia do conflito (yyyy-mm-dd). */
  date: string;
  /** Assunto dentro do dia, quando o tipo pode repetir (atividade do planejamento ou sessão); senão null. */
  subject: string | null;
  decision: DecisionValue;
  /** Gravidade do conflito quando a decisão foi tomada (só para exibição; a impressão digital já a inclui). */
  severity: 'warning' | 'info';
  sourceFingerprint: string;
  /** Texto do aviso no momento da decisão (só exibição em "Decisões lembradas"; nunca usado para comparar). */
  summary: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

