import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { BodyEntry, ProgressPhoto } from '@/lib/types';

// Consultas reativas da evolução corporal (undefined enquanto carregam).

/** Avaliações em ordem de data. */
export function useBodyEntries(): BodyEntry[] | undefined {
  return useLiveQuery(() => db.bodyEntries.orderBy('date').toArray(), []);
}

export function useProgressPhotos(): ProgressPhoto[] | undefined {
  return useLiveQuery(() => db.photos.toArray(), []);
}
