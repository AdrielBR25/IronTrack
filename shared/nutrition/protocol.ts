// Contrato do módulo de alimentação (IronTrack Life — Fase 02, docs/ALIMENTACAO.md). Compartilhado entre a API (que
// valida e calcula de verdade) e o app (que exibe e calcula a prévia com as MESMAS funções).
//
// Unidades: todo alimento tem valores por 100 g ou por 100 ml (baseUnit). A quantidade de um item está na mesma
// unidade do alimento; não há conversão g ↔ ml (densidade) para não introduzir erro silencioso. Porções ("1 unidade",
// "1 fatia") são só um atalho: o que se grava é a quantidade em g/ml.
import { z } from 'zod';

export const NUTRITION_PROTOCOL = 'irontrack.life.nutrition.v1';

// ------------------------------------------------------------------ vocabulário

export const MEAL_KINDS = ['breakfast', 'lunch', 'snack', 'dinner', 'supper', 'custom'] as const;
export type MealKind = (typeof MEAL_KINDS)[number];
export const MEAL_KIND_LABEL: Record<MealKind, string> = { breakfast: 'Café da manhã', lunch: 'Almoço', snack: 'Lanche', dinner: 'Jantar', supper: 'Ceia', custom: 'Refeição' };
/** Horários sugeridos (a pessoa define os próprios nas metas). */
export const DEFAULT_MEAL_TIMES: Record<MealKind, string> = { breakfast: '07:30', lunch: '12:30', snack: '16:00', dinner: '20:00', supper: '22:00', custom: '10:00' };

export const MEAL_STATUS = ['planned', 'consumed'] as const;
export type MealStatus = (typeof MEAL_STATUS)[number];

/** Estado de preparo: separa cru, cozido e preparado para evitar trocar "arroz cru" por "arroz cozido" (≈ 3×). */
export const FOOD_STATES = ['raw', 'cooked', 'prepared', 'packaged', 'other'] as const;
export type FoodState = (typeof FOOD_STATES)[number];
export const FOOD_STATE_LABEL: Record<FoodState, string> = { raw: 'Cru', cooked: 'Cozido', prepared: 'Preparado', packaged: 'Rótulo', other: '' };

export const OBJECTIVES = ['maintenance', 'muscle_gain', 'fat_loss', 'organization'] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const OBJECTIVE_LABEL: Record<Objective, string> = { maintenance: 'Manutenção', muscle_gain: 'Ganho de massa muscular', fat_loss: 'Redução de gordura', organization: 'Organização alimentar' };

export type FoodSourceKind = 'taco' | 'generic' | 'custom';
export const FOOD_REF_RE = /^(taco:\d{1,4}|generic:[a-z0-9-]{2,40}|custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Recompensas de ACOMPANHAMENTO (registrar), nunca de comer menos ou atingir peso. O servidor aplica. */
export const NUTRITION_REWARD = {
  /** Diário do dia: XP quando há ao menos `minMeals` refeições CONSUMIDAS registradas (hoje ou ontem). */
  diaryDay: 15,
  minMeals: 2,
  /** Primeira anotação de água do dia. */
  water: 5,
  /** Missão semanal automática: dias com diário registrado. */
  weeklyDays: 4,
  weeklyXp: 40,
} as const;

/** Limites de entrada. */
export const NUTRITION_LIMITS = { itemsPerMeal: 40, mealsPerDay: 20, customFoods: 500, savedMeals: 60, planDays: 14, maxQuantity: 5000, rangeDays: 120, futureDays: 60, pastDays: 365 } as const;

// ------------------------------------------------------------------ cálculos (iguais no app e no servidor)

export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}
/** Valores por 100 g/ml. null = não informado na fonte (traço, não analisado ou não aplicável): conta como 0. */
export interface Per100 {
  kcal: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
}

export const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };

/** Nutrientes de uma quantidade (g/ml) a partir dos valores por 100. Sem arredondar (o arredondamento é só na exibição). */
export function itemMacros(per100: Per100, quantity: number): Macros {
  const f = Math.max(0, quantity) / 100;
  return { kcal: per100.kcal * f, protein: (per100.protein ?? 0) * f, carbs: (per100.carbs ?? 0) * f, fat: (per100.fat ?? 0) * f, fiber: (per100.fiber ?? 0) * f };
}

