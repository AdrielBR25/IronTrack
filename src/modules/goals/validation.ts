// Vocabulário, limites e validação das metas (IronTrack 2.0 F01/P12). Funções puras, sem banco nem interface.
// A mesma validação serve ao formulário (mensagens por campo), à gravação (src/db/goals.ts) e à verificação de
// integridade dos backups (src/lib/integrity.ts): uma meta inválida nunca é gravada nem descartada em silêncio.
import type { GoalExerciseRef, GoalParams, GoalPeriod, GoalStatus, GoalType, GoalUnit, TrainingGoal } from './types';

export const GOAL_TYPES: readonly GoalType[] = ['weekly_frequency', 'session_count', 'max_load', 'reps', 'duration', 'distance', 'e1rm'];
export const EXERCISE_GOAL_TYPES: readonly GoalType[] = ['max_load', 'reps', 'duration', 'distance', 'e1rm'];
export const GOAL_STATUSES: readonly GoalStatus[] = ['active', 'paused', 'archived'];

export const GOAL_UNIT_BY_TYPE: Record<GoalType, GoalUnit> = {
  weekly_frequency: 'sessoes_semana',
  session_count: 'sessoes',
  max_load: 'kg',
  reps: 'reps',
  duration: 's',
  distance: 'm',
  e1rm: 'kg',
};

export const GOAL_PERIOD_BY_TYPE: Record<GoalType, GoalPeriod> = {
  weekly_frequency: 'semanal',
  session_count: 'janela',
  max_load: 'recorde',
  reps: 'recorde',
  duration: 'recorde',
  distance: 'recorde',
  e1rm: 'recorde',
};

export const GOAL_TYPE_LABEL: Record<GoalType, string> = {
  weekly_frequency: 'Frequência semanal',
  session_count: 'Quantidade de sessões',
  max_load: 'Carga máxima',
  reps: 'Repetições',
  duration: 'Duração',
  distance: 'Distância',
  e1rm: '1RM estimado',
};

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = { active: 'Ativa', paused: 'Pausada', archived: 'Arquivada' };

/** Limites documentados (docs/METAS_TREINAMENTO.md §2). Acima disso o valor é tratado como erro de digitação. */
export const GOAL_LIMITS = {
  maxTitleChars: 80,
  maxWeeklySessions: 14,
  maxSessionCount: 400,
  maxWindowDays: 366,
  maxLoadKg: 1000,
  maxReps: 1000,
  /** 24 h, o mesmo limite de duração por série do modelo de exercícios. */
  maxDurationSec: 86_400,
  /** 1 000 km, o mesmo limite de distância do modelo de exercícios. */
  maxDistanceM: 1_000_000,
  maxTemplateIds: 20,
  maxPauses: 500,
} as const;

const MODALITIES = ['resistance', 'bodyweight', 'timed', 'cardio'] as const;
const LOAD_MODES = ['externa', 'corporal', 'adicional', 'assistida'] as const;
const LATERALITIES = ['bilateral', 'unilateral'] as const;
const DISTANCE_UNITS = ['m', 'km', 'mi'] as const;
const SIDES = ['direito', 'esquerdo'] as const;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Data de calendário yyyy-mm-dd existente (ex.: 2026-02-30 é inválida). */
export function isGoalDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export const isExerciseGoal = (type: GoalType) => EXERCISE_GOAL_TYPES.includes(type);

/**
 * Por que um exercício não serve para um tipo de meta (null = serve). Regras: carga e 1RM só com carga externa
 * registrada (peso corporal nunca vira carga; assistência nunca vira carga adicional), duração só em exercícios por
 * tempo ou cardio, distância só em cardio, repetições nunca em tempo/cardio.
 */
export function exerciseGoalBlocker(type: GoalType, ex: Pick<GoalExerciseRef, 'modality' | 'loadMode' | 'equipment'>): string | null {
  const m = ex.modality;
  const timedOrCardio = m === 'timed' || m === 'cardio';
  switch (type) {
    case 'max_load':
      if (timedOrCardio) return 'Exercícios por tempo ou cardio não registram carga.';
      if (ex.loadMode === 'corporal' || ex.loadMode === 'assistida') return 'Este exercício não registra carga externa (peso corporal ou assistência não contam como carga).';
      if (m === 'bodyweight' && ex.loadMode !== 'adicional') return 'Exercício de peso corporal: só há carga com o tipo "carga adicional".';
      return null;
    case 'e1rm':
      if (m !== null && m !== 'resistance') return 'O 1RM estimado só existe para exercícios de musculação com carga externa.';
      if (ex.loadMode !== null && ex.loadMode !== 'externa') return 'O 1RM estimado só existe para exercícios com carga externa.';
      if (ex.equipment === 'bodyweight') return 'Exercícios de peso corporal não têm 1RM estimado.';
      return null;
    case 'reps':
      return timedOrCardio ? 'Exercícios por tempo ou cardio não registram repetições.' : null;
    case 'duration':
      return timedOrCardio ? null : 'A duração só é registrada em exercícios por tempo ou de cardio.';
    case 'distance':
      return m === 'cardio' ? null : 'A distância só é registrada em exercícios de cardio.';
    default:
      return 'Este tipo de meta não usa exercício.';
  }
}

