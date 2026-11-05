// Operações do módulo de alimentação (Fase 02, docs/ALIMENTACAO.md). Usado pelas rotas (/api/v1/nutrition/*) e pelos
// handlers das propostas aprovadas do assistente — o mesmo caminho e as mesmas validações nos dois casos.
//
// Regras centrais:
//  - Toda consulta filtra por user_id; ID de outra conta simplesmente "não existe".
//  - Itens guardam cópia dos valores por 100 g/ml do alimento; o total é sempre quantidade × valor/100.
//  - Refeição PLANEJADA nunca conta como consumo. Ao marcar como consumida, o total planejado fica guardado
//    (planned_totals) para comparar planejado × real.
//  - Escritas rodam em lifeTx (perfil da conta bloqueado): serializa a conta, e a recompensa de registro é aplicada pelo
//    motor da Fase 01 (idempotente por dia, com teto diário e estorno).
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MEAL_TIMES,
  MEAL_KIND_LABEL,
  NUTRITION_LIMITS,
  NUTRITION_PROTOCOL,
  NUTRITION_REWARD,
  ZERO,
  estimateGoals,
  itemMacros,
  macroSplit,
  roundMacros,
  sumMacros,
  type CustomFoodInput,
  type CustomFoodPatch,
  type DaySummaryView,
  type DayView,
  type FoodState,
  type FoodView,
  type GoalsInput,
  type GoalsView,
  type Macros,
  type MealDraftItem,
  type MealInput,
  type MealItemInput,
  type MealItemView,
  type MealKind,
  type MealPatch,
  type MealStatus,
  type MealView,
  type Per100,
  type QuickView,
  type SavedMealView,
  type StatsView,
} from '../../../../shared/nutrition/protocol.ts';
import type { PoolClient } from '../db/pool.ts';
import { ApiError } from '../http/core.ts';
import { addDays, mondayOf } from '../assistant/tools/time.ts';
import { activeGrant, grant, reverse, weekday, type LifeTx } from '../life/engine.ts';
import { logHabit } from '../life/service.ts';
import { catalog, catalogFood, catalogView, hintOf, scoreName, searchCatalog, tokens } from './catalog.ts';

type Q = Pick<PoolClient, 'query'>;
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ------------------------------------------------------------------ alimentos

export interface CustomFoodRow {
  id: string;
  name: string;
  brand: string | null;
  state: FoodState;
  base_unit: 'g' | 'ml';
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  fiber: string | null;
  portion_label: string | null;
  portion_amount: string | null;
  source_note: string | null;
  origin: 'user' | 'ai';
  archived: boolean;
  version: number;
}

export function customView(r: CustomFoodRow, favorite = false): FoodView {
  return {
    ref: `custom:${r.id}`,
    name: r.name,
    brand: r.brand,
    category: 'Meus alimentos',
    state: r.state,
    baseUnit: r.base_unit,
    per100: { kcal: Number(r.kcal), protein: Number(r.protein), carbs: Number(r.carbs), fat: Number(r.fat), fiber: n(r.fiber) },
    portions: r.portion_label && r.portion_amount ? [{ label: r.portion_label, amount: Number(r.portion_amount), approximate: false }] : [],
    source: { kind: 'custom', label: r.source_note ? `Cadastrado por você (${r.source_note})` : 'Cadastrado por você (rótulo)' },
    favorite,
    hint: null,
    custom: { id: r.id, version: r.version, archived: r.archived, sourceNote: r.source_note },
  };
}

