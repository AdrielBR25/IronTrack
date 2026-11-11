// Rotas do módulo de alimentação (Fase 02): /api/v1/nutrition/*. Só com a sessão da conta; tudo filtrado por user_id.
// Escritas rodam em lifeTx (perfil bloqueado, mesmo fuso do RPG) e devolvem o dia afetado + o resultado das
// recompensas de registro (animações). Não existe rota que conceda XP diretamente.
import { z } from 'zod';
import {
  NUTRITION_LIMITS,
  consumeSchema,
  copyDaySchema,
  customFoodInputSchema,
  customFoodPatchSchema,
  draftResolveSchema,
  duplicateSchema,
  estimateGoals,
  estimateInputSchema,
  foodRefSchema,
  goalsInputSchema,
  isoDate,
  mealInputSchema,
  mealPatchSchema,
  savedMealInputSchema,
  useSavedMealSchema,
  waterSchema,
} from '../../../../shared/nutrition/protocol.ts';
import type { Pool } from '../db/pool.ts';
import { ApiError, readJson, type RequestCtx, type Router } from '../http/core.ts';
import { addDays } from '../assistant/tools/time.ts';
import { ensureMissions, lifeTx, type LifeTx } from '../life/engine.ts';
import { localHHMM } from '../life/module.ts';
import * as N from './service.ts';

export interface NutritionDeps {
  pool: Pool;
  now?: () => number;
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) fields[i.path.join('.') || 'body'] ??= i.message;
  throw new ApiError('validation_failed', fields);
}

const versioned = <S extends z.ZodTypeAny>(s: S) => z.object({ version: z.number().int().positive().optional(), patch: s }).strict();
const versionOnly = z.object({ version: z.number().int().positive().optional() }).strict();