/** Faixa e precisão do valor desejado por tipo (mensagem de erro ou null). */
export function targetValueError(type: GoalType, v: unknown): string | null {
  if (!finite(v)) return 'Informe um número.';
  if (v <= 0) return 'O valor precisa ser maior que zero.';
  const L = GOAL_LIMITS;
  const int = (max: number, what: string) => (!Number.isInteger(v) ? `Use um número inteiro de ${what}.` : v > max ? `O máximo é ${max} ${what}.` : null);
  switch (type) {
    case 'weekly_frequency':
      return int(L.maxWeeklySessions, 'sessões por semana');
    case 'session_count':
      return int(L.maxSessionCount, 'sessões');
    case 'reps':
      return int(L.maxReps, 'repetições');
    case 'duration':
      return int(L.maxDurationSec, 'segundos');
    case 'max_load':
    case 'e1rm':
      return v > L.maxLoadKg ? `O máximo é ${L.maxLoadKg} kg.` : null;
    case 'distance':
      return v > L.maxDistanceM ? 'O máximo é 1.000 km.' : null;
  }
}

/** Campos editáveis de uma meta (formulário e gravação). */
export interface GoalFields {
  type: GoalType;
  title: string;
  exercise: GoalExerciseRef | null;
  targetValue: number;
  params: GoalParams;
  startDate: string;
  targetDate: string | null;
}

export type GoalField = 'type' | 'title' | 'exercise' | 'targetValue' | 'windowDays' | 'minLoadKg' | 'side' | 'startDate' | 'targetDate' | 'params';

/** Erros por campo (vazio = válido). Usado pelo formulário para validação imediata. */
export function goalFieldErrors(f: Partial<GoalFields>): Partial<Record<GoalField, string>> {
  const e: Partial<Record<GoalField, string>> = {};
  if (!isOneOf(GOAL_TYPES, f.type)) {
    e.type = 'Escolha o tipo de meta.';
    return e;
  }
  const type = f.type;
  if (!nonEmpty(f.title)) e.title = 'Dê um título à meta.';
  else if (f.title.trim().length > GOAL_LIMITS.maxTitleChars) e.title = `Use até ${GOAL_LIMITS.maxTitleChars} caracteres.`;
  const tv = targetValueError(type, f.targetValue);
  if (tv) e.targetValue = tv;

  if (isExerciseGoal(type)) {
    const exErr = exerciseRefError(f.exercise);
    if (exErr) e.exercise = exErr;
    else if (f.exercise) {
      const blocker = exerciseGoalBlocker(type, f.exercise);
      if (blocker) e.exercise = blocker;
    }
  } else if (f.exercise != null) e.exercise = 'Este tipo de meta não usa exercício.';

  const p = (f.params ?? {}) as Record<string, unknown>;
  const allowed = new Set<string>(type === 'session_count' ? ['windowDays'] : type === 'reps' ? ['minLoadKg', 'side'] : type === 'max_load' || type === 'e1rm' ? ['side'] : []);
  const extra = Object.keys(p).filter((k) => p[k] !== undefined && !allowed.has(k));
  if (extra.length) e.params = `Parâmetros que não se aplicam a este tipo: ${extra.join(', ')}.`;
  if (type === 'session_count') {
    const w = p.windowDays;
    if (!finite(w) || !Number.isInteger(w) || w < 1) e.windowDays = 'Informe a janela em dias (número inteiro).';
    else if (w > GOAL_LIMITS.maxWindowDays) e.windowDays = `A janela máxima é de ${GOAL_LIMITS.maxWindowDays} dias.`;
  }
  if (p.minLoadKg !== undefined && allowed.has('minLoadKg')) {
    if (!finite(p.minLoadKg) || p.minLoadKg <= 0) e.minLoadKg = 'A carga mínima precisa ser maior que zero (ou deixe em branco).';
    else if (p.minLoadKg > GOAL_LIMITS.maxLoadKg) e.minLoadKg = `O máximo é ${GOAL_LIMITS.maxLoadKg} kg.`;
    else if (f.exercise && (f.exercise.loadMode === 'corporal' || f.exercise.loadMode === 'assistida'))
      e.minLoadKg = 'Este exercício não registra carga externa.';
  }
  if (p.side !== undefined && allowed.has('side')) {
    if (!isOneOf(SIDES, p.side)) e.side = 'Lado inválido.';
    else if (f.exercise && f.exercise.laterality !== 'unilateral') e.side = 'O lado só se aplica a exercícios unilaterais.';
  }

  if (!isGoalDate(f.startDate)) e.startDate = 'Informe uma data de início válida.';
  if (f.targetDate !== null && f.targetDate !== undefined) {
    if (type === 'session_count') e.targetDate = 'A quantidade de sessões usa a janela em dias, sem prazo separado.';
    else if (!isGoalDate(f.targetDate)) e.targetDate = 'Informe um prazo válido ou deixe em branco.';
    else if (isGoalDate(f.startDate) && f.targetDate < f.startDate) e.targetDate = 'O prazo não pode ser anterior ao início.';
  }
  return e;
}

