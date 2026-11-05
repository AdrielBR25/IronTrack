// Módulo RPG para a IA central (Fase 01): leitura do perfil, missões, hábitos, rotinas, progresso e conquistas, e
// PROPOSTAS de criação/edição (hábitos, rotinas, missões, metas, pausas). Nada é gravado sem aprovação; a aprovação usa
// o mesmo serviço das rotas do app (mesmas validações). A IA NUNCA concede XP: não há ferramenta para isso, missões
// propostas por ela recebem a recompensa calculada pelo servidor e o XP só nasce quando a pessoa cumpre a atividade.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PreviewLine, PreviewSection } from '../../../../../shared/assistant/protocol.ts';
import {
  ATTRIBUTES,
  ATTRIBUTE_LABEL,
  ICONS,
  MISSION_UNITS,
  ROUTINE_KINDS,
  ROUTINE_KIND_LABEL,
  TAGS,
  UNIT_LABEL,
  defaultMissionXp,
  habitInputSchema,
  habitPatchSchema,
  missionInputSchema,
  missionPatchSchema,
  routineInputSchema,
  routinePatchSchema,
  type HabitInput,
  type MissionInput,
} from '../../../../../shared/life/protocol.ts';
import type { PoolClient } from '../../db/pool.ts';
import { isApiError } from '../../http/core.ts';
import { recomputeMission, runLife, streakOf, weekOf, type LifeTx, type MissionRow, type ProfileRow } from '../../life/engine.ts';
import * as L from '../../life/service.ts';
import { addDays, localDate } from './time.ts';
import { StaleError } from './training.ts';
import { ToolError, type ActionHandler, type AiModuleDef, type ReadTool, type ToolContext, type WriteTool } from './types.ts';

type Q = Pick<PoolClient, 'query'>;
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const daysText = (d: number[]) => (d.length === 7 ? 'todos os dias' : d.map((x) => WEEKDAYS[x]).join(', '));

/** Perfil e "hoje" da pessoa sem criar nada (leitura). */
async function lifeCtx(ctx: ToolContext): Promise<{ q: Q; profile: ProfileRow | null; tz: string; today: string }> {
  const q = ctx.pool as unknown as Q;
  const p = (await q.query<ProfileRow>('SELECT * FROM life_profiles WHERE user_id = $1', [ctx.userId])).rows[0] ?? null;
  const tz = p?.timezone ?? ctx.timezone;
  return { q, profile: p, tz, today: localDate(ctx.now, tz) };
}
const NO_PROFILE = { note: 'A pessoa ainda não abriu o RPG (tela Início no modo conta). Não há perfil, hábitos ou missões registrados.' };

/** Executa uma escrita do RPG dentro da transação da aprovação, convertendo erros do serviço. */
async function inLife<T>(c: PoolClient, ctx: ToolContext, fn: (t: LifeTx) => Promise<T>): Promise<T> {
  try {
    return (await runLife(c, ctx.userId, ctx.now, fn)).value;
  } catch (e) {
    if (isApiError(e) && e.code === 'life_stale') throw new StaleError();
    if (isApiError(e)) throw new ToolError(e.code, e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ leitura

const getProfile: ReadTool = {
  kind: 'read',
  name: 'get_rpg_profile',
  label: 'Consultando seu personagem',
  description: 'Perfil RPG da pessoa: nível, XP total e para o próximo nível, título, atributos (Força, Conhecimento, Disciplina, Saúde, Espiritualidade), sequência de consistência e XP de hoje. Atributos medem atividades registradas, não avaliação clínica.',
  parameters: NO_ARGS,
  args: z.object({}).strict(),
  async run(ctx) {
    const { q, profile, today } = await lifeCtx(ctx);
    if (!profile) return NO_PROFILE;
    const v = await L.profileView(q, profile, today);
    return { ...v, note: 'XP só é gerado por atividades cumpridas no app; a IA não concede XP.' };
  },
};

const listMissions: ReadTool<z.ZodObject<{ scope: z.ZodDefault<z.ZodEnum<['today', 'week', 'current', 'history']>> }>> = {
  kind: 'read',
  name: 'list_life_missions',
  label: 'Consultando suas missões',
  description: 'Missões da pessoa. scope: today (diárias de hoje + personalizadas ativas), week (semanais), current (todas em andamento), history (encerradas). Cada uma com progresso/meta, prazo, recompensa e estado.',
  parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['today', 'week', 'current', 'history'] } }, additionalProperties: false },
  args: z.object({ scope: z.enum(['today', 'week', 'current', 'history']).default('current') }).strict(),
  async run(ctx, a) {
    const { q, profile, today } = await lifeCtx(ctx);
    if (!profile) return NO_PROFILE;
    const all = await L.missionViews(q, ctx.userId, a.scope === 'history' ? 'history' : 'current', today);
    const list = a.scope === 'today' ? all.filter((m) => (m.type === 'daily' && m.startsOn === today) || m.type === 'custom' || m.type === 'special') : a.scope === 'week' ? all.filter((m) => m.type === 'weekly') : all;
    const habits = a.scope === 'today' ? (await L.habitViews(q, ctx.userId, today)).filter((h) => h.status === 'active' && h.today.scheduled).map((h) => ({ id: h.id, name: h.name, done: h.today.completed, amount: h.today.amount, target: h.goalTarget, unit: h.goalUnit })) : undefined;
    return { today, missions: list.map((m) => ({ id: m.id, type: m.type, title: m.title, progress: m.progress, target: m.target, unit: m.unit, status: m.status, endsOn: m.endsOn, xp: m.xp, attribute: m.attribute, version: m.version })), ...(habits ? { habitsToday: habits } : {}), note: 'Missões diárias automáticas são geradas quando a pessoa abre o app no dia.' };
  },
};

