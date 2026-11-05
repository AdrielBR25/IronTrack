// Catálogo de alimentos (Fase 02). Fonte oficial: TACO — Tabela Brasileira de Composição de Alimentos, 4ª edição
// (NEPA/UNICAMP, 2011), gerada por scripts/build-taco-catalog.py sem completar nenhum valor. Valores por 100 g da parte
// comestível; nutriente ausente na tabela = null (o app mostra "—" e soma 0).
//
// Além da TACO, há poucos MODELOS GENÉRICOS de rótulo (leite UHT, whey) porque a TACO não traz energia para eles. Eles
// são marcados como "não oficial — confira o rótulo" e existem só para não deixar a busca vazia; o certo é a pessoa
// cadastrar o produto dela com os dados do rótulo.
//
// O catálogo fica em memória na API (nunca no pacote do app): a busca é feita no servidor.
import { readFileSync } from 'node:fs';
import { FOOD_STATES, type FoodState, type FoodView, type Per100, type PortionView } from '../../../../shared/nutrition/protocol.ts';

interface TacoFile {
  source: string;
  via: string;
  categories: Record<string, string>;
  foods: [number, string, number, number, number | null, number | null, number | null, number | null][];
}

export interface CatalogFood {
  ref: string;
  name: string;
  brand: string | null;
  category: string;
  state: FoodState;
  baseUnit: 'g' | 'ml';
  per100: Per100;
  portions: PortionView[];
  source: { kind: 'taco' | 'generic'; label: string };
  /** Texto normalizado para busca. */
  norm: string;
  /** Bônus de busca: alimentos muito comuns no dia a dia brasileiro. */
  boost: number;
  /** Cru costuma não ser o que se come (cereais, carnes, peixes, ovos, leguminosas): penaliza "cru" na busca. */
  rawUnusual: boolean;
  words: string[];
}

export const TACO_LABEL = 'TACO 4ª ed. (NEPA/UNICAMP)';
export const GENERIC_LABEL = 'Modelo genérico (não oficial) — confira o rótulo';

/** Medidas caseiras APROXIMADAS (não vêm da TACO): só atalhos, sempre exibidos como aproximados. */
const APPROX_PORTIONS: Record<number, { label: string; amount: number }[]> = {
  3: [{ label: 'colher de servir', amount: 45 }],
  1: [{ label: 'colher de servir', amount: 45 }],
  561: [{ label: 'concha', amount: 80 }],
  567: [{ label: 'concha', amount: 80 }],
  488: [{ label: 'unidade', amount: 50 }],
  489: [{ label: 'unidade', amount: 50 }],
  490: [{ label: 'unidade', amount: 50 }],
  53: [{ label: 'unidade', amount: 50 }],
  52: [{ label: 'fatia', amount: 25 }],
  182: [{ label: 'unidade', amount: 65 }],
  222: [{ label: 'unidade média', amount: 130 }],
  7: [{ label: 'colher de sopa', amount: 15 }],
};

const GENERIC: Omit<CatalogFood, 'norm' | 'words' | 'boost' | 'rawUnusual'>[] = [
  { ref: 'generic:leite-integral-uht', name: 'Leite de vaca integral UHT (modelo de rótulo)', brand: null, category: 'Leite e derivados', state: 'packaged', baseUnit: 'ml', per100: { kcal: 59, protein: 3, carbs: 4.5, fat: 3.2, fiber: null }, portions: [{ label: 'copo (200 ml)', amount: 200, approximate: true }], source: { kind: 'generic', label: GENERIC_LABEL } },
  { ref: 'generic:leite-desnatado-uht', name: 'Leite de vaca desnatado UHT (modelo de rótulo)', brand: null, category: 'Leite e derivados', state: 'packaged', baseUnit: 'ml', per100: { kcal: 35, protein: 3.2, carbs: 4.8, fat: 0.2, fiber: null }, portions: [{ label: 'copo (200 ml)', amount: 200, approximate: true }], source: { kind: 'generic', label: GENERIC_LABEL } },
  { ref: 'generic:whey-concentrado', name: 'Whey protein concentrado (modelo de rótulo)', brand: null, category: 'Suplementos', state: 'packaged', baseUnit: 'g', per100: { kcal: 400, protein: 78, carbs: 8, fat: 6, fiber: null }, portions: [{ label: 'dosador (30 g)', amount: 30, approximate: true }], source: { kind: 'generic', label: GENERIC_LABEL } },
];

/** Alimentos muito registrados (sobem na busca quando a consulta é genérica: "arroz", "feijão", "leite"). */
const POPULAR = new Set(['taco:3', 'taco:1', 'taco:561', 'taco:567', 'taco:410', 'taco:488', 'taco:490', 'taco:53', 'taco:182', 'taco:7', 'taco:91', 'taco:129', 'taco:377', 'generic:leite-integral-uht', 'generic:leite-desnatado-uht', 'generic:whey-concentrado']);
const RAW_UNUSUAL_CATEGORIES = new Set([1, 5, 6, 9, 14]);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'na', 'no']);
/** Palavra "raiz" simples para plurais (ovos → ovo, feijoes → feijo… ambos os lados passam pela mesma regra). */
const stem = (w: string) => (w.length > 3 ? w.replace(/(oes|aes|ns|s)$/, (m) => (m === 'oes' || m === 'aes' ? 'o' : m === 'ns' ? 'm' : '')) : w);
export const tokens = (s: string) => normalize(s).split(' ').filter((w) => w && !STOP.has(w)).map(stem);