function exerciseRefError(ex: unknown): string | null {
  if (ex === null || ex === undefined) return 'Escolha o exercício.';
  const r = ex as Record<string, unknown>;
  if (!Array.isArray(r.templateIds) || !r.templateIds.length || !r.templateIds.every(nonEmpty)) return 'Exercício sem identificador estável: escolha um exercício de uma ficha.';
  if (r.templateIds.length > GOAL_LIMITS.maxTemplateIds) return 'Exercícios demais na mesma meta.';
  if (new Set(r.templateIds).size !== r.templateIds.length) return 'Exercício repetido na meta.';
  if (!nonEmpty(r.routineId)) return 'Exercício sem rotina de origem.';
  if (!nonEmpty(r.name)) return 'Exercício sem nome.';
  if (r.modality !== null && !isOneOf(MODALITIES, r.modality)) return 'Modalidade do exercício inválida.';
  if (r.loadMode !== null && !isOneOf(LOAD_MODES, r.loadMode)) return 'Tipo de carga do exercício inválido.';
  if (r.laterality !== null && !isOneOf(LATERALITIES, r.laterality)) return 'Lateralidade do exercício inválida.';
  if (r.distanceUnit !== null && !isOneOf(DISTANCE_UNITS, r.distanceUnit)) return 'Unidade de distância inválida.';
  if (r.equipment !== null && typeof r.equipment !== 'string') return 'Equipamento inválido.';
  return null;
}

export interface GoalIssue {
  field: string;
  message: string;
}

/**
 * Validação completa de um registro de meta (gravação e backups). Lista vazia = válido. Confere também a coerência
 * entre tipo, unidade e período, estado, pausas, carimbos de tempo e versão.
 */
export function goalIssues(raw: unknown): GoalIssue[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [{ field: 'meta', message: 'registro de meta não é um objeto' }];
  const g = raw as Partial<Record<keyof TrainingGoal, unknown>>;
  const out: GoalIssue[] = [];
  const add = (field: string, message: string) => out.push({ field, message });
  if (!nonEmpty(g.id)) add('id', 'identificador ausente');
  const fieldErrors = goalFieldErrors(g as Partial<GoalFields>);
  for (const [k, v] of Object.entries(fieldErrors)) add(k, v as string);
  if (isOneOf(GOAL_TYPES, g.type)) {
    if (g.unit !== GOAL_UNIT_BY_TYPE[g.type]) add('unit', `unidade incompatível com o tipo (esperado ${GOAL_UNIT_BY_TYPE[g.type]})`);
    if (g.period !== GOAL_PERIOD_BY_TYPE[g.type]) add('period', `período incompatível com o tipo (esperado ${GOAL_PERIOD_BY_TYPE[g.type]})`);
  }
  if (typeof g.params !== 'object' || g.params === null || Array.isArray(g.params)) add('params', 'parâmetros ausentes');
  if (!isOneOf(GOAL_STATUSES, g.status)) add('status', 'estado inválido');
  if (!Array.isArray(g.pauses)) add('pauses', 'lista de pausas ausente');
  else {
    if (g.pauses.length > GOAL_LIMITS.maxPauses) add('pauses', 'pausas demais');
    g.pauses.forEach((p, i) => {
      const pp = (p ?? {}) as { from?: unknown; to?: unknown };
      if (!isGoalDate(pp.from) || (pp.to !== null && (!isGoalDate(pp.to) || (pp.to as string) < (pp.from as string)))) add('pauses', `pausa ${i + 1} com datas inválidas`);
      else if (pp.to === null && i !== (g.pauses as unknown[]).length - 1) add('pauses', 'só a última pausa pode estar aberta');
    });
    const open = g.pauses.length > 0 && (g.pauses[g.pauses.length - 1] as { to?: unknown })?.to === null;
    if (g.status === 'paused' && !open) add('pauses', 'meta pausada sem pausa aberta');
    if (g.status === 'active' && open) add('pauses', 'meta ativa com pausa aberta');
  }
  if (!finite(g.createdAt) || g.createdAt <= 0) add('createdAt', 'data de criação inválida');
  if (!finite(g.updatedAt) || g.updatedAt <= 0) add('updatedAt', 'data de atualização inválida');
  if (!finite(g.revision) || !Number.isInteger(g.revision) || g.revision < 1) add('revision', 'versão do registro inválida');
  return out;
}

export const isValidGoal = (raw: unknown): raw is TrainingGoal => goalIssues(raw).length === 0;

/** Normaliza os campos digitados (título sem espaços nas pontas, parâmetros só os definidos). */
export function cleanGoalFields(f: GoalFields): GoalFields {
  const params: GoalParams = {};
  if (f.params.windowDays !== undefined) params.windowDays = f.params.windowDays;
  if (f.params.minLoadKg !== undefined) params.minLoadKg = f.params.minLoadKg;
  if (f.params.side !== undefined) params.side = f.params.side;
  return { ...f, title: f.title.trim(), params, exercise: f.exercise ? { ...f.exercise, templateIds: [...f.exercise.templateIds] } : null, targetDate: f.targetDate || null };
}