export function sumMacros(list: readonly Macros[]): Macros {
  const s = { ...ZERO };
  for (const m of list) {
    s.kcal += m.kcal;
    s.protein += m.protein;
    s.carbs += m.carbs;
    s.fat += m.fat;
    s.fiber += m.fiber;
  }
  return s;
}

/** Arredondamento de exibição/armazenamento de totais: kcal inteiro, gramas com 1 casa. */
export function roundMacros(m: Macros): Macros {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { kcal: Math.round(m.kcal), protein: r1(m.protein), carbs: r1(m.carbs), fat: r1(m.fat), fiber: r1(m.fiber) };
}

/** Distribuição de energia por macronutriente (4/4/9 kcal por g). Percentuais inteiros; null sem energia. */
export function macroSplit(m: Macros): { protein: number; carbs: number; fat: number } | null {
  const p = m.protein * 4;
  const c = m.carbs * 4;
  const f = m.fat * 9;
  const t = p + c + f;
  if (t <= 0) return null;
  const pp = Math.round((p / t) * 100);
  const ff = Math.round((f / t) * 100);
  return { protein: pp, carbs: Math.max(0, 100 - pp - ff), fat: ff };
}

// ------------------------------------------------------------------ estimativa de metas (não é prescrição)

export const ACTIVITY_LEVELS = ['sedentary', 'light', 'moderate', 'high'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];
export const ACTIVITY_LABEL: Record<ActivityLevel, string> = { sedentary: 'Pouco ativo', light: 'Leve (1–3 treinos/semana)', moderate: 'Moderado (3–5 treinos/semana)', high: 'Alto (6+ treinos/semana ou trabalho físico)' };
const ACTIVITY_FACTOR: Record<ActivityLevel, number> = { sedentary: 1.2, light: 1.375, moderate: 1.55, high: 1.725 };

export const estimateInputSchema = z
  .object({
    objective: z.enum(OBJECTIVES),
    sex: z.enum(['male', 'female']),
    age: z.number().int().min(16).max(90),
    weightKg: z.number().min(35).max(250),
    heightCm: z.number().min(130).max(230),
    activity: z.enum(ACTIVITY_LEVELS),
  })
  .strict();
export type EstimateInput = z.infer<typeof estimateInputSchema>;

export interface EstimateView {
  input: EstimateInput;
  bmr: number;
  maintenance: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  waterMl: number;
  assumptions: string[];
}

/**
 * Estimativa inicial (Mifflin-St Jeor × fator de atividade, ajuste moderado pelo objetivo). Ajustes limitados a
 * ±15% e nunca abaixo do metabolismo basal estimado nem de 1.500/1.200 kcal: não incentiva restrição extrema.
 */
export function estimateGoals(i: EstimateInput): EstimateView {
  const bmr = 10 * i.weightKg + 6.25 * i.heightCm - 5 * i.age + (i.sex === 'male' ? 5 : -161);
  const maintenance = bmr * ACTIVITY_FACTOR[i.activity];
  const floor = Math.max(bmr, i.sex === 'male' ? 1500 : 1200);
  let kcal = maintenance;
  if (i.objective === 'muscle_gain') kcal = maintenance + Math.min(300, maintenance * 0.1);
  if (i.objective === 'fat_loss') kcal = Math.max(floor, maintenance - Math.min(500, maintenance * 0.15));
  kcal = Math.round(kcal / 10) * 10;
  const proteinPerKg = i.objective === 'maintenance' || i.objective === 'organization' ? 1.6 : 1.8;
  const protein = Math.round(i.weightKg * proteinPerKg);
  const fat = Math.round(Math.max(i.weightKg * 0.6, (kcal * 0.25) / 9));
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  const waterMl = Math.round((i.weightKg * 35) / 50) * 50;
  const assumptions = [
    `Gasto em repouso estimado pela equação de Mifflin-St Jeor: ${Math.round(bmr)} kcal.`,
    `Fator de atividade ${ACTIVITY_FACTOR[i.activity]} (${ACTIVITY_LABEL[i.activity].toLowerCase()}): manutenção ≈ ${Math.round(maintenance)} kcal.`,
    i.objective === 'muscle_gain'
      ? 'Ganho de massa: acréscimo moderado (até 10%, no máximo 300 kcal).'
      : i.objective === 'fat_loss'
        ? `Redução de gordura: déficit moderado (até 15%, no máximo 500 kcal), nunca abaixo de ${Math.round(floor)} kcal.`
        : 'Sem ajuste de energia para este objetivo.',
    `Proteína: ${proteinPerKg} g por kg de peso; gordura: ~25% da energia (mínimo 0,6 g/kg); carboidratos: o restante.`,
    'Água: ~35 ml por kg de peso.',
    'É uma estimativa de partida, não uma prescrição. Ajuste pelo que funciona para você e procure um nutricionista para orientação individual.',
  ];
  return { input: i, bmr: Math.round(bmr), maintenance: Math.round(maintenance), kcal, protein, carbs, fat, waterMl, assumptions };
}

