// Integração multimódulo da IA central (Fase 06, docs/INTEGRACAO_LIFE.md §3–4).
//
// Leitura AGREGADA (uma chamada responde perguntas que cruzam módulos, sem mandar o banco inteiro ao modelo):
//  - get_life_overview: indicadores determinísticos de "Minha Evolução" por período, com comparação, separando dados
//    registrados, ausência de dados e o que foi só planejado;
//  - get_week_agenda: a agenda unificada ("Minha Semana"), com situação de cada item, conflitos e carga;
//  - check_schedule_conflicts: confere horários propostos contra a agenda antes de propor um planejamento;
//  - get_personal_context: objetivos, preferências (confirmadas × inferidas), horários, metas e planos ativos.
//
// Escrita (sempre PROPOSTA com prévia e aprovação explícita):
//  - propose_schedule_items: atividades na agenda (Minha Semana);
//  - propose_life_plan: plano com etapas em VÁRIOS módulos. Cada etapa reaproveita a ferramenta propose_* do módulo
//    (mesma validação e prévia) e, na aprovação, o ActionHandler do mesmo tipo, cada uma num SAVEPOINT próprio:
//    etapas que falham são desfeitas sozinhas e o plano fica "parcial" (nunca "salvo por inteiro"); nova tentativa
//    aplica só o que falta (os IDs são gerados na proposta, então repetir não duplica). Planejar não gera XP.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MEMORY_CATEGORY_LABEL, type ActionKind, type PreviewLine, type PreviewSection } from '../../../../../shared/assistant/protocol.ts';
import { AGENDA_CATEGORIES, CATEGORY_LABEL, CUSTOM_CATEGORIES, STATUS_LABEL, addMinutes, dayLoad, findConflicts, plannerItemInputSchema, type AgendaCategory, type AgendaItem, type EvolutionPeriod } from '../../../../../shared/planner/protocol.ts';
import type { PoolClient } from '../../db/pool.ts';
import { isApiError } from '../../http/core.ts';
import { evolution } from '../../insights/service.ts';
import { accountTz, buildAgenda, createItem, dedupeKey } from '../../planner/service.ts';
import { addDays, localDate, mondayOf } from './time.ts';
import { StaleError } from './training.ts';
import { ToolError, type ActionHandler, type AiModuleDef, type ReadTool, type StoredAction, type ToolContext, type WriteTool } from './types.ts';

type Q = Pick<PoolClient, 'query'>;
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------ leitura agregada

const PERIODS = { last_7_days: ['last7', 0], last_30_days: ['last30', 0], this_week: ['week', 0], last_week: ['week', 1], this_month: ['month', 0], last_month: ['month', 1] } as const;
const MODULES = ['training', 'nutrition', 'life', 'knowledge', 'bible'] as const;
const overviewArgs = z.object({ period: z.enum(Object.keys(PERIODS) as [keyof typeof PERIODS, ...(keyof typeof PERIODS)[]]).default('last_7_days'), modules: z.array(z.enum(MODULES)).max(5).nullish() }).strict();

