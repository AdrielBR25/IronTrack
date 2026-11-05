// Rotas da integração Life (Fase 06): /api/v1/planner/* (Minha Semana e painel inicial) e /api/v1/insights/* (Minha
// Evolução). Só com a sessão da conta; tudo filtrado por user_id. Nenhuma rota concede XP nem chama a OpenAI.
import { z } from 'zod';
import { EVOLUTION_PERIODS, homeLayoutSchema, overrideInputSchema, plannerItemInputSchema, plannerItemPatchSchema, reorderSchema, type EvolutionPeriod, type TodayView } from '../../../../shared/planner/protocol.ts';
import { withTx, type Pool } from '../db/pool.ts';
import { ApiError, readJson, type RequestCtx, type Router } from '../http/core.ts';
import { addDays, localDate, mondayOf } from '../assistant/tools/time.ts';
import { evolution } from '../insights/service.ts';
import * as P from './service.ts';

export interface PlannerDeps {
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

const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** Resumo do dia para o painel: só leitura, montado da agenda e dos módulos. */
export async function todayView(pool: Pool, userId: string, now: number): Promise<TodayView> {
  const tz = await P.accountTz(pool, userId);
  const today = localDate(now, tz);
  const nowHHMM = P.localHHMM(now, tz);
  const [agenda, layout, weekly, kGoals, profile, workoutsWeek] = await Promise.all([
    P.buildAgenda(pool, userId, now, today, 1, tz),
    P.getLayout(pool, userId),
    pool.query<{ title: string; progress: number; target: number; unit: string; tag: string }>(
      "SELECT title, progress, target, unit, tag FROM life_missions WHERE user_id = $1 AND type = 'weekly' AND status IN ('active', 'completed') AND starts_on <= $2 AND ends_on >= $2 ORDER BY title LIMIT 4",
      [userId, today],
    ),
    pool.query<{ id: string; module: string; title: string; metric: string; scope: string; target: number }>(
      "SELECT id, module, title, metric, scope, target FROM knowledge_goals WHERE user_id = $1 AND status = 'active' AND period = 'weekly' ORDER BY created_at LIMIT 4",
      [userId],
    ),
    pool.query<{ weekly_workout_target: number | null }>('SELECT weekly_workout_target FROM life_profiles WHERE user_id = $1', [userId]),
    pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM life_xp_events WHERE user_id = $1 AND source = 'workout' AND kind = 'grant' AND reversed_at IS NULL AND day BETWEEN $2 AND $3",
      [userId, mondayOf(today), addDays(mondayOf(today), 6)],
    ),
  ]);
  const day = agenda.days[0];
  const items = day.items;
  const pick = <T extends { status: string; startTime: string | null }>(xs: T[]) =>
    xs.find((x) => x.status === 'in_progress') ?? xs.find((x) => x.status === 'planned' && (x.startTime ?? '99:99') >= nowHHMM) ?? xs.find((x) => x.status === 'planned') ?? null;

  const workouts = items.filter((i) => i.category === 'workout');
  const w = workouts.find((i) => i.status === 'in_progress') ?? workouts.find((i) => i.status === 'planned') ?? workouts.find((i) => i.status === 'done');
  const workout: TodayView['workout'] = w
    ? { status: w.status === 'in_progress' ? 'in_progress' : w.status === 'done' ? 'done' : 'planned', title: w.title, link: w.link ?? '/treinar' }
    : day.rest || items.some((i) => i.category === 'rest')
      ? { status: 'rest', title: 'Descanso', link: '/planejamento' }
      : { status: 'none', title: null, link: '/planejamento' };

  const meal = pick(items.filter((i) => i.category === 'meal'));
  const kcalOf = (s: string | null) => {
    const m = s?.match(/(\d+) kcal/);
    return m ? Number(m[1]) : null;
  };
  const study = pick(items.filter((i) => i.category === 'study' || i.category === 'reading' || i.category === 'bible'));