const listHabits: ReadTool<z.ZodObject<{ includeArchived: z.ZodOptional<z.ZodBoolean> }>> = {
  kind: 'read',
  name: 'list_habits',
  label: 'Consultando seus hábitos',
  description: 'Hábitos com IDs, categoria (atributo), frequência, dias, meta, horário, XP, estado (ativo/pausado/arquivado), registro de hoje, cumprimentos na semana e sequência. Use antes de propor edições.',
  parameters: { type: 'object', properties: { includeArchived: { type: 'boolean' } }, additionalProperties: false },
  args: z.object({ includeArchived: z.boolean().optional() }).strict(),
  async run(ctx, a) {
    const { q, profile, today } = await lifeCtx(ctx);
    if (!profile) return NO_PROFILE;
    const list = await L.habitViews(q, ctx.userId, today, { includeArchived: !!a.includeArchived });
    return { today, habits: list, total: list.length };
  },
};

const listRoutines: ReadTool = {
  kind: 'read',
  name: 'list_life_routines',
  label: 'Consultando suas rotinas',
  description: 'Rotinas do dia a dia (matinal, estudos, treino, noturna, personalizadas) com IDs, dias, estado e atividades (horário, duração, vínculo com hábito/missão, feita hoje). Não confundir com as fichas de treino (list_routines).',
  parameters: NO_ARGS,
  args: z.object({}).strict(),
  async run(ctx) {
    const { q, profile, today } = await lifeCtx(ctx);
    if (!profile) return NO_PROFILE;
    return { today, routines: await L.routineViews(q, ctx.userId, today) };
  },
};

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const getProgress: ReadTool<z.ZodObject<{ from: z.ZodOptional<z.ZodNullable<z.ZodString>>; to: z.ZodOptional<z.ZodNullable<z.ZodString>> }>> = {
  kind: 'read',
  name: 'get_life_progress',
  label: 'Analisando seu progresso',
  description: 'Progresso num período (padrão: semana atual, segunda a domingo): XP por dia e por atributo, cumprimento de cada hábito (cumpridos × previstos), missões concluídas, treinos recompensados e sequência. Use para perguntas como "como está minha disciplina nesta semana?".',
  parameters: { type: 'object', properties: { from: { type: ['string', 'null'], description: 'yyyy-mm-dd' }, to: { type: ['string', 'null'], description: 'yyyy-mm-dd' } }, additionalProperties: false },
  args: z.object({ from: ISO.nullish(), to: ISO.nullish() }).strict(),
  async run(ctx, a) {
    const { q, profile, today } = await lifeCtx(ctx);
    if (!profile) return NO_PROFILE;
    const w = weekOf(today);
    const from = a.from ?? w.start;
    const to = a.to ?? (w.end > today ? today : w.end);
    if (from > to) throw new ToolError('invalid_range', 'A data inicial é depois da final.');
    if (addDays(from, 92) < to) throw new ToolError('invalid_range', 'Período máximo de 92 dias.');
    const ev = (await q.query<{ day: string; source: string; attribute: string | null; amount: number }>("SELECT day, source, attribute, amount FROM life_xp_events WHERE user_id = $1 AND day BETWEEN $2 AND $3 AND kind = 'grant' AND reversed_at IS NULL", [ctx.userId, from, to])).rows;
    const byDay: Record<string, number> = {};
    const byAttr: Record<string, number> = {};
    for (const e of ev) {
      byDay[e.day] = (byDay[e.day] ?? 0) + e.amount;
      if (e.attribute) byAttr[ATTRIBUTE_LABEL[e.attribute as keyof typeof ATTRIBUTE_LABEL]] = (byAttr[ATTRIBUTE_LABEL[e.attribute as keyof typeof ATTRIBUTE_LABEL]] ?? 0) + e.amount;
    }
    const habits = (await q.query<L.HabitRow>("SELECT * FROM life_habits WHERE user_id = $1 AND status <> 'archived'", [ctx.userId])).rows;
    const logs = (await q.query<{ habit_id: string; date: string }>('SELECT habit_id, date FROM life_habit_logs WHERE user_id = $1 AND completed AND date BETWEEN $2 AND $3', [ctx.userId, from, to])).rows;
    const habitStats = habits.map((h) => {
      let expected = 0;
      for (let d = from; d <= to; d = addDays(d, 1)) if (d >= h.start_date && h.frequency === 'daily' && h.days.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) expected++;
      if (h.frequency === 'weekly') expected = Math.ceil(((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1) / 7) * (h.times_per_week ?? 0);
      return { id: h.id, name: h.name, status: h.status, attribute: ATTRIBUTE_LABEL[h.attribute], done: logs.filter((l) => l.habit_id === h.id).length, expected };
    });
    const missions = (await q.query<{ title: string; type: string }>("SELECT title, type FROM life_missions WHERE user_id = $1 AND status = 'completed' AND ends_on BETWEEN $2 AND $3", [ctx.userId, from, to])).rows;
    return {
      period: { from, to },
      xpTotal: ev.reduce((s, e) => s + e.amount, 0),
      xpByDay: byDay,
      xpByAttribute: byAttr,
      habits: habitStats,
      missionsCompleted: missions,
      workoutsRewarded: ev.filter((e) => e.source === 'workout').length,
      streak: await streakOf(q as PoolClient, ctx.userId, today),
      note: 'Disciplina = hábitos, rotinas e missões de constância cumpridos; é medida de atividade registrada, não avaliação psicológica.',
    };
  },
};

const listAchievements: ReadTool = {
  kind: 'read',
  name: 'list_achievements',
  label: 'Consultando suas conquistas',
  description: 'Conquistas: desbloqueadas (data), progresso atual e as que dependem de dados que ainda não existem na conta.',
  parameters: NO_ARGS,
  args: z.object({}).strict(),
  async run(ctx) {
    const { q, profile, today } = await lifeCtx(ctx);
    if (!profile) return NO_PROFILE;
    return { achievements: await L.achievementViews(q, ctx.userId, today) };
  },
};

// ------------------------------------------------------------------ JSON Schemas (para o modelo)

const HABIT_JSON = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    attribute: { type: 'string', enum: [...ATTRIBUTES] },
    tag: { type: 'string', enum: [...TAGS] },
    icon: { type: 'string', enum: [...ICONS] },
    frequency: { type: 'string', enum: ['daily', 'weekly'] },
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0 = domingo … 6 = sábado (diários).' },
    timesPerWeek: { type: ['integer', 'null'], minimum: 1, maximum: 7, description: 'Obrigatório se weekly.' },
    goalKind: { type: 'string', enum: ['check', 'count', 'duration'], description: 'check = concluir; count = quantidade; duration = minutos.' },
    goalTarget: { type: 'integer', minimum: 1, maximum: 1440 },
    goalUnit: { type: ['string', 'null'] },
    preferredTime: { type: ['string', 'null'], description: 'HH:MM' },
    xp: { type: 'integer', minimum: 5, maximum: 50, description: 'XP por cumprimento (padrão 10).' },
  },
  required: ['name', 'attribute', 'frequency', 'goalKind'],
  additionalProperties: false,
};
const ROUTINE_JSON = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    kind: { type: 'string', enum: [...ROUTINE_KINDS] },
    days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: { type: 'object', properties: { title: { type: 'string' }, startTime: { type: ['string', 'null'] }, durationMin: { type: ['integer', 'null'] }, habitId: { type: ['string', 'null'], description: 'ID de hábito existente (list_habits).' } }, required: ['title'], additionalProperties: false },
    },
  },
  required: ['name', 'kind', 'items'],
  additionalProperties: false,
};
const MISSION_JSON = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['custom', 'special'], description: 'custom = objetivo com prazo; special = desafio de 3 a 90 dias.' },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    metric: { type: 'string', enum: ['manual', 'habit', 'workouts', 'habit_completions'], description: 'manual = a pessoa registra (minutos, páginas…); habit = cumprimentos de um hábito; workouts = treinos concluídos; habit_completions = hábitos cumpridos.' },
    habitId: { type: ['string', 'null'] },
    unit: { type: 'string', enum: [...MISSION_UNITS] },
    tag: { type: 'string', enum: [...TAGS] },
    target: { type: 'integer', minimum: 1 },
    attribute: { type: 'string', enum: [...ATTRIBUTES] },
    startsOn: { type: ['string', 'null'], description: 'yyyy-mm-dd (padrão hoje)' },
    endsOn: { type: 'string', description: 'Prazo yyyy-mm-dd (inclusive).' },
  },
  required: ['type', 'title', 'metric', 'target', 'attribute', 'endsOn'],
  additionalProperties: false,
};

