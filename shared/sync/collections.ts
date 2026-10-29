// Coleções do app que sincronizam com a nuvem (Prompt 21, docs/NUVEM_SINCRONIZACAO.md §2).
// Fotos (`photos`) e perfis locais (`profiles`) NÃO sincronizam: fotos ficam só no aparelho nesta fase (sem
// armazenamento privado de objetos) e o perfil da conta é fixo (`data_profile_id`).

export const SYNC_COLLECTIONS = [
  'settings',
  'routines',
  'sessions',
  'rotations',
  'overrides',
  'bodyEntries',
  'goals',
  'planEntries',
  'calendarDecisions',
  'customExercises',
  'exerciseFavorites',
] as const;
export type SyncCollection = (typeof SYNC_COLLECTIONS)[number];

export const isSyncCollection = (v: unknown): v is SyncCollection => typeof v === 'string' && (SYNC_COLLECTIONS as readonly string[]).includes(v);

/** Coleções cujo registro tem `profileId` (o servidor sempre grava o perfil da conta). */
export const PROFILE_OWNED: readonly SyncCollection[] = ['routines', 'sessions', 'bodyEntries', 'goals', 'planEntries', 'calendarDecisions', 'customExercises', 'exerciseFavorites'];

/** Tamanho máximo de um ID de entidade aceito pela nuvem. */
export const MAX_ENTITY_ID = 200;

type Rec = Record<string, unknown>;

/**
 * Identidade da entidade na nuvem a partir do registro local. `rotations` usa o ID da rotina; `overrides` (chave
 * composta no Dexie) vira `<rotina>|<data>`. Devolve null se o registro não tiver identidade válida.
 */
export function entityIdOf(collection: SyncCollection, rec: unknown): string | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Rec;
  let id: unknown;
  if (collection === 'settings') id = r.id === 'settings' ? 'settings' : null;
  else if (collection === 'rotations') id = r.routineId;
  else if (collection === 'overrides') id = typeof r.routineId === 'string' && typeof r.date === 'string' && !r.routineId.includes('|') ? `${r.routineId}|${r.date}` : null;
  else id = r.id;
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ENTITY_ID ? id : null;
}

/** Chave Dexie (primária) correspondente ao ID da nuvem. */
export function dexieKeyOf(collection: SyncCollection, entityId: string): string | [string, string] {
  if (collection === 'overrides') {
    const i = entityId.indexOf('|');
    return [entityId.slice(0, i), entityId.slice(i + 1)];
  }
  return entityId;
}

/** IDs que dependem do perfil (P16/P17): o servidor exige que usem o perfil da conta. */
export function expectedProfileBoundId(collection: SyncCollection, doc: Rec, profileId: string): string | null {
  if (collection === 'calendarDecisions') return typeof doc.conflictId === 'string' ? `${profileId}~${doc.conflictId}` : '';
  if (collection === 'exerciseFavorites') return typeof doc.target === 'string' ? `${profileId}~${doc.target}` : '';
  return null;
}
