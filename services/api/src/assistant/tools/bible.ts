// Módulo Bíblia para a IA central (Fase 05, docs/BIBLIA.md §9). Leitura: passagens por referência (texto REAL da
// tradução, com referência e tradução), busca por palavras, passagens por tema (seleção verificada), versículo do dia,
// progresso, planos, metas, favoritos, estatísticas e — só quando a pessoa pedir — reflexões. Escrita (proposta →
// aprovação → desfazer): plano de leitura, ajuste de plano, meta, favorito e reflexão aprovada.
//
// Limites: a IA nunca escreve versículos de memória (o texto vem das ferramentas), não concede XP e não recebe o diário
// inteiro (no máximo 10 reflexões por consulta, e só com pedido explícito; a pessoa pode desligar em Ajustes).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PreviewLine } from '../../../../../shared/assistant/protocol.ts';
import { TRANSLATION, formatKey, parseKey, parseQuery, passageKey, isBookId } from '../../../../../shared/bible/canon.ts';
import { PLAN_TEMPLATES, TEMPLATES } from '../../../../../shared/bible/plans.ts';
import { BIBLE_GOAL_METRICS, BIBLE_GOAL_UNIT, REFLECTION_KINDS, REFLECTION_KIND_LABEL, bibleGoalInputSchema, planCreateSchema, type PlanCreate } from '../../../../../shared/bible/protocol.ts';
import { CURATED, VERSE_THEMES } from '../../../../../shared/bible/verses.ts';
import type { PoolClient } from '../../db/pool.ts';
import { isApiError } from '../../http/core.ts';
import { runLife, type LifeTx } from '../../life/engine.ts';
import * as B from '../../bible/service.ts';
import * as K from '../../knowledge/service.ts';
import { BibleTextError, passage, passageByKey, search } from '../../bible/text.ts';
import { addDays, localDate } from './time.ts';
import { StaleError } from './training.ts';
import { ToolError, type ActionHandler, type AiModuleDef, type ReadTool, type ToolContext, type WriteTool } from './types.ts';

type Q = Pick<PoolClient, 'query'>;
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const q = (ctx: ToolContext) => ctx.pool as unknown as Q;
const RATIONALE = { type: ['string', 'null'], description: 'Por que esta sugestão (curto).' };
const RANGE_PROPS = { from: { type: ['string', 'null'], description: 'yyyy-mm-dd' }, to: { type: ['string', 'null'], description: 'yyyy-mm-dd' } };
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const daysText = (d: number[]) => (d.length === 7 ? 'todos os dias' : d.map((x) => WEEKDAYS[x]).join(', '));
const dateBr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const TEXT_NOTE = `Texto da ${TRANSLATION.name} (${TRANSLATION.short}, domínio público). Cite sempre a referência e a tradução; não altere nem complete o texto.`;

async function tzToday(ctx: ToolContext): Promise<{ tz: string; today: string }> {
  const tz = (await q(ctx).query<{ timezone: string }>('SELECT timezone FROM life_profiles WHERE user_id = $1', [ctx.userId])).rows[0]?.timezone ?? ctx.timezone;
  return { tz, today: localDate(ctx.now, tz) };
}

async function inLife<T>(c: PoolClient, ctx: ToolContext, fn: (t: LifeTx) => Promise<T>): Promise<T> {
  try {
    return (await runLife(c, ctx.userId, ctx.now, fn)).value;
  } catch (e) {
    if (isApiError(e) && e.code === 'life_stale') throw new StaleError();
    if (isApiError(e)) throw new ToolError(e.code, e.fields ? `${e.message} ${Object.values(e.fields)[0]}` : e.message);
    throw e;
  }
}

function range(a: { from?: string | null; to?: string | null }, today: string, defDays: number, max = 120): { from: string; to: string } {
  const to = a.to ?? today;
  const from = a.from ?? addDays(to, -(defDays - 1));
  if (from > to) throw new ToolError('invalid_range', 'A data inicial é depois da final.');
  if (addDays(from, max) < to) throw new ToolError('invalid_range', `Período máximo de ${max} dias.`);
  return { from, to };
}

/** Aceita "Filipenses 4:13", "Fp 4.13", "Salmo 23" ou a chave "PHP.4.13". */
function refFrom(input: string): string {
  const key = parseKey(input.trim().toUpperCase().replace(/\s/g, ''));
  if (key) return passageKey(key);
  const p = parseQuery(input);
  if (p.kind === 'ref') return passageKey(p.ref);
  if (p.kind === 'invalid') throw new ToolError('invalid_ref', `${p.message} Não invente o texto: diga que a referência não existe nesta tradução.`);
  throw new ToolError('invalid_ref', 'Referência não reconhecida. Use o formato "Livro capítulo:versículo" (ex.: "João 3:16").');
}