  // Metas da semana: treinos (meta semanal do RPG), missões semanais e metas semanais de leitura/estudo/Bíblia.
  const weekGoals: TodayView['weekGoals'] = [];
  const target = profile.rows[0]?.weekly_workout_target;
  if (target) weekGoals.push({ title: 'Treinos da semana', module: 'training', done: workoutsWeek.rows[0]?.n ?? 0, target, unit: 'treinos', link: '/treinar' });
  for (const m of weekly.rows) weekGoals.push({ title: m.title, module: 'life', done: Math.min(m.progress, m.target), target: m.target, unit: m.unit === 'times' ? 'vezes' : m.unit, link: '/missoes' });
  if (kGoals.rows.length) {
    const from = mondayOf(today);
    const s = await pool.query<{ module: string; kind: string; sec: number; pages: number; date: string }>('SELECT module, kind, active_sec AS sec, pages_read AS pages, date FROM knowledge_sessions WHERE user_id = $1 AND date BETWEEN $2 AND $3', [userId, from, addDays(from, 6)]);
    for (const g of kGoals.rows) {
      const rows = s.rows.filter((r) => r.module === g.module && (g.scope === 'any' || r.kind === g.scope));
      const done = g.metric === 'minutes' ? Math.round(rows.reduce((n, r) => n + r.sec, 0) / 60) : g.metric === 'pages' ? rows.reduce((n, r) => n + r.pages, 0) : g.metric === 'sessions' ? rows.length : new Set(rows.map((r) => r.date)).size;
      const unit = g.metric === 'minutes' ? 'min' : g.metric === 'pages' ? 'páginas' : g.metric === 'sessions' ? 'sessões' : 'dias';
      weekGoals.push({ title: g.title, module: g.module === 'bible' ? 'bible' : 'knowledge', done: Math.min(done, g.target), target: g.target, unit, link: g.module === 'bible' ? '/biblia/metas' : '/conhecimento/metas' });
    }
  }

  // Sugestões discretas e determinísticas (sem IA, no máximo duas).
  const suggestions: TodayView['suggestions'] = [];
  if (day.conflicts.length) suggestions.push({ text: `Há ${day.conflicts.length === 1 ? 'uma sobreposição' : `${day.conflicts.length} sobreposições`} de horário hoje.`, link: '/semana' });
  if (day.load.overloaded) suggestions.push({ text: 'Hoje está carregado. Que tal mover algo para outro dia?', link: '/semana' });
  if (workout.status === 'planned' && nowHHMM >= '18:00') suggestions.push({ text: `${workout.title} ainda está planejado para hoje.`, link: workout.link });
  if (nowHHMM >= '14:00' && !items.some((i) => i.category === 'meal' && i.status === 'done') && items.some((i) => i.category === 'meal')) suggestions.push({ text: 'Nenhuma refeição registrada hoje ainda.', link: '/alimentacao' });
  if (!items.some((i) => i.category !== 'mission')) suggestions.push({ text: 'Sua agenda de hoje está vazia. Planeje a semana em Minha Semana.', link: '/semana' });

  return {
    protocol: agenda.protocol,
    today,
    now: nowHHMM,
    workout,
    nextMeal: meal ? { title: meal.title, time: meal.startTime, kcal: kcalOf(meal.subtitle), link: meal.link ?? '/alimentacao' } : null,
    nextStudy: study ? { title: study.title, time: study.startTime, category: study.category as 'study' | 'reading' | 'bible', status: study.status, link: study.link ?? '/conhecimento' } : null,
    weekGoals: weekGoals.slice(0, 5),
    upcoming: items.filter((i) => (i.status === 'planned' || i.status === 'in_progress') && i.category !== 'mission' && (!i.startTime || i.startTime >= nowHHMM)).slice(0, 5),
    suggestions: suggestions.slice(0, 2),
    layout,
  };
}