const getLifeOverview: ReadTool<typeof overviewArgs> = {
  kind: 'read',
  name: 'get_life_overview',
  label: 'Consultando sua evolução em todas as áreas',
  description:
    'Visão AGREGADA de vários módulos num período (treinos e cargas, diário alimentar × metas, hábitos, XP e níveis, leitura, estudos e Bíblia), já calculada pelo app, com comparação ao período anterior e o que está sem dados. Use PRIMEIRO em perguntas amplas: "como foi minha semana?", "estou mantendo treino e alimentação?", "quanto estudei nos últimos 30 dias?", "quais hábitos estão ficando para trás?". Para detalhes, use depois as ferramentas do módulo.',
  parameters: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: Object.keys(PERIODS), description: 'Padrão: last_7_days.' },
      modules: { type: ['array', 'null'], items: { type: 'string', enum: [...MODULES] }, description: 'Filtrar módulos (padrão: todos).' },
    },
    additionalProperties: false,
  },
  args: overviewArgs,
  async run(ctx, a) {
    const [kind, offset] = PERIODS[a.period];
    const v = await evolution(ctx.pool, ctx.userId, ctx.now, kind as EvolutionPeriod, offset);
    const want = (m: string) => !a.modules?.length || a.modules.includes(m as (typeof MODULES)[number]);
    const metrics = v.metrics.filter((m) => want(m.module));
    // Planejado × realizado só faz sentido para a semana corrente (a agenda é calculada sob demanda).
    let planned: unknown = undefined;
    if (a.period === 'this_week') {
      const ag = await buildAgenda(ctx.pool, ctx.userId, ctx.now, v.period.from, 7);
      const count: Record<string, Record<string, number>> = {};
      for (const d of ag.days) for (const i of d.items) {
        if (i.category === 'mission') continue;
        count[i.category] ??= {};
        count[i.category][STATUS_LABEL[i.status]] = (count[i.category][STATUS_LABEL[i.status]] ?? 0) + 1;
      }
      planned = { observacao: 'Itens da agenda da semana por situação. "Planejado" inclui dias que ainda não chegaram; nada vira concluído sem registro.', por_categoria: count };
    }
    return {
      periodo: { rotulo: v.period.label, de: v.period.from, ate: v.period.to, comparado_com: `${v.previous.label} (${v.previous.from} a ${v.previous.to})` },
      dados_registrados: metrics.filter((m) => m.value != null).map((m) => ({ modulo: m.module, indicador: m.label, valor: m.value, unidade: m.unit, periodo_anterior: m.previous ?? 'sem dados', diferenca: m.delta, detalhe: m.detail })),
      sem_dados: [...metrics.filter((m) => m.value == null).map((m) => m.label), ...v.missing.filter((x) => !metrics.some((m) => m.label === x))],
      cargas: want('training') ? v.loads.map((l) => ({ exercicio: l.exercise, primeira_sessao_kg: l.first, ultima_sessao_kg: l.last, sessoes: l.sessions })) : undefined,
      planejado_x_realizado: planned,
      observacoes_calculadas: v.insights.map((i) => `${i.text} (${i.basis})`),
      regras: v.notes,
    };
  },
};

const agendaArgs = z.object({ start: z.string().regex(dateRe).nullish(), days: z.number().int().min(1).max(14).nullish(), categories: z.array(z.enum(AGENDA_CATEGORIES)).max(11).nullish() }).strict();
const compactItem = (i: AgendaItem) => ({ hora: i.startTime, duracao_min: i.durationMin, titulo: i.title, categoria: CATEGORY_LABEL[i.category], situacao: STATUS_LABEL[i.status], origem: i.statusSource === 'record' ? 'registro' : i.statusSource === 'user' ? 'marcado pela pessoa' : 'planejamento', detalhe: i.subtitle });

const getWeekAgenda: ReadTool<typeof agendaArgs> = {
  kind: 'read',
  name: 'get_week_agenda',
  label: 'Consultando a sua semana',
  description:
    'Agenda unificada ("Minha Semana"): treinos planejados/realizados, refeições planejadas/consumidas, hábitos, missões com prazo, metas de leitura/estudo, planos bíblicos, rotinas, atividades personalizadas e descansos, com a situação de cada item (planejado, em andamento, concluído, não realizado, pausado), conflitos de horário e carga do dia. Padrão: semana atual (segunda a domingo). Use antes de planejar ou reorganizar a semana.',
  parameters: {
    type: 'object',
    properties: {
      start: { type: ['string', 'null'], description: 'yyyy-mm-dd (padrão: segunda-feira desta semana)' },
      days: { type: ['integer', 'null'], description: '1–14 (padrão 7)' },
      categories: { type: ['array', 'null'], items: { type: 'string', enum: [...AGENDA_CATEGORIES] } },
    },
    additionalProperties: false,
  },
  args: agendaArgs,
  async run(ctx, a) {
    const tz = await accountTz(ctx.pool, ctx.userId);
    const start = a.start ?? mondayOf(localDate(ctx.now, tz));
    const ag = await buildAgenda(ctx.pool, ctx.userId, ctx.now, start, a.days ?? 7, tz);
    return {
      fuso: ag.timezone,
      hoje: ag.today,
      dias: ag.days.map((d) => ({
        data: d.date,
        dia: WEEKDAYS[d.weekday],
        descanso: d.rest || undefined,
        itens: d.items.filter((i) => !a.categories?.length || a.categories.includes(i.category)).map(compactItem),
        carga: { minutos_planejados: d.load.plannedMin, itens: d.load.count, sobrecarregado: d.load.overloaded },
        conflitos: d.conflicts.map((c) => c.text),
      })),
      regra: 'Situação vem dos registros reais. Itens com horário passado continuam "Planejado" se não houver registro; não suponha que foram feitos nem que não foram.',
    };
  },
};

