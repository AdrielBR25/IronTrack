// Fase 03 — revisão do rascunho da foto no app (sem rede): correção de porções, troca de alimento, totais iguais ao
// cálculo do servidor, bloqueio de registro incompleto e preparo da imagem (tamanho, HEIC).
import { describe, expect, it } from 'vitest';
import { itemMacros, roundMacros, sumMacros, type FoodView } from '@shared/nutrition/protocol.ts';
import { MEAL_VISION_JSON_SCHEMA, mealVisionOutputSchema, type PhotoAnalysisView } from '@shared/nutrition/vision.ts';
import { canConfirm, fromAnalysis, kindByHour, manualItem, replaceFood, reviewTotals, setQuantity, toMealItems } from '@/cloud/nutrition/photo/draft';
import { dataUrlBytes, fitSize, isHeic, isImageFile } from '@/cloud/nutrition/photo/image';

const food = (ref: string, name: string, per100: FoodView['per100'], state: FoodView['state'] = 'cooked'): FoodView => ({ ref, name, brand: null, category: 'x', state, baseUnit: 'g', per100, portions: [], source: { kind: 'taco', label: 'TACO' }, favorite: false, hint: null, custom: null });
const RICE = food('taco:3', 'Arroz, tipo 1, cozido', { kcal: 128, protein: 2.5, carbs: 28.1, fat: 0.2, fiber: 1.6 });
const RICE_RAW = food('taco:4', 'Arroz, tipo 1, cru', { kcal: 358, protein: 7.2, carbs: 78.8, fat: 0.3, fiber: 1.6 }, 'raw');
const CHICKEN = food('taco:410', 'Frango, peito, sem pele, grelhado', { kcal: 159, protein: 32, carbs: 0, fat: 2.5, fiber: null });

const analysis = (): PhotoAnalysisView => ({
  protocol: 'irontrack.life.mealPhoto.v1',
  id: 'a1',
  status: 'ok',
  imageQuality: 'boa',
  summary: 'Arroz e frango',
  calorieNotes: [],
  uncertain: [],
  totals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
  completeness: { itemsCounted: 0, itemsPending: 0, missing: {} },
  suggestedKind: 'lunch',
  model: 'm',
  storedPhoto: false,
  items: [
    { id: 'p1', label: 'arroz branco (cozido)', match: RICE_RAW, candidates: [RICE], quantity: 150, confidence: 0.85, warning: 'A foto parece cozido, mas o alimento encontrado é CRU', preparation: 'cozido', role: 'principal', unit: 'g', range: { min: 120, max: 180 }, confidenceLevel: 'alta', needsReview: true, matchedBy: 'arroz' },
    { id: 'p2', label: 'frango grelhado', match: CHICKEN, candidates: [], quantity: 160, confidence: 0.6, warning: null, preparation: 'grelhado', role: 'principal', unit: 'g', range: null, confidenceLevel: 'media', needsReview: false, matchedBy: 'frango grelhado' },
    { id: 'p3', label: 'molho', match: null, candidates: [], quantity: null, confidence: 0.3, warning: 'Não encontrei', preparation: 'nao_identificado', role: 'molho', unit: 'g', range: null, confidenceLevel: 'baixa', needsReview: true, matchedBy: null },
  ],
});

describe('revisão da foto', () => {
  it('itens incompletos ficam fora do total e bloqueiam o registro até serem resolvidos ou removidos', () => {
    let items = fromAnalysis(analysis());
    let t = reviewTotals(items);
    expect(t.counted).toBe(2);
    expect(t.pending).toBe(1);
    expect(t.missing.fiber).toBe(1); // frango sem fibra na fonte: não vira zero silencioso
    const c = canConfirm(items);
    expect(c.ok).toBe(false);
    // Remover o molho libera; nunca registra item sem alimento.
    items = items.filter((i) => i.food);
    expect(canConfirm(items).ok).toBe(true);
    expect(toMealItems(items)).toHaveLength(2);
    t = reviewTotals(items);
    expect(t.totals).toEqual(roundMacros(sumMacros([itemMacros(RICE_RAW.per100, 150), itemMacros(CHICKEN.per100, 160)])));
  });

  it('trocar cru → cozido e corrigir a porção recalculam com o catálogo', () => {
    const [rice, chicken] = fromAnalysis(analysis());
    expect(rice.needsReview).toBe(true);
    const fixed = replaceFood(rice, RICE);
    expect(fixed.food!.ref).toBe('taco:3');
    expect(fixed.candidates.map((c) => c.ref)).toContain('taco:4');
    expect(fixed.needsReview).toBe(false);
    const more = setQuantity(fixed, 210);
    expect(reviewTotals([more, chicken]).totals.kcal).toBe(Math.round(128 * 2.1 + 159 * 1.6));
    // Quantidade inválida volta a exigir revisão e bloqueia.
    const zero = setQuantity(more, 0);
    expect(zero.quantity).toBeNull();
    expect(canConfirm([zero]).ok).toBe(false);
    // Alimento adicionado à mão entra completo.
    const extra = manualItem(food('taco:260', 'Azeite, de oliva, extra virgem', { kcal: 884, protein: null, carbs: null, fat: 100, fiber: null }, 'other'), 10);
    expect(toMealItems([more, extra])).toEqual([
      { foodRef: 'taco:3', quantity: 210, portionLabel: null, portionCount: null },
      { foodRef: 'taco:260', quantity: 10, portionLabel: null, portionCount: null },
    ]);
  });

  it('tipo de refeição pelo horário', () => {
    expect([7, 12, 16, 20, 23].map(kindByHour)).toEqual(['breakfast', 'lunch', 'snack', 'dinner', 'supper']);
  });
});

describe('preparo da imagem e contrato', () => {
  it('reduz sem ampliar, detecta HEIC e calcula bytes da data URL', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: 1536, height: 1152 });
    expect(fitSize(3024, 4032)).toEqual({ width: 1152, height: 1536 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(isHeic({ type: '', name: 'IMG_0001.HEIC' })).toBe(true);
    expect(isHeic({ type: 'image/heif', name: 'x' })).toBe(true);
    expect(isImageFile({ type: 'application/pdf', name: 'a.pdf' })).toBe(false);
    expect(isImageFile({ type: '', name: 'foto.webp' })).toBe(true);
    expect(dataUrlBytes(`data:image/jpeg;base64,${btoa('abcde')}`)).toBe(5);
  });

  it('esquema estrito: sem campos de calorias/macros, todos obrigatórios; Zod recusa extras', () => {
    const item = MEAL_VISION_JSON_SCHEMA.properties.itens.items;
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(MEAL_VISION_JSON_SCHEMA.required).toEqual(Object.keys(MEAL_VISION_JSON_SCHEMA.properties));
    expect(JSON.stringify(MEAL_VISION_JSON_SCHEMA)).not.toMatch(/kcal|"calorias"|prote[ií]na"|carboidrato|gordura/i);
    const ok = { contem_comida: true, qualidade_imagem: 'boa', itens: [], observacoes_caloricas: [], nao_identificado: [], resumo: 'x' };
    expect(mealVisionOutputSchema.safeParse(ok).success).toBe(true);
    expect(mealVisionOutputSchema.safeParse({ ...ok, kcal: 500 }).success).toBe(false);
  });
});
