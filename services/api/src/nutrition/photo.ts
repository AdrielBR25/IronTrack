// Fase 03: da resposta estruturada da IA (alimentos + porções estimadas) para um RASCUNHO revisável, com alimentos
// reais do catálogo (TACO) ou da própria pessoa. Os valores nutricionais vêm SEMPRE do catálogo/cadastro; o modelo não
// devolve calorias nem macros (o esquema nem tem esses campos). Nada é gravado aqui.
import { randomUUID } from 'node:crypto';
import { itemMacros, roundMacros, sumMacros, type FoodView, type MealKind } from '../../../../shared/nutrition/protocol.ts';
import {
  CONFIDENCE_SCORE,
  MEAL_VISION_PROTOCOL,
  PREPARATION_LABEL,
  missingNutrients,
  type MealVisionItem,
  type MealVisionOutput,
  type PhotoAnalysisView,
  type PhotoItemView,
  type Preparation,
} from '../../../../shared/nutrition/vision.ts';
import type { PoolClient } from '../db/pool.ts';
import { catalog } from './catalog.ts';
import { searchFoods } from './service.ts';

type Q = Pick<PoolClient, 'query'>;

/** Palavra do catálogo para o preparo (a TACO escreve "cozido", "grelhado", "frito"...). */
const PREP_WORD: Partial<Record<Preparation, string>> = { cozido: 'cozido', grelhado: 'grelhado', assado: 'assado', frito: 'frito', refogado: 'refogado', ensopado: 'ensopado', vapor: 'cozido', cru: 'cru', empanado: 'empanado' };
const COOKED_PREPS = new Set<Preparation>(['cozido', 'grelhado', 'assado', 'frito', 'refogado', 'ensopado', 'vapor', 'empanado']);
const HAS_STATE = /\b(cru|crua|cozid|grelhad|assad|frit|refogad|ensopad|vapor|empanad)/i;

/** Arredonda a estimativa visual para múltiplos de 5 g/ml: evita precisão falsa ("143,7 g" a partir de uma foto). */
export const roundEstimate = (v: number) => Math.max(5, Math.round(v / 5) * 5);

/** Consultas ao catálogo, da mais específica para a mais genérica, sem repetir. `approx` = último recurso. */
export function queriesFor(it: Pick<MealVisionItem, 'nome' | 'termos_busca' | 'preparo'> & { confianca?: MealVisionItem['confianca'] }): { q: string; approx: boolean }[] {
  const prep = PREP_WORD[it.preparo];
  const out: { q: string; approx: boolean }[] = [];
  const push = (q: string, approx: boolean) => {
    const k = q.trim().toLowerCase();
    if (k && !out.some((o) => o.q === k)) out.push({ q: k, approx });
  };
  for (const t of [...it.termos_busca, it.nome]) {
    if (prep && !HAS_STATE.test(t)) push(`${t} ${prep}`, false);
    push(t, false);
  }
  // Último recurso: só a primeira palavra do nome ("arroz branco" → "arroz cozido", "arroz"). Não vale para itens de
  // confiança baixa: "molho desconhecido" não deve virar um molho qualquer do catálogo.
  const head = it.nome.trim().split(/\s+/)[0] ?? '';
  if (head.length > 2 && it.confianca !== 'baixa') {
    if (prep) push(`${head} ${prep}`, true);
    push(head, true);
  }
  return out.slice(0, 10);
}

/** Há a mesma comida em outro estado (cru × cozido) no catálogo? */
function hasOtherState(match: FoodView): boolean {
  if (match.source.kind !== 'taco' || (match.state !== 'raw' && match.state !== 'cooked')) return false;
  const base = match.name.split(',').slice(0, 2).join(',');
  return catalog().list.some((f) => f.ref !== match.ref && f.name.startsWith(base) && (f.state === 'raw' || f.state === 'cooked') && f.state !== match.state);
}

