import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/db/db';
import { listCalendarDecisions, type StoredDecisions } from '@/db/calendarDecisions';
import { useActiveRoutine, useCurrentProfile, useRoutines, useToday } from '@/hooks/data';
import { usePlanEntries, usePlannerSessions, useRotations } from '@/hooks/usePlanner';
import { resolveMonth, resolveRange, resolveWeek, type CalendarInput, type ResolvedDay, type ResolvedMonth, type ResolvedWeek } from '@/modules/calendar';
import type { DayOverride, Routine } from '@/lib/types';

/** Entradas do calendário com as rotinas completas (as telas iniciam treinos a partir delas). */
export type CalendarData = Omit<CalendarInput, 'routines'> & { routines: Routine[] };

// Calendário unificado (IronTrack 2.0 F01/P14, docs/CALENDARIO_UNIFICADO.md). Só leitura: reúne as fontes (sessões,
// planejamento, agenda anterior da rotina ativa e rotação) e entrega ao domínio puro, que resolve os dias sob demanda.
// Nada é gravado e nenhum dia é materializado no banco.

/** Reagendamentos da agenda anterior de uma rotina (só leitura). */
function useOverrides(routineId: string | undefined): DayOverride[] | undefined {
  return useLiveQuery(async () => (routineId ? db.overrides.where('routineId').equals(routineId).toArray() : []), [routineId]);
}

/**
 * P16: decisões lembradas do perfil (validadas; os registros ilegíveis vêm à parte). Observadas ao vivo: uma decisão
 * tomada ou removida em outra aba atualiza as três telas.
 */
export function useStoredDecisions(): StoredDecisions | undefined {
  return useLiveQuery(() => listCalendarDecisions(), []);
}

/** Entradas do calendário unificado (undefined enquanto carrega). Observadas ao vivo: outra aba atualiza a tela. */
export function useCalendarInput(): CalendarData | undefined {
  const today = useToday();
  const entries = usePlanEntries();
  const sessions = usePlannerSessions();
  const routines = useRoutines();
  const rotations = useRotations();
  const profile = useCurrentProfile();
  const { routine: active, settings } = useActiveRoutine();
  const overrides = useOverrides(active?.id);
  const stored = useStoredDecisions();
  const decisions = stored?.decisions;
  // Memoizado pelas fontes: o cronômetro do treino e outras atualizações visuais não recalculam o calendário nem as
  // impressões digitais (só uma mudança real em alguma fonte ou nas decisões).
  return useMemo(() => {
    if (!entries || !sessions || !routines || !rotations || active === undefined || !overrides || !decisions) return undefined;
    return {
      today,
      profileId: profile?.id,
      entries,
      sessions,
      routines,
      rotations,
      legacy: active && active.workouts.length ? { routineId: active.id, trainingDays: settings.trainingDays, overrides } : null,
      decisions,
    };
  }, [today, entries, sessions, routines, rotations, profile?.id, active, settings.trainingDays, overrides, decisions]);
}

export function useResolvedRange(from: string, to: string): { input: CalendarInput; days: ResolvedDay[] } | undefined {
  const input = useCalendarInput();
  return useMemo(() => (input ? { input, days: resolveRange(input, from, to) } : undefined), [input, from, to]);
}

export function useResolvedWeek(anyDay: string): ResolvedWeek | undefined {
  const input = useCalendarInput();
  return useMemo(() => (input ? resolveWeek(input, anyDay) : undefined), [input, anyDay]);
}

export function useResolvedMonth(month: string): ResolvedMonth | undefined {
  const input = useCalendarInput();
  return useMemo(() => (input ? resolveMonth(input, month) : undefined), [input, month]);
}
