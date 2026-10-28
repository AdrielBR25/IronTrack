import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { listCustomExercises, listFavorites } from '@/db/library';
import { recentCompletedSessions } from '@/db/repo';
import { buildIndex, libraryItems, recentKeys, resolveFavorites, type LibraryIndex, type LibraryItem, type LibraryKey, type ExerciseFavorite } from '@/modules/exercises';
import { getCatalog } from '@/modules/exercises/catalog';
import type { CustomExercise } from '@/lib/types';

/** Treinos recentes considerados em "Usado recentemente". */
const RECENT_SESSIONS = 60;

export interface LibraryData {
  items: LibraryItem[];
  index: LibraryIndex;
  byKey: Map<LibraryKey, LibraryItem>;
  customs: CustomExercise[];
  invalidCustomIds: string[];
  favorites: Set<LibraryKey>;
  orphanFavorites: ExerciseFavorite[];
  recent: LibraryKey[];
}

/**
 * Biblioteca completa: catálogo estático + personalizados e favoritos do perfil (observados pelo Dexie: o que outra
 * aba grava aparece sozinho, inclusive depois de restaurar um backup). O índice de busca só é refeito quando a lista
 * muda, nunca a cada tecla. undefined enquanto carrega; `error` quando o armazenamento local falha.
 */
export function useLibrary(): { data: LibraryData | undefined; error: string | null } {
  const stored = useLiveQuery(async () => {
    try {
      const [customs, favorites, sessions] = await Promise.all([listCustomExercises(), listFavorites(), recentCompletedSessions(RECENT_SESSIONS)]);
      return { ok: true as const, customs, favorites, recent: recentKeys(sessions) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, []);
  const data = useMemo<LibraryData | undefined>(() => {
    if (!stored || !stored.ok) return undefined;
    const items = libraryItems(stored.customs.exercises, getCatalog());
    const fav = resolveFavorites(stored.favorites, items);
    return {
      items,
      index: buildIndex(items),
      byKey: new Map(items.map((i) => [i.key, i])),
      customs: stored.customs.exercises,
      invalidCustomIds: stored.customs.invalidIds,
      favorites: fav.keys,
      orphanFavorites: fav.orphans,
      recent: stored.recent,
    };
  }, [stored]);
  return { data, error: stored && !stored.ok ? stored.error : null };
}
