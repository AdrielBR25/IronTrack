import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/db/db';
import { buildPerformanceIndex, type PerformanceIndex } from '@/modules/performance';

/**
 * Índice de desempenho (P19) das sessões concluídas do perfil atual. Uma consulta ao IndexedDB por mudança no banco
 * (inclusive vinda de outra aba, pelo liveQuery do Dexie) e um recálculo puro memorizado; nunca uma consulta por série.
 */
export function usePerformanceIndex(): PerformanceIndex | undefined {
  const data = useLiveQuery(async () => ({ sessions: await db.sessions.where('status').equals('completed').toArray(), profileId: db.currentProfileId }), []);
  return useMemo(() => (data ? buildPerformanceIndex(data.sessions, { profileId: data.profileId }) : undefined), [data]);
}