// ------------------------------------------------------------------ prévias

const habitLines = (h: HabitInput): PreviewLine[] => [
  { kind: 'add', text: `${h.name} — ${ATTRIBUTE_LABEL[h.attribute]}` },
  { kind: 'info', text: h.frequency === 'daily' ? `Diário (${daysText(h.days)})` : `${h.timesPerWeek}× por semana` },
  { kind: 'info', text: `Meta: ${h.goalKind === 'check' ? 'concluir' : `${h.goalTarget} ${h.goalUnit ?? (h.goalKind === 'duration' ? 'min' : 'vezes')}`}${h.preferredTime ? ` · ${h.preferredTime}` : ''} · ${h.xp} XP` },
  ...(h.description ? [{ kind: 'info' as const, text: h.description }] : []),
];

const PATCH_LABEL: Record<string, string> = { name: 'Nome', description: 'Descrição', attribute: 'Categoria', tag: 'Tipo', icon: 'Ícone', frequency: 'Frequência', days: 'Dias', timesPerWeek: 'Vezes por semana', goalKind: 'Tipo de meta', goalTarget: 'Meta', goalUnit: 'Unidade', preferredTime: 'Horário', xp: 'XP', status: 'Estado', target: 'Meta', endsOn: 'Prazo', title: 'Título', kind: 'Tipo', items: 'Atividades' };
const STATUS_TEXT: Record<string, string> = { active: 'ativo (retomar)', paused: 'pausado', archived: 'arquivado', cancelled: 'cancelada' };
const fmt = (k: string, v: unknown) => (k === 'status' ? (STATUS_TEXT[String(v)] ?? String(v)) : k === 'days' && Array.isArray(v) ? daysText(v as number[]) : k === 'attribute' ? ATTRIBUTE_LABEL[v as keyof typeof ATTRIBUTE_LABEL] : k === 'items' && Array.isArray(v) ? `${v.length} atividade(s)` : v === null || v === undefined ? '—' : String(v));
const patchLines = (before: Record<string, unknown>, patch: Record<string, unknown>): PreviewLine[] => Object.entries(patch).map(([k, v]) => ({ kind: 'change', text: `${PATCH_LABEL[k] ?? k}: ${fmt(k, before[k])} → ${fmt(k, v)}` }));
const habitAsInput = (h: L.HabitRow): Record<string, unknown> => ({ name: h.name, description: h.description, attribute: h.attribute, tag: h.tag, icon: h.icon, frequency: h.frequency, days: h.days, timesPerWeek: h.times_per_week, goalKind: h.goal_kind, goalTarget: h.goal_target, goalUnit: h.goal_unit, preferredTime: h.preferred_time, xp: h.xp, status: h.status });

