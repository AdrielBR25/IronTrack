// Modelos de metas de treinamento (IronTrack 2.0 F01/P12). Ver docs/METAS_TREINAMENTO.md.
// Formato persistido no IndexedDB (tabela `goals`, Dexie v3) e no backup v4: não altere campos sem migração.
// Este arquivo não importa nada (é agregado por src/lib/types.ts): os vocabulários de modalidade repetem os do
// treinamento de propósito e um teste garante que continuam iguais.

/** Tipos de meta. Só existem tipos que os registros atuais permitem calcular. */
export type GoalType = 'weekly_frequency' | 'session_count' | 'max_load' | 'reps' | 'duration' | 'distance' | 'e1rm';

/** Unidade do valor desejado, sempre explícita e fixa por tipo. Pesos em kg, durações em s, distâncias em m. */
export type GoalUnit = 'sessoes_semana' | 'sessoes' | 'kg' | 'reps' | 's' | 'm';

/**
 * Período da meta:
 *  - semanal: avaliada por semana (segunda a domingo), recorrente (frequência semanal);
 *  - janela: contagem dentro de uma janela fixa a partir do início (quantidade de sessões);
 *  - recorde: melhor marca registrada a partir do início (metas por exercício).
 */
export type GoalPeriod = 'semanal' | 'janela' | 'recorde';

/** Estado gravado. "Atingida" e "prazo encerrado" não são gravados: são calculados a partir dos registros. */
export type GoalStatus = 'active' | 'paused' | 'archived';

/** Mesmos vocabulários de src/modules/training/types.ts (teste de igualdade em tests/unit/goals-domain.test.ts). */
export type GoalExerciseModality = 'resistance' | 'bodyweight' | 'timed' | 'cardio';
export type GoalLoadMode = 'externa' | 'corporal' | 'adicional' | 'assistida';
export type GoalLaterality = 'bilateral' | 'unilateral';
export type GoalDistanceUnit = 'm' | 'km' | 'mi';
export type GoalSide = 'direito' | 'esquerdo';

/**
 * Referência ao exercício de uma meta. A associação é feita pelos IDs dos exercícios da ficha
 * (`ExerciseTemplate.id`), que não mudam quando o exercício é renomeado; o nome nunca é usado para associar.
 * Os demais campos são uma fotografia do momento da escolha, usada para exibir e para não misturar modalidades.
 */
export interface GoalExerciseRef {
  /** Um ou mais IDs de exercícios da mesma rotina, escolhidos pelo usuário (ex.: o mesmo supino nos treinos A e C). */
  templateIds: string[];
  /** Rotina em que o exercício foi escolhido. */
  routineId: string;
  /** Nome no momento da escolha (exibido se o exercício sair das fichas). */
  name: string;
  /** Modalidade explícita no momento da escolha; null = sem modalidade (registro antigo: carga × repetições). */
  modality: GoalExerciseModality | null;
  loadMode: GoalLoadMode | null;
  laterality: GoalLaterality | null;
  /** Equipamento da ficha (peso corporal nunca tem 1RM). */
  equipment: string | null;
  /** Unidade de exibição da distância (cardio). A meta é sempre gravada em metros. */
  distanceUnit: GoalDistanceUnit | null;
}

/** Parâmetros que distinguem metas por período de metas de recorde. Só os aplicáveis ao tipo podem existir. */
export interface GoalParams {
  /** Quantidade de sessões: janela em dias a partir do início (1–366). */
  windowDays?: number;
  /** Repetições: carga mínima (kg) para a série contar. Ausente = qualquer série sem assistência. */
  minLoadKg?: number;
  /** Exercício unilateral: lado considerado. Ausente = qualquer lado (a evidência mostra o lado). */
  side?: GoalSide;
}

/** Intervalo de pausa (datas locais yyyy-mm-dd; `to` null enquanto pausada). */
export interface GoalPause {
  from: string;
  to: string | null;
}

export interface TrainingGoal {
  /** UUID gerado uma única vez, na criação. */
  id: string;
  /** Perfil proprietário (preenchido pelo banco na criação; nunca muda). */
  profileId?: string;
  type: GoalType;
  title: string;
  /** Obrigatório nas metas por exercício; null nas metas de frequência e de sessões. */
  exercise: GoalExerciseRef | null;
  targetValue: number;
  unit: GoalUnit;
  period: GoalPeriod;
  params: GoalParams;
  /** Primeiro dia (local) em que registros contam para a meta. */
  startDate: string;
  /** Prazo opcional (local, inclusive). Vencer o prazo nunca marca a meta como fracassada. */
  targetDate: string | null;
  status: GoalStatus;
  pauses: GoalPause[];
  createdAt: number;
  updatedAt: number;
  /** Versão do registro, incrementada a cada gravação (verificação de concorrência entre abas). */
  revision: number;
}
