// Previsão da rotação (IronTrack 2.0 F01/P14, docs/CALENDARIO_UNIFICADO.md §6).
// Problema do P13: "próximo da rotação" em dias futuros repetia o ponteiro ATUAL em todos eles. Aqui a previsão é uma
// simulação determinística a partir do ponteiro, nunca um fato:
//  - a primeira atividade "segue a rotação" de uma rotina, sem nada antes dela que mova o ponteiro, recebe o treino do
//    ponteiro atual (`current`);
//  - cada atividade seguinte da mesma rotina é simulada como se as anteriores fossem concluídas e a rotação avançasse
//    pela regra de sempre (`forecast`): "segue a rotação" consome o próximo; treino específico faz a rotação continuar
//    a partir dele (`indexAfter`);
//  - um treino em andamento da rotina conta como se fosse concluído (a previsão vira `forecast`);
//  - além de FORECAST_HORIZON_DAYS, ou sem treinos na rotina: `undetermined` ("Treino a definir pela rotação").
// Nada é gravado e a rotação não avança: é só leitura do ponteiro.
import { indexAfter, normIndex, type RotationState, type WorkoutSession } from '@/modules/training';
import { planAddDays, planForDate, type DayView, type PlanEntry } from '@/modules/planner';
import { FORECAST_HORIZON_DAYS, daysBetween } from './legacy';
import type { CalendarRoutine, RotationForecast } from './types';

export interface ForecastInput {
  entries: readonly PlanEntry[];
  routines: readonly CalendarRoutine[];
  rotations: readonly RotationState[];
  sessions: readonly WorkoutSession[];
  profileId: string | undefined;
  today: string;
  /** O dia de hoje como o planejamento o calcula (para saber o que já foi realizado ou está em andamento). */
  todayView: DayView;
  /** Última data que interessa (inclusive). */
  to: string;
}

const undetermined = (routineId: string): RotationForecast => ({ routineId, workoutId: null, workoutLabel: null, workoutName: null, certainty: 'undetermined' });

/** Ponteiro atual de uma rotina (0 se nunca gravado), normalizado para a quantidade de treinos. */
export function rotationPointer(routine: CalendarRoutine, rotations: readonly RotationState[]): number {
  return normIndex(rotations.find((r) => r.routineId === routine.id)?.nextIndex ?? 0, routine.workouts.length);
}

/**
 * Previsões de hoje até `to` (chave: data → ID da entrada → previsão), só para atividades que seguem a rotação.
 * Datas passadas não entram (o passado é mostrado pelo que foi registrado).
 */
export function forecastRotation(input: ForecastInput): Map<string, Record<string, RotationForecast>> {
  const out = new Map<string, Record<string, RotationForecast>>();
  if (input.to < input.today) return out;
  const state = new Map<string, { p: number; simulated: boolean }>();
  const ownActive = input.sessions.find((s) => s?.status === 'active' && (!input.profileId || !s.profileId || s.profileId === input.profileId));
  for (const r of input.routines) {
    if (!r.workouts.length) continue;
    let p = rotationPointer(r, input.rotations);
    let simulated = false;
    if (ownActive && ownActive.routineId === r.id && r.workouts.some((w) => w.id === ownActive.workoutId)) {
      p = indexAfter(r.workouts.map((w) => w.id), ownActive.workoutId, p);
      simulated = true;
    }
    state.set(r.id, { p, simulated });
  }
  // Atividades de hoje já resolvidas não consomem a rotação de novo: a concluída já moveu o ponteiro; a em andamento
  // foi considerada acima.
  const settledToday = new Set(input.todayView.activities.filter((a) => a.status === 'realizada' || a.status === 'em_andamento').map((a) => a.entry.id));

  for (let d = input.today; d <= input.to; d = planAddDays(d, 1)) {
    const beyond = daysBetween(input.today, d) >= FORECAST_HORIZON_DAYS;
    const plan = planForDate(input.entries, d);
    const day: Record<string, RotationForecast> = {};
    for (const e of plan.entries) {
      if (e.kind !== 'workout' || !e.routineId) continue;
      if (d === input.today && settledToday.has(e.id)) continue;
      const routine = input.routines.find((r) => r.id === e.routineId);
      const st = routine ? state.get(routine.id) : undefined;
      if (e.workoutId !== null) {
        // Treino específico: a rotação continua a partir dele (regra de `completeSession`).
        if (routine && st && routine.workouts.some((w) => w.id === e.workoutId)) {
          st.p = indexAfter(routine.workouts.map((w) => w.id), e.workoutId, st.p);
          st.simulated = true;
        }
        continue;
      }
      if (!routine || !st || beyond) {
        day[e.id] = undetermined(e.routineId);
        continue;
      }
      const w = routine.workouts[normIndex(st.p, routine.workouts.length)];
      day[e.id] = { routineId: routine.id, workoutId: w.id, workoutLabel: w.label, workoutName: w.name, certainty: st.simulated ? 'forecast' : 'current' };
      st.p = normIndex(st.p + 1, routine.workouts.length);
      st.simulated = true;
    }
    if (Object.keys(day).length) out.set(d, day);
  }
  return out;
}