export async function getCustomFood(c: Q, userId: string, id: string, lock = false): Promise<CustomFoodRow | null> {
  if (!isUuid(id)) return null;
  const r = await c.query<CustomFoodRow>(`SELECT * FROM nutrition_foods WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id]);
  return r.rows[0] ?? null;
}

async function favoriteSet(c: Q, userId: string): Promise<Set<string>> {
  return new Set((await c.query<{ food_ref: string }>('SELECT food_ref FROM nutrition_food_favorites WHERE user_id = $1', [userId])).rows.map((r) => r.food_ref));
}

/** Resolve referências (catálogo ou próprios) em visões. Referências inexistentes ficam de fora. */
export async function foodViews(c: Q, userId: string, refs: string[], favs?: Set<string>): Promise<Map<string, FoodView>> {
  const f = favs ?? (await favoriteSet(c, userId));
  const out = new Map<string, FoodView>();
  const customIds = refs.filter((r) => r.startsWith('custom:')).map((r) => r.slice(7)).filter(isUuid);
  if (customIds.length) {
    const rows = (await c.query<CustomFoodRow>('SELECT * FROM nutrition_foods WHERE user_id = $1 AND id = ANY($2)', [userId, customIds])).rows;
    for (const r of rows) out.set(`custom:${r.id}`, customView(r, f.has(`custom:${r.id}`)));
  }
  for (const ref of refs) {
    if (out.has(ref)) continue;
    const cf = catalogFood(ref);
    if (cf) out.set(ref, catalogView(cf, f.has(ref)));
  }
  return out;
}

export async function getFood(c: Q, userId: string, ref: string): Promise<FoodView | null> {
  return (await foodViews(c, userId, [ref])).get(ref) ?? null;
}

/** Busca: alimentos próprios + catálogo, com bônus para favoritos e para o que a pessoa mais registra. */
export async function searchFoods(c: Q, userId: string, q: string, limit = 25): Promise<FoodView[]> {
  const qw = tokens(q);
  if (!qw.length) return [];
  const favs = await favoriteSet(c, userId);
  const usage = new Map((await c.query<{ food_ref: string; n: number }>("SELECT i.food_ref, count(*)::int AS n FROM nutrition_meal_items i JOIN nutrition_meals m ON m.id = i.meal_id WHERE i.user_id = $1 AND m.date >= (now() - interval '90 days')::date GROUP BY i.food_ref", [userId])).rows.map((r) => [r.food_ref, r.n]));
  const customs = (await c.query<CustomFoodRow>('SELECT * FROM nutrition_foods WHERE user_id = $1 AND NOT archived', [userId])).rows;
  const bonus = (ref: string) => (favs.has(ref) ? 3 : 0) + Math.min(4, usage.get(ref) ?? 0);
  const scored: { v: FoodView; s: number }[] = [];
  for (const r of customs) {
    const words = tokens(`${r.name} ${r.brand ?? ''}`);
    const s = scoreName(qw, words, r.name, r.state, 5, false);
    if (s >= 0) scored.push({ v: customView(r, favs.has(`custom:${r.id}`)), s: s + bonus(`custom:${r.id}`) });
  }
  for (const f of searchCatalog(q, 60)) {
    const s = scoreName(qw, f.words, f.name, f.state, f.boost, f.rawUnusual);
    scored.push({ v: catalogView(f, favs.has(f.ref)), s: s + bonus(f.ref) });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.v);
}

export async function createCustomFood(c: Q, userId: string, f: CustomFoodInput, origin: 'user' | 'ai', id: string = randomUUID()): Promise<CustomFoodRow> {
  const cnt = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM nutrition_foods WHERE user_id = $1 AND NOT archived', [userId])).rows[0].n;
  if (cnt >= NUTRITION_LIMITS.customFoods) throw new ApiError('life_limit');
  const r = await c.query<CustomFoodRow>(
    `INSERT INTO nutrition_foods (id, user_id, name, brand, state, base_unit, kcal, protein, carbs, fat, fiber, portion_label, portion_amount, source_note, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
    [id, userId, f.name, f.brand, f.state, f.baseUnit, f.kcal, f.protein, f.carbs, f.fat, f.fiber ?? null, f.portionLabel, f.portionAmount ?? null, f.sourceNote, origin],
  );
  return r.rows[0];
}

export async function updateCustomFood(c: Q, userId: string, id: string, p: CustomFoodPatch, version?: number | null): Promise<{ before: CustomFoodRow; after: CustomFoodRow }> {
  const before = await getCustomFood(c, userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && version !== before.version) throw new ApiError('life_stale');
  const next = {
    name: p.name ?? before.name,
    brand: p.brand !== undefined ? p.brand : before.brand,
    state: p.state ?? before.state,
    kcal: p.kcal ?? Number(before.kcal),
    protein: p.protein ?? Number(before.protein),
    carbs: p.carbs ?? Number(before.carbs),
    fat: p.fat ?? Number(before.fat),
    fiber: p.fiber !== undefined ? p.fiber : n(before.fiber),
    portion_label: p.portionLabel !== undefined ? p.portionLabel : before.portion_label,
    portion_amount: p.portionAmount !== undefined ? p.portionAmount : n(before.portion_amount),
    source_note: p.sourceNote !== undefined ? p.sourceNote : before.source_note,
    archived: p.archived ?? before.archived,
  };
  if (next.protein + next.carbs + next.fat > 100.5) throw new ApiError('validation_failed', { fat: 'Proteínas + carboidratos + gorduras passam de 100 g por 100.' });
  if (!next.portion_label !== !next.portion_amount) throw new ApiError('validation_failed', { portionAmount: 'Informe o nome e a quantidade da porção.' });
  const r = await c.query<CustomFoodRow>(
    `UPDATE nutrition_foods SET name = $3, brand = $4, state = $5, kcal = $6, protein = $7, carbs = $8, fat = $9, fiber = $10, portion_label = $11, portion_amount = $12,
       source_note = $13, archived = $14, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, id, next.name, next.brand, next.state, next.kcal, next.protein, next.carbs, next.fat, next.fiber, next.portion_label, next.portion_amount, next.source_note, next.archived],
  );
  return { before, after: r.rows[0] };
}

export async function setFavorite(c: Q, userId: string, ref: string, on: boolean): Promise<void> {
  if (on) {
    if (!(await getFood(c, userId, ref))) throw new ApiError('not_found');
    await c.query('INSERT INTO nutrition_food_favorites (user_id, food_ref) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, ref]);
  } else await c.query('DELETE FROM nutrition_food_favorites WHERE user_id = $1 AND food_ref = $2', [userId, ref]);
}

// ------------------------------------------------------------------ itens de refeição

export interface ItemRow {
  id: string;
  meal_id: string;
  position: number;
  food_ref: string;
  name: string;
  state: FoodState;
  source: string;
  unit: 'g' | 'ml';
  quantity: string;
  portion_label: string | null;
  portion_count: string | null;
  kcal: string;
  protein: string | null;
  carbs: string | null;
  fat: string | null;
  fiber: string | null;
}

export interface ResolvedItem {
  foodRef: string;
  name: string;
  state: FoodState;
  source: string;
  unit: 'g' | 'ml';
  quantity: number;
  portionLabel: string | null;
  portionCount: number | null;
  per100: Per100;
}

const brandName = (f: FoodView) => (f.brand ? `${f.name} (${f.brand})` : f.name);

/**
 * Confere os alimentos e copia os valores atuais. Alimento próprio arquivado não entra em registros novos
 * (`keep` = refs já presentes na refeição, que podem continuar mesmo arquivados).
 */
export async function resolveItems(c: Q, userId: string, items: MealItemInput[], keep: Map<string, ResolvedItem> = new Map()): Promise<ResolvedItem[]> {
  const views = await foodViews(c, userId, [...new Set(items.map((i) => i.foodRef))]);
  return items.map((i) => {
    const f = views.get(i.foodRef);
    if (!f || (f.custom?.archived && !keep.has(i.foodRef))) {
      const k = keep.get(i.foodRef);
      if (k) return { ...k, quantity: i.quantity, portionLabel: i.portionLabel, portionCount: i.portionCount ?? null };
      throw new ApiError('nutrition_food_unavailable');
    }
    return { foodRef: f.ref, name: brandName(f), state: f.state, source: f.source.label, unit: f.baseUnit, quantity: i.quantity, portionLabel: i.portionLabel, portionCount: i.portionCount ?? null, per100: f.per100 };
  });
}

const itemFromRow = (r: ItemRow): ResolvedItem => ({
  foodRef: r.food_ref,
  name: r.name,
  state: r.state,
  source: r.source,
  unit: r.unit,
  quantity: Number(r.quantity),
  portionLabel: r.portion_label,
  portionCount: n(r.portion_count),
  per100: { kcal: Number(r.kcal), protein: n(r.protein), carbs: n(r.carbs), fat: n(r.fat), fiber: n(r.fiber) },
});

export const resolvedTotals = (items: ResolvedItem[]): Macros => sumMacros(items.map((i) => itemMacros(i.per100, i.quantity)));

async function insertItems(c: Q, userId: string, mealId: string, items: ResolvedItem[]): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await c.query(
      `INSERT INTO nutrition_meal_items (id, user_id, meal_id, position, food_ref, name, state, source, unit, quantity, portion_label, portion_count, kcal, protein, carbs, fat, fiber)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [randomUUID(), userId, mealId, i, it.foodRef, it.name.slice(0, 120), it.state, it.source.slice(0, 120), it.unit, it.quantity, it.portionLabel, it.portionCount, it.per100.kcal, it.per100.protein, it.per100.carbs, it.per100.fat, it.per100.fiber],
    );
  }
}