// ------------------------------------------------------------------ propostas

const createHabitArgs = z.object({ habit: habitInputSchema, rationale: z.string().trim().max(600).nullish() }).strict();
const proposeCreateHabit: WriteTool<typeof createHabitArgs> = {
  kind: 'write',
  name: 'propose_create_habit',
  label: 'Preparando um novo hábito',
  description: 'Prepara a PROPOSTA de criar um hábito (ex.: "quero estudar uma hora todos os dias" → goalKind duration, goalTarget 60, attribute knowledge, tag study). A pessoa aprova antes. Confira list_habits para não duplicar.',
  parameters: { type: 'object', properties: { habit: HABIT_JSON, rationale: { type: ['string', 'null'] } }, required: ['habit'], additionalProperties: false },
  args: createHabitArgs,
  async prepare(ctx, a) {
    const dup = (await (ctx.pool as unknown as Q).query("SELECT 1 FROM life_habits WHERE user_id = $1 AND status <> 'archived' AND lower(name) = lower($2)", [ctx.userId, a.habit.name])).rowCount;
    if (dup) throw new ToolError('duplicate', 'Já existe um hábito com esse nome. Proponha editar o existente (propose_update_habit).');
    return { kind: 'create_habit', title: `Criar o hábito "${a.habit.name}"`, rationale: a.rationale ?? null, payload: { habit: a.habit, id: randomUUID() }, preview: [{ title: 'Novo hábito', lines: habitLines(a.habit) }], targetId: null, baseVersion: null };
  },
};