const slotSchema = z.object({ date: z.string().regex(dateRe), startTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/), durationMin: z.number().int().min(5).max(720).nullish(), title: z.string().trim().min(1).max(80) }).strict();
const conflictArgs = z.object({ items: z.array(slotSchema).min(1).max(40) }).strict();

async function conflictsFor(ctx: ToolContext, items: { date: string; startTime?: string | null; durationMin?: number | null; title: string; category?: AgendaCategory }[]) {
  const ds = [...new Set(items.map((i) => i.date))].sort();
  if (!ds.length) return { conflicts: [] as string[], overloaded: [] as string[] };
  const span = Math.round((Date.parse(`${ds[ds.length - 1]}T00:00:00Z`) - Date.parse(`${ds[0]}T00:00:00Z`)) / 86_400_000) + 1;
  if (span > 14) throw new ToolError('invalid_args', 'Planeje no máximo 14 dias por vez.');
  const ag = await buildAgenda(ctx.pool, ctx.userId, ctx.now, ds[0], span);
  const conflicts: string[] = [];
  const overloaded: string[] = [];
  for (const d of ag.days) {
    const mine = items.filter((i) => i.date === d.date).map((i, k) => ({ key: `new:${k}`, title: `${i.title} (nova)`, date: i.date, startTime: i.startTime ?? null, durationMin: i.durationMin ?? null, status: 'planned' as const, category: i.category ?? ('custom' as AgendaCategory) }));
    if (!mine.length) continue;
    const all = [...d.items, ...mine];
    for (const c of findConflicts(all)) if (c.a.startsWith('new:') || c.b.startsWith('new:')) conflicts.push(`${d.date}: ${c.text}`);
    const load = dayLoad(all);
    if (load.overloaded) overloaded.push(`${d.date}: ${load.plannedMin} min planejados em ${load.count} atividades`);
  }
  return { conflicts, overloaded };
}

const checkConflicts: ReadTool<typeof conflictArgs> = {
  kind: 'read',
  name: 'check_schedule_conflicts',
  label: 'Conferindo conflitos de horário',
  description: 'Confere horários que você pretende propor contra a agenda real (treinos, refeições, hábitos, rotinas, estudos, Bíblia e atividades): devolve sobreposições e dias sobrecarregados. Use antes de propose_life_plan/propose_schedule_items.',
  parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, startTime: { type: 'string', description: 'HH:MM' }, durationMin: { type: ['integer', 'null'] }, title: { type: 'string' } }, required: ['date', 'startTime', 'title'], additionalProperties: false } } }, required: ['items'], additionalProperties: false },
  args: conflictArgs,
  async run(ctx, a) {
    const r = await conflictsFor(ctx, a.items);
    return { conflitos: r.conflicts, dias_sobrecarregados: r.overloaded, ok: !r.conflicts.length && !r.overloaded.length };
  },
};