// ------------------------------------------------------------------ refeições

export interface MealRow {
  id: string;
  date: string;
  kind: MealKind;
  name: string | null;
  time: string | null;
  status: MealStatus;
  notes: string | null;
  origin: MealView['origin'];
  planned_totals: Macros | null;
  consumed_at: Date | null;
  client_id: string | null;
  version: number;
  created_at: Date;
}

export interface MealSnapshot {
  row: MealRow;
  items: ResolvedItem[];
}

export async function getMeal(c: Q, userId: string, id: string, lock = false): Promise<MealRow | null> {
  if (!isUuid(id)) return null;
  const r = await c.query<MealRow>(`SELECT * FROM nutrition_meals WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id]);
  return r.rows[0] ?? null;
}

export async function mealSnapshot(c: Q, userId: string, id: string, lock = false): Promise<MealSnapshot | null> {
  const row = await getMeal(c, userId, id, lock);
  if (!row) return null;
  const items = (await c.query<ItemRow>('SELECT * FROM nutrition_meal_items WHERE user_id = $1 AND meal_id = $2 ORDER BY position', [userId, id])).rows.map(itemFromRow);
  return { row, items };
}

const mealTitle = (m: Pick<MealRow, 'kind' | 'name'>) => m.name ?? MEAL_KIND_LABEL[m.kind];

function mealView(m: MealRow, items: ItemRow[]): MealView {
  const its: MealItemView[] = items.map((r) => {
    const it = itemFromRow(r);
    return { id: r.id, foodRef: it.foodRef, name: it.name, state: it.state, source: it.source, unit: it.unit, quantity: it.quantity, portionLabel: it.portionLabel, portionCount: it.portionCount, per100: it.per100, totals: roundMacros(itemMacros(it.per100, it.quantity)) };
  });
  return {
    id: m.id,
    date: m.date,
    kind: m.kind,
    title: mealTitle(m),
    name: m.name,
    time: m.time,
    status: m.status,
    notes: m.notes,
    origin: m.origin,
    items: its,
    totals: roundMacros(sumMacros(items.map((r) => itemMacros(itemFromRow(r).per100, Number(r.quantity))))),
    plannedTotals: m.planned_totals ? roundMacros(m.planned_totals) : null,
    consumedAt: iso(m.consumed_at),
    version: m.version,
  };
}

const ORDER = "ORDER BY m.date, coalesce(m.time, '99:99'), array_position(ARRAY['breakfast','lunch','snack','dinner','supper','custom'], m.kind), m.created_at";

export async function mealViews(c: Q, userId: string, where: { from: string; to: string } | { ids: string[] }, opts: { status?: MealStatus; kind?: MealKind; limit?: number } = {}): Promise<MealView[]> {
  const p: unknown[] = [userId];
  let w = '';
  if ('ids' in where) {
    if (!where.ids.length) return [];
    p.push(where.ids.filter(isUuid));
    w = 'AND m.id = ANY($2)';
  } else {
    p.push(where.from, where.to);
    w = 'AND m.date BETWEEN $2 AND $3';
  }
  if (opts.status) {
    p.push(opts.status);
    w += ` AND m.status = $${p.length}`;
  }
  if (opts.kind) {
    p.push(opts.kind);
    w += ` AND m.kind = $${p.length}`;
  }
  const lim = opts.limit ? ` LIMIT ${Math.min(500, Math.max(1, Math.floor(opts.limit)))}` : '';
  const order = opts.limit ? 'ORDER BY m.date DESC, coalesce(m.time, \'99:99\') DESC, m.created_at DESC' : ORDER;
  const meals = (await c.query<MealRow>(`SELECT m.* FROM nutrition_meals m WHERE m.user_id = $1 ${w} ${order}${lim}`, p)).rows;
  if (!meals.length) return [];
  const items = (await c.query<ItemRow>('SELECT * FROM nutrition_meal_items WHERE user_id = $1 AND meal_id = ANY($2) ORDER BY position', [userId, meals.map((m) => m.id)])).rows;
  const by = new Map<string, ItemRow[]>();
  for (const i of items) by.set(i.meal_id, [...(by.get(i.meal_id) ?? []), i]);
  return meals.map((m) => mealView(m, by.get(m.id) ?? []));
}

/** Datas aceitas: até 1 ano para trás e 60 dias à frente; consumida nunca no futuro. */
export function checkMealDate(t: LifeTx, date: string, status: MealStatus): void {
  if (date < addDays(t.today, -NUTRITION_LIMITS.pastDays) || date > addDays(t.today, NUTRITION_LIMITS.futureDays)) throw new ApiError('nutrition_date_not_allowed');
  if (status === 'consumed' && date > t.today) throw new ApiError('nutrition_date_not_allowed');
}

async function checkDayLimit(t: LifeTx, date: string, extra = 1): Promise<void> {
  const cnt = (await t.c.query<{ n: number }>('SELECT count(*)::int AS n FROM nutrition_meals WHERE user_id = $1 AND date = $2', [t.userId, date])).rows[0].n;
  if (cnt + extra > NUTRITION_LIMITS.mealsPerDay) throw new ApiError('life_limit');
}

export async function createMeal(
  t: LifeTx,
  input: MealInput,
  origin: MealView['origin'],
  opts: { id?: string; resolved?: ResolvedItem[] } = {},
): Promise<{ id: string; existed: boolean }> {
  if (input.clientId) {
    const ex = await t.c.query<{ id: string }>('SELECT id FROM nutrition_meals WHERE user_id = $1 AND client_id = $2', [t.userId, input.clientId]);
    if (ex.rows[0]) return { id: ex.rows[0].id, existed: true };
  }
  checkMealDate(t, input.date, input.status);
  await checkDayLimit(t, input.date);
  const items = opts.resolved ?? (await resolveItems(t.c, t.userId, input.items));
  const id = opts.id ?? randomUUID();
  await t.c.query(
    `INSERT INTO nutrition_meals (id, user_id, date, kind, name, time, status, notes, origin, consumed_at, client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, t.userId, input.date, input.kind, input.name, input.time ?? null, input.status, input.notes, origin, input.status === 'consumed' ? new Date(t.now) : null, input.clientId ?? null],
  );
  await insertItems(t.c, t.userId, id, items);
  if (input.status === 'consumed') await syncDiaryReward(t, input.date);
  return { id, existed: false };
}

