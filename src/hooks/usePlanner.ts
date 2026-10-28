import { useLiveQuery } from 'dexie-react-hooks';
import { listPlanEntries } from '@/db/planner';
import { db } from '@/db/db';
import type { PlanEntry, RotationState, WorkoutSession } from '@/lib/types';

/**
 * Entradas do planejamento do perfil local (undefined enquanto carrega). Observada pelo Dexie: uma alteração feita
 * em outra aba atualiza a tela sozinha.
 */
export function usePlanEntries(): PlanEntry[] | undefined {
  return useLiveQuery(() => listPlanEntries(), []);
}

/** Sessões concluídas e em andamento (o painel mostra o treino em andamento sem contá-lo como concluído). */
export function usePlannerSessions(): WorkoutSession[] | undefined {
  return useLiveQuery(() => db.sessions.where('status').anyOf('completed', 'active').toArray(), []);
}

/** Ponteiros de rotação (só leitura: o planejamento nunca altera a rotação). */
export function useRotations(): RotationState[] | undefined {
  return useLiveQuery(() => db.rotations.toArray(), []);
}