const verseLines = (p: ReturnType<typeof passage>) => p.verses.map((v) => (v.omitted ? { v: v.v, omitted: true, note: v.note } : { v: v.v, text: v.text }));

// ------------------------------------------------------------------ leitura

const passageArgs = z.object({ reference: z.string().trim().min(2).max(60) }).strict();
const getPassage: ReadTool<typeof passageArgs> = {
  kind: 'read',
  name: 'get_bible_passage',
  label: 'Abrindo a passagem bíblica',
  description:
    'Texto REAL de uma passagem da Bíblia na tradução do app, por referência ("Filipenses 4:13", "Salmo 23", "João 3:16-18"; capítulo inteiro até 60 versículos). Use SEMPRE antes de citar um versículo; nunca cite de memória. Para explicar o contexto, leia também os versículos ao redor (ex.: o capítulo).',
  parameters: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'], additionalProperties: false },
  args: passageArgs,
  async run(_ctx, a) {
    const p = passageByKey(refFrom(a.reference), 60);
    return { reference: p.label, key: p.ref, translation: `${TRANSLATION.name} (${TRANSLATION.short})`, verses: verseLines(p), truncated: p.truncated || undefined, note: TEXT_NOTE };
  },
};

const searchArgs = z.object({ query: z.string().trim().min(2).max(80), book: z.string().nullish(), testament: z.enum(['OT', 'NT']).nullish(), limit: z.number().int().min(1).max(20).default(12) }).strict();
const searchBible: ReadTool<typeof searchArgs> = {
  kind: 'read',
  name: 'search_bible',
  label: 'Buscando na Bíblia',
  description: 'Busca por palavras no texto da tradução do app (todas as palavras precisam aparecer no versículo). Opcional: book (id USFM, ex.: "PRO", "JHN") ou testament (OT/NT). Devolve versículos reais com referência.',
  parameters: { type: 'object', properties: { query: { type: 'string' }, book: { type: ['string', 'null'] }, testament: { type: ['string', 'null'], enum: ['OT', 'NT', null] }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false },
  args: searchArgs,
  async run(_ctx, a) {
    const r = search(a.query, { limit: a.limit, book: a.book && isBookId(a.book.toUpperCase()) ? a.book.toUpperCase() : null, testament: a.testament ?? null });
    return { translation: TRANSLATION.short, total: r.total, results: r.hits.map((h) => ({ reference: h.label, key: h.ref, text: h.text })), note: r.total ? TEXT_NOTE : 'Nada encontrado com essas palavras nesta tradução. Não invente versículos.' };
  },
};

const themeArgs = z.object({ theme: z.enum(VERSE_THEMES) }).strict();
const passagesByTheme: ReadTool<typeof themeArgs> = {
  kind: 'read',
  name: 'find_bible_passages_by_theme',
  label: 'Procurando passagens sobre o tema',
  description: `Passagens da seleção editorial verificada do app sobre um tema (${VERSE_THEMES.join(', ')}), com texto real e contexto quando necessário. Use para "me mostre uma passagem sobre perseverança".`,
  parameters: { type: 'object', properties: { theme: { type: 'string', enum: [...VERSE_THEMES] } }, required: ['theme'], additionalProperties: false },
  args: themeArgs,
  async run(_ctx, a) {
    const list = CURATED.filter((p) => p.theme === a.theme).map((p) => {
      const x = passageByKey(p.ref);
      return { reference: x.label, key: x.ref, text: x.verses.map((v) => v.text).join(' '), context: p.context ?? null };
    });
    return { theme: a.theme, translation: TRANSLATION.short, passages: list, note: `${TEXT_NOTE} Ao sugerir, ofereça abrir o capítulo para ler no contexto.` };
  },
};

const getVerseOfDay: ReadTool = {
  kind: 'read',
  name: 'get_bible_verse_of_day',
  label: 'Consultando o versículo do dia',
  description: 'A passagem do dia mostrada no app para a pessoa (escolha determinística da seleção verificada, fuso da conta).',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  args: z.object({}).strict(),
  async run(ctx) {
    const { today } = await tzToday(ctx);
    const v = await B.dailyVerse(q(ctx), ctx.userId, today);
    return { date: v.date, theme: v.theme, reference: v.passage.label, key: v.passage.ref, translation: TRANSLATION.short, text: v.passage.verses.map((x) => x.text).join(' '), context: v.context, savedAsFavorite: v.favorite };
  },
};

const progressArgs = z.object({ from: ISO.nullish(), to: ISO.nullish() }).strict();
const getProgress: ReadTool<typeof progressArgs> = {
  kind: 'read',
  name: 'get_bible_reading_progress',
  label: 'Consultando sua leitura bíblica',
  description: 'O que a pessoa REGISTROU de leitura bíblica num período (padrão: últimos 7 dias): capítulos por dia, sessões (minutos), última passagem aberta e o total de capítulos diferentes já lidos. Use para "o que li na Bíblia esta semana?".',
  parameters: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
  args: progressArgs,
  async run(ctx, a) {
    const { today } = await tzToday(ctx);
    const r = range(a, today, 7);
    const logs = (await q(ctx).query<{ date: string; book: string; chapter: number; source: string }>('SELECT date, book, chapter, source FROM bible_chapter_logs WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date, book, chapter', [ctx.userId, r.from, r.to])).rows;
    const sessions = await K.sessionViews(q(ctx), ctx.userId, { from: r.from, to: r.to, module: 'bible', limit: 100 });
    const prog = await B.progressView(q(ctx), ctx.userId);
    const prefs = B.prefsView(await B.prefsRow(q(ctx), ctx.userId));
    const byDay = new Map<string, string[]>();
    for (const l of logs) byDay.set(l.date, [...(byDay.get(l.date) ?? []), formatKey(`${l.book}.${l.chapter}`)]);
    return {
      today,
      ...r,
      chaptersByDay: [...byDay.entries()].map(([date, chapters]) => ({ date, chapters })),
      sessions: sessions.map((s) => ({ date: s.date, passage: s.ref ? formatKey(s.ref) : s.title, minutes: s.activeMin, origin: s.origin === 'timer' ? 'cronômetro' : 'registro manual' })),
      totals: { chaptersInPeriod: logs.length, minutesInPeriod: sessions.reduce((n, s) => n + s.activeMin, 0), distinctChaptersEver: prog.chaptersRead, totalChapters: prog.totalChapters },
      lastOpened: prefs.lastRef ? formatKey(prefs.lastRef) : null,
      note: 'Dias sem registro não significam que a pessoa não leu: só que não registrou no app. Não julgue a frequência.',
    };
  },
};

const getPlans: ReadTool = {
  kind: 'read',
  name: 'get_bible_plans',
  label: 'Consultando seus planos de leitura',
  description: 'Planos de leitura bíblica da pessoa (ativos, pausados e concluídos): progresso, próximo dia e o que ler nele. Também lista os modelos disponíveis para criar.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  args: z.object({}).strict(),
  async run(ctx) {
    const { today } = await tzToday(ctx);
    const plans = await B.planViews(q(ctx), ctx.userId, today, { status: ['active', 'paused', 'completed'] });
    return {
      today,
      plans: plans.map((p) => ({ id: p.id, title: p.title, status: p.status, days: `${p.doneDays}/${p.totalDays}`, percent: p.percent, next: p.next ? { day: p.next.day + 1, reading: p.next.label, minutes: p.next.minutes } : null, behindSuggestedPace: p.behind || undefined, version: p.version })),
      templates: PLAN_TEMPLATES.map((t) => ({ id: t, title: TEMPLATES[t].title, description: TEMPLATES[t].description })),
      note: plans.length ? 'Atraso é só informativo: nunca cobre a pessoa.' : 'Nenhum plano ainda.',
    };
  },
};

const getGoals: ReadTool = {
  kind: 'read',
  name: 'get_bible_goals',
  label: 'Consultando metas de leitura bíblica',
  description: 'Metas da área Bíblia (minutos, capítulos, dias, sessões, concluir plano) com o progresso real do período e vínculos com hábitos/missões.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  args: z.object({}).strict(),
  async run(ctx) {
    const { today } = await tzToday(ctx);
    const goals = await K.goalViews(q(ctx), ctx.userId, today, { module: 'bible' });
    return { today, goals: goals.map((g) => ({ id: g.id, title: g.title, metric: g.metric, period: g.period, target: g.target, unit: BIBLE_GOAL_UNIT[g.metric as keyof typeof BIBLE_GOAL_UNIT] ?? '', progress: g.current.progress, met: g.current.met, book: g.ref, linked: g.linkedName, status: g.status, version: g.version })) };
  },
};

const favArgs = z.object({ tag: z.string().trim().max(30).nullish(), limit: z.number().int().min(1).max(50).default(30) }).strict();
const getFavorites: ReadTool<typeof favArgs> = {
  kind: 'read',
  name: 'get_bible_favorites',
  label: 'Consultando passagens salvas',
  description: 'Passagens que a pessoa salvou como favoritas (com texto real e etiquetas). Para "passagens sobre esperança", filtre por etiqueta (tag) ou leia o texto/etiquetas de todas.',
  parameters: { type: 'object', properties: { tag: { type: ['string', 'null'] }, limit: { type: 'integer' } }, additionalProperties: false },
  args: favArgs,
  async run(ctx, a) {
    const marks = await B.markViews(q(ctx), ctx.userId, { kind: 'favorite', tag: a.tag ?? null, withText: true, limit: a.limit });
    return { translation: TRANSLATION.short, favorites: marks.map((m) => ({ reference: m.label, key: m.ref, text: m.text, tags: m.tags, savedAt: m.createdAt.slice(0, 10) })), note: marks.length ? undefined : 'Nenhuma passagem salva (com esse filtro).' };
  },
};

const reflArgs = z.object({ query: z.string().trim().max(60).nullish(), from: ISO.nullish(), to: ISO.nullish(), reference: z.string().trim().max(60).nullish(), limit: z.number().int().min(1).max(10).default(5) }).strict();
const getReflections: ReadTool<typeof reflArgs> = {
  kind: 'read',
  name: 'get_bible_reflections',
  label: 'Consultando suas reflexões (a seu pedido)',
  description:
    'Reflexões, gratidões e anotações PRIVADAS do diário espiritual. Use SOMENTE quando a pessoa pedir explicitamente para consultar o que ela escreveu (ex.: "o que escrevi sobre Salmo 23?"). Nunca use por iniciativa própria nem para avaliar a vida espiritual da pessoa. No máximo 10 por consulta.',
  parameters: { type: 'object', properties: { query: { type: ['string', 'null'] }, ...RANGE_PROPS, reference: { type: ['string', 'null'] }, limit: { type: 'integer' } }, additionalProperties: false },
  args: reflArgs,
  async run(ctx, a) {
    const prefs = await B.prefsRow(q(ctx), ctx.userId);
    if (!prefs.share_ai) throw new ToolError('not_shared', 'A pessoa desativou o acesso da IA às reflexões (Bíblia › Ajustes). Diga isso e não tente adivinhar o conteúdo.');
    const r = a.reference ? parseKey(refFrom(a.reference)) : null;
    const list = await B.reflectionViews(q(ctx), ctx.userId, { q: a.query ?? null, from: a.from ?? null, to: a.to ?? null, book: r?.b ?? null, chapter: r?.c ?? null, limit: a.limit });
    return { reflections: list.map((x) => ({ date: x.date, kind: REFLECTION_KIND_LABEL[x.kind], title: x.title, reference: x.label, tags: x.tags, text: x.content.slice(0, 1500) })), note: 'Conteúdo pessoal e privado: use só para responder ao pedido; não resuma além do necessário nem faça julgamentos.' };
  },
};

const statsArgs = z.object({ from: ISO.nullish(), to: ISO.nullish() }).strict();
const getStats: ReadTool<typeof statsArgs> = {
  kind: 'read',
  name: 'get_bible_stats',
  label: 'Consultando estatísticas de leitura bíblica',
  description: 'Minutos e capítulos por dia (só dias com registro) num período (padrão: 28 dias, máx. 120), total, média nos dias com leitura e planos concluídos.',
  parameters: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
  args: statsArgs,
  async run(ctx, a) {
    const { today } = await tzToday(ctx);
    const r = range(a, today, 28);
    const days = await B.readingDays(q(ctx), ctx.userId, r.from, r.to);
    const done = (await q(ctx).query<{ n: number }>("SELECT count(*)::int AS n FROM bible_plans WHERE user_id = $1 AND status = 'completed'", [ctx.userId])).rows[0].n;
    const minutes = days.reduce((n, d) => n + d.minutes, 0);
    return { ...r, days, totals: { minutes, chapters: days.reduce((n, d) => n + d.chapters, 0), daysWithReading: days.length, avgMinutesPerReadingDay: days.length ? Math.round(minutes / days.length) : 0, plansCompleted: done }, note: 'Só dias com registro. Leitura não registrada não aparece.' };
  },
};

// ------------------------------------------------------------------ escrita (propostas)

const planArgs = z
  .object({
    template: z.enum(PLAN_TEMPLATES).nullish(),
    books: z.array(z.string()).max(66).nullish(),
    fromRef: z.string().trim().max(40).nullish(),
    toRef: z.string().trim().max(40).nullish(),
    days: z.number().int().min(1).max(400).nullish(),
    perDay: z.number().int().min(1).max(30).nullish(),
    title: z.string().trim().max(80).nullish(),
    startDate: ISO.nullish(),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict();
const proposeCreatePlan: WriteTool<typeof planArgs> = {
  kind: 'write',
  name: 'propose_create_bible_plan',
  label: 'Preparando o plano de leitura',
  description: `Prepara a PROPOSTA de um plano de leitura bíblica: um modelo (${PLAN_TEMPLATES.map((t) => `${t} = ${TEMPLATES[t].title}`).join('; ')}) OU personalizado com books (ids USFM na ordem, ex.: ["MAT","MRK","LUK","JHN"] para os quatro Evangelhos) ou um trecho fromRef/toRef ("Gênesis 1" a "Gênesis 11"), com days (duração) OU perDay (capítulos por dia). O cronograma é calculado pelo servidor com os capítulos que existem na tradução.`,
  parameters: {
    type: 'object',
    properties: {
      template: { type: ['string', 'null'], enum: [...PLAN_TEMPLATES, null] },
      books: { type: ['array', 'null'], items: { type: 'string' } },
      fromRef: { type: ['string', 'null'] },
      toRef: { type: ['string', 'null'] },
      days: { type: ['integer', 'null'] },
      perDay: { type: ['integer', 'null'] },
      title: { type: ['string', 'null'] },
      startDate: { type: ['string', 'null'] },
      rationale: RATIONALE,
    },
    additionalProperties: false,
  },
  args: planArgs,
  async prepare(_ctx, a) {
    let span: string | null = null;
    if (a.fromRef) {
      const f = parseKey(refFrom(a.fromRef))!;
      const t = parseKey(refFrom(a.toRef ?? a.fromRef))!;
      span = `${f.b}.${f.c}-${t.b}.${t.c}`;
    }
    const books = a.books?.map((b) => b.toUpperCase());
    if (books?.some((b) => !isBookId(b))) throw new ToolError('invalid_args', 'Livro inexistente nesta tradução (use ids USFM como "JHN").');
    const input = planCreateSchema.safeParse({ id: randomUUID(), template: a.template ?? null, books: books?.length ? books : null, span, days: a.days ?? null, perDay: a.perDay ?? null, title: a.title ?? null, startDate: a.startDate ?? null });
    if (!input.success) throw new ToolError('invalid_args', input.error.issues[0]?.message ?? 'Plano inválido.');
    let built: ReturnType<typeof B.buildSchedule>;
    try {
      built = B.buildSchedule(input.data);
    } catch (e) {
      if (isApiError(e)) throw new ToolError(e.code, e.message);
      throw e;
    }
    const chapters = built.schedule.reduce((n, d) => n + d.length, 0);
    const lines: PreviewLine[] = [
      { kind: 'add', text: built.title },
      { kind: 'info', text: `${built.schedule.length} dias · ${chapters} capítulos${input.data.startDate ? ` · começa em ${dateBr(input.data.startDate)}` : ''}` },
      ...built.schedule.slice(0, 3).map((d, i) => ({ kind: 'info' as const, text: `Dia ${i + 1}: ${d.map(formatKey).join(', ')}` })),
      ...(built.schedule.length > 3 ? [{ kind: 'info' as const, text: '…' }] : []),
    ];
    return { kind: 'create_bible_plan', title: `Criar o plano "${built.title}"`, rationale: a.rationale ?? null, payload: { plan: input.data }, preview: [{ title: 'Plano de leitura', lines }], targetId: null, baseVersion: null };
  },
};

const updPlanArgs = z
  .object({ planId: z.string().uuid(), status: z.enum(['active', 'paused', 'archived']).nullish(), remainingDays: z.number().int().min(1).max(400).nullish(), title: z.string().trim().min(1).max(80).nullish(), rationale: z.string().trim().max(600).nullish() })
  .strict()
  .refine((a) => !!(a.status || a.remainingDays || a.title), { message: 'Nada para alterar.' });
const proposeUpdatePlan: WriteTool<typeof updPlanArgs> = {
  kind: 'write',
  name: 'propose_update_bible_plan',
  label: 'Preparando o ajuste do plano',
  description: 'Prepara a PROPOSTA de ajustar um plano de leitura: pausar/retomar/arquivar (status), reorganizar o que falta em N dias (remainingDays; os dias concluídos continuam no histórico) ou renomear. Use get_bible_plans antes.',
  parameters: { type: 'object', properties: { planId: { type: 'string' }, status: { type: ['string', 'null'], enum: ['active', 'paused', 'archived', null] }, remainingDays: { type: ['integer', 'null'] }, title: { type: ['string', 'null'] }, rationale: RATIONALE }, required: ['planId'], additionalProperties: false },
  args: updPlanArgs,
  async prepare(ctx, a) {
    const { today } = await tzToday(ctx);
    const p = (await B.planViews(q(ctx), ctx.userId, today, { ids: [a.planId] }))[0];
    if (!p) throw new ToolError('not_found', 'Plano não encontrado (use get_bible_plans).');
    const lines: PreviewLine[] = [];
    if (a.status) lines.push({ kind: 'change', text: a.status === 'paused' ? 'Pausar (o histórico fica guardado)' : a.status === 'active' ? 'Retomar de onde parou' : 'Arquivar' });
    if (a.remainingDays) lines.push({ kind: 'change', text: `Reorganizar os ${p.totalDays - p.doneDays} dias restantes em ${a.remainingDays} dias (os ${p.doneDays} concluídos continuam)` });
    if (a.title) lines.push({ kind: 'change', text: `Nome → ${a.title}` });
    return { kind: 'update_bible_plan', title: `Ajustar o plano "${p.title}"`, rationale: a.rationale ?? null, payload: { planId: a.planId, patch: { ...(a.status ? { status: a.status } : {}), ...(a.remainingDays ? { remainingDays: a.remainingDays } : {}), ...(a.title ? { title: a.title } : {}) } }, preview: [{ title: 'Plano de leitura', lines }], targetId: a.planId, baseVersion: p.version };
  },
};

const GOAL_JSON = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    metric: { type: 'string', enum: [...BIBLE_GOAL_METRICS] },
    period: { type: 'string', enum: ['daily', 'weekly', 'by_date'] },
    target: { type: 'integer' },
    book: { type: ['string', 'null'], description: 'id USFM do livro (ex.: "PRO") para restringir' },
    planId: { type: ['string', 'null'] },
    days: { type: 'array', items: { type: 'integer' }, description: '0=domingo … 6=sábado (metas diárias)' },
    dueDate: { type: ['string', 'null'] },
    preferredTime: { type: ['string', 'null'] },
    habitId: { type: ['string', 'null'] },
    missionId: { type: ['string', 'null'] },
  },
  required: ['metric', 'period', 'target'],
  additionalProperties: false,
};
const goalArgs = z.object({ goal: bibleGoalInputSchema, rationale: z.string().trim().max(600).nullish() }).strict();
const proposeGoal: WriteTool<typeof goalArgs> = {
  kind: 'write',
  name: 'propose_create_bible_goal',
  label: 'Preparando a meta de leitura bíblica',
  description:
    'Prepara a PROPOSTA de uma meta de leitura bíblica: "ler um capítulo por dia" (chapters/daily/1), "15 minutos por dia" (minutes/daily/15), "Provérbios durante a semana" (chapters/weekly/7 com book "PRO"), "concluir o plano até dd/mm" (plan_finish + planId + dueDate), "ler em 5 dias por semana" (days/weekly/5). Pode vincular a um hábito (habitId, só diárias) ou missão (missionId). Metas são opcionais e nunca medem fé ou valor da pessoa.',
  parameters: { type: 'object', properties: { goal: GOAL_JSON, rationale: RATIONALE }, required: ['goal'], additionalProperties: false },
  args: goalArgs,
  async prepare(ctx, a) {
    const g = a.goal;
    if (g.planId && !(await B.getPlan(q(ctx), ctx.userId, g.planId))) throw new ToolError('not_found', 'Plano não encontrado (use get_bible_plans).');
    const title = g.title ?? B.defaultGoalTitle(g);
    const lines: PreviewLine[] = [{ kind: 'add', text: title }];
    if (g.period === 'daily') lines.push({ kind: 'info', text: daysText(g.days) });
    if (g.preferredTime) lines.push({ kind: 'info', text: `Horário: ${g.preferredTime}` });
    if (g.habitId || g.missionId) lines.push({ kind: 'info', text: 'Vinculada (o XP vem do hábito/missão, sem duplicar)' });
    return { kind: 'create_bible_goal', title: 'Criar meta de leitura bíblica', rationale: a.rationale ?? null, payload: { goal: { ...g, title }, id: randomUUID() }, preview: [{ title: 'Metas da Bíblia', lines }], targetId: null, baseVersion: null };
  },
};

const favAddArgs = z.object({ reference: z.string().trim().min(2).max(60), tags: z.array(z.string().trim().min(1).max(30)).max(8).nullish(), rationale: z.string().trim().max(600).nullish() }).strict();
const proposeFavorite: WriteTool<typeof favAddArgs> = {
  kind: 'write',
  name: 'propose_add_bible_favorite',
  label: 'Preparando o favorito',
  description: 'Prepara a PROPOSTA de salvar uma passagem nos favoritos da pessoa (com etiquetas opcionais, ex.: ["esperança"]).',
  parameters: { type: 'object', properties: { reference: { type: 'string' }, tags: { type: ['array', 'null'], items: { type: 'string' } }, rationale: RATIONALE }, required: ['reference'], additionalProperties: false },
  args: favAddArgs,
  async prepare(ctx, a) {
    const ref = refFrom(a.reference);
    const r = parseKey(ref)!;
    const dup = (await q(ctx).query("SELECT 1 FROM bible_marks WHERE user_id = $1 AND kind = 'favorite' AND book = $2 AND chapter = $3 AND verse_start = $4 AND verse_end = $5", [ctx.userId, r.b, r.c, r.v1 ?? 1, r.v2 ?? r.v1 ?? 1])).rowCount;
    if (dup) throw new ToolError('duplicate', 'Essa passagem já está nos favoritos.');
    const p = passageByKey(ref, 8);
    const tags = [...new Set((a.tags ?? []).map((t) => t.toLowerCase()))];
    const lines: PreviewLine[] = [{ kind: 'add', text: `${p.label} (${TRANSLATION.short})` }, { kind: 'info', text: p.verses.map((v) => v.text).join(' ').slice(0, 240) }, ...(tags.length ? [{ kind: 'info' as const, text: `Etiquetas: ${tags.join(', ')}` }] : [])];
    return { kind: 'add_bible_favorite', title: `Salvar ${p.label} nos favoritos`, rationale: a.rationale ?? null, payload: { ref, tags, id: randomUUID() }, preview: [{ title: 'Favoritos', lines }], targetId: null, baseVersion: null };
  },
};

const reflSaveArgs = z
  .object({
    kind: z.enum(REFLECTION_KINDS).default('reflection'),
    title: z.string().trim().max(120).nullish(),
    content: z.string().trim().min(1).max(4000),
    reference: z.string().trim().max(60).nullish(),
    tags: z.array(z.string().trim().min(1).max(30)).max(8).nullish(),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict();
const proposeReflection: WriteTool<typeof reflSaveArgs> = {
  kind: 'write',
  name: 'propose_save_bible_reflection',
  label: 'Preparando a reflexão para salvar',
  description:
    'Prepara a PROPOSTA de salvar no diário espiritual uma reflexão, gratidão ou anotação que a PESSOA escreveu ou pediu para guardar (pode ser um texto construído na conversa com ela). Só use quando ela pedir para salvar; escreva na voz dela, sem acrescentar interpretações suas. A pessoa vê o texto inteiro antes de aprovar.',
  parameters: { type: 'object', properties: { kind: { type: 'string', enum: [...REFLECTION_KINDS] }, title: { type: ['string', 'null'] }, content: { type: 'string' }, reference: { type: ['string', 'null'] }, tags: { type: ['array', 'null'], items: { type: 'string' } }, rationale: RATIONALE }, required: ['content'], additionalProperties: false },
  args: reflSaveArgs,
  async prepare(_ctx, a) {
    const ref = a.reference ? refFrom(a.reference) : null;
    const tags = [...new Set((a.tags ?? []).map((t) => t.toLowerCase()))];
    const lines: PreviewLine[] = [
      { kind: 'add', text: `${REFLECTION_KIND_LABEL[a.kind]}${a.title ? `: ${a.title}` : ''}${ref ? ` · ${formatKey(ref)}` : ''}` },
      { kind: 'info', text: a.content },
      ...(tags.length ? [{ kind: 'info' as const, text: `Etiquetas: ${tags.join(', ')}` }] : []),
      { kind: 'info', text: 'Fica privada no seu diário.' },
    ];
    return { kind: 'save_bible_reflection', title: `Salvar ${REFLECTION_KIND_LABEL[a.kind].toLowerCase()} no diário`, rationale: a.rationale ?? null, payload: { kind: a.kind, title: a.title ?? null, content: a.content, ref, tags, id: randomUUID(), clientId: randomUUID() }, preview: [{ title: 'Diário espiritual', lines }], targetId: null, baseVersion: null };
  },
};

// ------------------------------------------------------------------ handlers (aplicar e desfazer)

const planCreate: ActionHandler = {
  kind: 'create_bible_plan',
  async apply(c, ctx, action) {
    const { plan } = action.payload as { plan: PlanCreate };
    const row = await inLife(c, ctx, (t) => B.createPlan(t, planCreateSchema.parse(plan), 'ai'));
    return { collection: 'bible_plans', entityId: row.id, summary: `Plano "${row.title}" criado (${row.schedule.length} dias).`, undo: { id: row.id, version: row.version } };
  },
  async undo(c, ctx, _a, u) {
    const { id, version } = u as { id: string; version: number };
    return inLife(c, ctx, async (t) => {
      const p = await B.getPlan(t.c, t.userId, id, true);
      if (!p) return { summary: 'O plano já não existia.' };
      if (p.version !== version) throw new StaleError();
      if ((await t.c.query('SELECT 1 FROM bible_plan_days WHERE user_id = $1 AND plan_id = $2 LIMIT 1', [t.userId, id])).rowCount) throw new StaleError();
      await B.deletePlan(t, id);
      return { summary: `Plano "${p.title}" removido.` };
    });
  },
};

const planUpdate: ActionHandler = {
  kind: 'update_bible_plan',
  async apply(c, ctx, action) {
    const { planId, patch } = action.payload as { planId: string; patch: { status?: 'active' | 'paused' | 'archived'; remainingDays?: number; title?: string } };
    return inLife(c, ctx, async (t) => {
      const cur = await B.getPlan(t.c, t.userId, planId, true);
      if (!cur || cur.version !== action.baseVersion) throw new StaleError();
      const r = await B.updatePlan(t, planId, patch);
      return { collection: 'bible_plans' as const, entityId: planId, summary: `Plano "${r.after.title}" ajustado.`, undo: { before: r.before, days: r.beforeDays, version: r.after.version } };
    });
  },
  async undo(c, ctx, _a, u) {
    const x = u as { before: B.PlanRow; days: { day: number; completed_on: string }[]; version: number };
    await inLife(c, ctx, async (t) => {
      const cur = await B.getPlan(t.c, t.userId, x.before.id, true);
      if (!cur || cur.version !== x.version) throw new StaleError();
      await B.restorePlan(t, x.before, x.days);
    });
    return { summary: 'Plano voltou como estava.' };
  },
};

const goalCreate: ActionHandler = {
  kind: 'create_bible_goal',
  async apply(c, ctx, action) {
    const { goal, id } = action.payload as { goal: unknown; id: string };
    const row = await inLife(c, ctx, (t) => B.createGoal(t, bibleGoalInputSchema.parse(goal), 'ai', id));
    return { collection: 'bible_goals', entityId: row.id, summary: `Meta "${row.title}" criada.`, undo: { id: row.id, version: row.version } };
  },
  async undo(c, ctx, _a, u) {
    const { id, version } = u as { id: string; version: number };
    await inLife(c, ctx, async (t) => {
      const g = await K.getGoal(t.c, t.userId, id, true);
      if (!g) return;
      if (g.version !== version) throw new StaleError();
      await K.deleteGoal(t, id);
    });
    return { summary: 'Meta removida.' };
  },
};

const favoriteAdd: ActionHandler = {
  kind: 'add_bible_favorite',
  async apply(c, ctx, action) {
    const { ref, tags, id } = action.payload as { ref: string; tags: string[]; id: string };
    const r = await B.upsertMark(c, ctx.userId, { kind: 'favorite', ref, color: null, tags }, 'ai', id);
    return { collection: 'bible_marks', entityId: r.mark.id, summary: `${r.mark.label} salvo nos favoritos.`, undo: { id: r.mark.id, created: r.created } };
  },
  async undo(c, ctx, _a, u) {
    const { id, created } = u as { id: string; created: boolean };
    if (created) await c.query('DELETE FROM bible_marks WHERE user_id = $1 AND id = $2', [ctx.userId, id]);
    return { summary: 'Favorito removido.' };
  },
};

const reflectionSave: ActionHandler = {
  kind: 'save_bible_reflection',
  async apply(c, ctx, action) {
    const p = action.payload as { kind: 'reflection' | 'gratitude' | 'note'; title: string | null; content: string; ref: string | null; tags: string[]; id: string; clientId: string };
    const { today } = await tzToday({ ...ctx, pool: c as never });
    try {
      const r = await B.createReflection(c, ctx.userId, today, { clientId: p.clientId, kind: p.kind, date: today, title: p.title, content: p.content, ref: p.ref, tags: p.tags, favorite: false }, 'ai', p.id);
      return { collection: 'bible_reflections', entityId: r.reflection.id, summary: `${REFLECTION_KIND_LABEL[p.kind]} salva no diário.`, undo: { id: r.reflection.id, version: r.reflection.version } };
    } catch (e) {
      if (isApiError(e)) throw new ToolError(e.code, e.message);
      throw e;
    }
  },
  async undo(c, ctx, _a, u) {
    const { id, version } = u as { id: string; version: number };
    const cur = await B.getReflection(c, ctx.userId, id, true);
    if (!cur) return { summary: 'A reflexão já não existia.' };
    if (cur.version !== version) throw new StaleError();
    await B.deleteReflection(c, ctx.userId, id);
    return { summary: 'Reflexão removida do diário.' };
  },
};

export const bibleModule: AiModuleDef = {
  id: 'bible',
  name: 'Bíblia: leitura, planos, versículo do dia e diário espiritual',
  status: 'available',
  scope: `texto bíblico real (${TRANSLATION.name}, domínio público), busca, passagens por tema, versículo do dia, capítulos lidos e sessões, planos de leitura, metas, favoritos e — só sob pedido — reflexões`,
  tools: [getPassage, searchBible, passagesByTheme, getVerseOfDay, getProgress, getPlans, getGoals, getFavorites, getReflections, getStats, proposeCreatePlan, proposeUpdatePlan, proposeGoal, proposeFavorite, proposeReflection],
  actions: [planCreate, planUpdate, goalCreate, favoriteAdd, reflectionSave],
};

/** Para os testes: a passagem que uma ferramenta devolveria (garante que vem do arquivo da tradução). */
export const _test = { refFrom, BibleTextError };