export async function updateMeal(t: LifeTx, id: string, patch: MealPatch, version?: number | null): Promise<{ before: MealSnapshot; after: MealRow }> {
  const before = await mealSnapshot(t.c, t.userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && version !== before.row.version) throw new ApiError('life_stale');
  const date = patch.date ?? before.row.date;
  if (patch.date && patch.date !== before.row.date) {
    checkMealDate(t, date, before.row.status);
    await checkDayLimit(t, date);
  }
  if (patch.items) {
    const keep = new Map(before.items.map((i) => [i.foodRef, i]));
    const items = await resolveItems(t.c, t.userId, patch.items, keep);
    await t.c.query('DELETE FROM nutrition_meal_items WHERE user_id = $1 AND meal_id = $2', [t.userId, id]);
    await insertItems(t.c, t.userId, id, items);
  }
  const r = await t.c.query<MealRow>(
    `UPDATE nutrition_meals SET date = $3, kind = $4, name = $5, time = $6, notes = $7, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [t.userId, id, date, patch.kind ?? before.row.kind, patch.name !== undefined ? patch.name : before.row.name, patch.time !== undefined ? patch.time : before.row.time, patch.notes !== undefined ? patch.notes : before.row.notes],
  );
  if (before.row.status === 'consumed') {
    await syncDiaryReward(t, before.row.date);
    if (date !== before.row.date) await syncDiaryReward(t, date);
  }
  return { before, after: r.rows[0] };
}

/** Planejada → consumida (guarda o total planejado). `time`/`date` opcionais (padrão: mantém). */
export async function consumeMeal(t: LifeTx, id: string, opts: { time?: string | null; date?: string; version?: number | null } = {}): Promise<MealRow> {
  const snap = await mealSnapshot(t.c, t.userId, id, true);
  if (!snap) throw new ApiError('not_found');
  if (opts.version != null && opts.version !== snap.row.version) throw new ApiError('life_stale');
  if (snap.row.status !== 'planned') throw new ApiError('nutrition_state');
  if (!snap.items.length) throw new ApiError('validation_failed', { items: 'Adicione ao menos um alimento antes de marcar como consumida.' });
  const date = opts.date ?? snap.row.date;
  checkMealDate(t, date, 'consumed');
  const planned = roundMacros(resolvedTotals(snap.items));
  const r = await t.c.query<MealRow>(
    "UPDATE nutrition_meals SET status = 'consumed', date = $3, time = $4, planned_totals = $5, consumed_at = $6, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *",
    [t.userId, id, date, opts.time !== undefined ? opts.time : snap.row.time, JSON.stringify(planned), new Date(t.now)],
  );
  await syncDiaryReward(t, date);
  return r.rows[0];
}

/** Consumida → planejada (correção de engano). Só para refeições que vieram de planejamento ou do futuro próximo. */
export async function unconsumeMeal(t: LifeTx, id: string, version?: number | null): Promise<MealRow> {
  const m = await getMeal(t.c, t.userId, id, true);
  if (!m) throw new ApiError('not_found');
  if (version != null && version !== m.version) throw new ApiError('life_stale');
  if (m.status !== 'consumed') throw new ApiError('nutrition_state');
  const r = await t.c.query<MealRow>("UPDATE nutrition_meals SET status = 'planned', planned_totals = NULL, consumed_at = NULL, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *", [t.userId, id]);
  await syncDiaryReward(t, m.date);
  return r.rows[0];
}

export async function deleteMeal(t: LifeTx, id: string, version?: number | null): Promise<MealSnapshot> {
  const snap = await mealSnapshot(t.c, t.userId, id, true);
  if (!snap) throw new ApiError('not_found');
  if (version != null && version !== snap.row.version) throw new ApiError('life_stale');
  await t.c.query('DELETE FROM nutrition_meals WHERE user_id = $1 AND id = $2', [t.userId, id]);
  if (snap.row.status === 'consumed') await syncDiaryReward(t, snap.row.date);
  return snap;
}

/** Recria uma refeição exatamente como estava (desfazer do assistente). */
export async function restoreMeal(t: LifeTx, s: MealSnapshot): Promise<void> {
  const cur = await getMeal(t.c, t.userId, s.row.id, true);
  const version = (cur?.version ?? s.row.version) + 1;
  if (cur) await t.c.query('DELETE FROM nutrition_meals WHERE user_id = $1 AND id = $2', [t.userId, s.row.id]);
  await t.c.query(
    `INSERT INTO nutrition_meals (id, user_id, date, kind, name, time, status, notes, origin, planned_totals, consumed_at, client_id, version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [s.row.id, t.userId, s.row.date, s.row.kind, s.row.name, s.row.time, s.row.status, s.row.notes, s.row.origin, s.row.planned_totals ? JSON.stringify(s.row.planned_totals) : null, s.row.consumed_at ? new Date(s.row.consumed_at) : null, s.row.client_id, version, new Date(s.row.created_at)],
  );
  await insertItems(t.c, t.userId, s.row.id, s.items);
  await syncDiaryReward(t, s.row.date);
  if (cur && cur.date !== s.row.date) await syncDiaryReward(t, cur.date);
}

const asInput = (s: MealSnapshot, over: Partial<MealInput>): MealInput => ({
  clientId: null,
  date: s.row.date,
  kind: s.row.kind,
  name: s.row.name,
  time: s.row.time,
  status: s.row.status,
  notes: s.row.notes,
  items: s.items.map((i) => ({ foodRef: i.foodRef, quantity: i.quantity, portionLabel: i.portionLabel, portionCount: i.portionCount })),
  ...over,
});

export async function duplicateMeal(t: LifeTx, id: string, o: { clientId?: string | null; date?: string; status?: MealStatus }): Promise<{ id: string; existed: boolean }> {
  const s = await mealSnapshot(t.c, t.userId, id);
  if (!s) throw new ApiError('not_found');
  const status = o.status ?? (o.date && o.date > t.today ? 'planned' : s.row.status);
  return createMeal(t, asInput(s, { clientId: o.clientId ?? null, date: o.date ?? s.row.date, status }), 'copy', { resolved: s.items });
}

/** Copia refeições de um dia para outros dias (reutilizar um dia alimentar). Datas futuras viram planejadas. */
export async function copyDay(t: LifeTx, from: string, o: { to: string[]; status: MealStatus; mealIds?: string[] | null; only: 'consumed' | 'planned' | 'all' }): Promise<{ ids: string[] }> {
  const all = (await t.c.query<{ id: string; status: MealStatus }>(`SELECT m.id, m.status FROM nutrition_meals m WHERE m.user_id = $1 AND m.date = $2 ${ORDER}`, [t.userId, from])).rows;
  const pick = all.filter((m) => (o.mealIds?.length ? o.mealIds.includes(m.id) : true) && (o.only === 'all' || m.status === o.only));
  if (!pick.length) throw new ApiError('validation_failed', { from: 'Não há refeições para copiar neste dia.' });
  const ids: string[] = [];
  for (const to of [...new Set(o.to)]) {
    if (to === from) continue;
    const status: MealStatus = to > t.today ? 'planned' : o.status;
    await checkDayLimit(t, to, pick.length);
    for (const m of pick) {
      const s = (await mealSnapshot(t.c, t.userId, m.id))!;
      ids.push((await createMeal(t, asInput(s, { date: to, status, notes: s.row.notes }), 'copy', { resolved: s.items })).id);
    }
  }
  return { ids };
}

// ------------------------------------------------------------------ refeições salvas (favoritas)

interface SavedRow {
  id: string;
  name: string;
  kind: MealKind;
  items: ResolvedItem[];
  use_count: number;
  last_used_at: Date | null;
}

const savedView = (r: SavedRow): SavedMealView => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  items: r.items.map((i) => ({ foodRef: i.foodRef, name: i.name, quantity: i.quantity, unit: i.unit, portionLabel: i.portionLabel, portionCount: i.portionCount, per100: i.per100 })),
  totals: roundMacros(resolvedTotals(r.items)),
  useCount: r.use_count,
  lastUsedAt: iso(r.last_used_at),
});

