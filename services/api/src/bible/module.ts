// Rotas do módulo Bíblia (Fase 05): /api/v1/bible/*. Só com a sessão da conta; tudo filtrado por user_id.
// Escritas que podem mexer em XP/metas rodam em lifeTx (perfil bloqueado, mesmo fuso do RPG) e devolvem o resultado das
// recompensas. O texto bíblico é lido pelo app nos arquivos empacotados; aqui só a busca e as passagens (IA/versículo).
import { z } from 'zod';
import { parseKey, parseQuery, TRANSLATION, isBookId } from '../../../../shared/bible/canon.ts';
import { TEMPLATES, templateSchedule } from '../../../../shared/bible/plans.ts';
import {
  MARK_KINDS,
  REFLECTION_KINDS,
  bibleGoalInputSchema,
  bibleManualSchema,
  bibleTimerFinishSchema,
  bibleTimerStartSchema,
  markInputSchema,
  markPatchSchema,
  planCreateSchema,
  planPatchSchema,
  positionSchema,
  prefsPatchSchema,
  readInputSchema,
  reflectionInputSchema,
  reflectionPatchSchema,
  BIBLE_LIMITS,
} from '../../../../shared/bible/protocol.ts';
import { goalPatchSchema } from '../../../../shared/knowledge/protocol.ts';
import type { Pool } from '../db/pool.ts';
import { ApiError, readJson, type RequestCtx, type Router } from '../http/core.ts';
import { addDays } from '../assistant/tools/time.ts';
import { lifeTx, type LifeTx } from '../life/engine.ts';
import * as K from '../knowledge/service.ts';
import * as B from './service.ts';
import { passageByKey, search } from './text.ts';

