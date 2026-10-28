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