export async function savedMeals(c: Q, userId: string): Promise<SavedMealView[]> {
  return (await c.query<SavedRow>('SELECT * FROM nutrition_saved_meals WHERE user_id = $1 ORDER BY use_count DESC, created_at DESC', [userId])).rows.map(savedView);
}

export async function createSavedMeal(c: Q, userId: string, s: { name: string; kind: MealKind; fromMealId?: string | null; items?: MealItemInput[] | null }): Promise<string> {
  const cnt = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM nutrition_saved_meals WHERE user_id = $1', [userId])).rows[0].n;
  if (cnt >= NUTRITION_LIMITS.savedMeals) throw new ApiError('life_limit');
  let items: ResolvedItem[];
  if (s.fromMealId) {
    const snap = await mealSnapshot(c, userId, s.fromMealId);
    if (!snap) throw new ApiError('not_found');
    items = snap.items;
  } else items = await resolveItems(c, userId, s.items ?? []);
  if (!items.length) throw new ApiError('validation_failed', { items: 'A refeição salva precisa de ao menos um alimento.' });
  const id = randomUUID();
  await c.query('INSERT INTO nutrition_saved_meals (id, user_id, name, kind, items) VALUES ($1, $2, $3, $4, $5)', [id, userId, s.name, s.kind, JSON.stringify(items)]);
  return id;
}

export async function deleteSavedMeal(c: Q, userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new ApiError('not_found');
  const r = await c.query('DELETE FROM nutrition_saved_meals WHERE user_id = $1 AND id = $2', [userId, id]);
  if (!r.rowCount) throw new ApiError('not_found');
}

/** Registra uma refeição salva (poucos toques). Os valores são os guardados na refeição salva. */
export async function useSavedMeal(t: LifeTx, id: string, o: { clientId?: string | null; date: string; kind?: MealKind; status: MealStatus; time?: string | null }): Promise<{ id: string; existed: boolean }> {
  if (!isUuid(id)) throw new ApiError('not_found');
  const r = (await t.c.query<SavedRow>('SELECT * FROM nutrition_saved_meals WHERE user_id = $1 AND id = $2 FOR UPDATE', [t.userId, id])).rows[0];
  if (!r) throw new ApiError('not_found');
  const kind = o.kind ?? r.kind;
  const res = await createMeal(
    t,
    { clientId: o.clientId ?? null, date: o.date, kind, name: kind === 'custom' ? r.name : null, time: o.time ?? null, status: o.status, notes: null, items: r.items.map((i) => ({ foodRef: i.foodRef, quantity: i.quantity, portionLabel: i.portionLabel, portionCount: i.portionCount })) },
    'saved',
    { resolved: r.items },
  );
  if (!res.existed) await t.c.query('UPDATE nutrition_saved_meals SET use_count = use_count + 1, last_used_at = now() WHERE user_id = $1 AND id = $2', [t.userId, id]);
  return res;
}

