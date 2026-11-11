// Rotas do módulo Conhecimento (Fase 04): /api/v1/knowledge/*. Só com a sessão da conta; tudo filtrado por user_id.
// Escritas rodam em lifeTx (perfil bloqueado, mesmo fuso do RPG) e devolvem o resultado das recompensas (animações).
// Não existe rota que conceda XP diretamente: o XP nasce das sessões, metas e livros, validados aqui.
import { z } from 'zod';
import {
  KNOWLEDGE_LIMITS,
  SESSION_KINDS,
  bookInputSchema,
  bookPatchSchema,
  goalInputSchema,
  goalPatchSchema,
  goalRoutineSchema,
  isoDate,
  manualSessionSchema,
  noteInputSchema,
  sessionPatchSchema,
  subjectInputSchema,
  subjectPatchSchema,
  timerEventsSchema,
  timerFinishSchema,
  timerStartSchema,
  topicInputSchema,
  topicPatchSchema,
  NOTE_KINDS,
} from '../../../../shared/knowledge/protocol.ts';
import type { Pool } from '../db/pool.ts';
import { ApiError, readJson, type RequestCtx, type Router } from '../http/core.ts';
import { addDays } from '../assistant/tools/time.ts';
import { lifeTx, type LifeTx } from '../life/engine.ts';
import * as K from './service.ts';
import { finishHook } from '../bible/service.ts';

