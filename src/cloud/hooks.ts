// Consultas reativas do modo conta para as telas de src/cloud/ui (que não acessam o Dexie diretamente).
import { useLiveQuery } from 'dexie-react-hooks';
import type { OutboxEntry } from './accountDb';
import { currentAccountDb } from './runtime';
import { listConflicts, type ConflictView } from './syncEngine';

export function useOutbox(): OutboxEntry[] | undefined {
  const d = currentAccountDb();
  return useLiveQuery(() => (d ? d.syncOutbox.toArray() : []), [d]);
}

export function useConflicts(): ConflictView[] | undefined {
  const d = currentAccountDb();
  return useLiveQuery(() => (d ? listConflicts(d) : []), [d]);
}

/** Fotos guardadas só neste aparelho (não sincronizadas). */
export function useLocalPhotoCount(): number | undefined {
  const d = currentAccountDb();
  return useLiveQuery(() => (d ? d.photos.count() : 0), [d]);
}