// ------------------------------------------------------------------ entradas (validadas no servidor)

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const qty = z.number().positive().max(NUTRITION_LIMITS.maxQuantity).transform((v) => Math.round(v * 100) / 100);

export const foodRefSchema = z.string().regex(FOOD_REF_RE, 'Alimento inválido.');

export const mealItemInputSchema = z
  .object({
    foodRef: foodRefSchema,
    /** Quantidade em g ou ml (a unidade do alimento). */
    quantity: qty,
    portionLabel: optText(40),
    portionCount: z.number().positive().max(100).nullish(),
  })
  .strict();
export type MealItemInput = z.output<typeof mealItemInputSchema>;

export const mealInputSchema = z
  .object({
    /** Id gerado pelo app para tornar o envio idempotente (reenviar devolve a mesma refeição). */
    clientId: z.string().uuid().nullish(),
    date: isoDate,
    kind: z.enum(MEAL_KINDS),
    name: optText(60),
    time: z.string().regex(HHMM).nullish(),
    status: z.enum(MEAL_STATUS),
    notes: optText(300),
    items: z.array(mealItemInputSchema).max(NUTRITION_LIMITS.itemsPerMeal),
  })
  .strict();
export type MealInput = z.output<typeof mealInputSchema>;

export const mealPatchSchema = z
  .object({
    date: isoDate.optional(),
    kind: z.enum(MEAL_KINDS).optional(),
    name: optText(60).optional(),
    time: z.string().regex(HHMM).nullable().optional(),
    notes: optText(300).optional(),
    /** Substitui todos os itens, na ordem. */
    items: z.array(mealItemInputSchema).max(NUTRITION_LIMITS.itemsPerMeal).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type MealPatch = z.output<typeof mealPatchSchema>;

const per100Num = (max: number) => z.number().min(0).max(max).transform((v) => Math.round(v * 100) / 100);
export const customFoodInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    brand: optText(60),
    state: z.enum(FOOD_STATES).default('other'),
    baseUnit: z.enum(['g', 'ml']),
    kcal: per100Num(900),
    protein: per100Num(100),
    carbs: per100Num(100),
    fat: per100Num(100),
    fiber: per100Num(100).nullish(),
    portionLabel: optText(40),
    portionAmount: z.number().min(0.1).max(5000).nullish(),
    sourceNote: optText(120),
  })
  .strict()
  .refine((f) => f.protein + f.carbs + f.fat <= 100.5, { message: 'Proteínas + carboidratos + gorduras passam de 100 g por 100.', path: ['fat'] })
  .refine((f) => !f.portionLabel === !f.portionAmount, { message: 'Informe o nome e a quantidade da porção.', path: ['portionAmount'] });
export type CustomFoodInput = z.output<typeof customFoodInputSchema>;

export const customFoodPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    brand: optText(60).optional(),
    state: z.enum(FOOD_STATES).optional(),
    kcal: per100Num(900).optional(),
    protein: per100Num(100).optional(),
    carbs: per100Num(100).optional(),
    fat: per100Num(100).optional(),
    fiber: per100Num(100).nullable().optional(),
    portionLabel: optText(40).optional(),
    portionAmount: z.number().min(0.1).max(5000).nullable().optional(),
    sourceNote: optText(120).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type CustomFoodPatch = z.output<typeof customFoodPatchSchema>;

export const mealTimesSchema = z.record(z.enum(MEAL_KINDS), z.string().regex(HHMM)).default({});