export interface BibleDeps {
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
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function bibleRoutes(router: Router, d: BibleDeps): void {
  const now = d.now ?? Date.now;
  const P = '/api/v1/bible';
  const body = (ctx: RequestCtx, max = 32 * 1024) => readJson(ctx, max);
  const q = (ctx: RequestCtx, k: string) => ctx.url.searchParams.get(k);
  const tzHint = (ctx: RequestCtx) => q(ctx, 'tz');
  async function mutate(ctx: RequestCtx, fn: (t: LifeTx) => Promise<Record<string, unknown> | void>, status = 200) {
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), async (t) => (await fn(t)) ?? {}, { tzHint: tzHint(ctx) });
    return { status, body: { ...(r.value as Record<string, unknown>), outcome: r.outcome } };
  }
  const read = <T>(ctx: RequestCtx, fn: (t: LifeTx) => Promise<T>) => lifeTx(d.pool, ctx.auth!.userId, now(), fn, { tzHint: tzHint(ctx) }).then((r) => r.value);
  const ok = (b: unknown, status = 200) => ({ status, body: b });

  // ---------------------------------------------------------------- painel, tradução, texto
  router.add({ method: 'GET', path: `${P}/home`, auth: 'session', handler: async (ctx) => ok(await read(ctx, (t) => B.home(t))) });
  router.add({ method: 'GET', path: `${P}/translation`, auth: 'session', handler: async () => ok({ translation: TRANSLATION, templates: Object.values(TEMPLATES).map((x) => ({ ...x, days: x.days || templateSchedule(x.id).length })) }) });
  router.add({ method: 'GET', path: `${P}/passage`, auth: 'session', handler: async (ctx) => {
    const ref = q(ctx, 'ref') ?? '';
    if (!parseKey(ref)) throw new ApiError('bible_ref_invalid');
    return ok({ passage: passageByKey(ref, BIBLE_LIMITS.passageVerses) });
  } });
  router.add({ method: 'GET', path: `${P}/search`, auth: 'session', handler: async (ctx) => {
    const text = (q(ctx, 'q') ?? '').trim().slice(0, 120);
    const parsed = parseQuery(text);
    if (parsed.kind === 'ref') return ok({ kind: 'ref', ref: parsed.ref });
    if (parsed.kind === 'invalid') return ok({ kind: 'invalid', message: parsed.message });
    const book = q(ctx, 'book');
    const testament = q(ctx, 'testament');
    const r = search(text, { limit: Math.min(BIBLE_LIMITS.searchResults, Number(q(ctx, 'limit') ?? 30) || 30), book: book && isBookId(book) ? book : null, testament: testament === 'OT' || testament === 'NT' ? testament : null });
    return ok({ kind: 'text', ...r, book: parsed.kind === 'book' ? parsed.book.id : null });
  } });

  // ---------------------------------------------------------------- preferências e posição
  router.add({ method: 'GET', path: `${P}/prefs`, auth: 'session', handler: async (ctx) => ok({ prefs: B.prefsView(await B.prefsRow(d.pool as never, ctx.auth!.userId)) }) });
  router.add({ method: 'PATCH', path: `${P}/prefs`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(prefsPatchSchema), await body(ctx));
    return ok({ prefs: await B.updatePrefs(d.pool as never, ctx.auth!.userId, b.patch, b.version) });
  } });
  router.add({ method: 'POST', path: `${P}/position`, auth: 'session', handler: async (ctx) => {
    const b = parse(positionSchema, await body(ctx));
    await B.setPosition(d.pool as never, ctx.auth!.userId, b.ref);
    return ok({ ok: true });
  } });

  // ---------------------------------------------------------------- versículo do dia
  router.add({ method: 'GET', path: `${P}/verse`, auth: 'session', handler: async (ctx) => ok({ verse: await read(ctx, (t) => B.dailyVerse(t.c, t.userId, t.today)) }) });
  router.add({ method: 'POST', path: `${P}/verse/another`, auth: 'session', handler: async (ctx) => ok({ verse: await read(ctx, (t) => B.anotherVerse(t.c, t.userId, t.today)) }) });
  router.add({ method: 'GET', path: `${P}/verse/history`, auth: 'session', handler: async (ctx) => ok({ verses: await B.verseHistory(d.pool as never, ctx.auth!.userId, Number(q(ctx, 'limit') ?? 60) || 60) }) });

  // ---------------------------------------------------------------- favoritos e destaques
  router.add({ method: 'GET', path: `${P}/marks`, auth: 'session', handler: async (ctx) => {
    const kind = q(ctx, 'kind');
    const book = q(ctx, 'book');
    return ok({
      marks: await B.markViews(d.pool as never, ctx.auth!.userId, {
        kind: kind && (MARK_KINDS as readonly string[]).includes(kind) ? (kind as never) : null,
        book: book && isBookId(book) ? book : null,
        chapter: Number(q(ctx, 'chapter')) || null,
        tag: q(ctx, 'tag'),
        withText: q(ctx, 'text') === '1',
      }),
    });
  } });
  router.add({ method: 'POST', path: `${P}/marks`, auth: 'session', handler: async (ctx) => {
    const m = parse(markInputSchema, await body(ctx));
    const r = await B.upsertMark(d.pool as never, ctx.auth!.userId, m);
    return ok(r, r.created ? 201 : 200);
  } });
  router.add({ method: 'PATCH', path: `${P}/marks/:id`, auth: 'session', handler: async (ctx) => ok({ mark: await B.patchMark(d.pool as never, ctx.auth!.userId, ctx.params.id, parse(markPatchSchema, await body(ctx))) }) });
  router.add({ method: 'DELETE', path: `${P}/marks/:id`, auth: 'session', handler: async (ctx) => {
    await B.deleteMark(d.pool as never, ctx.auth!.userId, ctx.params.id);
    return ok({ ok: true });
  } });

  // ---------------------------------------------------------------- reflexões (privadas)
  router.add({ method: 'GET', path: `${P}/reflections`, auth: 'session', handler: async (ctx) => {
    const kind = q(ctx, 'kind');
    const book = q(ctx, 'book');
    return ok({
      reflections: await B.reflectionViews(d.pool as never, ctx.auth!.userId, {
        q: q(ctx, 'q')?.slice(0, 100) || null,
        kind: kind && (REFLECTION_KINDS as readonly string[]).includes(kind) ? (kind as never) : null,
        tag: q(ctx, 'tag'),
        favorite: q(ctx, 'favorite') === '1',
        book: book && isBookId(book) ? book : null,
        chapter: Number(q(ctx, 'chapter')) || null,
      }),
    });
  } });
  router.add({ method: 'POST', path: `${P}/reflections`, auth: 'session', handler: async (ctx) => {
    const x = parse(reflectionInputSchema, await body(ctx, 64 * 1024));
    const r = await read(ctx, (t) => B.createReflection(t.c, t.userId, t.today, x));
    return ok(r, r.existed ? 200 : 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/reflections/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(reflectionPatchSchema), await body(ctx, 64 * 1024));
    return ok({ reflection: await read(ctx, (t) => B.updateReflection(t.c, t.userId, t.today, ctx.params.id, b.patch, b.version)) });
  } });
  router.add({ method: 'DELETE', path: `${P}/reflections/:id`, auth: 'session', handler: async (ctx) => {
    await B.deleteReflection(d.pool as never, ctx.auth!.userId, ctx.params.id);
    return ok({ ok: true });
  } });

  // ---------------------------------------------------------------- leitura registrada e progresso
  router.add({ method: 'GET', path: `${P}/progress`, auth: 'session', handler: async (ctx) => ok({ progress: await B.progressView(d.pool as never, ctx.auth!.userId) }) });
  router.add({ method: 'POST', path: `${P}/read`, auth: 'session', handler: async (ctx) => {
    const b = parse(readInputSchema, await body(ctx));
    return mutate(ctx, async (t) => {
      if (b.planId && !(await B.getPlan(t.c, t.userId, b.planId))) throw new ApiError('validation_failed', { planId: 'Plano não encontrado.' });
      const added = await B.logChapters(t, b.chapters.map((k) => parseKey(k)!) as never, b.date ?? t.today, 'reader', { planId: b.planId ?? null });
      return { added };
    });
  } });
  router.add({ method: 'DELETE', path: `${P}/read/:chapter`, auth: 'session', handler: async (ctx) => {
    const r = parseKey(ctx.params.chapter);
    if (!r || r.v1) throw new ApiError('bible_ref_invalid');
    const date = q(ctx, 'date');
    return mutate(ctx, async (t) => ({ removed: await B.unlogChapter(t, r, date && isoDate.safeParse(date).success ? date : t.today) }));
  } });
  router.add({ method: 'GET', path: `${P}/stats`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const to = q(ctx, 'to') ?? t.today;
      const from = q(ctx, 'from') ?? addDays(to, -27);
      parse(isoDate, from);
      parse(isoDate, to);
      if (from > to || addDays(from, 400) < to) throw new ApiError('validation_failed', { from: 'Período inválido.' });
      return { from, to, days: await B.readingDays(t.c, t.userId, from, to) };
    });
    return ok({ stats: v });
  } });

  // ---------------------------------------------------------------- sessões (cronômetro e registro manual, Fase 04)
  router.add({ method: 'GET', path: `${P}/sessions`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const to = q(ctx, 'to') ?? t.today;
      const from = q(ctx, 'from') ?? addDays(to, -29);
      parse(isoDate, from);
      parse(isoDate, to);
      return K.sessionViews(t.c, t.userId, { from, to, module: 'bible', limit: 200 });
    });
    return ok({ sessions: v });
  } });
  router.add({ method: 'POST', path: `${P}/sessions`, auth: 'session', handler: async (ctx) => {
    const m = parse(bibleManualSchema, await body(ctx));
    return mutate(ctx, async (t) => {
      const r = await B.createManualSession(t, m);
      return { ...r, session: (await K.sessionViews(t.c, t.userId, { ids: [r.id] }))[0] ?? null };
    }, 201);
  } });
  router.add({ method: 'DELETE', path: `${P}/sessions/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => {
    const s = await K.getSession(t.c, t.userId, ctx.params.id);
    if (!s || s.module !== 'bible') throw new ApiError('not_found');
    return { id: (await K.deleteSession(t, s.id)).id };
  }) });
  router.add({ method: 'POST', path: `${P}/timer`, auth: 'session', handler: async (ctx) => {
    const s = parse(bibleTimerStartSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ timer: await B.startTimer(t, s), serverNow: t.now }), 201);
  } });
  router.add({ method: 'POST', path: `${P}/timer/:id/finish`, auth: 'session', handler: async (ctx) => {
    const f = parse(bibleTimerFinishSchema, await body(ctx));
    return mutate(ctx, async (t) => {
      const r = await B.finishTimer(t, ctx.params.id, f);
      return { ...r, session: (await K.sessionViews(t.c, t.userId, { ids: [r.id] }))[0] ?? null };
    });
  } });

  // ---------------------------------------------------------------- planos
  router.add({ method: 'GET', path: `${P}/plans`, auth: 'session', handler: async (ctx) => ok({ plans: await read(ctx, (t) => B.planViews(t.c, t.userId, t.today, q(ctx, 'all') === '1' ? {} : { status: ['active', 'paused', 'completed'] })) }) });
  router.add({ method: 'GET', path: `${P}/plans/:id`, auth: 'session', handler: async (ctx) => {
    const plan = (await read(ctx, (t) => B.planViews(t.c, t.userId, t.today, { ids: [ctx.params.id], withDays: true })))[0];
    if (!plan) throw new ApiError('not_found');
    return ok({ plan });
  } });
  router.add({ method: 'POST', path: `${P}/plans`, auth: 'session', handler: async (ctx) => {
    const x = parse(planCreateSchema, await body(ctx));
    return mutate(ctx, async (t) => {
      const p = await B.createPlan(t, x);
      return { plan: (await B.planViews(t.c, t.userId, t.today, { ids: [p.id], withDays: true }))[0] };
    }, 201);
  } });
  router.add({ method: 'POST', path: `${P}/plans/preview`, auth: 'session', handler: async (ctx) => {
    const x = parse(planCreateSchema, await body(ctx));
    const b = B.buildSchedule(x);
    return ok({ title: b.title, description: b.description, days: b.schedule.length, chapters: b.schedule.reduce((n, d) => n + d.length, 0), first: b.schedule.slice(0, 3) });
  } });
  router.add({ method: 'PATCH', path: `${P}/plans/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(planPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => {
      await B.updatePlan(t, ctx.params.id, b.patch, b.version);
      return { plan: (await B.planViews(t.c, t.userId, t.today, { ids: [ctx.params.id], withDays: true }))[0] };
    });
  } });
  router.add({ method: 'DELETE', path: `${P}/plans/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => ({ id: (await B.deletePlan(t, ctx.params.id)).id })) });
  router.add({ method: 'POST', path: `${P}/plans/:id/days/:day`, auth: 'session', handler: async (ctx) => {
    const b = parse(z.object({ date: isoDate.nullish() }).strict(), await body(ctx));
    return mutate(ctx, async (t) => {
      const r = await B.completeDay(t, ctx.params.id, Number(ctx.params.day), b.date ?? t.today);
      return { added: r.added, already: r.already, plan: (await B.planViews(t.c, t.userId, t.today, { ids: [ctx.params.id], withDays: true }))[0] };
    });
  } });
  router.add({ method: 'DELETE', path: `${P}/plans/:id/days/:day`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => {
    await B.uncompleteDay(t, ctx.params.id, Number(ctx.params.day));
    return { plan: (await B.planViews(t.c, t.userId, t.today, { ids: [ctx.params.id], withDays: true }))[0] };
  }) });

  // ---------------------------------------------------------------- metas (knowledge_goals, module = 'bible')
  const ownGoal = async (t: LifeTx, id: string) => {
    const g = await K.getGoal(t.c, t.userId, id);
    if (!g || g.module !== 'bible') throw new ApiError('not_found');
    return g;
  };
  router.add({ method: 'GET', path: `${P}/goals`, auth: 'session', handler: async (ctx) => ok({ goals: await read(ctx, (t) => K.goalViews(t.c, t.userId, t.today, { module: 'bible', includeArchived: q(ctx, 'archived') === '1' })) }) });
  router.add({ method: 'POST', path: `${P}/goals`, auth: 'session', handler: async (ctx) => {
    const g = parse(bibleGoalInputSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await B.createGoal(t, g)).id }), 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/goals/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(goalPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => {
      await ownGoal(t, ctx.params.id);
      return { id: (await K.updateGoal(t, ctx.params.id, b.patch, b.version)).after.id };
    });
  } });
  router.add({ method: 'DELETE', path: `${P}/goals/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => {
    await ownGoal(t, ctx.params.id);
    return { id: (await K.deleteGoal(t, ctx.params.id)).id };
  }) });
}
