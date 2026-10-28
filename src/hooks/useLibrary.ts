import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/db/db';
import { completedSessionsOfProfile, listCustomExercises, listFavorites } from '@/db/library';
import { buildIndex, libraryItems, mostUsed, recentKeys, resolveFavorites, sheetKeys, type LibraryIndex, type LibraryItem, type LibraryKey, type ExerciseFavorite, type MostUsed } from '@/modules/exercises';
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
  /** P18: itens presentes nas fichas pela origem da instância (quantidade de instâncias). Não é uso executado. */
  inSheets: Map<LibraryKey, number>;
  /** P18: itens usados em sessões concluídas, pela origem gravada na cópia da sessão. */
  usedInSessions: Set<LibraryKey>;
  mostUsed: MostUsed;
}

/**
 * Biblioteca completa: catálogo estático + personalizados e favoritos do perfil (observados pelo Dexie: o que outra
 * aba grava aparece sozinho, inclusive depois de restaurar um backup). O índice de busca só é refeito quando a lista
 * muda, nunca a cada tecla. undefined enquanto carrega; `error` quando o armazenamento local falha.
 */
export function useLibrary(): { data: LibraryData | undefined; error: string | null } {
  const stored = useLiveQuery(async () => {
    try {
      const [customs, favorites, sessions, routines] = await Promise.all([listCustomExercises(), listFavorites(), completedSessionsOfProfile(), db.routines.toArray()]);
      const pid = db.currentProfileId;
      const used = mostUsed(sessions, pid, Number.MAX_SAFE_INTEGER);
      return {
        ok: true as const,
        customs,
        favorites,
        recent: recentKeys(sessions, 12, RECENT_SESSIONS),
        inSheets: sheetKeys(routines, pid),
        usedInSessions: new Set(used.ranked.map((r) => r.key)),
        mostUsed: { ...used, ranked: used.ranked.slice(0, 10) },
      };
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
      inSheets: stored.inSheets,
      usedInSessions: stored.usedInSessions,
      mostUsed: stored.mostUsed,
    };
  }, [stored]);
  return { data, error: stored && !stored.ok ? stored.error : null };
}