const getPersonalContext: ReadTool<z.ZodObject<Record<string, never>>> = {
  kind: 'read',
  name: 'get_personal_context',
  label: 'Consultando objetivos, preferências e horários',
  description:
    'Contexto pessoal para planejar: preferências salvas (confirmadas × inferidas, com categoria), objetivo e restrições alimentares, horários de refeição, meta semanal de treinos, dias de treino planejados, fichas, rotinas e hábitos com horário, metas de leitura/estudo/Bíblia e planos bíblicos ativos. Os REGISTROS dos módulos são a fonte da verdade; preferências inferidas são hipóteses.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  args: z.object({}).strict() as z.ZodObject<Record<string, never>>,
  async run(ctx) {
    const q = ctx.pool as unknown as Q;
    const u = ctx.userId;
    const tz = await accountTz(ctx.pool, u);
    const today = localDate(ctx.now, tz);
    const [mem, ng, prof, plan, fichas, routines, habits, kg, bp, bprefs] = await Promise.all([
      q.query<{ content: string; category: string; confirmed: boolean; expires_on: string | null }>('SELECT content, category, confirmed, expires_on FROM assistant_memories WHERE user_id = $1 AND (expires_on IS NULL OR expires_on >= $2) ORDER BY created_at', [u, today]),
      q.query<{ objective: string; kcal: number | null; protein: number | null; meal_times: Record<string, string>; preferences: string | null }>('SELECT objective, kcal, protein, meal_times, preferences FROM nutrition_goals WHERE user_id = $1', [u]),
      q.query<{ weekly_workout_target: number | null }>('SELECT weekly_workout_target FROM life_profiles WHERE user_id = $1', [u]),
      q.query<{ weekday: number | null; kind: string }>("SELECT (doc->>'weekday')::int AS weekday, doc->>'kind' AS kind FROM plan_entries WHERE user_id = $1 AND NOT deleted AND doc->>'scope' = 'weekly' AND coalesce((doc->>'enabled')::boolean, true) AND (doc->>'validUntil' IS NULL OR doc->>'validUntil' >= $2)", [u, today]),
      q.query<{ name: string; n: number }>("SELECT doc->>'name' AS name, jsonb_array_length(coalesce(doc->'workouts', '[]'::jsonb)) AS n FROM routines WHERE user_id = $1 AND NOT deleted ORDER BY updated_at DESC LIMIT 5", [u]),
      q.query<{ name: string; days: number[]; items: string }>(
        "SELECT r.name, r.days, string_agg(coalesce(i.start_time || ' ', '') || i.title, '; ' ORDER BY i.position) AS items FROM life_routines r LEFT JOIN life_routine_items i ON i.routine_id = r.id WHERE r.user_id = $1 AND r.status = 'active' GROUP BY r.id, r.name, r.days",
        [u],
      ),
      q.query<{ name: string; days: number[]; preferred_time: string | null; status: string }>("SELECT name, days, preferred_time, status FROM life_habits WHERE user_id = $1 AND status IN ('active', 'paused') ORDER BY preferred_time NULLS LAST, name", [u]),
      q.query<{ module: string; title: string; metric: string; period: string; target: number; preferred_time: string | null }>("SELECT module, title, metric, period, target, preferred_time FROM knowledge_goals WHERE user_id = $1 AND status = 'active'", [u]),
      q.query<{ title: string; status: string }>("SELECT title, status FROM bible_plans WHERE user_id = $1 AND status IN ('active', 'paused')", [u]),
      q.query<{ share_ai: boolean }>('SELECT share_ai FROM bible_prefs WHERE user_id = $1', [u]),
    ]);
    const days = (d: number[]) => (d.length === 7 ? 'todos os dias' : d.map((x) => WEEKDAYS[x]).join(', '));
    const n = ng.rows[0];
    return {
      fuso: tz,
      hoje: today,
      preferencias_confirmadas: mem.rows.filter((m) => m.confirmed).map((m) => `[${MEMORY_CATEGORY_LABEL[m.category as keyof typeof MEMORY_CATEGORY_LABEL] ?? m.category}] ${m.content}${m.expires_on ? ` (vale até ${m.expires_on})` : ''}`),
      preferencias_inferidas_nao_confirmadas: mem.rows.filter((m) => !m.confirmed).map((m) => `[${MEMORY_CATEGORY_LABEL[m.category as keyof typeof MEMORY_CATEGORY_LABEL] ?? m.category}] ${m.content}`),
      alimentacao: n ? { objetivo: n.objective, kcal: n.kcal, proteina_g: n.protein, horarios_refeicoes: n.meal_times, restricoes_e_preferencias: n.preferences } : 'sem metas nutricionais cadastradas',
      treino: {
        meta_semanal: prof.rows[0]?.weekly_workout_target ?? 'não definida',
        dias_planejados: plan.rows.filter((p) => p.kind === 'workout' && p.weekday != null).map((p) => WEEKDAYS[p.weekday!]),
        descansos_planejados: plan.rows.filter((p) => p.kind === 'rest' && p.weekday != null).map((p) => WEEKDAYS[p.weekday!]),
        fichas: fichas.rows.map((f) => `${f.name} (${f.n} treinos)`),
      },
      rotinas: routines.rows.map((r) => ({ nome: r.name, dias: days(r.days), atividades: r.items })),
      habitos: habits.rows.map((h) => `${h.name} · ${days(h.days)}${h.preferred_time ? ` às ${h.preferred_time}` : ''}${h.status === 'paused' ? ' (pausado)' : ''}`),
      metas_conhecimento: kg.rows.map((g) => `${g.module === 'bible' ? 'Bíblia' : 'Conhecimento'}: ${g.title} (${g.target} ${g.metric}, ${g.period}${g.preferred_time ? `, ${g.preferred_time}` : ''})`),
      planos_biblicos: bp.rows.map((p) => `${p.title}${p.status === 'paused' ? ' (pausado)' : ''}`),
      reflexoes_espirituais: bprefs.rows[0]?.share_ai === false ? 'a pessoa desativou o acesso da IA às reflexões' : 'só consulte com pedido explícito (get_bible_reflections)',
    };
  },
};

