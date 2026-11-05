// Módulo de alimentação para a IA central (Fase 02): leitura do diário, refeições, alimentos, metas, planejamento e
// totais; PROPOSTAS de refeição, alimentos, metas e planejamento. Nada é gravado sem aprovação; a aprovação usa o mesmo
// serviço das rotas do app (mesmas validações, mesmos valores do catálogo mostrados na prévia) e pode ser desfeita.
//
// Limites: a IA não acessa SQL, não escolhe valores nutricionais de alimentos do catálogo (vêm da TACO ou do cadastro
// da pessoa), não concede XP (o XP de registro é do motor do RPG, quando a pessoa aprova o registro do que comeu) e
// não prescreve dieta: sugestões são sugestões.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PreviewLine, PreviewSection } from '../../../../../shared/assistant/protocol.ts';
import {
  FOOD_STATES,
  MEAL_KINDS,
  MEAL_KIND_LABEL,
  NUTRITION_LIMITS,
  OBJECTIVES,
  OBJECTIVE_LABEL,
  customFoodInputSchema,
  goalsInputSchema,
  itemMacros,
  roundMacros,
  sumMacros,
  type GoalsInput,
  type GoalsView,
  type Macros,
  type MealInput,
  type MealKind,
  type MealStatus,
} from '../../../../../shared/nutrition/protocol.ts';
import type { PoolClient } from '../../db/pool.ts';
import { isApiError } from '../../http/core.ts';
import { runLife, type LifeTx } from '../../life/engine.ts';
import * as N from '../../nutrition/service.ts';
import { addDays, localDate } from './time.ts';
import { StaleError } from './training.ts';
import { ToolError, type ActionHandler, type AiModuleDef, type ReadTool, type ToolContext, type WriteTool } from './types.ts';

type Q = Pick<PoolClient, 'query'>;
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const q = (ctx: ToolContext) => ctx.pool as unknown as Q;

async function todayOf(ctx: ToolContext): Promise<string> {
  const tz = (await q(ctx).query<{ timezone: string }>('SELECT timezone FROM life_profiles WHERE user_id = $1', [ctx.userId])).rows[0]?.timezone ?? ctx.timezone;
  return localDate(ctx.now, tz);
}

async function inLife<T>(c: PoolClient, ctx: ToolContext, fn: (t: LifeTx) => Promise<T>): Promise<T> {
  try {
    return (await runLife(c, ctx.userId, ctx.now, fn)).value;
  } catch (e) {
    if (isApiError(e) && e.code === 'life_stale') throw new StaleError();
    if (isApiError(e)) throw new ToolError(e.code, e.message);
    throw e;
  }
}

const r0 = (v: number) => Math.round(v);
const r1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('pt-BR');
const macroText = (m: Macros) => `${r0(m.kcal)} kcal · P ${r1(m.protein)} g · C ${r1(m.carbs)} g · G ${r1(m.fat)} g`;
/** Versão compacta para o modelo (menos tokens). */
const mx = (m: Macros) => ({ kcal: r0(m.kcal), p: Math.round(m.protein * 10) / 10, c: Math.round(m.carbs * 10) / 10, g: Math.round(m.fat * 10) / 10, fibra: Math.round(m.fiber * 10) / 10 });
const mealBrief = (m: import('../../../../../shared/nutrition/protocol.ts').MealView) => ({
  id: m.id,
  date: m.date,
  kind: m.kind,
  title: m.title,
  time: m.time,
  status: m.status,
  version: m.version,
  totals: mx(m.totals),
  ...(m.plannedTotals ? { planned: mx(m.plannedTotals) } : {}),
  items: m.items.map((i) => ({ foodRef: i.foodRef, name: i.name, quantity: i.quantity, unit: i.unit, kcal: r0(i.totals.kcal), p: i.totals.protein })),
});
const NOTE = 'Valores calculados de tabelas (TACO) e rótulos cadastrados; são estimativas, não análise laboratorial.';

// ------------------------------------------------------------------ leitura

const rangeArgs = z.object({ from: ISO.nullish(), to: ISO.nullish() }).strict();
const RANGE_JSON = { type: 'object', properties: { from: { type: ['string', 'null'], description: 'yyyy-mm-dd' }, to: { type: ['string', 'null'], description: 'yyyy-mm-dd' } }, additionalProperties: false };
function range(a: { from?: string | null; to?: string | null }, today: string, defFrom: string, defTo: string, max = 92): { from: string; to: string } {
  const from = a.from ?? defFrom;
  const to = a.to ?? defTo;
  if (from > to) throw new ToolError('invalid_range', 'A data inicial é depois da final.');
  if (addDays(from, max) < to) throw new ToolError('invalid_range', `Período máximo de ${max} dias.`);
  void today;
  return { from, to };
}

const getDiary: ReadTool<typeof rangeArgs> = {
  kind: 'read',
  name: 'get_food_diary',
  label: 'Consultando seu diário alimentar',
  description: 'Diário alimentar: refeições (consumidas e planejadas separadas) com alimentos, quantidades e totais por dia, água e metas. Padrão: hoje. Use para "o que eu comi hoje/ontem?". Planejadas NÃO são consumo.',
  parameters: RANGE_JSON,
  args: rangeArgs,
  async run(ctx, a) {
    const today = await todayOf(ctx);
    const { from, to } = range(a, today, a.to && a.to < today ? a.to : today, a.from && a.from > today ? a.from : today, 14);
    const meals = await N.mealViews(q(ctx), ctx.userId, { from, to });
    const water = (await q(ctx).query<{ date: string; ml: number }>('SELECT date, ml FROM nutrition_water WHERE user_id = $1 AND date BETWEEN $2 AND $3', [ctx.userId, from, to])).rows;
    const days: Record<string, unknown> = {};
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const ms = meals.filter((m) => m.date === d);
      const consumed = ms.filter((m) => m.status === 'consumed');
      if (!ms.length && !water.some((w) => w.date === d)) continue;
      days[d] = {
        consumed: consumed.map(mealBrief),
        planned: ms.filter((m) => m.status === 'planned').map(mealBrief),
        consumedTotals: mx(sumMacros(consumed.map((m) => m.totals))),
        waterMl: water.find((w) => w.date === d)?.ml ?? null,
      };
    }
    return { today, period: { from, to }, days, daysWithoutRecords: 'Dias ausentes não têm registro: não significa que a pessoa não comeu.', goals: await N.getGoals(q(ctx), ctx.userId), note: NOTE };
  },
};

