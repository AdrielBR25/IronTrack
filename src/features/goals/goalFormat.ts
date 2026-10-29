// Formatação e conversão de unidades das metas na interface (IronTrack 2.0 F01/P12).
// O banco guarda kg, segundos e metros; a tela mostra e recebe valores na unidade escolhida (kg/lb, minutos no
// cardio, km/mi/m conforme o exercício). Nenhum texto exibe NaN ou Infinity: valores ausentes viram "—".
import { fmtDateShort } from '@/lib/dates';
import { fromDisplay, toDisplay } from '@/lib/units';
import { fmtNum } from '@/lib/utils';
import type { WeightUnit } from '@/lib/types';
import { DISTANCE_UNIT_LABEL, fmtDurationSec, fromMetersTo, toMetersFrom } from '@/modules/training';
import { GOAL_TYPE_LABEL, type GoalDisplayState, type GoalEvidence, type GoalExerciseRef, type GoalType, type TrainingGoal } from '@/modules/goals';

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export const distanceUnitOf = (ex: GoalExerciseRef | null) => ex?.distanceUnit ?? 'km';
/** Duração no cardio é digitada em minutos; em exercícios por tempo, em segundos. */
export const durationInMinutes = (ex: GoalExerciseRef | null) => ex?.modality === 'cardio';

/** Unidade mostrada ao lado do campo do valor desejado. */
export function inputUnitLabel(type: GoalType, ex: GoalExerciseRef | null, weightUnit: WeightUnit): string {
  switch (type) {
    case 'weekly_frequency':
      return 'sessões por semana';
    case 'session_count':
      return 'sessões';
    case 'max_load':
    case 'e1rm':
      return weightUnit;
    case 'reps':
      return 'repetições';
    case 'duration':
      return durationInMinutes(ex) ? 'minutos' : 'segundos';
    case 'distance':
      return DISTANCE_UNIT_LABEL[distanceUnitOf(ex)];
  }
}

/** Valor digitado (na unidade da tela) → valor gravado (kg, s, m). null quando não há número. */
export function toStoredValue(type: GoalType, ex: GoalExerciseRef | null, display: number | null, weightUnit: WeightUnit): number | null {
  if (!ok(display)) return null;
  switch (type) {
    case 'max_load':
    case 'e1rm':
      return fromDisplay(display, weightUnit);
    case 'duration':
      return durationInMinutes(ex) ? Math.round(display * 60) : display;
    case 'distance':
      return toMetersFrom(display, distanceUnitOf(ex));
    default:
      return display;
  }
}

/** Valor gravado → número para preencher o campo na edição. */
export function toDisplayValue(type: GoalType, ex: GoalExerciseRef | null, stored: number, weightUnit: WeightUnit): number {
  switch (type) {
    case 'max_load':
    case 'e1rm':
      return Math.round((toDisplay(stored, weightUnit) ?? 0) * 100) / 100;
    case 'duration':
      return durationInMinutes(ex) ? Math.round((stored / 60) * 100) / 100 : stored;
    case 'distance':
      return Math.round(fromMetersTo(stored, distanceUnitOf(ex)) * 1000) / 1000;
    default:
      return stored;
  }
}

/** Valor gravado formatado com a unidade (ex.: "80 kg", "1:30", "5 km", "4 por semana"). */
export function fmtGoalValue(goal: Pick<TrainingGoal, 'type' | 'exercise'>, v: number | null | undefined, weightUnit: WeightUnit): string {
  if (!ok(v)) return '—';
  switch (goal.type) {
    case 'weekly_frequency':
      return `${fmtNum(v, 0)} por semana`;
    case 'session_count':
      return `${fmtNum(v, 0)} ${v === 1 ? 'sessão' : 'sessões'}`;
    case 'max_load':
    case 'e1rm':
      return `${fmtNum(toDisplay(v, weightUnit), 1)} ${weightUnit}`;
    case 'reps':
      return `${fmtNum(v, 0)} ${v === 1 ? 'repetição' : 'repetições'}`;
    case 'duration':
      return fmtDurationSec(Math.round(v));
    case 'distance': {
      const u = distanceUnitOf(goal.exercise);
      return `${fmtNum(fromMetersTo(v, u), u === 'm' ? 0 : 2)} ${u}`;
    }
  }
}

/** Quantidade atual sem a unidade (para "3 de 4"). */
export function fmtGoalNumber(goal: Pick<TrainingGoal, 'type' | 'exercise'>, v: number | null | undefined, weightUnit: WeightUnit): string {
  if (!ok(v)) return '—';
  if (goal.type === 'weekly_frequency' || goal.type === 'session_count' || goal.type === 'reps') return fmtNum(v, 0);
  return fmtGoalValue(goal, v, weightUnit);
}

const SIDE_TEXT = { direito: 'lado direito', esquerdo: 'lado esquerdo', ambos: 'ambos os lados', desconhecido: 'lado não informado' } as const;

/** Descrição curta da evidência (data e série), só com dados registrados. */
export function fmtEvidence(goal: Pick<TrainingGoal, 'type' | 'exercise'>, e: GoalEvidence | null, weightUnit: WeightUnit): string {
  if (!e) return '';
  const parts = [fmtGoalValue(goal, e.value, weightUnit)];
  if ((goal.type === 'max_load' || goal.type === 'e1rm') && ok(e.reps)) parts[0] = `${parts[0]}${goal.type === 'e1rm' ? ` (série de ${fmtNum(e.load ? toDisplay(e.load, weightUnit) : null, 1)} ${weightUnit} × ${e.reps})` : ` × ${e.reps}`}`;
  if (goal.type === 'reps' && ok(e.load)) parts[0] = `${parts[0]} com ${fmtNum(toDisplay(e.load, weightUnit), 1)} ${weightUnit}`;
  if (e.side) parts.push(SIDE_TEXT[e.side]);
  return `${parts.join(', ')} em ${fmtDateShort(e.date)}`;
}

export const DISPLAY_STATE_LABEL: Record<GoalDisplayState, string> = {
  ativa: 'Ativa',
  atingida: 'Atingida',
  pausada: 'Pausada',
  arquivada: 'Arquivada',
  prazo_encerrado: 'Prazo encerrado',
  nao_iniciada: 'Começa depois',
};

/** Título sugerido a partir do que foi preenchido (o usuário pode trocar). */
export function suggestTitle(type: GoalType, ex: GoalExerciseRef | null, stored: number | null, windowDays: number | null, weightUnit: WeightUnit): string {
  const v = ok(stored) ? stored : null;
  const name = ex?.name ?? '';
  switch (type) {
    case 'weekly_frequency':
      return v ? `Treinar ${fmtNum(v, 0)}x por semana` : 'Frequência semanal';
    case 'session_count':
      return v && windowDays ? `${fmtNum(v, 0)} sessões em ${windowDays} dias` : 'Quantidade de sessões';
    case 'e1rm':
      return name ? `${name}: 1RM estimado de ${v ? fmtGoalValue({ type, exercise: ex }, v, weightUnit) : '…'}` : GOAL_TYPE_LABEL[type];
    default:
      return name ? `${name}: ${v ? fmtGoalValue({ type, exercise: ex }, v, weightUnit) : '…'}` : GOAL_TYPE_LABEL[type];
  }
}
