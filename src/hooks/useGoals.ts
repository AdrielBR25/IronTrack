import { useLiveQuery } from 'dexie-react-hooks';
import { listGoals } from '@/db/goals';
import type { TrainingGoal } from '@/lib/types';

/**
 * Metas do perfil local (undefined enquanto carrega). A consulta é observada pelo Dexie: uma meta criada, editada,
 * arquivada ou excluída em outra aba atualiza a tela sozinha.
 */
export function useGoals(): TrainingGoal[] | undefined {
  return useLiveQuery(() => listGoals(), []);
}