// ------------------------------------------------------------------ escrita: agenda

const scheduleItemSchema = z
  .object({
    date: z.string().regex(dateRe),
    startTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/).nullish(),
    durationMin: z.number().int().min(5).max(720).nullish(),
    title: z.string().trim().min(1).max(80),
    category: z.enum(CUSTOM_CATEGORIES).default('custom'),
    notes: z.string().trim().max(300).nullish(),
  })
  .strict();
type ScheduleItem = z.infer<typeof scheduleItemSchema>;
const SCHEDULE_ITEM_JSON = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'yyyy-mm-dd' },
    startTime: { type: ['string', 'null'], description: 'HH:MM' },
    durationMin: { type: ['integer', 'null'] },
    title: { type: 'string' },
    category: { type: 'string', enum: [...CUSTOM_CATEGORIES], description: 'custom, study, reading, bible, workout, meal, rest (descanso) ou free (período livre)' },
    notes: { type: ['string', 'null'] },
  },
  required: ['date', 'title', 'category'],
  additionalProperties: false,
};

async function scheduleStep(ctx: ToolContext, items: ScheduleItem[]): Promise<{ title: string; payload: unknown; preview: PreviewSection[] }> {
  const tz = await accountTz(ctx.pool, ctx.userId);
  const today = localDate(ctx.now, tz);
  if (items.some((i) => i.date < today)) throw new ToolError('invalid_args', 'Só é possível planejar de hoje em diante.');
  if (items.some((i) => i.date > addDays(today, 60))) throw new ToolError('invalid_args', 'Planeje no máximo 60 dias à frente.');
  const keys = new Set<string>();
  for (const i of items) {
    const k = dedupeKey(i);
    if (keys.has(k)) throw new ToolError('duplicate', `Atividade repetida na proposta: ${i.title} em ${i.date}.`);
    keys.add(k);
  }
  const existing = new Set((await (ctx.pool as unknown as Q).query<{ dedupe_key: string }>('SELECT dedupe_key FROM planner_items WHERE user_id = $1 AND dedupe_key = ANY($2)', [ctx.userId, [...keys]])).rows.map((r) => r.dedupe_key));
  const { conflicts, overloaded } = await conflictsFor(ctx, items);
  const lines: PreviewLine[] = items.map((i) => ({
    kind: existing.has(dedupeKey(i)) ? 'info' : 'add',
    text: `${i.date.split('-').reverse().slice(0, 2).join('/')} (${WEEKDAYS[new Date(`${i.date}T00:00:00Z`).getUTCDay()]})${i.startTime ? ` ${i.startTime}${i.durationMin ? `–${addMinutes(i.startTime, i.durationMin)}` : ''}` : ''} · ${i.title} [${CATEGORY_LABEL[i.category]}]${existing.has(dedupeKey(i)) ? ' — já está na agenda, será ignorada' : ''}`,
  }));
  const preview: PreviewSection[] = [{ title: 'Minha Semana', lines }];
  if (conflicts.length || overloaded.length) preview.push({ title: 'Atenção na agenda', lines: [...conflicts.map((t) => ({ kind: 'change' as const, text: t })), ...overloaded.map((t) => ({ kind: 'change' as const, text: `Dia carregado: ${t}` }))] });
  return { title: `Adicionar ${items.length} ${items.length === 1 ? 'atividade' : 'atividades'} à Minha Semana`, payload: { items: items.map((i) => ({ ...i, clientId: randomUUID() })) }, preview };
}