const updateHabitArgs = z.object({ habitId: z.string().uuid(), changes: habitPatchSchema, rationale: z.string().trim().max(600).nullish() }).strict();
const proposeUpdateHabit: WriteTool<typeof updateHabitArgs> = {
  kind: 'write',
  name: 'propose_update_habit',
  label: 'Preparando a alteração do hábito',
  description: 'Prepara a PROPOSTA de editar um hábito: nome, meta (ajustar metas), dias, horário, XP (5–50) ou estado (status paused = pausar, active = retomar, archived = arquivar). Use o ID de list_habits.',
  parameters: { type: 'object', properties: { habitId: { type: 'string' }, changes: { ...HABIT_JSON, required: [], properties: { ...HABIT_JSON.properties, status: { type: 'string', enum: ['active', 'paused', 'archived'] } } }, rationale: { type: ['string', 'null'] } }, required: ['habitId', 'changes'], additionalProperties: false },
  args: updateHabitArgs,
  async prepare(ctx, a) {
    const h = await L.getHabit(ctx.pool as unknown as Q, ctx.userId, a.habitId);
    if (!h) throw new ToolError('not_found', 'Hábito não encontrado nesta conta.');
    return { kind: 'update_habit', title: a.changes.status === 'paused' ? `Pausar o hábito "${h.name}"` : `Alterar o hábito "${h.name}"`, rationale: a.rationale ?? null, payload: { habitId: h.id, changes: a.changes }, preview: [{ title: h.name, lines: patchLines(habitAsInput(h), a.changes) }], targetId: h.id, baseVersion: h.version };
  },
};

const createRoutineArgs = z.object({ routine: routineInputSchema, rationale: z.string().trim().max(600).nullish() }).strict();
const proposeCreateRoutine: WriteTool<typeof createRoutineArgs> = {
  kind: 'write',
  name: 'propose_create_life_routine',
  label: 'Preparando uma rotina',
  description: 'Prepara a PROPOSTA de criar uma rotina do dia a dia (matinal, estudos, treino, noturna ou personalizada) com atividades em ordem, horário e duração. Atividades podem apontar para um hábito existente (habitId) — o XP é o do hábito, sem duplicar. Ex.: "crie uma rotina matinal para mim".',
  parameters: { type: 'object', properties: { routine: ROUTINE_JSON, rationale: { type: ['string', 'null'] } }, required: ['routine'], additionalProperties: false },
  args: createRoutineArgs,
  async prepare(ctx, a) {
    for (const i of a.routine.items) if (i.habitId && !(await L.getHabit(ctx.pool as unknown as Q, ctx.userId, i.habitId))) throw new ToolError('not_found', `Hábito ${i.habitId} não encontrado (use list_habits).`);
    if (a.routine.items.some((i) => i.missionId)) throw new ToolError('invalid_args', 'Vínculo com missão não é aceito em propostas; use habitId ou nenhum.');
    const lines: PreviewLine[] = [{ kind: 'info', text: `${ROUTINE_KIND_LABEL[a.routine.kind]} · ${daysText(a.routine.days)}` }, ...a.routine.items.map((i) => ({ kind: 'add' as const, text: `${i.startTime ? `${i.startTime} ` : ''}${i.title}${i.durationMin ? ` (${i.durationMin} min)` : ''}${i.habitId ? ' · vinculada a hábito' : ''}` }))];
    return { kind: 'create_life_routine', title: `Criar a rotina "${a.routine.name}"`, rationale: a.rationale ?? null, payload: { routine: a.routine, id: randomUUID() }, preview: [{ title: a.routine.name, lines }], targetId: null, baseVersion: null };
  },
};

