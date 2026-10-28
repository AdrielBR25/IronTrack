// Conflitos entre as fontes da agenda (IronTrack 2.0 F01/P14, docs/CALENDARIO_UNIFICADO.md §5).
// Determinístico e só informativo: nenhum conflito é resolvido aqui nem gravado. A tela mostra o aviso e deixa a
// pessoa decidir (manter, ver detalhes, editar o planejamento ou consultar a agenda anterior).
import { planForDate, type DayView, type PlanEntry, type PlannedActivity } from '@/modules/planner';
import type { WorkoutSession } from '@/modules/training';
import type { CalendarConflict, CalendarRoutine, LegacyDay, RotationForecast } from './types';

export const workoutText = (label: string | null, name: string | null) => (label ? `Treino ${label}${name ? ` (${name})` : ''}` : 'treino a definir');

/** Texto de uma atividade planejada, com a previsão quando ela segue a rotação. */
export function activityText(a: Pick<PlannedActivity, 'availability' | 'routineName' | 'workoutLabel' | 'workoutName' | 'followsRotation'>, forecast?: RotationForecast | null): string {
  if (a.availability === 'routine_missing') return 'uma rotina excluída';
  if (a.availability === 'workout_missing') return `${a.routineName}: treino removido da rotina`;
  if (!a.followsRotation) return workoutText(a.workoutLabel, a.workoutName);
  if (forecast?.workoutLabel) return `${workoutText(forecast.workoutLabel, forecast.workoutName)}, pela rotação de ${a.routineName}`;
  return `${a.routineName}: treino a definir pela rotação`;
}

export function legacyText(l: LegacyDay): string {
  if (l.kind === 'rest') return l.source === 'override' ? 'descanso (reagendado)' : 'descanso';
  if (l.kind === 'done') return `${workoutText(l.workoutLabel, l.workoutName)} feito`;
  return l.workoutLabel ? workoutText(l.workoutLabel, l.workoutName) : 'um dia de treino';
}

const sessionText = (s: WorkoutSession) => workoutText(s.workoutLabel, s.workoutName);

const contentKey = (e: PlanEntry) => `${e.kind}|${e.routineId ?? ''}|${e.workoutId ?? ''}`;

export interface ConflictInput {
  date: string;
  today: string;
  entries: readonly PlanEntry[];
  plan: DayView;
  legacy: LegacyDay | null;
  forecasts: Record<string, RotationForecast>;
  routines: readonly CalendarRoutine[];
  /** Treino do ponteiro atual por rotina (para "a rotação indica outro treino" hoje). */
  pointerWorkout: (routineId: string) => { id: string; label: string; name: string } | null;
  hasActiveSession: boolean;
}

