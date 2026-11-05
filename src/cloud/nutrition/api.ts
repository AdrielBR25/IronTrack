// Cliente da alimentação (Fase 02): /api/v1/nutrition/*. O servidor calcula e guarda tudo (PostgreSQL, por conta);
// o app exibe, calcula a prévia com as mesmas funções do contrato e reenvia com `clientId` para não duplicar.
// Usa a mesma invalidação do RPG: registrar uma refeição atualiza missões, XP e o Início.
import type { RewardOutcome } from '@shared/life/protocol.ts';
import type { DaySummaryView, DayView, EstimateInput, EstimateView, FoodView, GoalsInput, GoalsView, MealDraftItem, MealInput, MealPatch, MealStatus, MealKind, MealView, QuickView, SavedMealView, StatsView, CustomFoodInput } from '@shared/nutrition/protocol.ts';
import type { MealKind as Kind } from '@shared/nutrition/protocol.ts';
import type { PhotoAnalysisView, VisionStatusView } from '@shared/nutrition/vision.ts';
import { apiRequest } from '../api';
import { emitReward, invalidateLife, lifeApi } from '../life/api';

export interface NutritionMutation {
  id?: string;
  ids?: string[];
  existed?: boolean;
  day?: DayView;
  outcome: RewardOutcome;
}

const enc = encodeURIComponent;
const tz = () => `tz=${enc(lifeApi.deviceTz())}`;

async function mutation(p: Promise<NutritionMutation>): Promise<NutritionMutation> {
  const r = await p;
  emitReward(r.outcome);
  invalidateLife();
  return r;
}
async function plain<T>(p: Promise<T>): Promise<T> {
  const r = await p;
  invalidateLife();
  return r;
}

export const newClientId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);

export const nutritionApi = {
  day: (date: string | 'hoje') => apiRequest<{ day: DayView; outcome: RewardOutcome | null; nowHHMM: string }>('GET', `/nutrition/days/${enc(date)}?${tz()}`),
  days: (from: string, to: string) => apiRequest<{ from: string; to: string; today: string; days: DaySummaryView[] }>('GET', `/nutrition/days?from=${from}&to=${to}&${tz()}`),
  meals: (from: string, to: string, status?: MealStatus) => apiRequest<{ meals: MealView[] }>('GET', `/nutrition/meals?from=${from}&to=${to}${status ? `&status=${status}` : ''}&${tz()}`),
  stats: (from: string, to: string) => apiRequest<{ stats: StatsView }>('GET', `/nutrition/stats?from=${from}&to=${to}&${tz()}`),
  quick: () => apiRequest<{ quick: QuickView }>('GET', '/nutrition/quick'),
  search: (q: string, limit = 25) => apiRequest<{ foods: FoodView[] }>('GET', `/nutrition/foods?q=${enc(q)}&limit=${limit}`),
  myFoods: (archived = false) => apiRequest<{ foods: FoodView[] }>('GET', `/nutrition/foods?mine=1${archived ? '&archived=1' : ''}`),
  food: (ref: string) => apiRequest<{ food: FoodView }>('GET', `/nutrition/foods/${enc(ref)}`),
  createFood: (f: Partial<CustomFoodInput>) => plain(apiRequest<{ food: FoodView }>('POST', '/nutrition/foods', f)),
  updateFood: (id: string, version: number, patch: Record<string, unknown>) => plain(apiRequest<{ food: FoodView }>('PATCH', `/nutrition/foods/${enc(id)}`, { version, patch })),
  favorite: (foodRef: string, favorite: boolean) => plain(apiRequest<{ ok: true }>('POST', '/nutrition/favorites', { foodRef, favorite })),
  createMeal: (m: MealInput) => mutation(apiRequest<NutritionMutation>('POST', `/nutrition/meals?${tz()}`, m)),
  updateMeal: (id: string, version: number, patch: MealPatch) => mutation(apiRequest<NutritionMutation>('PATCH', `/nutrition/meals/${enc(id)}?${tz()}`, { version, patch })),
  consume: (id: string, version: number, time?: string | null) => mutation(apiRequest<NutritionMutation>('POST', `/nutrition/meals/${enc(id)}/consume?${tz()}`, { version, ...(time !== undefined ? { time } : {}) })),
  unconsume: (id: string, version: number) => mutation(apiRequest<NutritionMutation>('POST', `/nutrition/meals/${enc(id)}/unconsume?${tz()}`, { version })),
  duplicate: (id: string, o: { date?: string; status?: MealStatus } = {}) => mutation(apiRequest<NutritionMutation>('POST', `/nutrition/meals/${enc(id)}/duplicate?${tz()}`, { clientId: newClientId(), ...o })),
  deleteMeal: (id: string) => mutation(apiRequest<NutritionMutation>('DELETE', `/nutrition/meals/${enc(id)}?${tz()}`)),
  copyDay: (from: string, to: string[], status: MealStatus, only: 'consumed' | 'planned' | 'all' = 'all') => mutation(apiRequest<NutritionMutation>('POST', `/nutrition/days/${from}/copy?${tz()}`, { to, status, only })),
  water: (date: string, ml: number) => mutation(apiRequest<NutritionMutation>('POST', `/nutrition/days/${date}/water?${tz()}`, { ml })),
  savedMeals: () => apiRequest<{ savedMeals: SavedMealView[] }>('GET', '/nutrition/saved-meals'),
  saveMeal: (name: string, kind: MealKind, fromMealId: string) => plain(apiRequest<{ id: string }>('POST', '/nutrition/saved-meals', { name, kind, fromMealId })),
  deleteSaved: (id: string) => plain(apiRequest<{ ok: true }>('DELETE', `/nutrition/saved-meals/${enc(id)}`)),
  useSaved: (id: string, date: string, status: MealStatus, kind?: MealKind) => mutation(apiRequest<NutritionMutation>('POST', `/nutrition/saved-meals/${enc(id)}/use?${tz()}`, { clientId: newClientId(), date, status, ...(kind ? { kind } : {}) })),
  goals: () => apiRequest<{ goals: GoalsView | null }>('GET', '/nutrition/goals'),
  saveGoals: (goals: Partial<GoalsInput>, version?: number | null) => plain(apiRequest<{ goals: GoalsView }>('PATCH', `/nutrition/goals?${tz()}`, { goals, ...(version ? { version } : {}) })),
  estimate: (i: EstimateInput) => apiRequest<{ estimate: EstimateView }>('POST', '/nutrition/goals/estimate', i),
  // Fase 03: foto da refeição (o servidor chama a OpenAI; nada é salvo até a confirmação).
  visionStatus: () => apiRequest<{ vision: VisionStatusView }>('GET', '/assistant/vision/status', undefined, { timeoutMs: 10_000 }),
  acceptPhotoNotice: (version: number) => apiRequest<{ vision: VisionStatusView }>('POST', '/assistant/vision/notice', { version }),
  analyzePhoto: (image: string, o: { note?: string | null; kind?: Kind | null; signal?: AbortSignal } = {}) =>
    apiRequest<{ analysis: PhotoAnalysisView }>('POST', '/assistant/vision/meal', { image, purpose: 'meal', note: o.note ?? null, kind: o.kind ?? null }, { timeoutMs: 75_000, ...(o.signal ? { signal: o.signal } : {}) }),
  resolveDraft: (items: { label: string; quantity?: number | null }[]) => apiRequest<{ items: MealDraftItem[] }>('POST', '/nutrition/drafts/resolve', { items }),
};