const COOKED = /\b(cozid[oa]s?|grelhad[oa]s?|assad[oa]s?|frit[oa]s?|refogad[oa]s?|ensopad[oa]s?|cozido\/10minutos|torrad[oa]s?|braseado|guisad[oa]|ao vapor)\b/;
const RAW = /\b(cru|crua|crus|cruas)\b/;
function stateOf(name: string, categoryId: number): FoodState {
  const n = name.toLowerCase();
  if (COOKED.test(n)) return 'cooked';
  if (RAW.test(n)) return 'raw';
  if (categoryId === 13) return 'prepared';
  if (categoryId === 12) return 'packaged';
  return 'other';
}

function withSearch(f: Omit<CatalogFood, 'norm' | 'words' | 'boost' | 'rawUnusual'>, categoryId = 0): CatalogFood {
  return { ...f, norm: normalize(f.name), words: tokens(f.name), boost: POPULAR.has(f.ref) ? 3 : 0, rawUnusual: RAW_UNUSUAL_CATEGORIES.has(categoryId) };
}

let cache: { list: CatalogFood[]; byRef: Map<string, CatalogFood> } | null = null;

export function catalog(): { list: CatalogFood[]; byRef: Map<string, CatalogFood> } {
  if (cache) return cache;
  const file = JSON.parse(readFileSync(new URL('./catalog/taco.json', import.meta.url), 'utf8')) as TacoFile;
  const list: CatalogFood[] = file.foods.map(([id, name, cat, kcal, protein, carbs, fat, fiber]) =>
    withSearch({
      ref: `taco:${id}`,
      name,
      brand: null,
      category: file.categories[String(cat)] ?? 'Outros',
      state: stateOf(name, cat),
      baseUnit: 'g',
      per100: { kcal, protein, carbs, fat, fiber },
      portions: (APPROX_PORTIONS[id] ?? []).map((p) => ({ ...p, approximate: true })),
      source: { kind: 'taco', label: TACO_LABEL },
    }, cat),
  );
  for (const g of GENERIC) list.push(withSearch(g));
  for (const f of list) if (!FOOD_STATES.includes(f.state)) throw new Error(`estado inválido em ${f.ref}`);
  cache = { list, byRef: new Map(list.map((f) => [f.ref, f])) };
  return cache;
}

export const catalogFood = (ref: string): CatalogFood | null => catalog().byRef.get(ref) ?? null;

export const RAW_HINT = 'Valores do alimento CRU: use o peso antes do preparo.';
export function hintOf(f: Pick<CatalogFood, 'state' | 'rawUnusual' | 'source'>): string | null {
  if (f.source.kind === 'generic') return 'Valores típicos de rótulo, não oficiais: prefira cadastrar o seu produto.';
  if (f.state === 'raw' && f.rawUnusual) return RAW_HINT;
  return null;
}

export function catalogView(f: CatalogFood, favorite = false): FoodView {
  return { ref: f.ref, name: f.name, brand: f.brand, category: f.category, state: f.state, baseUnit: f.baseUnit, per100: f.per100, portions: f.portions, source: f.source, favorite, hint: hintOf(f), custom: null };
}

/**
 * Pontua um alimento para a consulta: todas as palavras da consulta precisam aparecer (como prefixo de uma palavra do
 * nome). Bônus para a primeira palavra do nome, nomes curtos e preparados prontos para comer (cozido/grelhado), que é
 * o que se registra no dia a dia; "cru" só sobe quando pedido.
 */
export function scoreName(qWords: string[], words: string[], name: string, state: FoodState, boost = 0, rawUnusual = true): number {
  if (!qWords.length) return 0;
  let score = 0;
  for (const q of qWords) {
    const i = words.findIndex((w) => w.startsWith(q));
    if (i < 0) return -1;
    score += Math.max(1, 8 - i) + (words[i] === q ? 3 : 0);
  }
  if (words[0]?.startsWith(qWords[0])) score += 6;
  const askedRaw = qWords.some((q) => q === 'cru' || q === 'crua');
  if (state === 'cooked' && !askedRaw) score += 2;
  if (state === 'raw' && !askedRaw && rawUnusual) score -= 2;
  score += boost;
  score -= Math.min(6, name.length / 12);
  return score;
}

export function searchCatalog(q: string, limit = 25): CatalogFood[] {
  const qw = tokens(q);
  if (!qw.length) return [];
  return catalog()
    .list.map((f) => ({ f, s: scoreName(qw, f.words, f.name, f.state, f.boost, f.rawUnusual) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.f.name.length - b.f.name.length)
    .slice(0, limit)
    .map((x) => x.f);
}