const updateRoutineArgs = z.object({ routineId: z.string().uuid(), changes: routinePatchSchema, rationale: z.string().trim().max(600).nullish() }).strict();
const proposeUpdateRoutine: WriteTool<typeof updateRoutineArgs> = {
  kind: 'write',
  name: 'propose_update_life_routine',
  label: 'Preparando a alteração da rotina',
  description: 'Prepara a PROPOSTA de editar uma rotina do dia a dia: nome, dias, estado (paused = pausar, active = retomar, archived) ou a lista completa de atividades (items substitui tudo, na ordem; mantenha o id das que continuam). Use list_life_routines antes.',
  parameters: { type: 'object', properties: { routineId: { type: 'string' }, changes: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: [...ROUTINE_KINDS] }, days: ROUTINE_JSON.properties.days, status: { type: 'string', enum: ['active', 'paused', 'archived'] }, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, ...ROUTINE_JSON.properties.items.items.properties } } } }, additionalProperties: false }, rationale: { type: ['string', 'null'] } }, required: ['routineId', 'changes'], additionalProperties: false },
  args: updateRoutineArgs,
  async prepare(ctx, a) {
    const snap = await L.routineSnapshot(ctx.pool as unknown as Q, ctx.userId, a.routineId);
    if (!snap) throw new ToolError('not_found', 'Rotina não encontrada nesta conta.');
    const lines = patchLines({ name: snap.row.name, kind: snap.row.kind, days: snap.row.days, status: snap.row.status, items: snap.items }, { ...a.changes, ...(a.changes.items ? { items: a.changes.items } : {}) });
    const sections: PreviewSection[] = [{ title: snap.row.name, lines }];
    if (a.changes.items) sections.push({ title: 'Atividades depois da alteração', lines: a.changes.items.map((i) => ({ kind: i.id && snap.items.some((x) => x.id === i.id) ? ('info' as const) : ('add' as const), text: `${i.startTime ? `${i.startTime} ` : ''}${i.title}` })) });
    return { kind: 'update_life_routine', title: a.changes.status === 'paused' ? `Pausar a rotina "${snap.row.name}"` : `Alterar a rotina "${snap.row.name}"`, rationale: a.rationale ?? null, payload: { routineId: a.routineId, changes: a.changes }, preview: sections, targetId: a.routineId, baseVersion: snap.row.version };
  },
};

const createMissionsArgs = z.object({ missions: z.array(missionInputSchema).min(1).max(7), rationale: z.string().trim().max(600).nullish() }).strict();
const proposeCreateMissions: WriteTool<typeof createMissionsArgs> = {
  kind: 'write',
  name: 'propose_create_missions',
  label: 'Preparando missões',
  description: 'Prepara a PROPOSTA de criar de 1 a 7 missões personalizadas ou especiais com objetivo mensurável e prazo (ex.: "organize minhas metas para os próximos sete dias", "ler 30 minutos até sexta"). A recompensa é calculada pelo servidor: você NÃO escolhe XP.',
  parameters: { type: 'object', properties: { missions: { type: 'array', minItems: 1, maxItems: 7, items: MISSION_JSON }, rationale: { type: ['string', 'null'] } }, required: ['missions'], additionalProperties: false },
  args: createMissionsArgs,
  async prepare(ctx, a) {
    const { today } = await lifeCtx(ctx);
    const lines: PreviewLine[] = [];
    for (const m of a.missions) {
      if (m.habitId && !(await L.getHabit(ctx.pool as unknown as Q, ctx.userId, m.habitId))) throw new ToolError('not_found', `Hábito ${m.habitId} não encontrado.`);
      const starts = m.startsOn ?? today;
      if (starts < today || m.endsOn < starts) throw new ToolError('invalid_args', `Prazo inválido em "${m.title}" (hoje é ${today}).`);
      const days = Math.round((Date.parse(m.endsOn) - Date.parse(starts)) / 86_400_000) + 1;
      if (m.type === 'special' && (days < 3 || days > 90)) throw new ToolError('invalid_args', `"${m.title}": missões especiais duram de 3 a 90 dias.`);
      lines.push({ kind: 'add', text: `${m.title} — meta ${m.target}${m.unit === 'check' ? '' : ` ${UNIT_LABEL[m.unit]}`} até ${m.endsOn} · ${ATTRIBUTE_LABEL[m.attribute]} · ${defaultMissionXp(m.type, m.unit, m.target, days)} XP` });
    }
    const missions: MissionInput[] = a.missions.map((m) => ({ ...m, xp: null }));
    return { kind: 'create_missions', title: a.missions.length === 1 ? `Criar a missão "${a.missions[0].title}"` : `Criar ${a.missions.length} missões`, rationale: a.rationale ?? null, payload: { missions, ids: missions.map(() => randomUUID()) }, preview: [{ title: 'Missões', lines }], targetId: null, baseVersion: null };
  },
};

