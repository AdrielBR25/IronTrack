// Busca e filtros locais da biblioteca (P17, docs/BIBLIOTECA_EXERCICIOS.md §4–5). Puro e determinístico.
// Busca: o texto é dobrado (minúsculas, sem acentos, espaços simples) e dividido em termos; um item aparece se TODOS
// os termos estiverem em algum campo pesquisável (nome, apelidos, grupos musculares, equipamentos, tags). A ordem é
// por relevância simples e explícita (nome que começa com a busca > palavra do nome > nome contém > apelido > demais
// campos) e, no empate, pelo nome em pt-BR e pela chave. Cada item aparece no máximo uma vez.
// O índice é montado uma vez por lista de itens (na tela, só quando a lista muda), não a cada tecla.
import { MODALITY_LABEL } from '@/modules/training';
import type { ExerciseLaterality, TrainingModality } from '@/modules/training';
import { EQUIPMENT_NAME, MODALITY_FILTER_LABEL, MUSCLE_NAME } from './vocab';
import type { LibraryEquipment, LibraryItem, LibraryKey, LibraryMuscle, MovementPattern } from './types';

/** Minúsculas, sem acentos, só letras/números e espaços simples. */
export function foldText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface IndexedItem {
  item: LibraryItem;
  name: string;
  aliases: string[];
  /** Grupos, equipamentos, modalidade e tags dobrados. */
  other: string;
}

export interface LibraryIndex {
  entries: IndexedItem[];
}

export function buildIndex(items: readonly LibraryItem[]): LibraryIndex {
  const seen = new Set<LibraryKey>();
  const entries: IndexedItem[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const other = [
      ...item.primaryMuscles.map((m) => MUSCLE_NAME[m]),
      ...item.secondaryMuscles.map((m) => MUSCLE_NAME[m]),
      ...item.equipment.map((e) => EQUIPMENT_NAME[e]),
      MODALITY_LABEL[item.modality],
      MODALITY_FILTER_LABEL[item.modality],
      item.laterality === 'unilateral' ? 'unilateral' : 'bilateral',
      ...item.tags,
    ];
    entries.push({ item, name: foldText(item.name), aliases: item.aliases.map(foldText), other: foldText(other.join(' ')) });
  }
  return { entries };
}

export interface LibraryFilters {
  muscles: LibraryMuscle[];
  equipment: LibraryEquipment[];
  modalities: TrainingModality[];
  laterality: ExerciseLaterality | null;
  /** P20: padrão de movimento (opcional; filtros antigos sem o campo continuam válidos). */
  movements?: MovementPattern[];
  favoritesOnly: boolean;
  customOnly: boolean;
  /** Arquivados aparecem só quando pedidos (lista "Arquivados" de Meus exercícios). */
  archived: 'hide' | 'only';
}

export const EMPTY_FILTERS: LibraryFilters = { muscles: [], equipment: [], modalities: [], laterality: null, movements: [], favoritesOnly: false, customOnly: false, archived: 'hide' };

/** Quantos filtros estão ligados (para o botão "Limpar filtros"; o estado de arquivados não conta). */
export function activeFilterCount(f: LibraryFilters): number {
  return f.muscles.length + f.equipment.length + f.modalities.length + (f.movements?.length ?? 0) + (f.laterality ? 1 : 0) + (f.favoritesOnly ? 1 : 0) + (f.customOnly ? 1 : 0);
}

/**
 * Filtros: dentro de uma dimensão vale "qualquer um" (peitoral OU costas); entre dimensões vale "todos".
 * Grupo muscular confere os grupos PRINCIPAIS (o supino não aparece em "Tríceps"); a busca por texto continua
 * encontrando os secundários.
 */
export function matchesFilters(item: LibraryItem, f: LibraryFilters, favorites: ReadonlySet<LibraryKey>): boolean {
  if (f.archived === 'only' ? !item.archived : item.archived) return false;
  if (f.muscles.length && !item.primaryMuscles.some((m) => f.muscles.includes(m))) return false;
  if (f.equipment.length && !item.equipment.some((e) => f.equipment.includes(e))) return false;
  if (f.modalities.length && !f.modalities.includes(item.modality)) return false;
  if (f.laterality && item.laterality !== f.laterality) return false;
  if (f.movements?.length && (!item.movementPattern || !f.movements.includes(item.movementPattern))) return false;
  if (f.favoritesOnly && !favorites.has(item.key)) return false;
  if (f.customOnly && item.kind !== 'custom') return false;
  return true;
}

let collator: Intl.Collator | null = null;

/** Ordem estável: nome (pt-BR) e, no empate, a chave. */
export const compareItems = (a: LibraryItem, b: LibraryItem) =>
  (collator ??= new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })).compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function score(e: IndexedItem, terms: string[], phrase: string): number | null {
  for (const t of terms) if (!e.name.includes(t) && !e.aliases.some((a) => a.includes(t)) && !e.other.includes(t)) return null;
  if (!phrase) return 0;
  if (e.name.startsWith(phrase)) return 5;
  if (e.name.split(' ').some((w) => w.startsWith(phrase))) return 4;
  if (e.name.includes(phrase)) return 3;
  if (e.aliases.some((a) => a.includes(phrase))) return 2;
  if (terms.every((t) => e.name.includes(t))) return 1;
  return 0;
}

/** Busca + filtros. Sem texto: todos os itens filtrados em ordem alfabética. */
export function searchLibrary(index: LibraryIndex, query: string, filters: LibraryFilters, favorites: ReadonlySet<LibraryKey> = new Set()): LibraryItem[] {
  const phrase = foldText(query);
  const terms = phrase ? [...new Set(phrase.split(' '))] : [];
  const hits: { item: LibraryItem; s: number }[] = [];
  for (const e of index.entries) {
    if (!matchesFilters(e.item, filters, favorites)) continue;
    const s = score(e, terms, phrase);
    if (s !== null) hits.push({ item: e.item, s });
  }
  hits.sort((a, b) => b.s - a.s || compareItems(a.item, b.item));
  return hits.map((h) => h.item);
}
