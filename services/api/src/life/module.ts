// Rotas do RPG de desenvolvimento pessoal: /api/v1/life/*. Só com a sessão da conta; tudo filtrado por user_id.
// Mutação = uma transação (lifeTx) que devolve o "resultado" (XP ganho/estornado, nível, missões, conquistas) para as
// animações do app. Não existe rota que conceda XP diretamente: só registrar atividades válidas.
import { z } from 'zod';
import {
  habitInputSchema,
  habitLogSchema,
  habitPatchSchema,
  isoDateSchema,
  missionEntrySchema,
  missionInputSchema,
  missionPatchSchema,
  profilePatchSchema,
  routineCheckSchema,
  routineInputSchema,
  routinePatchSchema,
  type RewardOutcome,
} from '../../../../shared/life/protocol.ts';
import type { Pool } from '../db/pool.ts';
import { ApiError, readJson, type RequestCtx, type Router } from '../http/core.ts';
import { ensureMissions, lifeTx, reconcileWorkouts, type LifeTx } from './engine.ts';
import * as L from './service.ts';

export interface LifeDeps {
  pool: Pool;
  now?: () => number;
}

const versioned = <S extends z.ZodTypeAny>(s: S) => z.object({ version: z.number().int().positive().optional(), patch: s }).strict();

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const i of r.error.issues) fields[i.path.join('.') || 'body'] ??= i.message;
  throw new ApiError('validation_failed', fields);
}