export function plannerRoutes(router: Router, d: PlannerDeps): void {
  const now = d.now ?? Date.now;
  const B = '/api/v1/planner';
  const body = (ctx: RequestCtx, max = 16 * 1024) => readJson(ctx, max);

  router.add({
    method: 'GET',
    path: `${B}/week`,
    auth: 'session',
    handler: async (ctx) => {
      const u = ctx.auth!.userId;
      const tz = await P.accountTz(d.pool, u);
      const qs = ctx.url.searchParams.get('start');
      const start = isDate(qs) ? qs : mondayOf(localDate(now(), tz));
      const days = Math.max(1, Math.min(P.MAX_DAYS, Number(ctx.url.searchParams.get('days')) || 7));
      return { status: 200, body: await P.buildAgenda(d.pool, u, now(), start, days, tz) };
    },
  });
  router.add({ method: 'GET', path: `${B}/today`, auth: 'session', handler: async (ctx) => ({ status: 200, body: await todayView(d.pool, ctx.auth!.userId, now()) }) });

  router.add({
    method: 'POST',
    path: `${B}/items`,
    auth: 'session',
    handler: async (ctx) => {
      const x = parse(plannerItemInputSchema, await body(ctx));
      const r = await P.createItem(d.pool, ctx.auth!.userId, x, 'user');
      return { status: r.created ? 201 : 200, body: { id: r.row.id, created: r.created } };
    },
  });
  router.add({
    method: 'PATCH',
    path: `${B}/items/:id`,
    auth: 'session',
    handler: async (ctx) => {
      const b = parse(z.object({ version: z.number().int().positive().optional(), patch: plannerItemPatchSchema }).strict(), await body(ctx));
      const row = await withTx(d.pool, (c) => P.patchItem(c, ctx.auth!.userId, ctx.params.id, b.patch, b.version));
      return { status: 200, body: { id: row.id, version: row.version } };
    },
  });
  router.add({
    method: 'DELETE',
    path: `${B}/items/:id`,
    auth: 'session',
    handler: async (ctx) => {
      const r = await P.deleteItem(d.pool, ctx.auth!.userId, ctx.params.id);
      if (!r) throw new ApiError('not_found');
      return { status: 204 };
    },
  });
  router.add({
    method: 'POST',
    path: `${B}/overrides`,
    auth: 'session',
    handler: async (ctx) => {
      await P.setOverride(d.pool, ctx.auth!.userId, parse(overrideInputSchema, await body(ctx)));
      return { status: 200, body: { ok: true } };
    },
  });
  router.add({
    method: 'POST',
    path: `${B}/reorder`,
    auth: 'session',
    handler: async (ctx) => {
      const x = parse(reorderSchema, await body(ctx));
      await withTx(d.pool, (c) => P.reorder(c, ctx.auth!.userId, x.date, x.keys));
      return { status: 200, body: { ok: true } };
    },
  });
  router.add({ method: 'GET', path: `${B}/home-layout`, auth: 'session', handler: async (ctx) => ({ status: 200, body: await P.getLayout(d.pool, ctx.auth!.userId) }) });
  router.add({
    method: 'PATCH',
    path: `${B}/home-layout`,
    auth: 'session',
    handler: async (ctx) => {
      const x = parse(homeLayoutSchema, await body(ctx));
      return { status: 200, body: await withTx(d.pool, (c) => P.saveLayout(c, ctx.auth!.userId, x.cards, x.version)) };
    },
  });

  router.add({
    method: 'GET',
    path: '/api/v1/insights/evolution',
    auth: 'session',
    handler: async (ctx) => {
      const k = ctx.url.searchParams.get('period') ?? 'week';
      if (!(EVOLUTION_PERIODS as readonly string[]).includes(k)) throw new ApiError('validation_failed', { period: 'Período inválido.' });
      const offset = Math.max(0, Math.min(24, Number(ctx.url.searchParams.get('offset')) || 0));
      return { status: 200, body: await evolution(d.pool, ctx.auth!.userId, now(), k as EvolutionPeriod, offset) };
    },
  });
}
