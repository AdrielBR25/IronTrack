import type { DistanceUnit, ExerciseLaterality, ExerciseModelFields, LoadMode, SessionSet, SetSide, TrainingModality } from './types';

// Modelo de exercícios v3 (IronTrack 2.0 F01/P10): valores permitidos, limites, validação e quais campos cada
// modalidade registra. Funções puras. Documentação: docs/MIGRACAO_EXERCICIOS_V3.md e docs/MODELO_EXERCICIOS_V2.md.
// Regra central: campo ausente = não informado. Nada aqui preenche modalidade, lado ou duração por palpite.

export const MODALITIES: readonly TrainingModality[] = ['resistance', 'bodyweight', 'timed', 'cardio'];
export const LATERALITIES: readonly ExerciseLaterality[] = ['bilateral', 'unilateral'];
export const LOAD_MODES: readonly LoadMode[] = ['externa', 'corporal', 'adicional', 'assistida'];
export const DISTANCE_UNITS: readonly DistanceUnit[] = ['m', 'km', 'mi'];
export const SET_SIDES: readonly SetSide[] = ['direito', 'esquerdo', 'ambos'];

export const MODALITY_LABEL: Record<TrainingModality, string> = {
  resistance: 'Musculação com carga',
  bodyweight: 'Peso corporal',
  timed: 'Por tempo',
  cardio: 'Cardio',
};
export const LATERALITY_LABEL: Record<ExerciseLaterality, string> = { bilateral: 'Bilateral', unilateral: 'Unilateral' };
export const LOAD_MODE_LABEL: Record<LoadMode, string> = {
  externa: 'Carga externa',
  corporal: 'Só peso corporal',
  adicional: 'Peso corporal + carga adicional',
  assistida: 'Peso corporal com assistência',
};
export const DISTANCE_UNIT_LABEL: Record<DistanceUnit, string> = { m: 'metros', km: 'quilômetros', mi: 'milhas' };
export const SIDE_LABEL: Record<SetSide, string> = { direito: 'Direito', esquerdo: 'Esquerdo', ambos: 'Ambos' };
export const SIDE_SHORT: Record<SetSide, string> = { direito: 'D', esquerdo: 'E', ambos: 'D+E' };

/** Limites documentados (docs/MIGRACAO_EXERCICIOS_V3.md §2). Acima disso o valor é tratado como erro de digitação. */
export const MODEL_LIMITS = {
  /** 24 h por série. */
  maxDurationSec: 86_400,
  /** 1 000 km por série. */
  maxDistanceM: 1_000_000,
  maxAssistanceKg: 500,
  maxSecondaryMuscles: 4,
  maxMuscleChars: 40,
} as const;

/** Tipos de carga aceitos por modalidade. Modalidade ausente aceita qualquer tipo (registro parcial). */
export const LOAD_MODES_BY_MODALITY: Record<TrainingModality, readonly LoadMode[]> = {
  resistance: ['externa'],
  bodyweight: ['corporal', 'adicional', 'assistida'],
  timed: ['corporal', 'adicional', 'externa'],
  cardio: [],
};

export const METERS_PER_UNIT: Record<DistanceUnit, number> = { m: 1, km: 1000, mi: 1609.344 };