export function localHHMM(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

export async function displayName(pool: Pool | LifeTx['c'], userId: string): Promise<string> {
  const r = await pool.query<{ name: string; user_name: string | null }>(
    "SELECT u.name, s.doc->>'userName' AS user_name FROM users u LEFT JOIN user_settings s ON s.user_id = u.id AND s.id = 'settings' AND NOT s.deleted WHERE u.id = $1",
    [userId],
  );
  const row = r.rows[0];
  return (row?.user_name && row.user_name.trim()) || row?.name || '';
}

export function lifeRoutes(router: Router, d: LifeDeps): void {
  const now = d.now ?? Date.now;
  const P = '/api/v1/life';
  const body = async (ctx: RequestCtx, max = 16 * 1024) => readJson(ctx, max);
  const tzHint = (ctx: RequestCtx) => ctx.url.searchParams.get('tz');

  /** Mutação padrão: transação da conta + resultado das recompensas + perfil atualizado. */
  async function mutate(ctx: RequestCtx, fn: (t: LifeTx) => Promise<unknown>, status = 200) {
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), fn, { view: (t) => L.profileView(t.c, t.profile, t.today) });
    return { status, body: { ...(r.value && typeof r.value === 'object' ? (r.value as object) : {}), outcome: r.outcome satisfies RewardOutcome, profile: r.view } };
  }

  router.add({
    method: 'GET',
    path: `${P}/dashboard`,
    auth: 'session',
    handler: async (ctx) => {
      const u = ctx.auth!.userId;
      const name = await displayName(d.pool, u);
      const r = await lifeTx(
        d.pool,
        u,
        now(),
        async (t) => {
          await reconcileWorkouts(t);
          await ensureMissions(t);
        },
        { tzHint: tzHint(ctx), view: (t) => L.dashboard(t, name, localHHMM(t.now, t.tz)) },
      );
      return { status: 200, body: { ...r.view, outcome: r.outcome } };
    },
  });
  router.add({ method: 'POST', path: `${P}/reconcile`, auth: 'session', handler: (ctx) => mutate(ctx, (t) => reconcileWorkouts(t)) });
  router.add({ method: 'GET', path: `${P}/profile`, auth: 'session', handler: async (ctx) => {
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), async (t) => L.profileView(t.c, t.profile, t.today), { tzHint: tzHint(ctx) });
    return { status: 200, body: { profile: r.value } };
  } });
  router.add({ method: 'PATCH', path: `${P}/profile`, auth: 'session', handler: async (ctx) => {
    const p = parse(profilePatchSchema, await body(ctx));
    return mutate(ctx, (t) => L.patchProfile(t, p));
  } });

  // Hábitos
  router.add({ method: 'GET', path: `${P}/habits`, auth: 'session', handler: async (ctx) => {
    const all = ctx.url.searchParams.get('archived') === '1';
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), (t) => L.habitViews(t.c, t.userId, t.today, { includeArchived: all }));
    return { status: 200, body: { habits: r.value } };
  } });
  router.add({ method: 'POST', path: `${P}/habits`, auth: 'session', handler: async (ctx) => {
    const h = parse(habitInputSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await L.createHabit(t, h, 'user')).id }), 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/habits/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(habitPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await L.updateHabit(t, ctx.params.id, b.patch, b.version)).after.id }));
  } });
  router.add({ method: 'POST', path: `${P}/habits/:id/log`, auth: 'session', handler: async (ctx) => {
    const b = parse(habitLogSchema, await body(ctx));
    return mutate(ctx, (t) => L.logHabit(t, ctx.params.id, b.amount, b.date));
  } });
  router.add({ method: 'GET', path: `${P}/habits/:id/history`, auth: 'session', handler: async (ctx) => {
    const u = ctx.auth!.userId;
    if (!(await L.getHabit(d.pool as never, u, ctx.params.id))) throw new ApiError('not_found');
    const r = await d.pool.query<{ date: string; amount: number; completed: boolean }>('SELECT date, amount, completed FROM life_habit_logs WHERE user_id = $1 AND habit_id = $2 ORDER BY date DESC LIMIT 120', [u, ctx.params.id]);
    return { status: 200, body: { logs: r.rows } };
  } });

  // Rotinas
  router.add({ method: 'GET', path: `${P}/routines`, auth: 'session', handler: async (ctx) => {
    const all = ctx.url.searchParams.get('archived') === '1';
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), (t) => L.routineViews(t.c, t.userId, t.today, { includeArchived: all }));
    return { status: 200, body: { routines: r.value } };
  } });
  router.add({ method: 'POST', path: `${P}/routines`, auth: 'session', handler: async (ctx) => {
    const r = parse(routineInputSchema, await body(ctx, 32 * 1024));
    return mutate(ctx, async (t) => ({ id: (await L.createRoutine(t, r, 'user')).id }), 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/routines/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(routinePatchSchema), await body(ctx, 32 * 1024));
    return mutate(ctx, async (t) => ({ id: (await L.updateRoutine(t, ctx.params.id, b.patch, b.version)).after.id }));
  } });
  router.add({ method: 'POST', path: `${P}/routines/:id/items/:itemId/check`, auth: 'session', handler: async (ctx) => {
    const b = parse(routineCheckSchema, await body(ctx));
    return mutate(ctx, (t) => L.checkRoutineItem(t, ctx.params.id, ctx.params.itemId, b.done, b.date));
  } });

  // Missões
  router.add({ method: 'GET', path: `${P}/missions`, auth: 'session', handler: async (ctx) => {
    const scope = ctx.url.searchParams.get('scope') === 'history' ? 'history' : 'current';
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), async (t) => {
      if (scope === 'current') await ensureMissions(t);
    }, { view: (t) => L.missionViews(t.c, t.userId, scope, t.today) });
    return { status: 200, body: { missions: r.view } };
  } });
  router.add({ method: 'POST', path: `${P}/missions`, auth: 'session', handler: async (ctx) => {
    const m = parse(missionInputSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await L.createMission(t, m, 'user')).id }), 201);
  } });
  router.add({ method: 'GET', path: `${P}/missions/:id`, auth: 'session', handler: async (ctx) => {
    const u = ctx.auth!.userId;
    const m = await L.getMission(d.pool as never, u, ctx.params.id);
    if (!m) throw new ApiError('not_found');
    return { status: 200, body: { mission: L.missionView(m), entries: await L.missionEntries(d.pool as never, u, m.id) } };
  } });
  router.add({ method: 'PATCH', path: `${P}/missions/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(missionPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await L.updateMission(t, ctx.params.id, b.patch, b.version)).after.id }));
  } });
  router.add({ method: 'POST', path: `${P}/missions/:id/entries`, auth: 'session', handler: async (ctx) => {
    const b = parse(missionEntrySchema, await body(ctx));
    return mutate(ctx, (t) => L.addMissionEntry(t, ctx.params.id, b.amount, b.date, b.note));
  } });
  router.add({ method: 'DELETE', path: `${P}/missions/:id/entries/:entryId`, auth: 'session', handler: (ctx) => mutate(ctx, (t) => L.deleteMissionEntry(t, ctx.params.id, ctx.params.entryId)) });

  // Dias de descanso, histórico de XP, conquistas
  router.add({ method: 'POST', path: `${P}/days/:date/rest`, auth: 'session', handler: async (ctx) => {
    const date = parse(isoDateSchema, ctx.params.date);
    const b = parse(z.object({ rest: z.boolean() }).strict(), await body(ctx));
    return mutate(ctx, (t) => L.setRestDay(t, date, b.rest));
  } });
  router.add({ method: 'GET', path: `${P}/xp`, auth: 'session', handler: async (ctx) => {
    const lim = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 100) || 100));
    return { status: 200, body: { events: await L.xpHistory(d.pool as never, ctx.auth!.userId, lim) } };
  } });
  router.add({ method: 'GET', path: `${P}/achievements`, auth: 'session', handler: async (ctx) => {
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), (t) => L.achievementViews(t.c, t.userId, t.today));
    return { status: 200, body: { achievements: r.value } };
  } });
}