export interface KnowledgeDeps {
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

export function knowledgeRoutes(router: Router, d: KnowledgeDeps): void {
  const now = d.now ?? Date.now;
  const P = '/api/v1/knowledge';
  const body = (ctx: RequestCtx, max = 32 * 1024) => readJson(ctx, max);
  const tzHint = (ctx: RequestCtx) => ctx.url.searchParams.get('tz');
  const q = (ctx: RequestCtx, k: string) => ctx.url.searchParams.get(k);

  /** Transação da conta (perfil bloqueado) + resultado das recompensas. */
  async function mutate(ctx: RequestCtx, fn: (t: LifeTx) => Promise<Record<string, unknown> | void>, status = 200) {
    const r = await lifeTx(d.pool, ctx.auth!.userId, now(), async (t) => (await fn(t)) ?? {}, { tzHint: tzHint(ctx) });
    return { status, body: { ...(r.value as Record<string, unknown>), outcome: r.outcome } };
  }
  const read = <T>(ctx: RequestCtx, fn: (t: LifeTx) => Promise<T>) => lifeTx(d.pool, ctx.auth!.userId, now(), fn, { tzHint: tzHint(ctx) }).then((r) => r.value);

  // ---------------------------------------------------------------- painel e estatísticas
  router.add({ method: 'GET', path: `${P}/dashboard`, auth: 'session', handler: async (ctx) => ({ status: 200, body: await read(ctx, (t) => K.dashboard(t)) }) });
  router.add({ method: 'GET', path: `${P}/stats`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const to = q(ctx, 'to') ?? t.today;
      const from = q(ctx, 'from') ?? addDays(to, -27);
      parse(isoDate, from);
      parse(isoDate, to);
      if (from > to || addDays(from, KNOWLEDGE_LIMITS.rangeDays) < to) throw new ApiError('validation_failed', { from: `Período inválido (máximo ${KNOWLEDGE_LIMITS.rangeDays} dias).` });
      return K.statsView(t.c, t.userId, from, to, t.today, t.tz);
    });
    return { status: 200, body: { stats: v } };
  } });

  // ---------------------------------------------------------------- livros
  router.add({ method: 'GET', path: `${P}/books`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { books: await read(ctx, (t) => K.bookViews(t.c, t.userId, t.today)) } }) });
  router.add({ method: 'GET', path: `${P}/books/:id`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const book = await K.oneBookView(t.c, t.userId, ctx.params.id, t.today);
      if (!book) throw new ApiError('not_found');
      return { book, sessions: await K.sessionViews(t.c, t.userId, { bookId: book.id, limit: 100 }), notes: await K.noteViews(t.c, t.userId, { bookId: book.id }) };
    });
    return { status: 200, body: v };
  } });
  router.add({ method: 'POST', path: `${P}/books`, auth: 'session', handler: async (ctx) => {
    const b = parse(bookInputSchema, await body(ctx, 200 * 1024));
    return mutate(ctx, async (t) => ({ book: await K.oneBookView(t.c, t.userId, (await K.createBook(t, b, 'user')).id, t.today) }), 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/books/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(bookPatchSchema), await body(ctx, 200 * 1024));
    return mutate(ctx, async (t) => {
      await K.updateBook(t, ctx.params.id, b.patch, b.version);
      return { book: await K.oneBookView(t.c, t.userId, ctx.params.id, t.today) };
    });
  } });
  router.add({ method: 'DELETE', path: `${P}/books/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => ({ id: (await K.deleteBook(t, ctx.params.id)).id })) });

  // ---------------------------------------------------------------- matérias e tópicos
  router.add({ method: 'GET', path: `${P}/subjects`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { subjects: await read(ctx, (t) => K.subjectViews(t.c, t.userId, t.today, { archived: q(ctx, 'archived') === '1' })) } }) });
  router.add({ method: 'GET', path: `${P}/subjects/:id`, auth: 'session', handler: async (ctx) => {
    const v = await read(ctx, async (t) => {
      const subject = (await K.subjectViews(t.c, t.userId, t.today, { ids: [ctx.params.id], withTopics: true }))[0];
      if (!subject) throw new ApiError('not_found');
      return { subject, sessions: await K.sessionViews(t.c, t.userId, { subjectId: subject.id, limit: 100 }), notes: await K.noteViews(t.c, t.userId, { subjectId: subject.id }) };
    });
    return { status: 200, body: v };
  } });
  router.add({ method: 'POST', path: `${P}/subjects`, auth: 'session', handler: async (ctx) => {
    const b = parse(subjectInputSchema.extend({ topics: z.array(topicInputSchema).max(50).optional() }), await body(ctx));
    return mutate(ctx, async (t) => {
      const { topics, ...s } = b;
      const row = await K.createSubject(t.c, t.userId, s, 'user');
      if (topics?.length) await K.createTopics(t.c, t.userId, row.id, topics, 'user');
      return { id: row.id };
    }, 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/subjects/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(subjectPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await K.updateSubject(t.c, t.userId, ctx.params.id, b.patch, b.version)).after.id }));
  } });
  router.add({ method: 'DELETE', path: `${P}/subjects/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => {
    await K.deleteSubject(t, ctx.params.id);
    return { ok: true };
  }) });
  router.add({ method: 'POST', path: `${P}/subjects/:id/topics`, auth: 'session', handler: async (ctx) => {
    const b = parse(z.object({ topics: z.array(topicInputSchema).min(1).max(50) }).strict(), await body(ctx));
    return mutate(ctx, async (t) => ({ ids: (await K.createTopics(t.c, t.userId, ctx.params.id, b.topics, 'user')).map((x) => x.id) }), 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/topics/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(topicPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => ({ topic: K.topicView(await K.updateTopic(t.c, t.userId, ctx.params.id, b.patch, b.version)) }));
  } });
  router.add({ method: 'DELETE', path: `${P}/topics/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => {
    await K.deleteTopic(t.c, t.userId, ctx.params.id);
    return { ok: true };
  }) });

  // ---------------------------------------------------------------- anotações
  router.add({ method: 'GET', path: `${P}/notes`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { notes: await K.noteViews(d.pool as never, ctx.auth!.userId, { bookId: q(ctx, 'bookId'), subjectId: q(ctx, 'subjectId'), topicId: q(ctx, 'topicId') }) } }) });
  router.add({ method: 'POST', path: `${P}/notes`, auth: 'session', handler: async (ctx) => {
    const n = parse(noteInputSchema, await body(ctx));
    return { status: 201, body: { note: await K.createNote(d.pool as never, ctx.auth!.userId, n) } };
  } });
  router.add({ method: 'PATCH', path: `${P}/notes/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(z.object({ content: z.string().trim().min(1).max(4000).optional(), kind: z.enum(NOTE_KINDS).optional(), page: z.number().int().min(0).max(20000).nullable().optional() }).strict(), await body(ctx));
    return { status: 200, body: { note: await K.updateNote(d.pool as never, ctx.auth!.userId, ctx.params.id, b) } };
  } });
  router.add({ method: 'DELETE', path: `${P}/notes/:id`, auth: 'session', handler: async (ctx) => {
    await K.deleteNote(d.pool as never, ctx.auth!.userId, ctx.params.id);
    return { status: 200, body: { ok: true } };
  } });

  // ---------------------------------------------------------------- sessões
  router.add({ method: 'GET', path: `${P}/sessions`, auth: 'session', handler: async (ctx) => {
    const kind = q(ctx, 'kind');
    const v = await read(ctx, async (t) => {
      const to = q(ctx, 'to') ?? t.today;
      const from = q(ctx, 'from') ?? addDays(to, -29);
      parse(isoDate, from);
      parse(isoDate, to);
      return K.sessionViews(t.c, t.userId, { from, to, ...(kind && (SESSION_KINDS as readonly string[]).includes(kind) ? { kind: kind as never } : {}), limit: Number(q(ctx, 'limit') ?? 200) || 200 });
    });
    return { status: 200, body: { sessions: v } };
  } });
  router.add({ method: 'POST', path: `${P}/sessions`, auth: 'session', handler: async (ctx) => {
    const m = parse(manualSessionSchema, await body(ctx));
    return mutate(ctx, async (t) => {
      const r = await K.createManualSession(t, m, 'manual');
      return { ...r, session: (await K.sessionViews(t.c, t.userId, { ids: [r.id] }))[0] ?? null };
    }, 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/sessions/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(sessionPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await K.updateSession(t, ctx.params.id, b.patch, b.version)).id }));
  } });
  router.add({ method: 'DELETE', path: `${P}/sessions/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => ({ id: (await K.deleteSession(t, ctx.params.id)).id })) });

  // ---------------------------------------------------------------- cronômetro (um por conta, igual em todos os aparelhos)
  router.add({ method: 'GET', path: `${P}/timer`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { timer: await K.currentTimer(d.pool as never, ctx.auth!.userId, now()), serverNow: now() } }) });
  router.add({ method: 'POST', path: `${P}/timer`, auth: 'session', handler: async (ctx) => {
    const s = parse(timerStartSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ timer: await K.startTimer(t, s), serverNow: t.now }), 201);
  } });
  router.add({ method: 'POST', path: `${P}/timer/:id/events`, auth: 'session', handler: async (ctx) => {
    const b = parse(timerEventsSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ timer: await K.timerEvents(t, ctx.params.id, b.events, b.version), serverNow: t.now }));
  } });
  router.add({ method: 'POST', path: `${P}/timer/:id/finish`, auth: 'session', handler: async (ctx) => {
    const f = parse(timerFinishSchema, await body(ctx));
    return mutate(ctx, async (t) => {
      // Fase 05: um cronômetro bíblico encerrado por aqui vira sessão bíblica (sem capítulos dados como lidos).
      const r = await K.finishTimer(t, ctx.params.id, f, finishHook(t, null));
      return { ...r, session: (await K.sessionViews(t.c, t.userId, { ids: [r.id] }))[0] ?? null };
    });
  } });
  router.add({ method: 'DELETE', path: `${P}/timer/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => {
    await K.discardTimer(t, ctx.params.id);
    return { ok: true };
  }) });

  // ---------------------------------------------------------------- metas
  router.add({ method: 'GET', path: `${P}/goals`, auth: 'session', handler: async (ctx) => ({ status: 200, body: { goals: await read(ctx, (t) => K.goalViews(t.c, t.userId, t.today, { includeArchived: q(ctx, 'archived') === '1' })) } }) });
  router.add({ method: 'POST', path: `${P}/goals`, auth: 'session', handler: async (ctx) => {
    const g = parse(goalInputSchema, await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await K.createGoal(t, g, 'user')).id }), 201);
  } });
  router.add({ method: 'PATCH', path: `${P}/goals/:id`, auth: 'session', handler: async (ctx) => {
    const b = parse(versioned(goalPatchSchema), await body(ctx));
    return mutate(ctx, async (t) => ({ id: (await K.updateGoal(t, ctx.params.id, b.patch, b.version)).after.id }));
  } });
  router.add({ method: 'DELETE', path: `${P}/goals/:id`, auth: 'session', handler: (ctx) => mutate(ctx, async (t) => ({ id: (await K.deleteGoal(t, ctx.params.id)).id })) });
  router.add({ method: 'POST', path: `${P}/goals/:id/routine`, auth: 'session', handler: async (ctx) => {
    const b = parse(goalRoutineSchema, await body(ctx));
    return mutate(ctx, async (t) => await K.addGoalToRoutine(t, ctx.params.id, b));
  } });
}