const updateMissionArgs = z.object({ missionId: z.string().uuid(), changes: missionPatchSchema, rationale: z.string().trim().max(600).nullish() }).strict();
const proposeUpdateMission: WriteTool<typeof updateMissionArgs> = {
  kind: 'write',
  name: 'propose_update_mission',
  label: 'Preparando o ajuste da missão',
  description: 'Prepara a PROPOSTA de ajustar uma missão personalizada/especial (título, meta, prazo) ou pausar/retomar/cancelar qualquer missão (status paused | active | cancelled). Missões automáticas só podem ser pausadas/retomadas.',
  parameters: { type: 'object', properties: { missionId: { type: 'string' }, changes: { type: 'object', properties: { title: { type: 'string' }, description: { type: ['string', 'null'] }, target: { type: 'integer' }, endsOn: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused', 'cancelled'] } }, additionalProperties: false }, rationale: { type: ['string', 'null'] } }, required: ['missionId', 'changes'], additionalProperties: false },
  args: updateMissionArgs,
  async prepare(ctx, a) {
    const m = await L.getMission(ctx.pool as unknown as Q, ctx.userId, a.missionId);
    if (!m) throw new ToolError('not_found', 'Missão não encontrada nesta conta.');
    if (m.origin === 'system' && (a.changes.target !== undefined || a.changes.endsOn !== undefined || a.changes.title !== undefined)) throw new ToolError('invalid_args', 'Missões automáticas só podem ser pausadas, retomadas ou canceladas.');
    return { kind: 'update_mission', title: `Ajustar a missão "${m.title}"`, rationale: a.rationale ?? null, payload: { missionId: m.id, changes: a.changes }, preview: [{ title: m.title, lines: patchLines({ title: m.title, description: m.description, target: m.target, endsOn: m.ends_on, status: m.status }, a.changes) }], targetId: m.id, baseVersion: m.version };
  },
};

// ------------------------------------------------------------------ aplicação e desfazer

const habitCreate: ActionHandler = {
  kind: 'create_habit',
  async apply(c, ctx, action) {
    const { habit, id } = action.payload as { habit: unknown; id: string };
    const h = habitInputSchema.parse(habit);
    const row = await inLife(c, ctx, (t) => L.createHabit(t, h, 'ai', id));
    return { collection: 'habits', entityId: row.id, summary: `Hábito "${row.name}" criado.`, undo: { id: row.id, version: row.version } };
  },
  async undo(c, ctx, _a, u) {
    const { id, version } = u as { id: string; version: number };
    return inLife(c, ctx, async (t) => {
      const h = await L.getHabit(t.c, t.userId, id, true);
      if (!h) return { summary: 'O hábito já não existia.' };
      if (h.version !== version) throw new StaleError();
      const logs = (await t.c.query('SELECT 1 FROM life_habit_logs WHERE user_id = $1 AND habit_id = $2 LIMIT 1', [t.userId, id])).rowCount;
      // Com registros, arquiva (histórico e XP legítimo ficam); sem registros, remove.
      if (logs) await L.updateHabit(t, id, { status: 'archived' });
      else await t.c.query('DELETE FROM life_habits WHERE user_id = $1 AND id = $2', [t.userId, id]);
      return { summary: logs ? `Hábito "${h.name}" arquivado (já tinha registros).` : `Hábito "${h.name}" removido.` };
    });
  },
};

const habitUpdate: ActionHandler = {
  kind: 'update_habit',
  async apply(c, ctx, action) {
    const { habitId, changes } = action.payload as { habitId: string; changes: unknown };
    const patch = habitPatchSchema.parse(changes);
    const r = await inLife(c, ctx, (t) => L.updateHabit(t, habitId, patch, action.baseVersion));
    return { collection: 'habits', entityId: habitId, summary: `Hábito "${r.after.name}" atualizado.`, undo: { before: habitAsInput(r.before), version: r.after.version } };
  },
  async undo(c, ctx, action, u) {
    const { before, version } = u as { before: Record<string, unknown>; version: number };
    return inLife(c, ctx, async (t) => {
      const h = await L.getHabit(t.c, t.userId, action.targetId!, true);
      if (!h || h.version !== version) throw new StaleError();
      const r = await L.updateHabit(t, h.id, habitPatchSchema.parse(before), version);
      return { summary: `Hábito "${r.after.name}" voltou como estava.` };
    });
  },
};

const routineCreate: ActionHandler = {
  kind: 'create_life_routine',
  async apply(c, ctx, action) {
    const { routine, id } = action.payload as { routine: unknown; id: string };
    const r = routineInputSchema.parse(routine);
    const row = await inLife(c, ctx, (t) => L.createRoutine(t, r, 'ai', id));
    return { collection: 'life_routines', entityId: row.id, summary: `Rotina "${row.name}" criada (${r.items.length} atividade(s)).`, undo: { id: row.id, version: row.version } };
  },
  async undo(c, ctx, _a, u) {
    const { id, version } = u as { id: string; version: number };
    return inLife(c, ctx, async (t) => {
      const r = await L.getRoutine(t.c, t.userId, id, true);
      if (!r) return { summary: 'A rotina já não existia.' };
      if (r.version !== version) throw new StaleError();
      const used = (await t.c.query("SELECT 1 FROM life_xp_events WHERE user_id = $1 AND source = 'routine' AND source_id = $2 LIMIT 1", [t.userId, id])).rowCount;
      if (used) await L.updateRoutine(t, id, { status: 'archived' });
      else await t.c.query('DELETE FROM life_routines WHERE user_id = $1 AND id = $2', [t.userId, id]);
      return { summary: used ? `Rotina "${r.name}" arquivada (já tinha sido usada).` : `Rotina "${r.name}" removida.` };
    });
  },
};

const routineUpdate: ActionHandler = {
  kind: 'update_life_routine',
  async apply(c, ctx, action) {
    const { routineId, changes } = action.payload as { routineId: string; changes: unknown };
    const patch = routinePatchSchema.parse(changes);
    const r = await inLife(c, ctx, (t) => L.updateRoutine(t, routineId, patch, action.baseVersion));
    return { collection: 'life_routines', entityId: routineId, summary: `Rotina "${r.after.name}" atualizada.`, undo: { before: r.before, version: r.after.version } };
  },
  async undo(c, ctx, action, u) {
    const { before, version } = u as { before: L.RoutineSnapshot; version: number };
    return inLife(c, ctx, async (t) => {
      const r = await L.getRoutine(t.c, t.userId, action.targetId!, true);
      if (!r || r.version !== version) throw new StaleError();
      await L.restoreRoutine(t, before);
      return { summary: `Rotina "${before.row.name}" voltou como estava.` };
    });
  },
};

const missionsCreate: ActionHandler = {
  kind: 'create_missions',
  async apply(c, ctx, action) {
    const { missions, ids } = action.payload as { missions: unknown[]; ids: string[] };
    const list = z.array(missionInputSchema).min(1).max(7).parse(missions);
    const rows = await inLife(c, ctx, async (t) => {
      const out: MissionRow[] = [];
      for (let i = 0; i < list.length; i++) out.push(await L.createMission(t, list[i], 'ai', ids[i]));
      return out;
    });
    return { collection: 'missions', entityId: rows[0].id, summary: rows.length === 1 ? `Missão "${rows[0].title}" criada.` : `${rows.length} missões criadas.`, undo: { ids: rows.map((r) => r.id) } };
  },
  async undo(c, ctx, _a, u) {
    const { ids } = u as { ids: string[] };
    return inLife(c, ctx, async (t) => {
      const rows: MissionRow[] = [];
      for (const id of ids) {
        const m = await L.getMission(t.c, t.userId, id, true);
        if (m) rows.push(m);
      }
      if (rows.some((m) => m.status === 'completed')) throw new ToolError('action_undo_blocked', 'Missão já concluída.');
      if (rows.some((m) => m.version !== 1 && m.status !== 'expired')) throw new StaleError();
      for (const m of rows) await t.c.query("UPDATE life_missions SET status = 'cancelled', version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2", [t.userId, m.id]);
      return { summary: rows.length === 1 ? `Missão "${rows[0].title}" cancelada.` : `${rows.length} missões canceladas.` };
    });
  },
};

const missionUpdate: ActionHandler = {
  kind: 'update_mission',
  async apply(c, ctx, action) {
    const { missionId, changes } = action.payload as { missionId: string; changes: unknown };
    const patch = missionPatchSchema.parse(changes);
    const r = await inLife(c, ctx, (t) => L.updateMission(t, missionId, patch, action.baseVersion));
    return { collection: 'missions', entityId: missionId, summary: `Missão "${r.after.title}" ajustada.`, undo: { before: r.before, version: r.after.version } };
  },
  async undo(c, ctx, action, u) {
    const { before, version } = u as { before: MissionRow; version: number };
    return inLife(c, ctx, async (t) => {
      const m = await L.getMission(t.c, t.userId, action.targetId!, true);
      if (!m || m.version !== version) throw new StaleError();
      // Restaura campos e estado; a conclusão (e o XP) é recalculada pelo progresso real, nunca copiada.
      const status = before.status === 'completed' ? 'active' : before.status;
      const r = await t.c.query<MissionRow>('UPDATE life_missions SET title = $3, description = $4, target = $5, ends_on = $6, status = $7, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *', [t.userId, m.id, before.title, before.description, before.target, before.ends_on, status]);
      await recomputeMission(t, r.rows[0]);
      return { summary: `Missão "${before.title}" voltou como estava.` };
    });
  },
};

export const lifeModule: AiModuleDef = {
  id: 'life_rpg',
  name: 'RPG pessoal: hábitos, rotinas, missões, XP e conquistas',
  status: 'available',
  scope: 'perfil RPG (nível, XP, atributos), hábitos, rotinas do dia a dia, missões diárias/semanais/personalizadas/especiais, conquistas, sequência de consistência',
  tools: [getProfile, listMissions, listHabits, listRoutines, getProgress, listAchievements, proposeCreateHabit, proposeUpdateHabit, proposeCreateRoutine, proposeUpdateRoutine, proposeCreateMissions, proposeUpdateMission],
  actions: [habitCreate, habitUpdate, routineCreate, routineUpdate, missionsCreate, missionUpdate],
};