const scheduleArgs = z.object({ items: z.array(scheduleItemSchema).min(1).max(40), rationale: z.string().trim().max(600).nullish() }).strict();
const proposeSchedule: WriteTool<typeof scheduleArgs> = {
  kind: 'write',
  name: 'propose_schedule_items',
  label: 'Preparando atividades para a sua semana',
  description: 'Prepara a PROPOSTA de adicionar atividades à agenda "Minha Semana" (blocos de estudo, leitura, descanso, período livre, compromissos). Não cria registros nos módulos nem gera XP. Para planos que também criam hábitos, rotinas, fichas, refeições planejadas ou planos de leitura, use propose_life_plan.',
  parameters: { type: 'object', properties: { items: { type: 'array', items: SCHEDULE_ITEM_JSON }, rationale: { type: ['string', 'null'] } }, required: ['items'], additionalProperties: false },
  args: scheduleArgs,
  async prepare(ctx, a) {
    const s = await scheduleStep(ctx, a.items);
    return { kind: 'create_planner_items', title: s.title, rationale: a.rationale ?? null, payload: s.payload, preview: s.preview, targetId: null, baseVersion: null };
  },
};

const plannerItemsHandler: ActionHandler = {
  kind: 'create_planner_items',
  async apply(c, ctx, action) {
    const { items } = action.payload as { items: unknown[] };
    const times = new Map((action.approve?.times ?? []).filter((t) => t.step === 0).map((t) => [t.item, t.startTime]));
    const created: string[] = [];
    let skipped = 0;
    for (const [k, raw] of items.entries()) {
      const it = plannerItemInputSchema.parse(raw);
      if (times.has(k)) it.startTime = times.get(k) ?? null;
      const r = await createItem(c, ctx.userId, it, 'ai', { dedupe: true });
      if (r.created) created.push(r.row.id);
      else skipped++;
    }
    return { collection: 'planner', entityId: created[0] ?? action.id, summary: `${created.length} ${created.length === 1 ? 'atividade adicionada' : 'atividades adicionadas'} à Minha Semana${skipped ? ` (${skipped} já existiam)` : ''}.`, undo: { ids: created } };
  },
  async undo(c, ctx, _a, u) {
    const { ids } = u as { ids: string[] };
    const r = await c.query('DELETE FROM planner_items WHERE user_id = $1 AND id = ANY($2::uuid[])', [ctx.userId, ids]);
    return { summary: `${r.rowCount ?? 0} atividades removidas da agenda.` };
  },
};

// ------------------------------------------------------------------ escrita: plano multimódulo

/** Ferramentas de escrita que podem virar etapa de um plano (registrar consumo de refeição NÃO entra: é registro real). */
export const PLAN_STEP_TOOLS = [
  'propose_create_habit',
  'propose_update_habit',
  'propose_create_life_routine',
  'propose_update_life_routine',
  'propose_create_missions',
  'propose_create_routine',
  'propose_update_routine',
  'propose_create_meal_plan',
  'propose_update_meal_plan',
  'propose_update_nutrition_goals',
  'propose_create_study_plan',
  'propose_update_knowledge_goals',
  'propose_schedule_knowledge_routine',
  'propose_create_bible_plan',
  'propose_update_bible_plan',
  'propose_create_bible_goal',
  'propose_save_preference',
] as const;

const planArgs = z
  .object({
    title: z.string().trim().min(3).max(120),
    rationale: z.string().trim().max(600).nullish(),
    steps: z.array(z.object({ tool: z.enum(PLAN_STEP_TOOLS), args: z.record(z.unknown()) }).strict()).max(10).default([]),
    schedule: z.array(scheduleItemSchema).max(40).nullish(),
  })
  .strict()
  .refine((a) => a.steps.length + (a.schedule?.length ? 1 : 0) >= 2, { message: 'Um plano precisa de pelo menos duas etapas (use a ferramenta do módulo para uma só).' });

interface PlanStep {
  kind: ActionKind;
  title: string;
  preview: PreviewSection[];
  payload: unknown;
  targetId: string | null;
  baseVersion: number | null;
}