export const goalsInputSchema = z
  .object({
    objective: z.enum(OBJECTIVES),
    kcal: z.number().int().min(800).max(6000).nullish(),
    protein: z.number().int().min(10).max(400).nullish(),
    carbs: z.number().int().min(0).max(900).nullish(),
    fat: z.number().int().min(10).max(300).nullish(),
    waterMl: z.number().int().min(500).max(8000).nullish(),
    mealTimes: mealTimesSchema.optional(),
    preferences: optText(500),
    estimate: estimateInputSchema.nullish(),
  })
  .strict();
export type GoalsInput = z.output<typeof goalsInputSchema>;

export const savedMealInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(MEAL_KINDS),
    /** A partir de uma refeição registrada… */
    fromMealId: z.string().uuid().nullish(),
    /** …ou de uma lista de itens. */
    items: z.array(mealItemInputSchema).max(NUTRITION_LIMITS.itemsPerMeal).nullish(),
  })
  .strict()
  .refine((s) => !!s.fromMealId !== !!(s.items && s.items.length), { message: 'Informe a refeição de origem OU os itens.', path: ['items'] });

export const useSavedMealSchema = z.object({ clientId: z.string().uuid().nullish(), date: isoDate, kind: z.enum(MEAL_KINDS).optional(), status: z.enum(MEAL_STATUS), time: z.string().regex(HHMM).nullish() }).strict();
export const consumeSchema = z.object({ time: z.string().regex(HHMM).nullish(), date: isoDate.optional() }).strict();
export const duplicateSchema = z.object({ clientId: z.string().uuid().nullish(), date: isoDate.optional(), status: z.enum(MEAL_STATUS).optional() }).strict();
export const copyDaySchema = z
  .object({
    to: z.array(isoDate).min(1).max(NUTRITION_LIMITS.planDays),
    status: z.enum(MEAL_STATUS),
    /** Quais refeições copiar (padrão: todas do dia de origem). */
    mealIds: z.array(z.string().uuid()).max(NUTRITION_LIMITS.mealsPerDay).nullish(),
    /** Só refeições consumidas / só planejadas / todas. */
    only: z.enum(['consumed', 'planned', 'all']).default('all'),
  })
  .strict();
export const waterSchema = z.object({ ml: z.number().int().min(0).max(10000) }).strict();

// ------------------------------------------------------------------ visões devolvidas ao app

export interface PortionView {
  label: string;
  amount: number;
  /** true = medida caseira aproximada (não vem da tabela oficial). */
  approximate: boolean;
}

export interface FoodView {
  ref: string;
  name: string;
  brand: string | null;
  category: string;
  state: FoodState;
  baseUnit: 'g' | 'ml';
  per100: Per100;
  portions: PortionView[];
  source: { kind: FoodSourceKind; label: string };
  favorite: boolean;
  /** Aviso curto para evitar erro de cálculo (ex.: valores do alimento cru). */
  hint: string | null;
  /** Só alimentos próprios. */
  custom: { id: string; version: number; archived: boolean; sourceNote: string | null } | null;
}

export interface MealItemView {
  id: string;
  foodRef: string;
  name: string;
  state: FoodState;
  source: string;
  unit: 'g' | 'ml';
  quantity: number;
  portionLabel: string | null;
  portionCount: number | null;
  per100: Per100;
  totals: Macros;
}

export interface MealView {
  id: string;
  date: string;
  kind: MealKind;
  /** Nome exibido (personalizado ou o do tipo). */
  title: string;
  name: string | null;
  time: string | null;
  status: MealStatus;
  notes: string | null;
  origin: 'user' | 'ai' | 'photo' | 'copy' | 'saved';
  items: MealItemView[];
  totals: Macros;
  /** Totais quando ainda era planejada (só refeições planejadas que viraram consumidas). */
  plannedTotals: Macros | null;
  consumedAt: string | null;
  version: number;
}

export interface GoalsView {
  objective: Objective;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  waterMl: number | null;
  mealTimes: Partial<Record<MealKind, string>>;
  preferences: string | null;
  estimate: EstimateView | null;
  origin: 'user' | 'ai';
  version: number;
  updatedAt: string;
}

