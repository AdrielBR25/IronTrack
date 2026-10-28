import type { DistanceUnit, ExerciseModelFields, SessionSet } from '@/lib/types';
import { SIDE_SHORT, exerciseMeasures, fmtDurationSec, fmtRepRange, fromMetersTo, isValidDistanceM, isValidDurationSec } from '@/modules/training';
import { fmtNum } from '@/lib/utils';

// Textos de exibição do modelo v3 (P10). Só formatam o que existe: campo ausente vira "—" ou some, nunca zero.

type FmtW = (kg: number | null | undefined, withUnit?: boolean) => string;

export const distanceUnitOf = (ex: ExerciseModelFields): DistanceUnit => ex.distanceUnit ?? 'km';

export function fmtDistance(m: number, unit: DistanceUnit): string {
  return `${fmtNum(fromMetersTo(m, unit), unit === 'm' ? 0 : 2)} ${unit}`;
}

/** Plano do exercício: "3 × 8–12", "3 × 45 s", "30:00 · 5,00 km". */
export function planSummary(ex: ExerciseModelFields & { sets?: number | unknown[]; plannedSets?: number; repMin: number; repMax: number }): string {
  const ms = exerciseMeasures(ex);
  // Ficha: `sets` é o número de séries; sessão: `plannedSets` (lá `sets` é a lista de séries).
  const sets = typeof ex.sets === 'number' ? ex.sets : (ex.plannedSets ?? 0);
  if (ms.distance) {
    const parts = [ex.targetDurationSec ? fmtDurationSec(ex.targetDurationSec) : null, ex.targetDistance ? fmtDistance(ex.targetDistance, distanceUnitOf(ex)) : null].filter(Boolean);
    return `${sets > 1 ? `${sets} × ` : ''}${parts.join(' · ') || 'cardio'}`;
  }
  if (ms.duration) return `${sets} × ${ex.targetDurationSec ? fmtDurationSec(ex.targetDurationSec) : 'tempo'}`;
  return `${sets} × ${fmtRepRange(ex.repMin, ex.repMax)}`;
}

/**
 * Resumo de uma série a partir do que ela registrou. Séries antigas mantêm o formato de antes ("60×8").
 * Exemplos: "E 20×10", "45 s", "+10 kg × 8", "assist. 15 kg × 6", "25:00 · 5,00 km".
 */
export function setSummary(set: SessionSet, fmtW: FmtW, ex: ExerciseModelFields = {}): string {
  const side = set.side && SIDE_SHORT[set.side] ? `${SIDE_SHORT[set.side]} ` : '';
  const dur = isValidDurationSec(set.durationSec) ? fmtDurationSec(set.durationSec) : null;
  const dist = isValidDistanceM(set.distance) ? fmtDistance(set.distance, distanceUnitOf(ex)) : null;
  const hasReps = set.reps != null && set.reps > 0;
  if (!hasReps && (dur || dist)) {
    const load = set.weight != null && set.weight > 0 ? ` · +${fmtW(set.weight)}` : '';
    return `${side}${[dur, dist].filter(Boolean).join(' · ')}${load}`;
  }
  const reps = set.reps ?? '—';
  if (set.assistanceKg != null && set.assistanceKg > 0) return `${side}assist. ${fmtW(set.assistanceKg)} × ${reps}`;
  if (ex.loadMode === 'adicional') return `${side}${set.weight != null && set.weight > 0 ? `+${fmtW(set.weight)}` : 'corpo'} × ${reps}`;
  if (set.weight == null && exerciseMeasures(ex).weight === 'none') return `${side}${reps} reps`;
  return `${side}${fmtW(set.weight, false)}×${set.reps ?? 0}`;
}