const proposeLifePlan: WriteTool<typeof planArgs> = {
  kind: 'write',
  name: 'propose_life_plan',
  label: 'Montando um plano com várias áreas',
  description:
    'Prepara UMA proposta de planejamento que envolve VÁRIOS módulos (ex.: "monte minha rotina de segunda a sexta com musculação, alimentação, estudo e leitura bíblica"). Cada etapa usa uma ferramenta propose_* existente, com os MESMOS argumentos dela (steps: [{tool, args}]); schedule acrescenta blocos na agenda Minha Semana. Antes: get_personal_context, get_week_agenda e check_schedule_conflicts. A pessoa vê a prévia de todas as etapas, pode desmarcar etapas e ajustar horários, e aprova. Planejar NÃO gera XP.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Ex.: "Rotina de segunda a sexta"' },
      rationale: { type: ['string', 'null'] },
      steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string', enum: [...PLAN_STEP_TOOLS] }, args: { type: 'object', description: 'Os mesmos argumentos da ferramenta indicada.' } }, required: ['tool', 'args'], additionalProperties: false } },
      schedule: { type: ['array', 'null'], items: SCHEDULE_ITEM_JSON },
    },
    required: ['title', 'steps'],
    additionalProperties: false,
  },
  args: planArgs,
  async prepare(ctx, a) {
    const { TOOLS } = await import('./registry.ts');
    const steps: PlanStep[] = [];
    const seen = new Set<string>();
    for (const [k, s] of a.steps.entries()) {
      const tool = TOOLS.get(s.tool);
      if (!tool || tool.kind !== 'write') throw new ToolError('invalid_args', `Etapa ${k + 1}: ferramenta ${s.tool} indisponível.`);
      const parsed = tool.args.safeParse(s.args);
      if (!parsed.success) throw new ToolError('invalid_args', `Etapa ${k + 1} (${s.tool}): ${parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ')}`);
      let p;
      try {
        p = await tool.prepare(ctx, parsed.data);
      } catch (e) {
        if (e instanceof ToolError) throw new ToolError(e.code, `Etapa ${k + 1} (${s.tool}): ${e.message}`);
        if (isApiError(e)) throw new ToolError(e.code, `Etapa ${k + 1} (${s.tool}): ${e.message}`);
        throw e;
      }
      // Sem duplicar dentro do próprio plano (mesmo tipo e mesmo alvo/título).
      const sig = `${p.kind}|${p.targetId ?? ''}|${p.title.toLowerCase()}`;
      if (seen.has(sig)) throw new ToolError('duplicate', `Etapa ${k + 1} repete outra etapa ("${p.title}"). Junte as duas.`);
      seen.add(sig);
      if (p.kind === 'apply_life_plan' || p.kind === 'create_planner_items') throw new ToolError('invalid_args', 'Etapa inválida.');
      steps.push({ kind: p.kind, title: p.title, preview: p.preview, payload: p.payload, targetId: p.targetId, baseVersion: p.baseVersion });
    }
    if (a.schedule?.length) {
      const s = await scheduleStep(ctx, a.schedule);
      steps.push({ kind: 'create_planner_items', title: s.title, preview: s.preview, payload: s.payload, targetId: null, baseVersion: null });
    }
    const preview: PreviewSection[] = steps.map((s, i) => ({ title: `Etapa ${i + 1} · ${s.title}`, lines: s.preview.flatMap((sec) => (s.preview.length > 1 ? [{ kind: 'info' as const, text: sec.title }, ...sec.lines] : sec.lines)) }));
    preview.push({ title: 'Como funciona', lines: [{ kind: 'info', text: 'Cada etapa é gravada no módulo dela. Se alguma falhar, as outras continuam e o app mostra o que faltou.' }, { kind: 'info', text: 'Planejar não gera XP: ele vem quando você cumprir as atividades.' }] });
    return { kind: 'apply_life_plan', title: a.title, rationale: a.rationale ?? null, payload: { steps }, preview, targetId: null, baseVersion: null };
  },
};

const stepError = (e: unknown): string => {
  if (e instanceof StaleError) return 'O item mudou depois da proposta. Peça uma nova proposta para esta etapa.';
  if (e instanceof ToolError) return e.message;
  if (isApiError(e)) return e.message;
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'ZodError') return 'Os dados da etapa não passaram na validação.';
  return 'Falha ao gravar esta etapa.';
};

interface StepResult {
  index: number;
  status: 'applied' | 'failed' | 'skipped';
  error?: string | null;
  collection?: string;
  entityId?: string;
  summary?: string;
}