export function nutritionRoutes(router: Router, d: NutritionDeps): void {
  const now = d.now ?? Date.now;
  const P = '/api/v1/nutrition';
  const body = (ctx: RequestCtx, max = 32 * 1024) => readJson(ctx, max);
  const optBody = async (ctx: RequestCtx) => (Number(ctx.req.headers['content-length'] ?? 0) > 0 ? readJson(ctx, 4 * 1024) : {});
  const tzHint = (ctx: RequestCtx) => ctx.url.searchParams.get('tz');

  /** Mutação: transação da conta + dia afetado (visão depois do acerto das recompensas) + resultado. */
  async function mutate(ctx: RequestCtx, fn: (t: LifeTx) => Promise<{ id?: string; date?: string; [k: string]: unknown } | void>, status = 200) {
    let date: string | undefined;
    const r = await lifeTx(
      d.pool,
      ctx.auth!.userId,
      now(),
      async (t) => {
        const v = (await fn(t)) ?? {};
        date = v.date;
        return v;
      },
      { tzHint: tzHint(ctx), view: async (t) => (date ? N.dayView(t, date) : undefined) },
    );
    const { date: _d, ...rest } = r.value as Record<string, unknown>;
    return { status, body: { ...rest, ...(r.view ? { day: r.view } : {}), outcome: r.outcome } };
  }
  /** Leitura que precisa do "hoje" no fuso da conta. */
  const read = <T>(ctx: RequestCtx, fn: (t: LifeTx) => Promise<T>) => lifeTx(d.pool, ctx.auth!.userId, now(), fn, { tzHint: tzHint(ctx) }).then((r) => r.value);
  const range = (ctx: RequestCtx, today: string, defDays: number) => {
    const to = ctx.url.searchParams.get('to') ?? today;
    const from = ctx.url.searchParams.get('from') ?? addDays(to, -(defDays - 1));
    parse(isoDate, from);
    parse(isoDate, to);
    if (from > to || addDays(from, NUTRITION_LIMITS.rangeDays) < to) throw new ApiError('validation_failed', { from: `Período inválido (máximo ${NUTRITION_LIMITS.rangeDays} dias).` });
    return { from, to };
  };

  // ---------------------------------------------------------------- dia, período, estatísticas, atalhos
  router.add({ method: 'GET', path: `${P}/days/:date`, auth: 'session', handler: async (ctx) => {
    const date = ctx.params.date === 'hoje' ? null : parse(isoDate, ctx.params.date);
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), async (t) => {
      // A missão semanal de diário alimentar nasce aqui também (não só no Início).
      if (!date || date === t.today) await ensureMissions(t);
    }, { tzHint: tzHint(ctx), view: (t) => N.dayView(t, date ?? t.today) });
    return { status: 200, body: { day: r.view, outcome: r.outcome, nowHHMM: localHHMM(now(), r.profile.timezone) } };
  } });
  router.add({ method: 'GET', path: `${P}/days`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const { from, to } = range(ctx, t.today, 42);
      return { from, to, today: t.today, days: await N.daySummaries(t.c, t.userId, from, to) };
    });
    return { status: 200, body: v };
  } });
  router.add({ method: 'GET', path: `${P}/meals`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const { from, to } = range(ctx, t.today, 7);
      const status = ctx.url.searchParams.get('status');
      return { from, to, meals: await N.mealViews(t.c, t.userId, { from, to }, status === 'planned' || status === 'consumed' ? { status } : {}) };
    });
    return { status: 200, body: v };
  } });
  router.add({ method: 'GET', path: `${P}/stats`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const { from, to } = range(ctx, t.today, 28);
      return N.statsView(t.c, t.userId, from, to, t.today);
    });
    return { status: 200, body: { stats: v } };
  } });
  router.add({ method: 'GET', path: `${P}/quick`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { quick: await N.quickView(d.pool as never, ctx.auth!.userId) } }) });

  // ---------------------------------------------------------------- alimentos
  router.add({ method: 'GET', path: `${P}/foods`, auth: 'session', handler: async (ctx) => {
    const q = (ctx.url.searchParams.get('q') ?? '').slice(0, 80);
    const lim = Math.min(50, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 25) || 25));
    const u = ctx.auth!.userId;
    if (ctx.url.searchParams.get('mine') === '1') {
      const rows = (await d.pool.query<N.CustomFoodRow>('SELECT * FROM nutrition_foods WHERE user_id = $1 AND (NOT archived OR $2) ORDER BY lower(name)', [u, ctx.url.searchParams.get('archived') === '1'])).rows;
      const favs = await N.foodViews(d.pool as never, u, rows.map((r) => `custom:${r.id}`));
      return { status: 200, body: { foods: rows.map((r) => favs.get(`custom:${r.id}`) ?? N.customView(r)) } };
    }
    return { status: 200, body: { foods: await N.searchFoods(d.pool as never, u, q, lim) } };
  } });
  router.add({ method: 'GET', path: `${P}/foods/:ref`, auth: 'session', handler: async (ctx) => {
    const ref = parse(foodRefSchema, ctx.params.ref);
    const f = await N.getFood(d.pool as never, ctx.auth!.userId, ref);
    if (!f) throw new ApiError('not_found');
    return { status: 200, body: { food: f } };
  } });
  router.add({ method: 'POST', path: `${P}/foods`, auth: 'session', handler: async (ctx) => {
    const f = parse(customFoodInputSchema, await body(ctx));
    const row = await N.createCustomFood(d.pool as never, ctx.auth!.userId, f, 'user');
    return { status: 201, body: { food: N.customView(row) } };
  } });
  router.add({ method: 'PATCH', path: `${P}/foods/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(customFoodPatchSchema), await body(ctx));
    const u = ctx.auth!.userId;
    const r = await lifeTx(d.pool, u, now(), (t) => N.updateCustomFood(t.c, u, ctx.params.id, b.patch, b.version));
    return { status: 200, body: { food: N.customView(r.value.after) } };
  } });
  router.add({ method: 'POST', path: `${P}/favorites`, auth: 'session', handler: async (ctx) => {
    const b = parse(z.object({ foodRef: foodRefSchema, favorite: z.boolean() }).strict(), await body(ctx));
    await N.setFavorite(d.pool as never, ctx.auth!.userId, b.foodRef, b.favorite);
    return { status: 200, body: { ok: true } };
  } });

  // ---------------------------------------------------------------- refeições
  router.add({ method: 'POST', path: `${P}/meals`, auth: 'session', handler: async (ctx) => {
    const m = parse(mealInputSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ ...(await N.createMeal(t, m, m.origin === 'photo' ? 'photo' : 'user')), date: m.date }), 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/meals/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(mealPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => {
      const r = await N.updateMeal(t, ctx.params.id, b.patch, b.version);
      return { id: r.after.id, date: r.after.date };
    });
  } });
  router.add({ method: 'POST', path: `${P}/meals/:id/consume`, auth: 'session', handler: async (ctx) => {
    const b = parse(consumeSchema.extend({ version: z.number().int().positive().optional() }), await optBody(ctx));
    return mutate(ctx, async (t) => {
      const r = await N.consumeMeal(t, ctx.params.id, { time: b.time, date: b.date, version: b.version });
      return { id: r.id, date: r.date };
    });
  } });
  router.add({ method: 'POST', path: `${P}/meals/:id/unconsume`, auth: 'session', handler: async (ctx) => {
    const b = parse(versionOnly, await optBody(ctx));
    return mutate(ctx, async (t) => {
      const r = await N.unconsumeMeal(t, ctx.params.id, b.version);
      return { id: r.id, date: r.date };
    });
  } });
  router.add({ method: 'POST', path: `${P}/meals/:id/duplicate`, auth: 'session', handler: async (ctx) => {
    const b = parse(duplicateSchema, await optBody(ctx));
    return mutate(ctx, async (t) => {
      const r = await N.duplicateMeal(t, ctx.params.id, b);
      const m = await N.getMeal(t.c, t.userId, r.id);
      return { ...r, date: m?.date };
    }, 201);
  } });
  router.add({ method: 'DELETE', path: `${P}/meals/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => {
    const s = await N.deleteMeal(t, ctx.params.id);
    return { id: s.row.id, date: s.row.date };
  }) });
  router.add({ method: 'POST', path: `${P}/days/:date/copy`, auth: 'session', handler: async (ctx) => {
    const from = parse(isoDate, ctx.params.date);
    const b = parse(copyDaySchema, await body(ctx));
    return mutate(ctx, async (t) => ({ ...(await N.copyDay(t, from, b)), date: b.to[0] }), 201);
  } });
  router.add({ method: 'POST', path: `${P}/days/:date/water`, auth: 'session', handler: async (ctx) => {
    const date = parse(isoDate, ctx.params.date);
    const b = parse(waterSchema, await body(ctx));
    return mutate(ctx, async (t) => {
      await N.setWater(t, date, b.ml);
      return { date };
    });
  } });

  // ---------------------------------------------------------------- refeições salvas
  router.add({ method: 'GET', path: `${P}/saved-meals`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { savedMeals: await N.savedMeals(d.pool as never, ctx.auth!.userId) } }) });
  router.add({ method: 'POST', path: `${P}/saved-meals`, auth: 'session', handler: async (ctx) => {
    const s = parse(savedMealInputSchema, await body(ctx));
    return { status: 201, body: { id: await N.createSavedMeal(d.pool as never, ctx.auth!.userId, s) } };
  } });
  router.add({ method: 'DELETE', path: `${P}/saved-meals/:id`, auth: 'session', handler: async (ctx) => {
    await N.deleteSavedMeal(d.pool as never, ctx.auth!.userId, ctx.params.id);
    return { status: 200, body: { ok: true } };
  } });
  router.add({ method: 'POST', path: `${P}/saved-meals/:id/use`, auth: 'session', handler: async (ctx) => {
    const b = parse(useSavedMealSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ ...(await N.useSavedMeal(t, ctx.params.id, b)), date: b.date }), 201);
  } });

  // ---------------------------------------------------------------- metas
  router.add({ method: 'GET', path: `${P}/goals`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { goals: await N.getGoals(d.pool as never, ctx.auth!.userId) } }) });
  router.add({ method: 'PATCH', path: `${P}/goals`, auth: 'session', handler: async (ctx) => {
    const b = parse(z.object({ version: z.number().int().positive().nullish(), goals: goalsInputSchema }).strict(), await body(ctx));
    const u = ctx.auth!.userId;
    const r = await lifeTx(d.pool, u, now(), async (t) => {
      const g = await N.saveGoals(t.c, u, b.goals, 'user', b.version);
      await ensureMissions(t);
      return g;
    });
    return { status: 200, body: { goals: r.value.after } };
  } });
  /** Só calcula (não grava): a pessoa revisa e decide. */
  router.add({ method: 'POST', path: `${P}/goals/estimate`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { estimate: estimateGoals(parse(estimateInputSchema, await body(ctx))) } }) });

  // ---------------------------------------------------------------- rascunhos (revisão antes de salvar; base da Fase 03)
  router.add({ method: 'POST', path: `${P}/drafts/resolve`, auth: 'session', handler: async (ctx) => {
    const b = parse(draftResolveSchema, await body(ctx));
    return { status: 200, body: { items: await N.resolveDraft(d.pool as never, ctx.auth!.userId, b.items) } };
  } });
}
