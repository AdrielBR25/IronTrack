import { instanceFromItem, type LibraryItem } from '@/modules/exercises';
import { sessionExerciseFromTemplate } from '@/modules/training';
import type { SessionExercise, Settings, WorkoutSession } from '@/lib/types';
import { uid } from '@/lib/utils';

/**
 * Exercício NOVO para uma sessão (treino em andamento ou edição do histórico), montado a partir de um item da biblioteca
 * (P20, docs/BIBLIOTECA_VISUAL.md §substituição). Identidade própria: ID novo, sem `templateId` (não é a instância da
 * ficha, então metas não são redirecionadas), origem do catálogo/personalizado gravada. Cargas sugeridas só do histórico
 * do PRÓPRIO exercício; `noLoads` (exercício esquecido no histórico) não sugere nenhuma.
 */
export function sessionCandidate(item: LibraryItem, settings: Pick<Settings, 'muscleGroups' | 'restCompoundSec' | 'restIsolationSec'>, history: WorkoutSession[], o: { noLoads?: boolean } = {}): SessionExercise {
  const template = instanceFromItem(item, { id: uid(), muscleGroups: settings.muscleGroups, rest: { restCompoundSec: settings.restCompoundSec, restIsolationSec: settings.restIsolationSec } });
  return sessionExerciseFromTemplate(template, history, { withTemplateId: false, ...(o.noLoads ? { last: null } : {}) });
}