const lifePlanHandler: ActionHandler = {
  kind: 'apply_life_plan',
  async apply(c, ctx, action) {
    const { ACTION_HANDLERS } = await import('./registry.ts');
    const { steps } = action.payload as { steps: PlanStep[] };
    const prevSteps = new Map((((action.previous?.result as { steps?: StepResult[] } | null)?.steps ?? []) as StepResult[]).map((s) => [s.index, s]));
    const prevUndo = ((action.previous?.undo as { steps?: { index: number; kind: ActionKind; undo: unknown }[] } | null)?.steps ?? []).slice();
    const skip = new Set(action.approve?.skip ?? []);
    const results: StepResult[] = [];
    const undo = [...prevUndo];
    for (const [i, s] of steps.entries()) {
      const before = prevSteps.get(i);
      if (before?.status === 'applied') {
        results.push(before);
        continue;
      }
      if (skip.has(i)) {
        results.push({ index: i, status: 'skipped' });
        continue;
      }
      const h = ACTION_HANDLERS.get(s.kind);
      if (!h || s.kind === 'apply_life_plan') {
        results.push({ index: i, status: 'failed', error: 'Tipo de etapa sem suporte.' });
        continue;
      }
      await c.query(`SAVEPOINT plan_step_${i}`);
      try {
        const sub: StoredAction = { id: action.id, kind: s.kind, payload: s.payload, targetId: s.targetId, baseVersion: s.baseVersion, ...(s.kind === 'create_planner_items' ? { approve: { times: (action.approve?.times ?? []).filter((t) => t.step === i).map((t) => ({ ...t, step: 0 })) } } : {}) };
        const r = await h.apply(c, ctx, sub);
        await c.query(`RELEASE SAVEPOINT plan_step_${i}`);
        results.push({ index: i, status: 'applied', collection: r.collection, entityId: r.entityId, summary: r.summary });
        if (r.undo !== undefined && h.undo) undo.push({ index: i, kind: s.kind, undo: r.undo });
      } catch (e) {
        await c.query(`ROLLBACK TO SAVEPOINT plan_step_${i}`);
        results.push({ index: i, status: 'failed', error: stepError(e) });
      }
    }
    const applied = results.filter((r) => r.status === 'applied');
    const failed = results.filter((r) => r.status === 'failed');
    const outcome = failed.length === 0 ? (applied.length ? 'applied' : 'failed') : applied.length ? 'partial' : 'failed';
    const summary =
      outcome === 'applied'
        ? `Plano aplicado: ${applied.map((r) => r.summary).join(' ')}`
        : outcome === 'partial'
          ? `Plano aplicado em parte (${applied.length} de ${results.filter((r) => r.status !== 'skipped').length} etapas). Gravado: ${applied.map((r) => r.summary).join(' ')} Não gravado: ${failed.map((r) => `etapa ${r.index + 1} (${r.error})`).join('; ')}.`
          : `Nenhuma etapa do plano foi gravada. ${failed.map((r) => `Etapa ${r.index + 1}: ${r.error}`).join('; ')}`;
    return { collection: 'plan', entityId: action.id, summary, undo: undo.length ? { steps: undo } : undefined, outcome, steps: results, ...(failed[0] ? { error: failed[0].error ?? undefined } : {}) };
  },
  async undo(c, ctx, action, u) {
    const { ACTION_HANDLERS } = await import('./registry.ts');
    const { steps } = u as { steps: { index: number; kind: ActionKind; undo: unknown }[] };
    const payload = action.payload as { steps: PlanStep[] };
    const done: string[] = [];
    // Ordem inversa: uma etapa pode depender de outra (ex.: rotina que aponta para hábito criado antes).
    for (const s of [...steps].reverse()) {
      const h = ACTION_HANDLERS.get(s.kind);
      if (!h?.undo) continue;
      const p = payload.steps[s.index];
      const r = await h.undo(c, ctx, { id: action.id, kind: s.kind, payload: p?.payload, targetId: p?.targetId ?? null, baseVersion: p?.baseVersion ?? null }, s.undo);
      done.push(r.summary);
    }
    return { summary: done.join(' ') || 'Nada para desfazer.' };
  },
};

export const integrationModule: AiModuleDef = {
  id: 'integration',
  name: 'Visão integrada e Minha Semana',
  status: 'available',
  scope: 'consultas agregadas entre módulos (evolução, agenda semanal, contexto pessoal), conflitos de horário e planos que envolvem vários módulos',
  tools: [getLifeOverview, getWeekAgenda, checkConflicts, getPersonalContext, proposeSchedule, proposeLifePlan],
  actions: [plannerItemsHandler, lifePlanHandler],
};
