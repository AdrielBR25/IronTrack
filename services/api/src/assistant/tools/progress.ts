// Metas e medidas corporais (módulos já existentes no app): só leitura nesta fase.
import { z } from 'zod';
import { exerciseStats, loadCompletedSessions, loadDocs } from './records.ts';
import { addDays, localDate, localMidnight, mondayOf } from './time.ts';
import type { AiModuleDef, ReadTool, ToolContext } from './types.ts';

type Doc = Record<string, unknown>;

/** Progresso aproximado de uma meta, calculado dos treinos sincronizados (a tela de Metas é a referência). */
async function goalProgress(ctx: ToolContext, g: Doc): Promise<Record<string, unknown>> {
  const tz = ctx.timezone;
  const today = localDate(ctx.now, tz);
  const start = typeof g.startDate === 'string' ? g.startDate : today;
  const fromMs = localMidnight(start, tz);
  const toMs = localMidnight(addDays(today, 1), tz);
  const target = typeof g.targetValue === 'number' ? g.targetValue : null;
  const type = g.type;
  if (type === 'weekly_frequency') {
    const monday = mondayOf(today);
    const s = await loadCompletedSessions(ctx.pool, ctx.userId, localMidnight(monday, tz), toMs, 50);
    return { current: s.length, target, unit: 'treinos nesta semana', achieved: target !== null && s.length >= target, weekStart: monday };
  }
  if (type === 'session_count') {
    const days = typeof (g.params as Doc | undefined)?.windowDays === 'number' ? ((g.params as Doc).windowDays as number) : 30;
    const end = Math.min(toMs, localMidnight(addDays(start, days), tz));
    const s = await loadCompletedSessions(ctx.pool, ctx.userId, fromMs, end, 500);
    return { current: s.length, target, unit: 'treinos na janela', windowEnds: addDays(start, days - 1), achieved: target !== null && s.length >= target };
  }
  const ex = g.exercise as Doc | null;
  const templateIds = Array.isArray(ex?.templateIds) ? (ex!.templateIds as string[]) : [];
  if (!templateIds.length) return { current: null, note: 'Meta sem exercício associado.' };
  const sessions = await loadCompletedSessions(ctx.pool, ctx.userId, fromMs, toMs, 500);
  let best: number | null = null;
  let bestDate: string | null = null;
  const minLoad = typeof (g.params as Doc | undefined)?.minLoadKg === 'number' ? ((g.params as Doc).minLoadKg as number) : null;
  for (const s of sessions)
    for (const e of s.exercises) {
      if (!e.templateId || !templateIds.includes(e.templateId)) continue;
      const st = exerciseStats(e);
      let v: number | null = null;
      if (type === 'max_load') v = st.bestWeightKg;
      else if (type === 'e1rm') v = st.e1rmKg;
      else if (type === 'reps') {
        const reps = e.sets.filter((x) => x.status === 'done' && x.type !== 'warmup' && (minLoad === null || (typeof x.weight === 'number' && x.weight >= minLoad))).map((x) => (typeof x.reps === 'number' ? x.reps : 0));
        v = reps.length ? Math.max(...reps) : null;
      } else if (type === 'duration') v = Math.max(0, ...e.sets.filter((x) => x.status === 'done').map((x) => (typeof x.durationSec === 'number' ? x.durationSec : 0))) || null;
      else if (type === 'distance') v = Math.max(0, ...e.sets.filter((x) => x.status === 'done').map((x) => (typeof x.distance === 'number' ? x.distance : 0))) || null;
      if (v !== null && (best === null || v > best)) {
        best = v;
        bestDate = localDate(s.startedAt, tz);
      }
    }
  return { current: best, bestDate, target, unit: g.unit ?? null, achieved: best !== null && target !== null && best >= target };
}

const listGoals: ReadTool<z.ZodObject<{ includeArchived: z.ZodOptional<z.ZodBoolean> }>> = {
  kind: 'read',
  name: 'list_goals',
  label: 'Consultando suas metas',
  description: 'Metas de treino com tipo, alvo, prazo, estado e progresso calculado a partir dos treinos registrados (aproximado; a tela de Metas é a referência).',
  parameters: { type: 'object', properties: { includeArchived: { type: 'boolean' } }, additionalProperties: false },
  args: z.object({ includeArchived: z.boolean().optional() }).strict(),
  async run(ctx, a) {
    const goals = (await loadDocs(ctx.pool, 'goals', ctx.userId, 60)).filter((g) => a.includeArchived || g.status !== 'archived');
    const today = localDate(ctx.now, ctx.timezone);
    const out = [];
    for (const g of goals.slice(0, 30)) {
      out.push({
        title: g.title,
        type: g.type,
        status: g.status,
        exercise: (g.exercise as Doc | null)?.name ?? null,
        target: g.targetValue,
        unit: g.unit,
        startDate: g.startDate,
        targetDate: g.targetDate ?? null,
        deadlinePassed: typeof g.targetDate === 'string' ? g.targetDate < today : false,
        progress: g.status === 'active' ? await goalProgress(ctx, g) : null,
      });
    }
    return { goals: out, total: out.length, ...(out.length ? {} : { note: 'Nenhuma meta cadastrada.' }) };
  },
};

const BODY_FIELDS = ['weightKg', 'bodyFatPct', 'leanMassKg', 'fatMassKg', 'waistCm', 'abdomenCm', 'hipCm', 'armCm', 'thighCm', 'bmi'] as const;

const bodyMeasurements: ReadTool<z.ZodObject<{ limit: z.ZodOptional<z.ZodNumber> }>> = {
  kind: 'read',
  name: 'get_body_measurements',
  label: 'Consultando suas medidas',
  description: 'Avaliações corporais registradas (peso, % de gordura, massa magra, circunferências), da mais recente para a mais antiga, e a variação entre a primeira e a última do recorte. Fotos nunca são enviadas.',
  parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 24 } }, additionalProperties: false },
  args: z.object({ limit: z.number().int().min(1).max(24).optional() }).strict(),
  async run(ctx, a) {
    const rows = await loadDocs(ctx.pool, 'body_measurements', ctx.userId, a.limit ?? 12);
    const entries = rows.map((r) => Object.fromEntries([['date', r.date], ...BODY_FIELDS.filter((f) => typeof r[f] === 'number').map((f) => [f, r[f]])]));
    const change: Record<string, number> = {};
    if (entries.length >= 2) {
      const last = entries[0];
      const first = entries[entries.length - 1];
      for (const f of BODY_FIELDS) if (typeof last[f] === 'number' && typeof first[f] === 'number') change[f] = Math.round(((last[f] as number) - (first[f] as number)) * 10) / 10;
    }
    return { entries, changeFirstToLast: entries.length >= 2 ? { from: entries[entries.length - 1].date, to: entries[0].date, ...change } : null, ...(entries.length ? {} : { note: 'Nenhuma avaliação corporal registrada.' }) };
  },
};

export const goalsModule: AiModuleDef = { id: 'goals', name: 'Metas de treino', status: 'available', scope: 'metas de frequência, sessões, carga, repetições, 1RM, duração e distância', tools: [listGoals], actions: [] };
export const bodyModule: AiModuleDef = { id: 'body', name: 'Medidas corporais', status: 'available', scope: 'avaliações corporais (peso, gordura, circunferências)', tools: [bodyMeasurements], actions: [] };
