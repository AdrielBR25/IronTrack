// Leitura das séries executadas para os painéis de desempenho (P19). Ver docs/DESEMPENHO_EXERCICIOS.md §2–3.
// Puro: recebe as cópias da sessão e devolve as séries classificadas e as medidas da sessão. Nada é gravado e o
// snapshot da sessão nunca é alterado.
import { canonicalE1rm, localDate } from '@/modules/analytics';
import { DISTANCE_UNITS, LATERALITIES, LOAD_MODES, isSetSide, isValidAssistanceKg, isValidDistanceM, isValidDurationSec, type SessionExercise, type SessionSet, type WorkoutSession } from '@/modules/training';
import { measureFamilyOf } from './identity';
import type { MeasureFamily, PerfMetrics, PerfObservation, PerfSet, PerfSetKind } from './types';

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isPosInt = (v: unknown): v is number => isPos(v) && Number.isInteger(v);

/** Comparação de valores derivados de kg/s/m sem ruído de ponto flutuante. */
export const EPS = 1e-6;
export const same = (a: number, b: number) => Math.abs(a - b) <= EPS;
export const greater = (a: number, b: number) => a - b > EPS;

/** Medida exigida pela família: sem ela a série concluída é "incompleta" (nunca vira zero). */
function hasRequiredMeasure(family: MeasureFamily, s: SessionSet): boolean {
  if (family === 'carga') return isPosInt(s.reps);
  if (family === 'corporal') {
    // Carga adicional e assistência ao mesmo tempo é incompatível (mesma regra do P09/P10).
    if (isPos(s.weight) && isPos(s.assistanceKg)) return false;
    return isPosInt(s.reps) || isValidDurationSec(s.durationSec);
  }
  if (family === 'tempo') return isValidDurationSec(s.durationSec);
  return isValidDurationSec(s.durationSec) || isValidDistanceM(s.distance);
}

/**
 * Classifica as séries executadas (pendentes ficam de fora). A ordem das séries normais (1, 2, 3…) conta também as
 * incompletas e puladas, para a comparação série a série não deslocar a correspondência. Em unilaterais, por lado.
 */
export function classifySets(family: MeasureFamily, sets: readonly SessionSet[]): PerfSet[] {
  const out: PerfSet[] = [];
  const counters = new Map<string, number>();
  for (const s of sets) {
    if (!s || s.status === 'pending') continue;
    let kind: PerfSetKind;
    if (s.status === 'skipped') kind = 'pulada';
    else if (s.status !== 'done') continue;
    else if (s.type === 'warmup') kind = 'aquecimento';
    else if (!hasRequiredMeasure(family, s)) kind = 'incompleta';
    else kind = s.type === 'drop' ? 'drop' : 'trabalho';
    const side = isSetSide(s.side) ? s.side : null;
    let ordinal: number | null = null;
    if (s.type === 'normal' && kind !== 'aquecimento') {
      const k = side ?? '-';
      ordinal = (counters.get(k) ?? 0) + 1;
      counters.set(k, ordinal);
    }
    out.push({
      id: String(s.id),
      kind,
      type: s.type,
      ordinal,
      side,
      loadKg: isPos(s.weight) ? s.weight : null,
      reps: isPosInt(s.reps) ? s.reps : null,
      assistanceKg: isValidAssistanceKg(s.assistanceKg) && s.assistanceKg > 0 ? s.assistanceKg : null,
      durationSec: isValidDurationSec(s.durationSec) ? s.durationSec : null,
      distanceM: isValidDistanceM(s.distance) ? s.distance : null,
    });
  }
  return out;
}

const emptyMetrics = (): PerfMetrics => ({
  workSets: 0,
  normalSets: 0,
  warmupSets: 0,
  incompleteSets: 0,
  skippedSets: 0,
  topLoadKg: null,
  topLoadReps: null,
  bestReps: null,
  bestRepsLoadKg: null,
  totalReps: null,
  volumeKg: null,
  e1rm: null,
  bodyOnlyBestReps: null,
  addedLoadKg: null,
  addedLoadReps: null,
  minAssistanceKg: null,
  minAssistanceReps: null,
  bestDurationSec: null,
  totalDurationSec: null,
  distanceM: null,
  cardioDurationSec: null,
  paceSecPerKm: null,
  pacedDistanceM: null,
});

/**
 * Medidas da sessão a partir das séries de trabalho (normais e drop). Aquecimento, incompletas e puladas só entram
 * nas contagens. Volume e 1RM só em musculação; 1RM pelo contrato canônico `epley-1a12-v1` (nada de fórmula nova).
 */
