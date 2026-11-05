// Revisão do rascunho da foto (Fase 03): estado editável e regras de confirmação, sem React (testável).
// Os totais usam as MESMAS funções do servidor (itemMacros/sumMacros) com os valores do catálogo.
// Regra central: nunca registrar com dados incompletos — todo item precisa de um alimento do catálogo e de quantidade.
import { itemMacros, roundMacros, sumMacros, type FoodView, type Macros, type MealItemInput } from '@shared/nutrition/protocol.ts';
import { missingNutrients, type ConfidenceLevel, type PhotoAnalysisView } from '@shared/nutrition/vision.ts';

export interface ReviewItem {
  key: string;
  /** O que a IA viu ("arroz branco (cozido)") ou o nome do alimento escolhido pela pessoa. */
  label: string;
  food: FoodView | null;
  candidates: FoodView[];
  quantity: number | null;
  warning: string | null;
  needsReview: boolean;
  confidence: ConfidenceLevel | null;
  range: { min: number; max: number } | null;
  /** true = veio da foto; false = adicionado pela pessoa na revisão. */
  fromPhoto: boolean;
}

let seq = 0;
const key = () => `r${++seq}`;

export function fromAnalysis(a: PhotoAnalysisView): ReviewItem[] {
  return a.items.map((i) => ({
    key: key(),
    label: i.label,
    food: i.match,
    candidates: i.candidates,
    quantity: i.quantity,
    warning: i.warning,
    needsReview: i.needsReview,
    confidence: i.confidenceLevel,
    range: i.range,
    fromPhoto: true,
  }));
}

export const manualItem = (f: FoodView, quantity: number): ReviewItem => ({ key: key(), label: f.name, food: f, candidates: [], quantity, warning: f.hint, needsReview: false, confidence: null, range: null, fromPhoto: false });

/** Troca o alimento (ex.: cru → cozido, ou escolhido na busca). A revisão do item fica resolvida se houver quantidade. */
export function replaceFood(it: ReviewItem, f: FoodView): ReviewItem {
  const others = [it.food, ...it.candidates].filter((c): c is FoodView => !!c && c.ref !== f.ref).slice(0, 4);
  return { ...it, food: f, candidates: others, warning: f.hint, needsReview: !(it.quantity && it.quantity > 0) };
}

export function setQuantity(it: ReviewItem, q: number): ReviewItem {
  const quantity = Number.isFinite(q) && q > 0 ? Math.round(q * 10) / 10 : null;
  // Corrigir a quantidade de um item com alimento resolve a revisão (a pessoa conferiu).
  return { ...it, quantity, needsReview: !it.food || !quantity, warning: it.food && quantity ? (it.food.hint ?? null) : it.warning };
}

export const isComplete = (it: ReviewItem) => !!it.food && !!it.quantity && it.quantity > 0;

export function reviewTotals(items: ReviewItem[]): { totals: Macros; counted: number; pending: number; missing: ReturnType<typeof missingNutrients> } {
  const ok = items.filter(isComplete);
  return {
    totals: roundMacros(sumMacros(ok.map((i) => itemMacros(i.food!.per100, i.quantity!)))),
    counted: ok.length,
    pending: items.length - ok.length,
    missing: missingNutrients(ok.map((i) => i.food!)),
  };
}

export function canConfirm(items: ReviewItem[]): { ok: true } | { ok: false; reason: string } {
  if (!items.length) return { ok: false, reason: 'Adicione ao menos um alimento.' };
  const pending = items.filter((i) => !isComplete(i));
  if (pending.length) return { ok: false, reason: pending.length === 1 ? `Escolha o alimento e a quantidade de "${pending[0].label}" ou remova o item.` : `${pending.length} itens precisam de alimento e quantidade (ou remova-os).` };
  return { ok: true };
}

export const toMealItems = (items: ReviewItem[]): MealItemInput[] => items.filter(isComplete).map((i) => ({ foodRef: i.food!.ref, quantity: i.quantity!, portionLabel: null, portionCount: null }));

/** Tipo de refeição pelo horário local (sugestão inicial; a pessoa troca na revisão). */
export function kindByHour(h: number): 'breakfast' | 'lunch' | 'snack' | 'dinner' | 'supper' {
  return h < 10 ? 'breakfast' : h < 15 ? 'lunch' : h < 18 ? 'snack' : h < 22 ? 'dinner' : 'supper';
}