const recentArgs = z.object({ limit: z.number().int().min(1).max(30).default(10), kind: z.enum(MEAL_KINDS).nullish() }).strict();
const listRecentMeals: ReadTool<typeof recentArgs> = {
  kind: 'read',
  name: 'list_recent_meals',
  label: 'Consultando refeições recentes',
  description: 'Últimas refeições CONSUMIDAS (opcional: de um tipo), com alimentos e quantidades, e as refeições salvas (favoritas). Use para montar sugestões com o que a pessoa costuma comer.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30 }, kind: { type: ['string', 'null'], enum: [...MEAL_KINDS, null] } }, additionalProperties: false },
  args: recentArgs,
  async run(ctx, a) {
    const today = await todayOf(ctx);
    const meals = await N.mealViews(q(ctx), ctx.userId, { from: addDays(today, -60), to: today }, { status: 'consumed', ...(a.kind ? { kind: a.kind } : {}), limit: a.limit });
    const quick = await N.quickView(q(ctx), ctx.userId);
    return {
      meals: meals.map(mealBrief),
      frequentFoods: quick.frequentFoods.map((f) => ({ foodRef: f.ref, name: f.name, lastQuantity: f.lastQuantity, unit: f.baseUnit })),
      savedMeals: quick.savedMeals.map((s) => ({ id: s.id, name: s.name, kind: s.kind, totals: mx(s.totals), items: s.items.map((i) => ({ foodRef: i.foodRef, name: i.name, quantity: i.quantity })) })),
    };
  },
};