// ------------------------------------------------------------------ metas

interface GoalsRow {
  objective: GoalsView['objective'];
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  water_ml: number | null;
  meal_times: Partial<Record<MealKind, string>>;
  preferences: string | null;
  estimate: GoalsView['estimate'];
  origin: 'user' | 'ai';
  version: number;
  updated_at: Date;
}

const goalsView = (r: GoalsRow): GoalsView => ({ objective: r.objective, kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, waterMl: r.water_ml, mealTimes: r.meal_times ?? {}, preferences: r.preferences, estimate: r.estimate, origin: r.origin, version: r.version, updatedAt: r.updated_at.toISOString() });

export async function getGoals(c: Q, userId: string, lock = false): Promise<GoalsView | null> {
  const r = await c.query<GoalsRow>(`SELECT * FROM nutrition_goals WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId]);
  return r.rows[0] ? goalsView(r.rows[0]) : null;
}

/** Grava as metas (substitui). `estimate` guarda as premissas da estimativa usada como ponto de partida. */
export async function saveGoals(c: Q, userId: string, g: GoalsInput, origin: 'user' | 'ai', version?: number | null): Promise<{ before: GoalsView | null; after: GoalsView }> {
  const before = await getGoals(c, userId, true);
  if (version != null && before && before.version !== version) throw new ApiError('life_stale');
  const est = g.estimate ? estimateGoals(g.estimate) : g.estimate === null ? null : (before?.estimate ?? null);
  const times = g.mealTimes ?? before?.mealTimes ?? {};
  const r = await c.query<GoalsRow>(
    `INSERT INTO nutrition_goals (user_id, objective, kcal, protein, carbs, fat, water_ml, meal_times, preferences, estimate, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (user_id) DO UPDATE SET objective = EXCLUDED.objective, kcal = EXCLUDED.kcal, protein = EXCLUDED.protein, carbs = EXCLUDED.carbs, fat = EXCLUDED.fat,
       water_ml = EXCLUDED.water_ml, meal_times = EXCLUDED.meal_times, preferences = EXCLUDED.preferences, estimate = EXCLUDED.estimate, origin = EXCLUDED.origin,
       version = nutrition_goals.version + 1, updated_at = now()
     RETURNING *`,
    [userId, g.objective, g.kcal ?? null, g.protein ?? null, g.carbs ?? null, g.fat ?? null, g.waterMl ?? null, JSON.stringify(times), g.preferences, est ? JSON.stringify(est) : null, origin],
  );
  return { before, after: goalsView(r.rows[0]) };
}

export async function restoreGoals(c: Q, userId: string, before: GoalsView | null): Promise<void> {
  if (!before) {
    await c.query('DELETE FROM nutrition_goals WHERE user_id = $1', [userId]);
    return;
  }
  await c.query(
    `UPDATE nutrition_goals SET objective = $2, kcal = $3, protein = $4, carbs = $5, fat = $6, water_ml = $7, meal_times = $8, preferences = $9, estimate = $10, origin = $11,
       version = version + 1, updated_at = now() WHERE user_id = $1`,
    [userId, before.objective, before.kcal, before.protein, before.carbs, before.fat, before.waterMl, JSON.stringify(before.mealTimes), before.preferences, before.estimate ? JSON.stringify(before.estimate) : null, before.origin],
  );
}

export const goalsAsInput = (g: GoalsView): GoalsInput => ({ objective: g.objective, kcal: g.kcal, protein: g.protein, carbs: g.carbs, fat: g.fat, waterMl: g.waterMl, mealTimes: g.mealTimes as GoalsInput['mealTimes'], preferences: g.preferences, estimate: undefined });

// ------------------------------------------------------------------ água

export async function setWater(t: LifeTx, date: string, ml: number): Promise<void> {
  if (date > t.today || date < addDays(t.today, -NUTRITION_LIMITS.pastDays)) throw new ApiError('nutrition_date_not_allowed');
  if (ml === 0) await t.c.query('DELETE FROM nutrition_water WHERE user_id = $1 AND date = $2', [t.userId, date]);
  else await t.c.query('INSERT INTO nutrition_water (user_id, date, ml) VALUES ($1, $2, $3) ON CONFLICT (user_id, date) DO UPDATE SET ml = EXCLUDED.ml, updated_at = now()', [t.userId, date, ml]);
  await syncWaterReward(t, date, ml);
}

// ------------------------------------------------------------------ recompensas (motor da Fase 01)

const rewardWindow = (t: LifeTx, date: string) => date <= t.today && date >= addDays(t.today, -1);

/** Hábito de alimentação ativo, do tipo "concluir", programado para o dia: registrar o diário conclui ESSE hábito. */
async function linkedHabit(t: LifeTx, date: string): Promise<{ id: string; name: string } | null> {
  const r = await t.c.query<{ id: string; name: string; frequency: string; days: number[] }>(
    "SELECT id, name, frequency, days FROM life_habits WHERE user_id = $1 AND status = 'active' AND tag = 'nutrition' AND goal_kind = 'check' AND start_date <= $2 ORDER BY created_at LIMIT 5",
    [t.userId, date],
  );
  const h = r.rows.find((x) => x.frequency === 'weekly' || x.days.includes(weekday(date)));
  return h ? { id: h.id, name: h.name } : null;
}

/**
 * Diário do dia: com `minMeals` refeições consumidas registradas (hoje ou ontem) concede o XP de registro UMA vez
 * (chave nutrition:day:<data>). Se existir um hábito de alimentação vinculado, o XP é o do hábito (o registro conclui
 * o hábito) e o lançamento do diário fica com 0 XP — a mesma ação nunca rende em dobro. Cair abaixo do mínimo estorna.
 */
export async function syncDiaryReward(t: LifeTx, date: string): Promise<void> {
  const key = `nutrition:day:${date}`;
  const count = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM nutrition_meals m WHERE m.user_id = $1 AND m.date = $2 AND m.status = 'consumed' AND EXISTS (SELECT 1 FROM nutrition_meal_items i WHERE i.meal_id = m.id)", [t.userId, date])).rows[0].n;
  const existing = await activeGrant(t.c, t.userId, key);
  if (count >= NUTRITION_REWARD.minMeals) {
    if (existing || !rewardWindow(t, date)) return;
    const habit = await linkedHabit(t, date);
    if (habit) {
      const done = (await t.c.query('SELECT 1 FROM life_habit_logs WHERE user_id = $1 AND habit_id = $2 AND date = $3 AND completed', [t.userId, habit.id, date])).rowCount;
      if (!done) await logHabit(t, habit.id, 1, date);
      await grant(t, { source: 'nutrition', key, sourceId: habit.id, attribute: 'health', requested: 0, day: date, reason: `Diário alimentar registrado (XP pelo hábito "${habit.name}")` });
    } else await grant(t, { source: 'nutrition', key, sourceId: null, attribute: 'health', requested: NUTRITION_REWARD.diaryDay, day: date, reason: 'Diário alimentar registrado' });
    return;
  }
  if (!existing) return;
  const src = (await t.c.query<{ source_id: string | null }>('SELECT source_id FROM life_xp_events WHERE id = $1', [existing.id])).rows[0]?.source_id;
  await reverse(t, key, 'Diário alimentar desfeito (refeições removidas)');
  // O hábito concluído automaticamente volta a ficar em aberto (só hoje/ontem, como qualquer hábito).
  if (src && rewardWindow(t, date)) {
    const h = await t.c.query<{ status: string }>('SELECT status FROM life_habits WHERE user_id = $1 AND id = $2', [t.userId, src]);
    if (h.rows[0]?.status === 'active') await logHabit(t, src, 0, date);
  }
}

async function syncWaterReward(t: LifeTx, date: string, ml: number): Promise<void> {
  const key = `nutrition:water:${date}`;
  if (ml > 0) {
    if (rewardWindow(t, date)) await grant(t, { source: 'nutrition', key, sourceId: null, attribute: 'health', requested: NUTRITION_REWARD.water, day: date, reason: 'Água registrada' });
  } else await reverse(t, key, 'Registro de água removido');
}

// ------------------------------------------------------------------ visões do dia, estatísticas e atalhos

export async function dayView(t: Pick<LifeTx, 'c' | 'userId' | 'today'>, date: string): Promise<DayView> {
  const meals = await mealViews(t.c, t.userId, { from: date, to: date });
  const goals = await getGoals(t.c, t.userId);
  const water = (await t.c.query<{ ml: number }>('SELECT ml FROM nutrition_water WHERE user_id = $1 AND date = $2', [t.userId, date])).rows[0]?.ml ?? 0;
  const consumed = meals.filter((m) => m.status === 'consumed');
  const planned = meals.filter((m) => m.status === 'planned');
  const fromPlan = consumed.filter((m) => m.plannedTotals);
  const consumedMeals = consumed.filter((m) => m.items.length).length;
  return {
    protocol: NUTRITION_PROTOCOL,
    date,
    today: t.today,
    meals,
    consumed: roundMacros(sumMacros(consumed.map((m) => m.totals))),
    plannedPending: roundMacros(sumMacros(planned.map((m) => m.totals))),
    planTotal: roundMacros(sumMacros([...planned.map((m) => m.totals), ...fromPlan.map((m) => m.plannedTotals!)])),
    hasPlan: planned.length > 0 || fromPlan.length > 0,
    goals,
    water: { ml: water, goalMl: goals?.waterMl ?? null },
    diary: { consumedMeals, minMeals: NUTRITION_REWARD.minMeals, rewarded: !!(await activeGrant(t.c, t.userId, `nutrition:day:${date}`)), rewardAllowed: date <= t.today && date >= addDays(t.today, -1) },
  };
}

/** Resumos por dia (só dias com algum registro). */
export async function daySummaries(c: Q, userId: string, from: string, to: string): Promise<DaySummaryView[]> {
  const rows = (
    await c.query<{ id: string; date: string; status: MealStatus; planned_totals: Macros | null; kcal: number; protein: number; carbs: number; fat: number; fiber: number; items: number }>(
      `SELECT m.id, m.date, m.status, m.planned_totals,
              coalesce(sum(i.kcal * i.quantity / 100), 0)::float8 AS kcal, coalesce(sum(coalesce(i.protein, 0) * i.quantity / 100), 0)::float8 AS protein,
              coalesce(sum(coalesce(i.carbs, 0) * i.quantity / 100), 0)::float8 AS carbs, coalesce(sum(coalesce(i.fat, 0) * i.quantity / 100), 0)::float8 AS fat,
              coalesce(sum(coalesce(i.fiber, 0) * i.quantity / 100), 0)::float8 AS fiber, count(i.id)::int AS items
         FROM nutrition_meals m LEFT JOIN nutrition_meal_items i ON i.meal_id = m.id
        WHERE m.user_id = $1 AND m.date BETWEEN $2 AND $3 GROUP BY m.id`,
      [userId, from, to],
    )
  ).rows;
  const water = new Map((await c.query<{ date: string; ml: number }>('SELECT date, ml FROM nutrition_water WHERE user_id = $1 AND date BETWEEN $2 AND $3', [userId, from, to])).rows.map((r) => [r.date, r.ml]));
  const days = new Map<string, { consumed: Macros[]; planned: Macros[]; cm: number; pm: number }>();
  for (const r of rows) {
    const d = days.get(r.date) ?? { consumed: [], planned: [], cm: 0, pm: 0 };
    const tot: Macros = { kcal: r.kcal, protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber };
    if (r.status === 'consumed') {
      d.consumed.push(tot);
      if (r.items > 0) d.cm++;
      if (r.planned_totals) d.planned.push(r.planned_totals);
    } else {
      d.planned.push(tot);
      d.pm++;
    }
    days.set(r.date, d);
  }
  for (const date of water.keys()) if (!days.has(date)) days.set(date, { consumed: [], planned: [], cm: 0, pm: 0 });
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, d]) => ({ date, consumed: roundMacros(sumMacros(d.consumed)), consumedMeals: d.cm, plannedMeals: d.pm, planned: d.planned.length ? roundMacros(sumMacros(d.planned)) : null, waterMl: water.get(date) ?? null }));
}

/** Estatísticas reais do período. Médias só sobre dias com refeição consumida (dia vazio ≠ consumo zero). */
export async function statsView(c: Q, userId: string, from: string, to: string, today: string): Promise<StatsView> {
  const end = to > today ? today : to;
  const days = await daySummaries(c, userId, from, end);
  const logged = days.filter((d) => d.consumedMeals > 0);
  const avg = (list: DaySummaryView[]) => (list.length ? roundMacros(Object.fromEntries(Object.entries(sumMacros(list.map((d) => d.consumed))).map(([k, v]) => [k, v / list.length])) as unknown as Macros) : null);
  const weeks = new Map<string, DaySummaryView[]>();
  for (let d = mondayOf(from); d <= end; d = addDays(d, 7)) weeks.set(d, []);
  for (const d of logged) weeks.get(mondayOf(d.date))?.push(d);
  const totalDays = Math.max(0, Math.round((Date.parse(end) - Date.parse(from)) / 86_400_000) + 1);
  return {
    from,
    to: end,
    days,
    loggedDays: logged.length,
    totalDays,
    average: avg(logged),
    weeks: [...weeks.entries()].map(([start, list]) => ({ start, loggedDays: list.length, average: avg(list) })),
    split: macroSplit(sumMacros(logged.map((d) => d.consumed))),
    goals: await getGoals(c, userId),
    planVsActual: days.filter((d) => d.planned && d.date <= today).map((d) => ({ date: d.date, planned: d.planned!, consumed: d.consumed })),
  };
}

export async function quickView(c: Q, userId: string): Promise<QuickView> {
  const favs = await favoriteSet(c, userId);
  const recent = (await c.query<{ food_ref: string }>("SELECT i.food_ref FROM nutrition_meal_items i JOIN nutrition_meals m ON m.id = i.meal_id WHERE i.user_id = $1 AND m.status = 'consumed' GROUP BY i.food_ref ORDER BY max(m.date) DESC, max(m.created_at) DESC LIMIT 12", [userId])).rows.map((r) => r.food_ref);
  const freq = (
    await c.query<{ food_ref: string; n: number; last_q: string }>(
      `SELECT i.food_ref, count(*)::int AS n, (array_agg(i.quantity ORDER BY m.date DESC, m.created_at DESC))[1] AS last_q
         FROM nutrition_meal_items i JOIN nutrition_meals m ON m.id = i.meal_id
        WHERE i.user_id = $1 AND m.status = 'consumed' AND m.date >= (now() - interval '30 days')::date GROUP BY i.food_ref ORDER BY n DESC LIMIT 8`,
      [userId],
    )
  ).rows;
  const views = await foodViews(c, userId, [...new Set([...recent, ...favs, ...freq.map((f) => f.food_ref)])], favs);
  const live = (ref: string) => {
    const v = views.get(ref);
    return v && !v.custom?.archived ? v : null;
  };
  const lastIds = (await c.query<{ id: string }>("SELECT DISTINCT ON (kind) id FROM nutrition_meals WHERE user_id = $1 AND status = 'consumed' AND kind <> 'custom' ORDER BY kind, date DESC, created_at DESC", [userId])).rows.map((r) => r.id);
  const last = await mealViews(c, userId, { ids: lastIds });
  const lastByKind: QuickView['lastByKind'] = {};
  for (const m of last) if (m.items.length) lastByKind[m.kind] = m;
  return {
    recentFoods: recent.map(live).filter((v): v is FoodView => !!v),
    favoriteFoods: [...favs].map(live).filter((v): v is FoodView => !!v),
    frequentFoods: freq.map((f) => (live(f.food_ref) ? { ...live(f.food_ref)!, lastQuantity: Number(f.last_q) } : null)).filter((v): v is FoodView & { lastQuantity: number } => !!v),
    savedMeals: await savedMeals(c, userId),
    lastByKind,
  };
}

// ------------------------------------------------------------------ rascunhos (texto/IA hoje; foto na Fase 03)

const STATE_WORDS = /\b(cru|crua|cozid|grelhad|assad|frit|refogad|vapor)/;

/**
 * Converte descrições ("arroz", "peito de frango") em sugestões para REVISÃO. Quando a descrição não diz o preparo e
 * há versões cruas e cozidas, escolhe a pronta para comer e avisa para conferir.
 */
export async function resolveDraft(c: Q, userId: string, items: { label: string; quantity?: number | null }[]): Promise<MealDraftItem[]> {
  const out: MealDraftItem[] = [];
  for (const it of items) {
    const found = await searchFoods(c, userId, it.label, 6);
    const match = found[0] ?? null;
    // Existe a mesma comida em outro preparo (ex.: "Arroz, tipo 1" cru × cozido)? Então vale conferir.
    const base = match && match.source.kind === 'taco' ? match.name.split(',').slice(0, 2).join(',') : null;
    const statesDiffer = !!base && (match!.state === 'raw' || match!.state === 'cooked') && catalog().list.some((f) => f.ref !== match!.ref && f.name.startsWith(base) && (f.state === 'raw' || f.state === 'cooked') && f.state !== match!.state);
    let warning: string | null = null;
    if (!match) warning = 'Nenhum alimento encontrado: busque outro nome ou cadastre pelo rótulo.';
    else if (statesDiffer && !STATE_WORDS.test(it.label.toLowerCase())) warning = `Confira o preparo: considerei "${match.name}".`;
    else if (match.hint) warning = match.hint;
    out.push({ label: it.label, match, candidates: found.slice(1, 5), quantity: it.quantity ?? null, confidence: null, warning });
  }
  return out;
}

export const defaultTime = (kind: MealKind, goals: GoalsView | null): string => goals?.mealTimes?.[kind] ?? DEFAULT_MEAL_TIMES[kind];

export const CATALOG_INFO = () => ({ foods: catalog().list.length, source: 'TACO 4ª ed. (NEPA/UNICAMP, 2011)' });
export { ZERO, hintOf };