export function detectConflicts(input: ConflictInput): CalendarConflict[] {
  const { date, today, plan, legacy, forecasts } = input;
  const out: CalendarConflict[] = [];
  const planWorkouts = plan.activities;
  const planLabel = planWorkouts.length
    ? planWorkouts.map((a) => activityText(a, forecasts[a.entry.id])).join(' + ')
    : plan.marker === 'rest'
      ? 'descanso'
      : plan.marker === 'free'
        ? 'dia livre'
        : null;

  // 1. Planejamento × agenda anterior (só hoje e dias futuros: é onde a divergência muda o que fazer).
  if (date >= today && plan.source !== 'none' && legacy && legacy.kind !== 'done') {
    const lText = legacyText(legacy);
    if (planWorkouts.length === 0 && legacy.kind === 'workout') {
      out.push({
        kind: 'plan_rest_vs_legacy_workout',
        severity: 'warning',
        message: `Seu planejamento indica ${planLabel}, mas a agenda anterior sugere ${lText}.`,
        planLabel,
        otherLabel: lText,
      });
    } else if (planWorkouts.length > 0 && legacy.kind === 'rest') {
      out.push({
        kind: 'plan_workout_vs_legacy_rest',
        severity: legacy.source === 'override' ? 'warning' : 'info',
        message:
          legacy.source === 'override'
            ? `Seu planejamento indica ${planLabel}, mas este dia foi marcado como descanso na agenda anterior.`
            : `Seu planejamento indica ${planLabel}; nas Configurações este não é um dia de treino (agenda anterior).`,
        planLabel,
        otherLabel: lText,
      });
    } else if (planWorkouts.length > 0 && legacy.kind === 'workout' && legacy.workoutId) {
      const matches = planWorkouts.some((a) => a.entry.routineId === legacy.routineId && (a.entry.workoutId ?? forecasts[a.entry.id]?.workoutId ?? null) === legacy.workoutId);
      // Os dois "seguem a rotação" da mesma rotina: é o mesmo próximo treino na hora de treinar (as simulações diferem).
      const bothRotation = legacy.source === 'rotation' && planWorkouts.some((a) => a.followsRotation && a.entry.routineId === legacy.routineId);
      if (!matches && !bothRotation) {
        const explicit = legacy.certainty === 'explicit' || legacy.certainty === 'current';
        out.push({
          kind: 'plan_vs_legacy_workout',
          severity: explicit ? 'warning' : 'info',
          message: explicit
            ? `Seu planejamento indica ${planLabel}, mas a agenda anterior sugere ${lText}.`
            : `Seu planejamento indica ${planLabel}; pela previsão da rotação, a agenda anterior sugeriria ${lText}.`,
          planLabel,
          otherLabel: lText,
        });
      }
    }
  }

  // 2. Exceção substituindo o planejamento semanal daquele dia.
  if (plan.source === 'exception') {
    const recurring = planForDate(
      input.entries.filter((e) => !(e.scope === 'date' && e.date === date)),
      date,
    ).entries;
    const ex = planForDate(input.entries, date).entries;
    const a = new Set(ex.map(contentKey));
    const b = new Set(recurring.map(contentKey));
    const differ = a.size !== b.size || [...a].some((k) => !b.has(k));
    if (recurring.length && differ) {
      const rText = recurring
        .map((e) => {
          if (e.kind === 'rest') return 'descanso';
          if (e.kind === 'free') return 'dia livre';
          const r = input.routines.find((x) => x.id === e.routineId);
          const w = r?.workouts.find((x) => x.id === e.workoutId);
          return e.workoutId === null ? `${r?.name ?? 'rotina excluída'}: próximo da rotação` : workoutText(w?.label ?? null, w?.name ?? null);
        })
        .join(' + ');
      out.push({
        kind: 'exception_replaces_recurring',
        severity: 'info',
        message: `Só neste dia: ${planLabel ?? 'nada planejado'}. O planejamento semanal indicaria ${rText}.`,
        planLabel,
        otherLabel: rText,
      });
    }
  }

  // 3. Hoje: treino específico planejado diferente do próximo da rotação.
  if (date === today && !input.hasActiveSession) {
    for (const a of planWorkouts) {
      if (a.followsRotation || a.status !== 'pendente' || a.availability !== 'ok' || !a.entry.routineId) continue;
      const next = input.pointerWorkout(a.entry.routineId);
      if (next && next.id !== a.entry.workoutId) {
        out.push({
          kind: 'rotation_differs',
          severity: 'info',
          message: `A rotação indica ${workoutText(next.label, next.name)} como próximo; o planejado é ${workoutText(a.workoutLabel, a.workoutName)}. Você escolhe qual iniciar.`,
          planLabel: workoutText(a.workoutLabel, a.workoutName),
          otherLabel: workoutText(next.label, next.name),
        });
      }
    }
  }

  // 4. Treino realizado fora do planejado (a sessão continua no dia em que aconteceu; nada é movido).
  if (plan.source !== 'none') {
    for (const s of plan.sessions.filter((x) => x.entryId === null)) {
      const t = sessionText(s.session);
      out.push({
        kind: 'session_off_plan',
        severity: 'info',
        message: plan.marker === 'rest' && planWorkouts.length === 0 ? `${t} foi realizado num dia de descanso planejado.` : `${t} foi realizado fora do planejado deste dia.`,
        planLabel,
        otherLabel: t,
      });
    }
  }
  return out;
}