export function metricsOf(family: MeasureFamily, sets: readonly PerfSet[]): PerfMetrics {
  const m = emptyMetrics();
  let pacedDur = 0;
  let pacedDist = 0;
  for (const s of sets) {
    if (s.kind === 'aquecimento') m.warmupSets++;
    else if (s.kind === 'incompleta') m.incompleteSets++;
    else if (s.kind === 'pulada') m.skippedSets++;
    if (s.kind !== 'trabalho' && s.kind !== 'drop') continue;
    m.workSets++;
    if (s.kind === 'trabalho') m.normalSets++;
    if (family === 'carga') {
      const reps = s.reps!;
      m.totalReps = (m.totalReps ?? 0) + reps;
      if (m.bestReps === null || reps > m.bestReps || (reps === m.bestReps && (s.loadKg ?? 0) > (m.bestRepsLoadKg ?? 0))) {
        m.bestReps = reps;
        m.bestRepsLoadKg = s.loadKg;
      }
      if (s.loadKg === null) continue;
      m.volumeKg = (m.volumeKg ?? 0) + s.loadKg * reps;
      if (m.topLoadKg === null || greater(s.loadKg, m.topLoadKg) || (same(s.loadKg, m.topLoadKg) && reps > (m.topLoadReps ?? 0))) {
        m.topLoadKg = s.loadKg;
        m.topLoadReps = reps;
      }
      const e = canonicalE1rm(s.loadKg, reps);
      if (e.ok && (m.e1rm === null || greater(e.valueKg, m.e1rm.valueKg))) m.e1rm = { valueKg: e.valueKg, kind: e.kind, loadKg: e.loadKg, reps: e.reps, method: e.method };
    } else if (family === 'corporal') {
      if (s.durationSec !== null) {
        m.bestDurationSec = Math.max(m.bestDurationSec ?? 0, s.durationSec);
        m.totalDurationSec = (m.totalDurationSec ?? 0) + s.durationSec;
      }
      if (s.reps === null) continue;
      m.totalReps = (m.totalReps ?? 0) + s.reps;
      m.bestReps = Math.max(m.bestReps ?? 0, s.reps);
      if (s.loadKg !== null) {
        if (m.addedLoadKg === null || greater(s.loadKg, m.addedLoadKg) || (same(s.loadKg, m.addedLoadKg) && s.reps > (m.addedLoadReps ?? 0))) {
          m.addedLoadKg = s.loadKg;
          m.addedLoadReps = s.reps;
        }
      } else if (s.assistanceKg !== null) {
        if (m.minAssistanceKg === null || greater(m.minAssistanceKg, s.assistanceKg) || (same(s.assistanceKg, m.minAssistanceKg) && s.reps > (m.minAssistanceReps ?? 0))) {
          m.minAssistanceKg = s.assistanceKg;
          m.minAssistanceReps = s.reps;
        }
      } else m.bodyOnlyBestReps = Math.max(m.bodyOnlyBestReps ?? 0, s.reps);
    } else if (family === 'tempo') {
      m.bestDurationSec = Math.max(m.bestDurationSec ?? 0, s.durationSec!);
      m.totalDurationSec = (m.totalDurationSec ?? 0) + s.durationSec!;
    } else {
      if (s.durationSec !== null) m.cardioDurationSec = (m.cardioDurationSec ?? 0) + s.durationSec;
      if (s.distanceM !== null) m.distanceM = (m.distanceM ?? 0) + s.distanceM;
      if (s.durationSec !== null && s.distanceM !== null) {
        pacedDur += s.durationSec;
        pacedDist += s.distanceM;
      }
    }
  }
  if (pacedDist > 0) {
    m.paceSecPerKm = pacedDur / (pacedDist / 1000);
    m.pacedDistanceM = pacedDist;
  }
  return m;
}

const pickOne = <T extends string>(list: readonly T[], v: unknown): T | null => ((list as readonly unknown[]).includes(v) ? (v as T) : null);

/**
 * Observação de uma identidade numa sessão. `copies` são as cópias da sessão que pertencem à identidade (normalmente
 * uma). A família e os atributos vêm da primeira cópia; cópias de outra família não são somadas (ficam de fora).
 */
export function observationOf(session: WorkoutSession, copies: readonly { ex: SessionExercise; primaryKey: string }[]): PerfObservation | null {
  if (!copies.length) return null;
  const first = copies[0].ex;
  const family = measureFamilyOf(first);
  const usable = copies.filter((c) => measureFamilyOf(c.ex) === family);
  const sets = classifySets(
    family,
    usable.flatMap((c) => c.ex.sets ?? []),
  );
  const metrics = metricsOf(family, sets);
  // Sem nenhuma série executada (tudo pendente), a cópia não foi realizada: não gera observação.
  if (!sets.length) return null;
  const date = localDate(session.startedAt);
  return {
    sessionId: session.id,
    ts: session.startedAt,
    date,
    routineId: String(session.routineId ?? ''),
    workoutId: String(session.workoutId ?? ''),
    workoutLabel: String(session.workoutLabel ?? ''),
    workoutName: String(session.workoutName ?? ''),
    primaryKeys: [...new Set(usable.map((c) => c.primaryKey))],
    name: String(first.name ?? '').trim() || 'Exercício sem nome',
    family,
    loadMode: pickOne(LOAD_MODES, first.loadMode),
    laterality: pickOne(LATERALITIES, first.laterality),
    equipment: typeof first.equipment === 'string' ? first.equipment : null,
    distanceUnit: pickOne(DISTANCE_UNITS, first.distanceUnit),
    repMax: isPosInt(first.repMax) ? first.repMax : null,
    catalogId: typeof first.catalogId === 'string' && first.catalogId ? first.catalogId : null,
    customExerciseId: typeof first.customExerciseId === 'string' && first.customExerciseId ? first.customExerciseId : null,
    substitutedFrom: typeof first.substitutedFrom === 'string' && first.substitutedFrom ? first.substitutedFrom : null,
    copies: usable.length,
    sets,
    metrics,
  };
}
