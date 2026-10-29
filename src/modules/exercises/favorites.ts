// Favoritos da biblioteca (P17, docs/BIBLIOTECA_EXERCICIOS.md §6). Um registro por (perfil, exercício), com ID
// determinístico `<perfil>~<alvo>`: favoritar duas vezes (toque duplo, duas abas) grava o MESMO registro, nunca dois.
// O alvo é `catalog:<catalogId>` ou `custom:<id>`. Favorito de um item que não existe mais (entrada retirada de uma
// versão futura do catálogo, personalizado excluído em outro aparelho e restaurado por backup) não é apagado nem
// remapeado por nome: aparece como "indisponível" e pode ser removido pela pessoa.
import { CATALOG_ID_RE, CUSTOM_ID_RE } from './custom';
import type { ExerciseFavorite, LibraryItem, LibraryKey } from './types';

export const FAVORITE_LIMITS = { maxPerProfile: 1000, maxId: 300 } as const;

export const favoriteId = (profileId: string, target: LibraryKey) => `${profileId}~${target}`;

export function isLibraryKey(v: unknown): v is LibraryKey {
  if (typeof v !== 'string') return false;
  if (v.startsWith('catalog:')) return CATALOG_ID_RE.test(v.slice(8)) && v.length <= 120;
  if (v.startsWith('custom:')) return CUSTOM_ID_RE.test(v.slice(7));
  return false;
}

export function favoriteIssues(r: unknown): string[] {
  if (typeof r !== 'object' || r === null) return ['registro não é um objeto'];
  const f = r as Partial<ExerciseFavorite>;
  const out: string[] = [];
  if (!isLibraryKey(f.target)) out.push('alvo do favorito inválido');
  if (typeof f.profileId !== 'string' || !f.profileId) out.push('favorito sem perfil');
  if (typeof f.id !== 'string' || f.id.length > FAVORITE_LIMITS.maxId) out.push('identificador inválido');
  else if (typeof f.profileId === 'string' && isLibraryKey(f.target) && f.id !== favoriteId(f.profileId, f.target)) out.push('identificador não corresponde ao perfil e ao alvo');
  if (typeof f.createdAt !== 'number' || !Number.isFinite(f.createdAt) || f.createdAt < 0) out.push('data de criação inválida');
  return out;
}

export const isValidFavorite = (r: unknown): r is ExerciseFavorite => favoriteIssues(r).length === 0;

export interface ResolvedFavorites {
  /** Chaves favoritas que existem na biblioteca atual (inclui arquivados). */
  keys: Set<LibraryKey>;
  /** Favoritos sem item correspondente (mantidos até a pessoa removê-los). */
  orphans: ExerciseFavorite[];
}

export function resolveFavorites(favorites: readonly ExerciseFavorite[], items: readonly LibraryItem[]): ResolvedFavorites {
  const known = new Set(items.map((i) => i.key));
  const keys = new Set<LibraryKey>();
  const orphans: ExerciseFavorite[] = [];
  for (const f of favorites) {
    if (!isValidFavorite(f)) continue;
    if (known.has(f.target)) keys.add(f.target);
    else orphans.push(f);
  }
  orphans.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return { keys, orphans };
}