export async function matchVisionItem(c: Q, userId: string, it: MealVisionItem, index: number): Promise<PhotoItemView> {
  let match: FoodView | null = null;
  let candidates: FoodView[] = [];
  let matchedBy: string | null = null;
  for (const { q, approx } of queriesFor(it)) {
    const found = await searchFoods(c, userId, q, 6);
    if (!found.length) continue;
    match = found[0];
    candidates = found.slice(1, 5);
    // Correspondência só pela primeira palavra do nome (último recurso) = vale conferir.
    matchedBy = approx ? `${q} (aproximado)` : q;
    break;
  }
  const warnings: string[] = [];
  let needsReview = it.confianca === 'baixa';
  const prepLabel = PREPARATION_LABEL[it.preparo];
  if (!match) {
    warnings.push('Não encontrei no catálogo: busque outro nome ou cadastre o alimento.');
    needsReview = true;
  } else {
    if (COOKED_PREPS.has(it.preparo) && match.state === 'raw') {
      warnings.push(`A foto parece ${prepLabel}, mas o alimento encontrado é CRU: troque ou ajuste o peso.`);
      needsReview = true;
    } else if (it.preparo === 'cru' && match.state === 'cooked') {
      warnings.push('A foto parece crua, mas o alimento encontrado é cozido: confira.');
      needsReview = true;
    } else if (it.preparo === 'nao_identificado' && hasOtherState(match)) {
      warnings.push(`Preparo incerto: considerei "${match.name}".`);
      needsReview = true;
    }
    if (matchedBy?.endsWith('(aproximado)')) {
      warnings.push(`Correspondência aproximada para "${it.nome}": confira o alimento.`);
      needsReview = true;
    }
    if (it.unidade !== match.baseUnit) {
      warnings.push(`A foto estimou em ${it.unidade}; este alimento é medido em ${match.baseUnit}. Confira a quantidade.`);
      needsReview = true;
    }
    if (match.hint && !warnings.length) warnings.push(match.hint);
  }
  let quantity: number | null = it.quantidade && it.quantidade > 0 ? roundEstimate(it.quantidade) : null;
  if (quantity == null) {
    warnings.push('Não deu para estimar a quantidade: informe o peso.');
    needsReview = true;
  }
  if (quantity != null && quantity > 2000) {
    quantity = null;
    warnings.push('Quantidade estimada fora do comum: informe o peso.');
    needsReview = true;
  }
  if (it.confianca === 'baixa' && it.observacao) warnings.push(it.observacao);
  else if (it.confianca === 'baixa') warnings.push('A IA não teve certeza deste item.');
  const lo = it.quantidade_min && it.quantidade_min > 0 ? roundEstimate(it.quantidade_min) : null;
  const hi = it.quantidade_max && it.quantidade_max > 0 ? roundEstimate(it.quantidade_max) : null;
  return {
    id: `p${index + 1}`,
    label: prepLabel && !HAS_STATE.test(it.nome) ? `${it.nome} (${prepLabel})` : it.nome,
    match,
    candidates,
    quantity,
    confidence: CONFIDENCE_SCORE[it.confianca],
    warning: warnings.length ? warnings.join(' ') : null,
    preparation: it.preparo,
    role: it.papel,
    unit: match?.baseUnit ?? it.unidade,
    range: lo != null && hi != null && hi >= lo ? { min: lo, max: hi } : null,
    confidenceLevel: it.confianca,
    needsReview,
    matchedBy,
  };
}

/** Totais calculados pelo sistema: só itens com alimento do catálogo E quantidade. */
export function draftTotals(items: Pick<PhotoItemView, 'match' | 'quantity'>[]): Pick<PhotoAnalysisView, 'totals' | 'completeness'> {
  const counted = items.filter((i) => i.match && i.quantity && i.quantity > 0);
  return {
    totals: roundMacros(sumMacros(counted.map((i) => itemMacros(i.match!.per100, i.quantity!)))),
    completeness: { itemsCounted: counted.length, itemsPending: items.length - counted.length, missing: missingNutrients(counted.map((i) => i.match!)) },
  };
}

export async function buildPhotoAnalysis(c: Q, userId: string, out: MealVisionOutput, o: { model: string; kind?: MealKind | null }): Promise<PhotoAnalysisView> {
  const noFood = !out.contem_comida;
  const items: PhotoItemView[] = [];
  if (!noFood) for (const [i, it] of out.itens.entries()) items.push(await matchVisionItem(c, userId, it, i));
  const status: PhotoAnalysisView['status'] = noFood ? 'no_food' : items.length === 0 ? 'low_quality' : 'ok';
  return {
    protocol: MEAL_VISION_PROTOCOL,
    id: randomUUID(),
    status,
    imageQuality: out.qualidade_imagem,
    summary: out.resumo,
    items,
    calorieNotes: noFood ? [] : out.observacoes_caloricas,
    uncertain: out.nao_identificado,
    ...draftTotals(items),
    suggestedKind: o.kind ?? null,
    model: o.model,
    storedPhoto: false,
  };
}