const searchArgs = z.object({ query: z.string().trim().max(80).nullish(), onlyMine: z.boolean().nullish(), limit: z.number().int().min(1).max(20).default(8) }).strict();
const searchFoods: ReadTool<typeof searchArgs> = {
  kind: 'read',
  name: 'search_foods',
  label: 'Procurando alimentos',
  description: 'Busca alimentos no catálogo (TACO) e nos cadastrados pela pessoa. Devolve foodRef (use nas propostas), valores por 100 g/ml, preparo (raw = cru, cooked = cozido…), fonte e avisos. onlyMine = só os cadastrados pela pessoa. Prefira o preparo que a pessoa come (ex.: arroz COZIDO).',
  parameters: { type: 'object', properties: { query: { type: ['string', 'null'] }, onlyMine: { type: ['boolean', 'null'] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false },
  args: searchArgs,
  async run(ctx, a) {
    let list;
    if (a.onlyMine) {
      const rows = (await q(ctx).query<N.CustomFoodRow>('SELECT * FROM nutrition_foods WHERE user_id = $1 AND NOT archived ORDER BY lower(name) LIMIT 100', [ctx.userId])).rows;
      const words = a.query ? a.query.toLowerCase() : '';
      list = rows.map((r) => N.customView(r)).filter((f) => !words || f.name.toLowerCase().includes(words)).slice(0, a.limit);
    } else {
      if (!a.query) throw new ToolError('invalid_args', 'Informe o que procurar (query) ou onlyMine.');
      list = await N.searchFoods(q(ctx), ctx.userId, a.query, a.limit);
    }
    return { foods: list.map((f) => ({ foodRef: f.ref, name: f.brand ? `${f.name} (${f.brand})` : f.name, state: f.state, unit: f.baseUnit, per100: f.per100, portions: f.portions, source: f.source.label, hint: f.hint })) };
  },
};

const getGoals: ReadTool = {
  kind: 'read',
  name: 'get_nutrition_goals',
  label: 'Consultando suas metas nutricionais',
  description: 'Metas nutricionais da pessoa (objetivo, calorias, proteínas, carboidratos, gorduras, água), horários preferidos das refeições e preferências/restrições alimentares que ela informou. Respeite sempre as restrições.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  args: z.object({}).strict(),
  async run(ctx) {
    const g = await N.getGoals(q(ctx), ctx.userId);
    if (!g) return { goals: null, note: 'A pessoa ainda não definiu metas nutricionais.' };
    return { goals: { ...g, objectiveLabel: OBJECTIVE_LABEL[g.objective] }, note: 'Metas definidas pela pessoa (a estimativa, se houver, é ponto de partida, não prescrição).' };
  },
};

const getPlan: ReadTool<typeof rangeArgs> = {
  kind: 'read',
  name: 'get_meal_plan',
  label: 'Consultando seu planejamento alimentar',
  description: 'Planejamento alimentar: refeições PLANEJADAS por dia (padrão: hoje + 6 dias) com IDs, horários, alimentos e totais estimados, e o que do planejamento já foi marcado como consumido. Use antes de propor alterações no planejamento.',
  parameters: RANGE_JSON,
  args: rangeArgs,
  async run(ctx, a) {
    const today = await todayOf(ctx);
    const { from, to } = range(a, today, today, addDays(today, 6), 31);
    const meals = await N.mealViews(q(ctx), ctx.userId, { from, to });
    return { today, period: { from, to }, planned: meals.filter((m) => m.status === 'planned').map(mealBrief), consumedFromPlan: meals.filter((m) => m.status === 'consumed' && m.plannedTotals).map(mealBrief) };
  },
};

const getTotals: ReadTool<typeof rangeArgs> = {
  kind: 'read',
  name: 'get_nutrition_totals',
  label: 'Somando sua alimentação no período',
  description: 'Totais e médias de calorias e macronutrientes num período (padrão: últimos 7 dias até hoje): por dia registrado, médias por dia registrado e por semana, distribuição de energia e frequência de registro. Use para "quanto de proteína consumi esta semana?".',
  parameters: RANGE_JSON,
  args: rangeArgs,
  async run(ctx, a) {
    const today = await todayOf(ctx);
    const { from, to } = range(a, today, addDays(today, -6), today);
    const s = await N.statsView(q(ctx), ctx.userId, from, to, today);
    const logged = s.days.filter((d) => d.consumedMeals > 0);
    const sum = logged.reduce((acc, d) => ({ kcal: acc.kcal + d.consumed.kcal, protein: acc.protein + d.consumed.protein, carbs: acc.carbs + d.consumed.carbs, fat: acc.fat + d.consumed.fat, fiber: acc.fiber + d.consumed.fiber }), { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
    return {
      period: { from: s.from, to: s.to },
      loggedDays: s.loggedDays,
      totalDays: s.totalDays,
      totalInLoggedDays: mx(sum),
      averagePerLoggedDay: s.average ? mx(s.average) : null,
      energySplitPct: s.split,
      days: logged.map((d) => ({ date: d.date, meals: d.consumedMeals, ...mx(d.consumed) })),
      weeks: s.weeks.map((w) => ({ start: w.start, loggedDays: w.loggedDays, average: w.average ? mx(w.average) : null })),
      note: `Somente dias com registro entram nas médias (dias sem registro não são consumo zero). ${NOTE}`,
    };
  },
};

const compareGoals: ReadTool<typeof rangeArgs> = {
  kind: 'read',
  name: 'compare_nutrition_goals',
  label: 'Comparando com suas metas',
  description: 'Compara o consumo registrado com as metas da pessoa (padrão: últimos 7 dias): diferença média por dia registrado e dia a dia, mais planejado × consumido. Não julgue: aponte padrões e sugestões práticas.',
  parameters: RANGE_JSON,
  args: rangeArgs,
  async run(ctx, a) {
    const today = await todayOf(ctx);
    const { from, to } = range(a, today, addDays(today, -6), today);
    const s = await N.statsView(q(ctx), ctx.userId, from, to, today);
    const g = s.goals;
    if (!g || (g.kcal == null && g.protein == null)) return { goals: g, note: 'Sem metas de calorias/proteína definidas: compare só com o histórico ou ofereça definir metas.' };
    const diff = (m: Macros) => ({ kcal: g.kcal != null ? r0(m.kcal - g.kcal) : null, protein: g.protein != null ? Math.round(m.protein - g.protein) : null, carbs: g.carbs != null ? Math.round(m.carbs - g.carbs) : null, fat: g.fat != null ? Math.round(m.fat - g.fat) : null });
    return {
      goals: { objective: OBJECTIVE_LABEL[g.objective], kcal: g.kcal, protein: g.protein, carbs: g.carbs, fat: g.fat },
      loggedDays: s.loggedDays,
      totalDays: s.totalDays,
      averageVsGoal: s.average ? diff(s.average) : null,
      byDay: s.days.filter((d) => d.consumedMeals > 0).map((d) => ({ date: d.date, meals: d.consumedMeals, ...diff(d.consumed) })),
      planVsActual: s.planVsActual.map((p) => ({ date: p.date, plannedKcal: p.planned.kcal, consumedKcal: p.consumed.kcal })),
      note: 'Dias com poucas refeições registradas podem estar incompletos: pergunte antes de concluir que a pessoa comeu pouco. Nunca incentive restrição extrema ou compensação.',
    };
  },
};

// ------------------------------------------------------------------ itens propostos

const aiItem = z
  .object({
    foodRef: z.string().max(60).nullish(),
    /** Descrição quando não há foodRef (o servidor procura no catálogo e avisa na prévia). */
    food: z.string().trim().max(80).nullish(),
    quantity: z.number().positive().max(NUTRITION_LIMITS.maxQuantity),
  })
  .strict()
  .refine((i) => !!i.foodRef || !!i.food, { message: 'Informe foodRef ou food.' });
type AiItem = z.infer<typeof aiItem>;
const ITEM_JSON = {
  type: 'object',
  properties: {
    foodRef: { type: ['string', 'null'], description: 'foodRef de search_foods (preferível).' },
    food: { type: ['string', 'null'], description: 'Descrição, se não tiver foodRef (ex.: "arroz cozido").' },
    quantity: { type: 'number', description: 'Quantidade em g (ou ml para líquidos cadastrados em ml).' },
  },
  required: ['quantity'],
  additionalProperties: false,
};
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Resolve os itens propostos em alimentos reais (catálogo/cadastro) e monta a prévia. */
async function resolveAiItems(ctx: ToolContext, items: AiItem[]): Promise<{ resolved: N.ResolvedItem[]; lines: PreviewLine[]; totals: Macros }> {
  const refs: { foodRef: string; quantity: number }[] = [];
  const warnings: string[] = [];
  for (const it of items) {
    if (it.foodRef) {
      refs.push({ foodRef: it.foodRef, quantity: it.quantity });
      continue;
    }
    const [d] = await N.resolveDraft(q(ctx), ctx.userId, [{ label: it.food!, quantity: it.quantity }]);
    if (!d.match) throw new ToolError('food_not_found', `Não encontrei "${it.food}". Use search_foods e passe o foodRef, ou proponha cadastrar o alimento (propose_create_food).`);
    refs.push({ foodRef: d.match.ref, quantity: it.quantity });
    if (d.warning) warnings.push(`${it.food}: ${d.warning}`);
  }
  let resolved: N.ResolvedItem[];
  try {
    resolved = await N.resolveItems(q(ctx), ctx.userId, refs.map((r) => ({ ...r, portionLabel: null, portionCount: null })));
  } catch {
    throw new ToolError('food_not_found', 'Algum foodRef não existe nesta conta ou está arquivado. Use search_foods.');
  }
  const lines: PreviewLine[] = resolved.map((r) => ({ kind: 'add', text: `${r.name} — ${r.quantity.toLocaleString('pt-BR')} ${r.unit} · ${macroText(itemMacros(r.per100, r.quantity))}` }));
  for (const w of warnings) lines.push({ kind: 'info', text: w });
  return { resolved, lines, totals: N.resolvedTotals(resolved) };
}

const asItems = (r: N.ResolvedItem[]) => r.map((i) => ({ foodRef: i.foodRef, quantity: i.quantity, portionLabel: i.portionLabel, portionCount: i.portionCount }));
const mealLabel = (kind: MealKind, name?: string | null) => name ?? MEAL_KIND_LABEL[kind];
const dateBr = (d: string) => d.split('-').reverse().join('/');

// ------------------------------------------------------------------ propostas: refeições

const createMealArgs = z
  .object({
    date: ISO.nullish(),
    kind: z.enum(MEAL_KINDS),
    name: z.string().trim().max(60).nullish(),
    status: z.enum(['consumed', 'planned']),
    time: HHMM.nullish(),
    items: z.array(aiItem).min(1).max(NUTRITION_LIMITS.itemsPerMeal),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict();
const MEAL_JSON_PROPS = {
  date: { type: ['string', 'null'], description: 'yyyy-mm-dd (padrão hoje)' },
  kind: { type: 'string', enum: [...MEAL_KINDS], description: 'breakfast=café da manhã, lunch=almoço, snack=lanche, dinner=jantar, supper=ceia, custom=personalizada (use name).' },
  name: { type: ['string', 'null'] },
  time: { type: ['string', 'null'], description: 'HH:MM' },
  items: { type: 'array', minItems: 1, items: ITEM_JSON },
};

async function checkDate(ctx: ToolContext, date: string, status: MealStatus): Promise<void> {
  const today = await todayOf(ctx);
  if (status === 'consumed' && date > today) throw new ToolError('invalid_args', `Refeição consumida não pode ser no futuro (hoje é ${today}). Use status planned.`);
  if (date < addDays(today, -NUTRITION_LIMITS.pastDays) || date > addDays(today, NUTRITION_LIMITS.futureDays)) throw new ToolError('invalid_args', 'Data fora do período permitido.');
}

const proposeCreateMeal: WriteTool<typeof createMealArgs> = {
  kind: 'write',
  name: 'propose_create_meal',
  label: 'Preparando a refeição',
  description: 'Prepara a PROPOSTA de registrar uma refeição consumida (status consumed) ou planejar uma (status planned), com alimentos e quantidades em g/ml. Para acrescentar a uma refeição que já existe no dia, use propose_add_foods_to_meal. A pessoa aprova antes de salvar.',
  parameters: { type: 'object', properties: { ...MEAL_JSON_PROPS, status: { type: 'string', enum: ['consumed', 'planned'] }, rationale: { type: ['string', 'null'] } }, required: ['kind', 'status', 'items'], additionalProperties: false },
  args: createMealArgs,
  async prepare(ctx, a) {
    const date = a.date ?? (await todayOf(ctx));
    await checkDate(ctx, date, a.status);
    const { resolved, lines, totals } = await resolveAiItems(ctx, a.items);
    const meal: MealInput = { clientId: null, date, kind: a.kind, name: a.name ?? null, time: a.time ?? null, status: a.status, notes: null, items: asItems(resolved) };
    const title = `${a.status === 'planned' ? 'Planejar' : 'Registrar'} ${mealLabel(a.kind, a.name).toLowerCase()} de ${dateBr(date)}`;
    return { kind: 'create_meal', title, rationale: a.rationale ?? null, payload: { meal, resolved, id: randomUUID() }, preview: [{ title: `${mealLabel(a.kind, a.name)}${a.time ? ` · ${a.time}` : ''} · ${a.status === 'planned' ? 'planejada' : 'consumida'}`, lines: [...lines, { kind: 'info', text: `Total: ${macroText(totals)}` }] }], targetId: null, baseVersion: null };
  },
};

const addItemsArgs = z
  .object({ date: ISO.nullish(), kind: z.enum(MEAL_KINDS), status: z.enum(['consumed', 'planned']).default('consumed'), items: z.array(aiItem).min(1).max(20), rationale: z.string().trim().max(600).nullish() })
  .strict();
const proposeAddItems: WriteTool<typeof addItemsArgs> = {
  kind: 'write',
  name: 'propose_add_foods_to_meal',
  label: 'Preparando os alimentos do diário',
  description: 'Prepara a PROPOSTA de adicionar alimentos ao diário numa refeição do dia (ex.: "adicione no meu almoço 150 g de arroz, 120 g de feijão e 160 g de frango"). Se já existe a refeição desse tipo no dia, acrescenta nela; senão cria. Quantidades em g/ml.',
  parameters: { type: 'object', properties: { date: MEAL_JSON_PROPS.date, kind: MEAL_JSON_PROPS.kind, status: { type: 'string', enum: ['consumed', 'planned'] }, items: { type: 'array', minItems: 1, maxItems: 20, items: ITEM_JSON }, rationale: { type: ['string', 'null'] } }, required: ['kind', 'items'], additionalProperties: false },
  args: addItemsArgs,
  async prepare(ctx, a) {
    const date = a.date ?? (await todayOf(ctx));
    await checkDate(ctx, date, a.status);
    const existing = (await q(ctx).query<{ id: string; version: number; name: string | null }>("SELECT id, version, name FROM nutrition_meals WHERE user_id = $1 AND date = $2 AND kind = $3 AND status = $4 ORDER BY created_at LIMIT 1", [ctx.userId, date, a.kind, a.status])).rows[0];
    const { resolved, lines, totals } = await resolveAiItems(ctx, a.items);
    const label = mealLabel(a.kind, existing?.name);
    return {
      kind: 'add_meal_items',
      title: `Adicionar ${resolved.length} alimento(s) ao ${label.toLowerCase()} de ${dateBr(date)}`,
      rationale: a.rationale ?? null,
      payload: { date, kind: a.kind, status: a.status, resolved, mealId: existing?.id ?? null, newId: randomUUID() },
      preview: [{ title: existing ? `${label} (já registrado: acrescentar)` : `${label} (nova refeição ${a.status === 'planned' ? 'planejada' : 'consumida'})`, lines: [...lines, { kind: 'info', text: `Acréscimo: ${macroText(totals)}` }] }],
      targetId: existing?.id ?? null,
      baseVersion: existing?.version ?? null,
    };
  },
};

const updateMealArgs = z
  .object({
    mealId: z.string().uuid(),
    changes: z
      .object({ date: ISO.optional(), kind: z.enum(MEAL_KINDS).optional(), name: z.string().trim().max(60).nullable().optional(), time: HHMM.nullable().optional(), items: z.array(aiItem).max(NUTRITION_LIMITS.itemsPerMeal).optional(), markConsumed: z.boolean().optional() })
      .strict()
      .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' }),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict();
const proposeUpdateMeal: WriteTool<typeof updateMealArgs> = {
  kind: 'write',
  name: 'propose_update_meal',
  label: 'Preparando a correção da refeição',
  description: 'Prepara a PROPOSTA de editar uma refeição (IDs de get_food_diary/get_meal_plan): corrigir quantidades ou alimentos (items substitui a lista inteira, mantendo os que continuam), horário, tipo, data ou marcar uma planejada como consumida (markConsumed).',
  parameters: { type: 'object', properties: { mealId: { type: 'string' }, changes: { type: 'object', properties: { date: { type: 'string' }, kind: MEAL_JSON_PROPS.kind, name: { type: ['string', 'null'] }, time: { type: ['string', 'null'] }, items: { type: 'array', items: ITEM_JSON }, markConsumed: { type: 'boolean' } }, additionalProperties: false }, rationale: { type: ['string', 'null'] } }, required: ['mealId', 'changes'], additionalProperties: false },
  args: updateMealArgs,
  async prepare(ctx, a) {
    const snap = await N.mealSnapshot(q(ctx), ctx.userId, a.mealId);
    if (!snap) throw new ToolError('not_found', 'Refeição não encontrada nesta conta.');
    const ch = a.changes;
    if (ch.markConsumed && snap.row.status !== 'planned') throw new ToolError('invalid_args', 'A refeição já está consumida.');
    if (ch.date) await checkDate(ctx, ch.date, ch.markConsumed ? 'consumed' : snap.row.status);
    else if (ch.markConsumed) await checkDate(ctx, snap.row.date, 'consumed');
    const lines: PreviewLine[] = [];
    let items: N.ResolvedItem[] | null = null;
    if (ch.items) {
      const r = await resolveAiItems(ctx, ch.items);
      items = r.resolved;
      lines.push({ kind: 'change', text: `Alimentos: ${macroText(N.resolvedTotals(snap.items))} → ${macroText(r.totals)}` }, ...r.lines);
    }
    if (ch.time !== undefined) lines.push({ kind: 'change', text: `Horário: ${snap.row.time ?? '—'} → ${ch.time ?? '—'}` });
    if (ch.kind) lines.push({ kind: 'change', text: `Tipo: ${MEAL_KIND_LABEL[snap.row.kind]} → ${MEAL_KIND_LABEL[ch.kind]}` });
    if (ch.name !== undefined) lines.push({ kind: 'change', text: `Nome: ${snap.row.name ?? '—'} → ${ch.name ?? '—'}` });
    if (ch.date) lines.push({ kind: 'change', text: `Data: ${dateBr(snap.row.date)} → ${dateBr(ch.date)}` });
    if (ch.markConsumed) lines.push({ kind: 'change', text: 'Planejada → consumida' });
    const title = ch.markConsumed && Object.keys(ch).length === 1 ? `Marcar ${mealLabel(snap.row.kind, snap.row.name).toLowerCase()} como consumida` : `Corrigir ${mealLabel(snap.row.kind, snap.row.name).toLowerCase()} de ${dateBr(snap.row.date)}`;
    return {
      kind: 'update_meal',
      title,
      rationale: a.rationale ?? null,
      payload: { mealId: snap.row.id, patch: { ...(ch.date ? { date: ch.date } : {}), ...(ch.kind ? { kind: ch.kind } : {}), ...(ch.name !== undefined ? { name: ch.name } : {}), ...(ch.time !== undefined ? { time: ch.time } : {}) }, items, markConsumed: !!ch.markConsumed },
      preview: [{ title: mealLabel(snap.row.kind, snap.row.name), lines }],
      targetId: snap.row.id,
      baseVersion: snap.row.version,
    };
  },
};

// ------------------------------------------------------------------ propostas: alimento e metas

const createFoodArgs = z.object({ food: customFoodInputSchema, rationale: z.string().trim().max(600).nullish() }).strict();
const proposeCreateFood: WriteTool<typeof createFoodArgs> = {
  kind: 'write',
  name: 'propose_create_food',
  label: 'Preparando o cadastro do alimento',
  description: 'Prepara a PROPOSTA de cadastrar um alimento próprio com os dados do RÓTULO informados pela pessoa (valores por 100 g ou 100 ml). Nunca invente valores: se a pessoa não informou, peça os números do rótulo.',
  parameters: {
    type: 'object',
    properties: {
      food: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          brand: { type: ['string', 'null'] },
          state: { type: 'string', enum: [...FOOD_STATES] },
          baseUnit: { type: 'string', enum: ['g', 'ml'] },
          kcal: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' },
          fiber: { type: ['number', 'null'] },
          portionLabel: { type: ['string', 'null'] },
          portionAmount: { type: ['number', 'null'] },
          sourceNote: { type: ['string', 'null'], description: 'Ex.: "rótulo informado pela pessoa".' },
        },
        required: ['name', 'baseUnit', 'kcal', 'protein', 'carbs', 'fat'],
        additionalProperties: false,
      },
      rationale: { type: ['string', 'null'] },
    },
    required: ['food'],
    additionalProperties: false,
  },
  args: createFoodArgs,
  async prepare(ctx, a) {
    const f = a.food;
    const dup = (await q(ctx).query('SELECT 1 FROM nutrition_foods WHERE user_id = $1 AND NOT archived AND lower(name) = lower($2) AND coalesce(lower(brand), \'\') = coalesce(lower($3), \'\')', [ctx.userId, f.name, f.brand])).rowCount;
    if (dup) throw new ToolError('duplicate', 'Já existe um alimento cadastrado com esse nome e marca.');
    const u = f.baseUnit;
    return {
      kind: 'create_food',
      title: `Cadastrar "${f.name}"`,
      rationale: a.rationale ?? null,
      payload: { food: f, id: randomUUID() },
      preview: [{ title: f.brand ? `${f.name} (${f.brand})` : f.name, lines: [{ kind: 'add', text: `Por 100 ${u}: ${macroText({ kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, fiber: f.fiber ?? 0 })}${f.fiber != null ? ` · fibra ${r1(f.fiber)} g` : ''}` }, ...(f.portionLabel ? [{ kind: 'info' as const, text: `Porção: ${f.portionLabel} = ${f.portionAmount} ${u}` }] : []), { kind: 'info', text: `Fonte: ${f.sourceNote ?? 'rótulo informado'}` }] }],
      targetId: null,
      baseVersion: null,
    };
  },
};

const goalsArgs = z
  .object({
    changes: z
      .object({
        objective: z.enum(OBJECTIVES).optional(),
        kcal: z.number().int().min(800).max(6000).nullable().optional(),
        protein: z.number().int().min(10).max(400).nullable().optional(),
        carbs: z.number().int().min(0).max(900).nullable().optional(),
        fat: z.number().int().min(10).max(300).nullable().optional(),
        waterMl: z.number().int().min(500).max(8000).nullable().optional(),
        mealTimes: z.record(z.enum(MEAL_KINDS), HHMM).optional(),
        preferences: z.string().trim().max(500).nullable().optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' }),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict();
const GOAL_LABEL: Record<string, string> = { objective: 'Objetivo', kcal: 'Calorias (kcal)', protein: 'Proteínas (g)', carbs: 'Carboidratos (g)', fat: 'Gorduras (g)', waterMl: 'Água (ml)', mealTimes: 'Horários', preferences: 'Preferências e restrições' };
const proposeGoals: WriteTool<typeof goalsArgs> = {
  kind: 'write',
  name: 'propose_update_nutrition_goals',
  label: 'Preparando o ajuste das metas',
  description: 'Prepara a PROPOSTA de ajustar metas nutricionais (objetivo, calorias, macros, água, horários das refeições, preferências/restrições). Sugira valores moderados e explique as premissas; nunca proponha restrição extrema (abaixo de ~1.200–1.500 kcal) nem compensação.',
  parameters: {
    type: 'object',
    properties: {
      changes: {
        type: 'object',
        properties: {
          objective: { type: 'string', enum: [...OBJECTIVES] },
          kcal: { type: ['integer', 'null'] },
          protein: { type: ['integer', 'null'] },
          carbs: { type: ['integer', 'null'] },
          fat: { type: ['integer', 'null'] },
          waterMl: { type: ['integer', 'null'] },
          mealTimes: { type: 'object', additionalProperties: { type: 'string' }, description: 'Ex.: {"breakfast":"07:00","lunch":"12:30"}' },
          preferences: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      rationale: { type: ['string', 'null'] },
    },
    required: ['changes'],
    additionalProperties: false,
  },
  args: goalsArgs,
  async prepare(ctx, a) {
    const cur = await N.getGoals(q(ctx), ctx.userId);
    const base: GoalsInput = cur ? N.goalsAsInput(cur) : { objective: 'organization', kcal: null, protein: null, carbs: null, fat: null, waterMl: null, mealTimes: {}, preferences: null, estimate: undefined };
    const next = goalsInputSchema.parse({ ...base, ...a.changes, estimate: undefined });
    if (next.kcal != null && next.kcal < 1200) throw new ToolError('unsafe_goal', 'Meta de calorias muito baixa: não proponha abaixo de 1.200 kcal.');
    const fmt = (k: string, v: unknown) => (v == null ? '—' : k === 'objective' ? OBJECTIVE_LABEL[v as keyof typeof OBJECTIVE_LABEL] : k === 'mealTimes' ? Object.entries(v as Record<string, string>).map(([kk, t]) => `${MEAL_KIND_LABEL[kk as MealKind]} ${t}`).join(', ') || '—' : String(v));
    const lines: PreviewLine[] = Object.keys(a.changes).map((k) => ({ kind: 'change', text: `${GOAL_LABEL[k] ?? k}: ${fmt(k, (base as Record<string, unknown>)[k])} → ${fmt(k, (next as Record<string, unknown>)[k])}` }));
    lines.push({ kind: 'info', text: 'Metas são pontos de referência ajustáveis, não prescrição.' });
    return { kind: 'update_nutrition_goals', title: cur ? 'Ajustar metas nutricionais' : 'Definir metas nutricionais', rationale: a.rationale ?? null, payload: { goals: next }, preview: [{ title: 'Metas nutricionais', lines }], targetId: null, baseVersion: cur?.version ?? null };
  },
};

// ------------------------------------------------------------------ propostas: planejamento

const planMeal = z.object({ date: ISO, kind: z.enum(MEAL_KINDS), name: z.string().trim().max(60).nullish(), time: HHMM.nullish(), items: z.array(aiItem).min(1).max(20) }).strict();
const PLAN_MEAL_JSON = { type: 'object', properties: { date: { type: 'string', description: 'yyyy-mm-dd' }, kind: MEAL_JSON_PROPS.kind, name: { type: ['string', 'null'] }, time: { type: ['string', 'null'] }, items: { type: 'array', minItems: 1, maxItems: 20, items: ITEM_JSON } }, required: ['date', 'kind', 'items'], additionalProperties: false };
const createPlanArgs = z.object({ meals: z.array(planMeal).min(1).max(42), rationale: z.string().trim().max(600).nullish() }).strict();

async function planSections(ctx: ToolContext, meals: z.infer<typeof planMeal>[], today: string): Promise<{ inputs: { meal: MealInput; resolved: N.ResolvedItem[] }[]; sections: PreviewSection[] }> {
  const inputs: { meal: MealInput; resolved: N.ResolvedItem[] }[] = [];
  const byDay = new Map<string, PreviewLine[]>();
  const dayTotals = new Map<string, Macros[]>();
  for (const m of meals) {
    if (m.date < today || m.date > addDays(today, NUTRITION_LIMITS.futureDays)) throw new ToolError('invalid_args', `Planejamento só de hoje (${today}) até ${NUTRITION_LIMITS.futureDays} dias à frente.`);
    const r = await resolveAiItems(ctx, m.items);
    inputs.push({ meal: { clientId: null, date: m.date, kind: m.kind, name: m.name ?? null, time: m.time ?? null, status: 'planned', notes: null, items: asItems(r.resolved) }, resolved: r.resolved });
    const lines = byDay.get(m.date) ?? [];
    lines.push({ kind: 'add', text: `${m.time ? `${m.time} ` : ''}${mealLabel(m.kind, m.name)}: ${r.resolved.map((i) => `${i.name.split(',')[0]} ${i.quantity}${i.unit}`).join(', ')} (${r0(r.totals.kcal)} kcal)` });
    byDay.set(m.date, lines);
    dayTotals.set(m.date, [...(dayTotals.get(m.date) ?? []), r.totals]);
  }
  const days = [...byDay.keys()].sort();
  if (days.length > NUTRITION_LIMITS.planDays) throw new ToolError('invalid_args', `Planejamento de no máximo ${NUTRITION_LIMITS.planDays} dias por proposta.`);
  const sections = days.map((d) => {
    const t = roundMacros((dayTotals.get(d) ?? []).reduce((s, m) => ({ kcal: s.kcal + m.kcal, protein: s.protein + m.protein, carbs: s.carbs + m.carbs, fat: s.fat + m.fat, fiber: s.fiber + m.fiber }), { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }));
    return { title: `${dateBr(d)} · ${macroText(t)}`, lines: byDay.get(d)! };
  });
  return { inputs, sections };
}

const proposeCreatePlan: WriteTool<typeof createPlanArgs> = {
  kind: 'write',
  name: 'propose_create_meal_plan',
  label: 'Montando o planejamento alimentar',
  description: 'Prepara a PROPOSTA de um planejamento alimentar (um dia ou a semana): refeições PLANEJADAS por data, com alimentos e quantidades. Nada vira consumo: a pessoa marca como consumida depois. Antes, consulte get_nutrition_goals (objetivo, horários, restrições) e list_recent_meals (o que ela costuma comer). É sugestão, não prescrição.',
  parameters: { type: 'object', properties: { meals: { type: 'array', minItems: 1, maxItems: 42, items: PLAN_MEAL_JSON }, rationale: { type: ['string', 'null'] } }, required: ['meals'], additionalProperties: false },
  args: createPlanArgs,
  async prepare(ctx, a) {
    const today = await todayOf(ctx);
    const { inputs, sections } = await planSections(ctx, a.meals, today);
    const days = new Set(a.meals.map((m) => m.date)).size;
    return { kind: 'create_meal_plan', title: days === 1 ? `Planejar a alimentação de ${dateBr(a.meals[0].date)}` : `Planejar a alimentação de ${days} dias`, rationale: a.rationale ?? null, payload: { meals: inputs, ids: inputs.map(() => randomUUID()) }, preview: [...sections, { title: 'Importante', lines: [{ kind: 'info', text: 'Refeições planejadas não contam como consumo até você marcá-las.' }] }], targetId: null, baseVersion: null };
  },
};

const updatePlanArgs = z
  .object({
    remove: z.array(z.string().uuid()).max(42).default([]),
    update: z.array(z.object({ mealId: z.string().uuid(), time: HHMM.nullable().optional(), items: z.array(aiItem).min(1).max(20).optional() }).strict()).max(42).default([]),
    add: z.array(planMeal).max(42).default([]),
    rationale: z.string().trim().max(600).nullish(),
  })
  .strict()
  .refine((p) => p.remove.length + p.update.length + p.add.length > 0, { message: 'nenhuma alteração' });
const proposeUpdatePlan: WriteTool<typeof updatePlanArgs> = {
  kind: 'write',
  name: 'propose_update_meal_plan',
  label: 'Preparando o ajuste do planejamento',
  description: 'Prepara a PROPOSTA de modificar o planejamento existente (IDs de get_meal_plan): remover refeições planejadas, trocar alimentos/quantidades ou horário (update), e acrescentar refeições planejadas (add). Só altera refeições ainda PLANEJADAS.',
  parameters: { type: 'object', properties: { remove: { type: 'array', items: { type: 'string' } }, update: { type: 'array', items: { type: 'object', properties: { mealId: { type: 'string' }, time: { type: ['string', 'null'] }, items: { type: 'array', items: ITEM_JSON } }, required: ['mealId'], additionalProperties: false } }, add: { type: 'array', items: PLAN_MEAL_JSON }, rationale: { type: ['string', 'null'] } }, additionalProperties: false },
  args: updatePlanArgs,
  async prepare(ctx, a) {
    const today = await todayOf(ctx);
    const touched = [...new Set([...a.remove, ...a.update.map((u) => u.mealId)])];
    const versions: Record<string, number> = {};
    const sections: PreviewSection[] = [];
    const removeLines: PreviewLine[] = [];
    for (const id of touched) {
      const s = await N.mealSnapshot(q(ctx), ctx.userId, id);
      if (!s) throw new ToolError('not_found', `Refeição ${id} não encontrada.`);
      if (s.row.status !== 'planned') throw new ToolError('invalid_args', `"${mealLabel(s.row.kind, s.row.name)}" de ${dateBr(s.row.date)} já foi consumida: use propose_update_meal.`);
      versions[id] = s.row.version;
      if (a.remove.includes(id)) removeLines.push({ kind: 'remove', text: `${dateBr(s.row.date)} · ${mealLabel(s.row.kind, s.row.name)} (${r0(N.resolvedTotals(s.items).kcal)} kcal)` });
    }
    if (removeLines.length) sections.push({ title: 'Remover do planejamento', lines: removeLines });
    const updates: { mealId: string; time?: string | null; items: N.ResolvedItem[] | null }[] = [];
    for (const u of a.update) {
      if (a.remove.includes(u.mealId)) throw new ToolError('invalid_args', 'A mesma refeição não pode ser removida e alterada.');
      const s = (await N.mealSnapshot(q(ctx), ctx.userId, u.mealId))!;
      const lines: PreviewLine[] = [];
      let items: N.ResolvedItem[] | null = null;
      if (u.items) {
        const r = await resolveAiItems(ctx, u.items);
        items = r.resolved;
        lines.push({ kind: 'change', text: `${r0(N.resolvedTotals(s.items).kcal)} kcal → ${r0(r.totals.kcal)} kcal` }, ...r.lines);
      }
      if (u.time !== undefined) lines.push({ kind: 'change', text: `Horário: ${s.row.time ?? '—'} → ${u.time ?? '—'}` });
      updates.push({ mealId: u.mealId, ...(u.time !== undefined ? { time: u.time } : {}), items });
      sections.push({ title: `${dateBr(s.row.date)} · ${mealLabel(s.row.kind, s.row.name)}`, lines });
    }
    const added = a.add.length ? await planSections(ctx, a.add, today) : { inputs: [], sections: [] };
    for (const s of added.sections) sections.push({ title: `Novo: ${s.title}`, lines: s.lines });
    return { kind: 'update_meal_plan', title: 'Ajustar o planejamento alimentar', rationale: a.rationale ?? null, payload: { remove: a.remove, updates, add: added.inputs, addIds: added.inputs.map(() => randomUUID()), versions }, preview: sections, targetId: null, baseVersion: null };
  },
};

// ------------------------------------------------------------------ aplicação e desfazer

const createdUndo = async (t: LifeTx, ids: string[], versions: Record<string, number>) => {
  for (const id of ids) {
    const m = await N.getMeal(t.c, t.userId, id, true);
    if (m && m.version !== versions[id]) throw new StaleError();
  }
  for (const id of ids) if (await N.getMeal(t.c, t.userId, id)) await N.deleteMeal(t, id);
};

const mealCreate: ActionHandler = {
  kind: 'create_meal',
  async apply(c, ctx, action) {
    const { meal, resolved, id } = action.payload as { meal: MealInput; resolved: N.ResolvedItem[]; id: string };
    const r = await inLife(c, ctx, (t) => N.createMeal(t, meal, 'ai', { id, resolved }));
    const v = (await N.getMeal(c, ctx.userId, r.id))!.version;
    return { collection: 'meals', entityId: r.id, summary: `${mealLabel(meal.kind, meal.name)} de ${dateBr(meal.date)} ${meal.status === 'planned' ? 'planejado' : 'registrado'} (${r0(N.resolvedTotals(resolved).kcal)} kcal).`, undo: { ids: [r.id], versions: { [r.id]: v }, date: meal.date } };
  },
  async undo(c, ctx, _a, u) {
    const { ids, versions } = u as { ids: string[]; versions: Record<string, number> };
    await inLife(c, ctx, (t) => createdUndo(t, ids, versions));
    return { summary: 'Refeição removida do diário.' };
  },
};

const mealAddItems: ActionHandler = {
  kind: 'add_meal_items',
  async apply(c, ctx, action) {
    const p = action.payload as { date: string; kind: MealKind; status: MealStatus; resolved: N.ResolvedItem[]; mealId: string | null; newId: string };
    return inLife(c, ctx, async (t) => {
      if (p.mealId) {
        const s = await N.mealSnapshot(t.c, t.userId, p.mealId, true);
        if (!s || s.row.version !== action.baseVersion) throw new StaleError();
        const r = await N.updateMeal(t, s.row.id, { items: asItems([...s.items, ...p.resolved]) }, s.row.version);
        return { collection: 'meals' as const, entityId: s.row.id, summary: `${p.resolved.length} alimento(s) adicionados ao ${mealLabel(s.row.kind, s.row.name).toLowerCase()}.`, undo: { restore: r.before, version: r.after.version } };
      }
      const r = await N.createMeal(t, { clientId: null, date: p.date, kind: p.kind, name: null, time: null, status: p.status, notes: null, items: asItems(p.resolved) }, 'ai', { id: p.newId, resolved: p.resolved });
      return { collection: 'meals' as const, entityId: r.id, summary: `${mealLabel(p.kind)} de ${dateBr(p.date)} registrado com ${p.resolved.length} alimento(s).`, undo: { ids: [r.id], versions: { [r.id]: 1 } } };
    });
  },
  async undo(c, ctx, _a, u) {
    const x = u as { restore?: N.MealSnapshot; version?: number; ids?: string[]; versions?: Record<string, number> };
    await inLife(c, ctx, async (t) => {
      if (x.ids) return createdUndo(t, x.ids, x.versions!);
      const cur = await N.getMeal(t.c, t.userId, x.restore!.row.id, true);
      if (!cur || cur.version !== x.version) throw new StaleError();
      await N.restoreMeal(t, x.restore!);
    });
    return { summary: 'Alimentos adicionados foram retirados.' };
  },
};

const mealUpdate: ActionHandler = {
  kind: 'update_meal',
  async apply(c, ctx, action) {
    const p = action.payload as { mealId: string; patch: Record<string, unknown>; items: N.ResolvedItem[] | null; markConsumed: boolean };
    return inLife(c, ctx, async (t) => {
      const before = await N.mealSnapshot(t.c, t.userId, p.mealId, true);
      if (!before || before.row.version !== action.baseVersion) throw new StaleError();
      let version = before.row.version;
      // Consome ANTES de corrigir: o planejado guardado é o original (comparação planejado × real fica fiel).
      if (p.markConsumed) version = (await N.consumeMeal(t, p.mealId, { version, ...(p.patch.date ? { date: p.patch.date as string } : {}) })).version;
      if (Object.keys(p.patch).length || p.items) version = (await N.updateMeal(t, p.mealId, { ...p.patch, ...(p.items ? { items: asItems(p.items) } : {}) }, version)).after.version;
      return { collection: 'meals' as const, entityId: p.mealId, summary: `${mealLabel(before.row.kind, before.row.name)} atualizado.`, undo: { restore: before, version } };
    });
  },
  async undo(c, ctx, _a, u) {
    const { restore, version } = u as { restore: N.MealSnapshot; version: number };
    await inLife(c, ctx, async (t) => {
      const cur = await N.getMeal(t.c, t.userId, restore.row.id, true);
      if (!cur || cur.version !== version) throw new StaleError();
      await N.restoreMeal(t, restore);
    });
    return { summary: 'Refeição voltou como estava.' };
  },
};

const foodCreate: ActionHandler = {
  kind: 'create_food',
  async apply(c, ctx, action) {
    const { food, id } = action.payload as { food: unknown; id: string };
    const row = await N.createCustomFood(c, ctx.userId, customFoodInputSchema.parse(food), 'ai', id);
    return { collection: 'foods', entityId: row.id, summary: `Alimento "${row.name}" cadastrado.`, undo: { id: row.id, version: row.version } };
  },
  async undo(c, ctx, _a, u) {
    const { id, version } = u as { id: string; version: number };
    const f = await N.getCustomFood(c, ctx.userId, id, true);
    if (!f) return { summary: 'O alimento já não existia.' };
    if (f.version !== version) throw new StaleError();
    const used = (await c.query("SELECT 1 FROM nutrition_meal_items WHERE user_id = $1 AND food_ref = $2 LIMIT 1", [ctx.userId, `custom:${id}`])).rowCount;
    if (used) await c.query('UPDATE nutrition_foods SET archived = true, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2', [ctx.userId, id]);
    else {
      await c.query('DELETE FROM nutrition_food_favorites WHERE user_id = $1 AND food_ref = $2', [ctx.userId, `custom:${id}`]);
      await c.query('DELETE FROM nutrition_foods WHERE user_id = $1 AND id = $2', [ctx.userId, id]);
    }
    return { summary: used ? `Alimento "${f.name}" arquivado (já estava no diário).` : `Alimento "${f.name}" removido.` };
  },
};

const goalsUpdate: ActionHandler = {
  kind: 'update_nutrition_goals',
  async apply(c, ctx, action) {
    const { goals } = action.payload as { goals: unknown };
    const r = await inLife(c, ctx, async (t) => {
      // Proposta feita sem metas, mas metas foram criadas depois: pede para refazer (não sobrescreve sem ver).
      if (action.baseVersion == null && (await N.getGoals(t.c, t.userId))) throw new StaleError();
      return N.saveGoals(t.c, t.userId, goalsInputSchema.parse(goals), 'ai', action.baseVersion);
    });
    return { collection: 'nutrition_goals', entityId: ctx.userId, summary: 'Metas nutricionais atualizadas.', undo: { before: r.before, version: r.after.version } };
  },
  async undo(c, ctx, _a, u) {
    const { before, version } = u as { before: GoalsView | null; version: number };
    const cur = await N.getGoals(c, ctx.userId, true);
    if (!cur || cur.version !== version) throw new StaleError();
    await N.restoreGoals(c, ctx.userId, before);
    return { summary: before ? 'Metas voltaram como estavam.' : 'Metas removidas.' };
  },
};

const planCreate: ActionHandler = {
  kind: 'create_meal_plan',
  async apply(c, ctx, action) {
    const { meals, ids } = action.payload as { meals: { meal: MealInput; resolved: N.ResolvedItem[] }[]; ids: string[] };
    await inLife(c, ctx, async (t) => {
      for (let i = 0; i < meals.length; i++) {
        if (meals[i].meal.date < t.today) throw new ToolError('invalid_args', 'O planejamento ficou para trás (datas passadas).');
        await N.createMeal(t, { ...meals[i].meal, status: 'planned' }, 'ai', { id: ids[i], resolved: meals[i].resolved });
      }
    });
    return { collection: 'meal_plan', entityId: ids[0], summary: `Planejamento criado: ${meals.length} refeição(ões) planejada(s).`, undo: { ids, versions: Object.fromEntries(ids.map((id) => [id, 1])) } };
  },
  async undo(c, ctx, _a, u) {
    const { ids, versions } = u as { ids: string[]; versions: Record<string, number> };
    await inLife(c, ctx, (t) => createdUndo(t, ids, versions));
    return { summary: 'Planejamento removido.' };
  },
};

const planUpdate: ActionHandler = {
  kind: 'update_meal_plan',
  async apply(c, ctx, action) {
    const p = action.payload as { remove: string[]; updates: { mealId: string; time?: string | null; items: N.ResolvedItem[] | null }[]; add: { meal: MealInput; resolved: N.ResolvedItem[] }[]; addIds: string[]; versions: Record<string, number> };
    return inLife(c, ctx, async (t) => {
      const restore: N.MealSnapshot[] = [];
      const after: Record<string, number> = {};
      for (const [id, v] of Object.entries(p.versions)) {
        const s = await N.mealSnapshot(t.c, t.userId, id, true);
        if (!s || s.row.version !== v || s.row.status !== 'planned') throw new StaleError();
        restore.push(s);
      }
      for (const id of p.remove) await N.deleteMeal(t, id);
      for (const u of p.updates) after[u.mealId] = (await N.updateMeal(t, u.mealId, { ...(u.time !== undefined ? { time: u.time } : {}), ...(u.items ? { items: asItems(u.items) } : {}) })).after.version;
      for (let i = 0; i < p.add.length; i++) {
        await N.createMeal(t, { ...p.add[i].meal, status: 'planned' }, 'ai', { id: p.addIds[i], resolved: p.add[i].resolved });
        after[p.addIds[i]] = 1;
      }
      return { collection: 'meal_plan' as const, entityId: p.addIds[0] ?? p.updates[0]?.mealId ?? p.remove[0], summary: 'Planejamento ajustado.', undo: { restore, after, removed: p.remove, added: p.addIds } };
    });
  },
  async undo(c, ctx, _a, u) {
    const x = u as { restore: N.MealSnapshot[]; after: Record<string, number>; removed: string[]; added: string[] };
    await inLife(c, ctx, async (t) => {
      for (const [id, v] of Object.entries(x.after)) {
        const m = await N.getMeal(t.c, t.userId, id, true);
        if (!m || m.version !== v) throw new StaleError();
      }
      for (const id of x.removed) if (await N.getMeal(t.c, t.userId, id)) throw new StaleError();
      for (const id of x.added) await N.deleteMeal(t, id);
      for (const s of x.restore) await N.restoreMeal(t, s);
    });
    return { summary: 'Planejamento voltou como estava.' };
  },
};

export const nutritionModule: AiModuleDef = {
  id: 'nutrition',
  name: 'Alimentação: diário, alimentos, metas e planejamento',
  status: 'available',
  scope: 'diário alimentar (refeições consumidas e planejadas), alimentos do catálogo TACO e cadastrados, calorias e macronutrientes, metas nutricionais, água, planejamento alimentar, comparação planejado × consumido',
  tools: [getDiary, listRecentMeals, searchFoods, getGoals, getPlan, getTotals, compareGoals, proposeCreateMeal, proposeAddItems, proposeUpdateMeal, proposeCreateFood, proposeGoals, proposeCreatePlan, proposeUpdatePlan],
  actions: [mealCreate, mealAddItems, mealUpdate, foodCreate, goalsUpdate, planCreate, planUpdate],
};
