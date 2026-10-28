// Interpretação da agenda anterior (IronTrack 2.0 F01/P14, docs/CALENDARIO_UNIFICADO.md §1 e §5).
// Usa exatamente a mesma projeção que a Início e a Treinos sempre usaram (`projectSchedule` do treinamento), a partir
// de hoje. Só lê: nunca grava `overrides`, `Settings.trainingDays` nem a rotação.
import { countableSessions } from '@/modules/goals';
import { projectSchedule, type DayOverride, type WorkoutSession } from '@/modules/training';
import { planAddDays, planWeekday, sessionDay } from '@/modules/planner';
import type { CalendarRoutine, LegacyDay, LegacySchedule } from './types';

/** Dias à frente (contando hoje) em que o treino exato da rotação é mostrado como previsão. Depois disso: "a definir". */
export const FORECAST_HORIZON_DAYS = 14;
/** Limite de segurança da projeção da agenda anterior (dias a partir de hoje). */
export const LEGACY_PROJECTION_LIMIT = 400;

/** Diferença em dias de calendário (aritmética em UTC, imune a horário de verão). */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  });
  return Math.round((b - a) / 86_400_000);
}

/**
 * Agenda anterior para as datas de `from` a `to` (inclusive). Hoje e dias futuros vêm da projeção usada desde o P01;
 * dias passados mostram só o que foi configurado (reagendamento ou dia de treino), sem inventar qual treino seria.
 */
export function interpretLegacy(
  legacy: LegacySchedule | null,
  routines: readonly CalendarRoutine[],
  sessions: readonly WorkoutSession[],
  rotationIndex: number,
  profileId: string | undefined,
  today: string,
  from: string,
  to: string,
): Map<string, LegacyDay> {
  const out = new Map<string, LegacyDay>();
  if (!legacy) return out;
  const routine = routines.find((r) => r.id === legacy.routineId);
  if (!routine || routine.workouts.length === 0) return out;
  const order = routine.workouts.map((w) => w.id);
  const byId = new Map(routine.workouts.map((w) => [w.id, w]));
  const overrides = new Map<string, DayOverride>(legacy.overrides.filter((o) => o.routineId === routine.id).map((o) => [o.date, o]));
  const describe = (workoutId: string | null) => {
    const w = workoutId ? byId.get(workoutId) : undefined;
    return { workoutId: w ? w.id : null, workoutLabel: w?.label ?? null, workoutName: w?.name ?? null };
  };

  // Passado: só o que estava configurado para o dia.
  for (let d = from; d <= to && d < today; d = planAddDays(d, 1)) {
    const ov = overrides.get(d);
    if (ov?.kind === 'rest') out.set(d, { date: d, kind: 'rest', source: 'override', routineId: routine.id, ...describe(null), certainty: 'explicit' });
    else if (ov?.kind === 'workout' && ov.workoutId && byId.has(ov.workoutId))
      out.set(d, { date: d, kind: 'workout', source: 'override', routineId: routine.id, ...describe(ov.workoutId), certainty: 'explicit' });
    else if (legacy.trainingDays.includes(planWeekday(d)))
      out.set(d, { date: d, kind: 'workout', source: 'rotation', routineId: routine.id, ...describe(null), certainty: 'suggestion' });
    else out.set(d, { date: d, kind: 'rest', source: 'off', routineId: routine.id, ...describe(null), certainty: 'suggestion' });
  }

  if (to < today) return out;
  const days = Math.min(daysBetween(today, to) + 1, LEGACY_PROJECTION_LIMIT);
  // Concluído hoje (mesma regra da Início: sessão concluída da rotina ativa, no dia local de hoje).
  const doneByDate = new Map<string, string>();
  for (const s of countableSessions(sessions as WorkoutSession[], profileId).list) {
    if (s.routineId === routine.id && sessionDay(s.startedAt) === today) doneByDate.set(today, s.workoutId);
  }
  const plan = projectSchedule({ order, nextIndex: rotationIndex, trainingDays: [...legacy.trainingDays], overrides, doneByDate, start: today, days });
  for (const p of plan) {
    if (p.date < from) continue;
    const ahead = daysBetween(today, p.date);
    if (p.kind === 'done') {
      out.set(p.date, { date: p.date, kind: 'done', source: 'done', routineId: routine.id, ...describe(p.workoutId ?? null), certainty: 'fact' });
    } else if (p.kind === 'rest') {
      out.set(p.date, { date: p.date, kind: 'rest', source: p.source === 'override' ? 'override' : 'off', routineId: routine.id, ...describe(null), certainty: p.source === 'override' ? 'explicit' : 'suggestion' });
    } else if (p.source === 'override') {
      out.set(p.date, { date: p.date, kind: 'workout', source: 'override', routineId: routine.id, ...describe(p.workoutId ?? null), certainty: 'explicit' });
    } else {
      // Dia de treino pela rotação: o treino exato só é conhecido hoje (ponteiro); depois é simulação.
      const certainty = ahead === 0 ? 'current' : ahead < FORECAST_HORIZON_DAYS ? 'forecast' : 'undetermined';
      out.set(p.date, { date: p.date, kind: 'workout', source: 'rotation', routineId: routine.id, ...describe(certainty === 'undetermined' ? null : (p.workoutId ?? null)), certainty });
    }
  }
  return out;
}