export interface DayView {
  protocol: typeof NUTRITION_PROTOCOL;
  date: string;
  today: string;
  meals: MealView[];
  /** Só refeições consumidas. */
  consumed: Macros;
  /** Refeições ainda planejadas (não contam como consumo). */
  plannedPending: Macros;
  /** Total do planejamento do dia: o que segue planejado + o planejado das que já foram consumidas. */
  planTotal: Macros;
  hasPlan: boolean;
  goals: GoalsView | null;
  water: { ml: number; goalMl: number | null };
  /** Diário do dia: refeições consumidas × mínimo para o XP de registro. */
  diary: { consumedMeals: number; minMeals: number; rewarded: boolean; rewardAllowed: boolean };
}

export interface DaySummaryView {
  date: string;
  consumed: Macros;
  consumedMeals: number;
  plannedMeals: number;
  /** Total planejado do dia (inclui o planejado das refeições já consumidas); null sem planejamento. */
  planned: Macros | null;
  waterMl: number | null;
}

export interface StatsView {
  from: string;
  to: string;
  /** Só dias COM registro (dias vazios não viram consumo zero). */
  days: DaySummaryView[];
  loggedDays: number;
  totalDays: number;
  /** Médias por dia registrado (null sem dias registrados). */
  average: Macros | null;
  weeks: { start: string; loggedDays: number; average: Macros | null }[];
  split: { protein: number; carbs: number; fat: number } | null;
  goals: GoalsView | null;
  /** Dias que tinham planejamento: planejado × consumido. */
  planVsActual: { date: string; planned: Macros; consumed: Macros }[];
}

export interface SavedMealView {
  id: string;
  name: string;
  kind: MealKind;
  items: { foodRef: string; name: string; quantity: number; unit: 'g' | 'ml'; portionLabel: string | null; portionCount: number | null; per100: Per100 }[];
  totals: Macros;
  useCount: number;
  lastUsedAt: string | null;
}

export interface QuickView {
  recentFoods: FoodView[];
  favoriteFoods: FoodView[];
  /** Mais usados nos últimos 30 dias (sugestões do próprio histórico). */
  frequentFoods: (FoodView & { lastQuantity: number })[];
  savedMeals: SavedMealView[];
  /** Última refeição CONSUMIDA de cada tipo (botão "Repetir"). */
  lastByKind: Partial<Record<MealKind, MealView>>;
}

/** Resposta de mutações: o dia afetado e o resultado das recompensas (animações). */
export interface NutritionMutation {
  id?: string;
  day?: DayView;
  outcome: import('../life/protocol.ts').RewardOutcome;
}

// ------------------------------------------------------------------ preparação da Fase 03 (foto da refeição)

/**
 * Rascunho de refeição para REVISÃO antes de salvar. Hoje nasce de texto (IA) ou da busca; na Fase 03 nascerá da
 * análise de uma foto. Nada aqui é salvo: a pessoa confere, corrige e confirma, e só então vira `MealInput`.
 * Fotos não são armazenadas nem enviadas a provedores sem aviso explícito (contrato da Fase 03).
 */
export interface MealDraftItem {
  /** Como o item foi descrito/identificado (ex.: "arroz", "filé de frango"). */
  label: string;
  /** Melhor correspondência no catálogo (null = a pessoa precisa escolher). */
  match: FoodView | null;
  /** Outras opções (ex.: cru × cozido). */
  candidates: FoodView[];
  quantity: number | null;
  /** 0–1 quando vier de reconhecimento automático; null para texto/manual. */
  confidence: number | null;
  /** Alerta para a revisão (ex.: "Confira se é cru ou cozido"). */
  warning: string | null;
}

export interface MealDraft {
  origin: 'manual' | 'ai' | 'photo';
  date: string;
  kind: MealKind;
  items: MealDraftItem[];
}

export const draftResolveSchema = z
  .object({
    items: z
      .array(z.object({ label: z.string().trim().min(1).max(80), quantity: z.number().positive().max(NUTRITION_LIMITS.maxQuantity).nullish() }).strict())
      .min(1)
      .max(NUTRITION_LIMITS.itemsPerMeal),
  })
  .strict();

export const MEAL_PHOTO_CONTRACT = {
  id: 'irontrack.life.mealPhoto.v0',
  status: 'planned',
  flow: ['captura ou envio (com aviso de envio ao provedor)', 'reconhecimento multimodal → MealDraft (origin photo, confidence)', 'revisão e correção', 'confirmação → POST /nutrition/meals (origin photo)'],
  storesPhotos: false,
} as const;
