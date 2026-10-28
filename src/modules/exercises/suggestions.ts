// Sugestões locais da biblioteca (P17, docs/BIBLIOTECA_EXERCICIOS.md §12). Regras simples, transparentes e
// determinísticas, só com dados deste aparelho e deste perfil: favoritos, uso recente nas sessões (pela origem
// gravada na cópia da sessão, nunca por nome) e semelhança de atributos com um exercício de referência.
// Nunca: IA, rede, necessidades clínicas, "melhor exercício", treinos gerados ou mudanças na ficha sem confirmação.
import type { ExerciseTemplate, WorkoutSession } from '@/modules/training';
import { compareItems } from './search';
import { libraryKeyOf } from './instance';
import { FROM_TEMPLATE_EQUIPMENT, muscleFromText } from './vocab';
import type { LibraryEquipment, LibraryItem, LibraryKey, LibraryMuscle } from './types';

export type SuggestionReason = 'favorito' | 'recente' | 'mesmo_grupo' | 'mesmo_equipamento' | 'mesma_modalidade';

export const SUGGESTION_REASON_LABEL: Record<SuggestionReason, string> = {
  favorito: 'Está nos favoritos.',
  recente: 'Usado recentemente.',
  mesmo_grupo: 'Mesmo grupo muscular.',
  mesmo_equipamento: 'Equipamento semelhante.',
  mesma_modalidade: 'Mesma modalidade.',
};

export interface Suggestion {
  item: LibraryItem;
  /** Motivo principal (o primeiro que se aplica, na ordem da lista acima). */
  reason: SuggestionReason;
}

/** Atributos de comparação (de um item da biblioteca ou de uma instância antiga da ficha). */
export interface Anchor {
  key: LibraryKey | null;
  muscles: LibraryMuscle[];
  equipment: LibraryEquipment[];
  modality: LibraryItem['modality'] | null;
}

export const anchorFromItem = (i: LibraryItem): Anchor => ({ key: i.key, muscles: i.primaryMuscles, equipment: i.equipment, modality: i.modality });

/** Instância da ficha → atributos; o grupo vem da normalização do P09 (texto não reconhecido = sem grupo). */
export function anchorFromTemplate(t: ExerciseTemplate): Anchor {
  const m = muscleFromText(t.muscleGroup);
  return { key: libraryKeyOf(t), muscles: m ? [m] : [], equipment: [FROM_TEMPLATE_EQUIPMENT[t.equipment] ?? 'outros'], modality: t.modality ?? null };
}

/** Chaves usadas nas sessões concluídas, da mais recente para a mais antiga (sem repetição). */
export function recentKeys(sessions: readonly WorkoutSession[], limit = 12): LibraryKey[] {
  const out: LibraryKey[] = [];
  const sorted = sessions.filter((s) => s.status === 'completed').sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
  for (const s of sorted)
    for (const e of s.exercises) {
      const k = libraryKeyOf(e);
      if (k && !out.includes(k)) out.push(k);
      if (out.length >= limit) return out;
    }
  return out;
}

export interface SuggestionInput {
  items: readonly LibraryItem[];
  favorites: ReadonlySet<LibraryKey>;
  recent: readonly LibraryKey[];
  /** Exercício de referência (ex.: o que vai ser substituído). Sem referência: só favoritos e recentes. */
  anchor?: Anchor | null;
  /** Itens que não devem aparecer (ex.: o próprio exercício de referência). */
  exclude?: ReadonlySet<LibraryKey>;
  limit?: number;
}

/**
 * Ordem: com referência, primeiro semelhança (grupo > equipamento > modalidade), e dentro de cada motivo favoritos e
 * recentes antes; sem referência, favoritos e depois recentes. Desempate pelo nome. Arquivados nunca são sugeridos.
 */
export function suggest(input: SuggestionInput): Suggestion[] {
  const { items, favorites, recent, anchor, exclude, limit = 8 } = input;
  const recentRank = new Map(recent.map((k, i) => [k, i]));
  const out: (Suggestion & { rank: number; sub: number })[] = [];
  for (const item of items) {
    if (item.archived || exclude?.has(item.key) || (anchor?.key && item.key === anchor.key)) continue;
    const fav = favorites.has(item.key);
    const rec = recentRank.get(item.key);
    let reason: SuggestionReason | null = null;
    let rank = 9;
    if (anchor) {
      const sameModality = !anchor.modality || item.modality === anchor.modality;
      if (item.primaryMuscles.some((m) => anchor.muscles.includes(m))) [reason, rank] = ['mesmo_grupo', 0];
      else if (sameModality && item.equipment.some((e) => anchor.equipment.includes(e))) [reason, rank] = ['mesmo_equipamento', 1];
      else if (anchor.modality && item.modality === anchor.modality) [reason, rank] = ['mesma_modalidade', 2];
    } else if (fav) [reason, rank] = ['favorito', 0];
    else if (rec !== undefined) [reason, rank] = ['recente', 1];
    if (!reason) continue;
    // Sem referência, o subcritério do recente é a posição na lista de recentes; com referência, favoritos/recentes primeiro.
    const sub = anchor ? (fav ? 0 : rec !== undefined ? 1 : 2) : rec ?? 0;
    out.push({ item, reason, rank, sub });
  }
  out.sort((a, b) => a.rank - b.rank || a.sub - b.sub || compareItems(a.item, b.item));
  return out.slice(0, limit).map(({ item, reason }) => ({ item, reason }));
}