export function toMetersFrom(value: number, unit: DistanceUnit): number {
  return Math.round(value * METERS_PER_UNIT[unit] * 1000) / 1000;
}
export function fromMetersTo(m: number, unit: DistanceUnit): number {
  return m / METERS_PER_UNIT[unit];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const present = (v: unknown) => v !== undefined && v !== null;
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

export const isValidDurationSec = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v > 0 && v <= MODEL_LIMITS.maxDurationSec;
export const isValidDistanceM = (v: unknown): v is number => finite(v) && v > 0 && v <= MODEL_LIMITS.maxDistanceM;
export const isValidAssistanceKg = (v: unknown): v is number => finite(v) && v >= 0 && v <= MODEL_LIMITS.maxAssistanceKg;
export const isSetSide = (v: unknown): v is SetSide => isOneOf(SET_SIDES, v);

export interface ModelIssue {
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

/**
 * Valida os metadados de um exercício. Erros = valor fora do tipo ou dos limites (o registro não deve ser
 * aceito como está). Avisos = combinação contraditória que é preservada, mas tratada com cautela pelas análises.
 */
export function exerciseModelIssues(e: Partial<Record<keyof ExerciseModelFields, unknown>>): ModelIssue[] {
  const out: ModelIssue[] = [];
  const err = (field: string, message: string) => out.push({ severity: 'error', field, message });
  const warn = (field: string, message: string) => out.push({ severity: 'warning', field, message });
  if (present(e.modality) && !isOneOf(MODALITIES, e.modality)) err('modality', `modalidade inválida (${String(e.modality)})`);
  if (present(e.laterality) && !isOneOf(LATERALITIES, e.laterality)) err('laterality', `lateralidade inválida (${String(e.laterality)})`);
  if (present(e.loadMode) && !isOneOf(LOAD_MODES, e.loadMode)) err('loadMode', `tipo de carga inválido (${String(e.loadMode)})`);
  if (present(e.distanceUnit) && !isOneOf(DISTANCE_UNITS, e.distanceUnit)) err('distanceUnit', `unidade de distância inválida (${String(e.distanceUnit)})`);
  if (present(e.secondaryMuscles)) {
    const list = e.secondaryMuscles;
    if (!Array.isArray(list)) err('secondaryMuscles', 'grupos secundários devem ser uma lista de textos');
    else {
      if (list.length > MODEL_LIMITS.maxSecondaryMuscles) err('secondaryMuscles', `no máximo ${MODEL_LIMITS.maxSecondaryMuscles} grupos secundários`);
      if (list.some((m) => typeof m !== 'string' || !m.trim() || m.length > MODEL_LIMITS.maxMuscleChars))
        err('secondaryMuscles', `cada grupo secundário deve ser um texto de 1 a ${MODEL_LIMITS.maxMuscleChars} caracteres`);
    }
  }
  if (present(e.targetDurationSec) && !isValidDurationSec(e.targetDurationSec)) err('targetDurationSec', `duração planejada inválida (inteiro de 1 a ${MODEL_LIMITS.maxDurationSec} s)`);
  if (present(e.targetDistance) && !isValidDistanceM(e.targetDistance)) err('targetDistance', 'distância planejada inválida (maior que zero e até 1 000 km)');
  if (out.length) return out;

  const m = e.modality as TrainingModality | undefined;
  const lm = e.loadMode as LoadMode | undefined;
  if (m && lm && !LOAD_MODES_BY_MODALITY[m].includes(lm)) warn('loadMode', `tipo de carga "${LOAD_MODE_LABEL[lm]}" não combina com a modalidade "${MODALITY_LABEL[m]}"`);
  if (m === 'cardio' && e.laterality === 'unilateral') warn('laterality', 'cardio marcado como unilateral');
  return out;
}

/** Contexto do exercício necessário para validar uma série. */
export type SetContext = Pick<ExerciseModelFields, 'modality' | 'laterality' | 'loadMode'>;

/** Valida os campos novos de uma série (e as combinações com o exercício). Não olha carga nem repetições antigas. */
export function setModelIssues(set: Partial<Record<keyof SessionSet, unknown>>, ex: SetContext = {}): ModelIssue[] {
  const out: ModelIssue[] = [];
  const err = (field: string, message: string) => out.push({ severity: 'error', field, message });
  const warn = (field: string, message: string) => out.push({ severity: 'warning', field, message });
  if (present(set.durationSec) && !isValidDurationSec(set.durationSec)) err('durationSec', `duração inválida (inteiro de 1 a ${MODEL_LIMITS.maxDurationSec} s)`);
  if (present(set.distance) && !isValidDistanceM(set.distance)) err('distance', 'distância inválida (maior que zero e até 1 000 km)');
  if (present(set.assistanceKg) && !isValidAssistanceKg(set.assistanceKg)) err('assistanceKg', `assistência inválida (de 0 a ${MODEL_LIMITS.maxAssistanceKg} kg)`);
  if (present(set.side) && !isSetSide(set.side)) err('side', `lado inválido (${String(set.side)})`);
  if (out.length) return out;
  if (finite(set.assistanceKg) && set.assistanceKg > 0 && finite(set.weight) && set.weight > 0) warn('assistanceKg', 'série com carga adicional e assistência ao mesmo tempo');
  if (present(set.assistanceKg) && ex.loadMode !== 'assistida') warn('assistanceKg', 'assistência registrada num exercício que não é assistido');
  if (present(set.side) && ex.laterality !== 'unilateral') warn('side', 'lado registrado num exercício que não é unilateral');
  return out;
}

/** Como a carga aparece no registro da série. */
export type WeightField = 'none' | 'externa' | 'adicional';

/** O que a série de um exercício registra. Exercícios antigos (sem modalidade) = carga + repetições, como sempre. */
export interface ExerciseMeasures {
  reps: boolean;
  weight: WeightField;
  assistance: boolean;
  duration: boolean;
  distance: boolean;
  side: boolean;
  /** A sugestão de progressão de carga só vale para carga externa com repetições. */
  progression: boolean;
}

export function exerciseMeasures(e: ExerciseModelFields): ExerciseMeasures {
  const m = e.modality;
  const lm = e.loadMode;
  const cardio = m === 'cardio';
  const timed = m === 'timed';
  let weight: WeightField = 'externa';
  if (cardio || lm === 'corporal' || lm === 'assistida' || (timed && !lm)) weight = 'none';
  else if (lm === 'adicional') weight = 'adicional';
  const reps = !cardio && !timed;
  return {
    reps,
    weight,
    assistance: lm === 'assistida' && !cardio,
    duration: cardio || timed,
    distance: cardio,
    side: e.laterality === 'unilateral' && !cardio,
    progression: reps && weight === 'externa' && m !== 'bodyweight',
  };
}

/** Copia só os metadados definidos (sem criar chaves `undefined` que mudariam o registro gravado). */
export function pickModelFields(e: ExerciseModelFields): ExerciseModelFields {
  const out: ExerciseModelFields = {};
  if (e.modality !== undefined) out.modality = e.modality;
  if (e.laterality !== undefined) out.laterality = e.laterality;
  if (e.loadMode !== undefined) out.loadMode = e.loadMode;
  if (e.secondaryMuscles !== undefined) out.secondaryMuscles = [...e.secondaryMuscles];
  if (e.distanceUnit !== undefined) out.distanceUnit = e.distanceUnit;
  if (e.targetDurationSec !== undefined) out.targetDurationSec = e.targetDurationSec;
  if (e.targetDistance !== undefined) out.targetDistance = e.targetDistance;
  return out;
}

/**
 * Problemas que impedem concluir a série (mensagens para a tela). Exercícios antigos mantêm a regra de antes:
 * só repetições > 0. Valores inválidos nunca são gravados como concluídos.
 */
export function setCompletionErrors(ex: ExerciseModelFields, set: SessionSet): string[] {
  const ms = exerciseMeasures(ex);
  const errs: string[] = [];
  if (ms.reps && !(finite(set.reps) && set.reps > 0)) errs.push('Informe as repetições.');
  if (present(set.weight) && !(finite(set.weight) && set.weight >= 0)) errs.push('Carga inválida.');
  for (const i of setModelIssues(set, ex)) if (i.severity === 'error') errs.push(`${i.message[0].toUpperCase()}${i.message.slice(1)}.`);
  if (ms.duration && !ms.distance && !isValidDurationSec(set.durationSec)) errs.push('Informe a duração da série.');
  if (ms.distance && !isValidDurationSec(set.durationSec) && !isValidDistanceM(set.distance)) errs.push('Informe a duração ou a distância.');
  if (finite(set.assistanceKg) && set.assistanceKg > 0 && finite(set.weight) && set.weight > 0) errs.push('Use carga adicional ou assistência, não as duas.');
  return [...new Set(errs)];
}

/** "45 s", "1:30", "1:02:05". */
export function fmtDurationSec(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * Ritmo (segundos por unidade de distância) derivado só da duração e da distância registradas. Null se faltar uma
 * delas ou se o resultado não fizer sentido. Não estima nada além disso (sem calorias, sem frequência cardíaca).
 */
export function paceSecPerUnit(durationSec: number | null | undefined, distanceM: number | null | undefined, unit: DistanceUnit): number | null {
  if (!isValidDurationSec(durationSec) || !isValidDistanceM(distanceM)) return null;
  const units = fromMetersTo(distanceM, unit);
  if (!(units > 0)) return null;
  const pace = durationSec / units;
  return Number.isFinite(pace) && pace > 0 ? pace : null;
}

/** Lado oposto (atalho de alternância). "Ambos" e ausente não têm oposto. */
export function oppositeSide(side: SetSide | null | undefined): SetSide | null {
  return side === 'direito' ? 'esquerdo' : side === 'esquerdo' ? 'direito' : null;
}
