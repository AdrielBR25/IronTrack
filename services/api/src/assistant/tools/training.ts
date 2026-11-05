// Módulo de treino (já existente no app): ferramentas reais de leitura e propostas de escrita de fichas.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRoutineArgsSchema, updateRoutineArgsSchema, type PreviewSection } from '../../../../../shared/assistant/protocol.ts';
import { lockRow, lockUserSeq, normalizeRecord, saveUserSeq, writeRow } from '../../modules/records.ts';
import { exerciseStats, loadCompletedSessions, loadRoutine, loadRoutines, loadSession, loadSettings, normalizeName, performedExercises, recordCounts, type SessionDoc } from './records.ts';
import { applyRoutineChanges, describeExercise, generateIds, toWorkout, type GeneratedIds } from './routineEdit.ts';
import { addDays, localDate, localMidnight } from './time.ts';
import { ToolError, type ActionHandler, type AiModuleDef, type ReadTool, type ToolContext, type WriteTool } from './types.ts';

type Doc = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO);

/** Intervalo em datas locais → instantes. Padrão: últimos `defDays` dias até hoje (inclusive). */
function range(ctx: ToolContext, from?: string | null, to?: string | null, defDays = 90) {
  const today = localDate(ctx.now, ctx.timezone);
  const t = to && ISO.test(to) ? to : today;
  const f = from && ISO.test(from) ? from : addDays(t, -(defDays - 1));
  if (f > t) throw new ToolError('invalid_range', 'A data inicial é depois da final.');
  return { from: f, to: t, fromMs: localMidnight(f, ctx.timezone), toMs: localMidnight(addDays(t, 1), ctx.timezone) };
}

const sessionHeader = (s: SessionDoc, tz: string) => ({
  id: s.id,
  date: localDate(s.startedAt, tz),
  workout: [s.workoutLabel, s.workoutName].filter(Boolean).join(' — ') || null,
  durationMin: typeof s.durationSec === 'number' ? Math.round(s.durationSec / 60) : null,
});

const routineSummary = (r: { id: string; doc: Doc }) => ({
  id: r.id,
  name: r.doc.name,
  description: r.doc.description ?? null,
  updatedAt: typeof r.doc.updatedAt === 'number' ? new Date(r.doc.updatedAt).toISOString() : null,
  workouts: (Array.isArray(r.doc.workouts) ? (r.doc.workouts as Doc[]) : []).map((w) => ({ id: w.id, label: w.label, name: w.name, exercises: Array.isArray(w.exercises) ? w.exercises.length : 0 })),
});

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const RANGE_PROPS = {
  from: { type: 'string', description: 'Data inicial local (yyyy-mm-dd). Opcional.' },
  to: { type: 'string', description: 'Data final local (yyyy-mm-dd), inclusive. Opcional; padrão = hoje.' },
};

const getOverview: ReadTool = {
  kind: 'read',
  name: 'get_account_overview',
  label: 'Consultando seu perfil',
  description: 'Resumo da conta: nome de exibição, unidade de peso preferida, quantidade de registros por tipo e datas do primeiro e do último treino concluído. Use para saber quais dados existem antes de analisar.',
  parameters: NO_ARGS,
  args: z.object({}).strict(),
  async run(ctx) {
    const [settings, counts, first, last, user] = await Promise.all([
      loadSettings(ctx.pool, ctx.userId),
      recordCounts(ctx.pool, ctx.userId),
      ctx.pool.query<{ t: Date }>("SELECT min(started_at) AS t FROM workout_sessions WHERE user_id = $1 AND NOT deleted AND status = 'completed'", [ctx.userId]),
      ctx.pool.query<{ t: Date }>("SELECT max(started_at) AS t FROM workout_sessions WHERE user_id = $1 AND NOT deleted AND status = 'completed'", [ctx.userId]),
      ctx.pool.query<{ name: string; created_at: Date }>('SELECT name, created_at FROM users WHERE id = $1', [ctx.userId]),
    ]);
    const tz = ctx.timezone;
    return {
      displayName: (typeof settings?.userName === 'string' && settings.userName) || user.rows[0]?.name || null,
      accountSince: user.rows[0] ? localDate(user.rows[0].created_at.getTime(), tz) : null,
      weightUnit: settings?.weightUnit ?? 'kg',
      today: localDate(ctx.now, tz),
      counts,
      firstWorkout: first.rows[0]?.t ? localDate(first.rows[0].t.getTime(), tz) : null,
      lastWorkout: last.rows[0]?.t ? localDate(last.rows[0].t.getTime(), tz) : null,
      note: 'Contagens da cópia sincronizada na nuvem. Pesos sempre em kg.',
    };
  },
};

const listRoutines: ReadTool = {
  kind: 'read',
  name: 'list_routines',
  label: 'Consultando suas fichas',
  description: 'Lista as fichas (rotinas) de treino da pessoa com seus treinos (A, B, C…) e IDs. Use antes de propor alterações.',
  parameters: NO_ARGS,
  args: z.object({}).strict(),
  async run(ctx) {
    const rows = await loadRoutines(ctx.pool, ctx.userId);
    return { routines: rows.map(routineSummary), total: rows.length };
  },
};

const getRoutine: ReadTool<z.ZodObject<{ routineId: z.ZodString }>> = {
  kind: 'read',
  name: 'get_routine',
  label: 'Abrindo a ficha',
  description: 'Detalhes de uma ficha: treinos e exercícios com séries, repetições, descanso, carga planejada e IDs (necessários para propose_update_routine).',
  parameters: { type: 'object', properties: { routineId: { type: 'string' } }, required: ['routineId'], additionalProperties: false },
  args: z.object({ routineId: z.string().min(1).max(200) }).strict(),
  async run(ctx, a) {
    const r = await loadRoutine(ctx.pool, ctx.userId, a.routineId);
    if (!r) throw new ToolError('not_found', 'Ficha não encontrada nesta conta.');
    return {
      id: r.id,
      name: r.doc.name,
      description: r.doc.description ?? null,
      workouts: (r.doc.workouts as Doc[]).map((w) => ({
        id: w.id,
        label: w.label,
        name: w.name,
        notes: w.notes ?? null,
        exercises: ((w.exercises as Doc[]) ?? []).map((e) => ({ id: e.id, summary: describeExercise(e), name: e.name, muscleGroup: e.muscleGroup, category: e.category, equipment: e.equipment, sets: e.sets, repMin: e.repMin, repMax: e.repMax, restSec: e.restSec, warmupSets: e.warmupSets, targetWeight: e.targetWeight ?? null, notes: e.notes ?? null })),
      })),
    };
  },
};

const listWorkouts: ReadTool<z.ZodObject<{ from: z.ZodOptional<z.ZodNullable<z.ZodString>>; to: z.ZodOptional<z.ZodNullable<z.ZodString>>; limit: z.ZodOptional<z.ZodNumber> }>> = {
  kind: 'read',
  name: 'list_recent_workouts',
  label: 'Consultando seu histórico',
  description: 'Treinos concluídos (mais recentes primeiro) com data, treino, duração, séries feitas e volume. Padrão: últimos 30 dias, até 15 treinos.',
  parameters: { type: 'object', properties: { ...RANGE_PROPS, limit: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
  args: z.object({ from: isoDate.nullish(), to: isoDate.nullish(), limit: z.number().int().min(1).max(30).optional() }).strict(),
  async run(ctx, a) {
    const r = range(ctx, a.from, a.to, 30);
    const sessions = await loadCompletedSessions(ctx.pool, ctx.userId, r.fromMs, r.toMs, a.limit ?? 15);
    return {
      period: { from: r.from, to: r.to },
      workouts: sessions.map((s) => {
        const stats = s.exercises.map(exerciseStats);
        return { ...sessionHeader(s, ctx.timezone), exercises: s.exercises.length, doneSets: stats.reduce((n, x) => n + x.doneSets, 0), volumeKg: stats.reduce((n, x) => n + x.volumeKg, 0) };
      }),
      ...(sessions.length ? {} : { note: 'Nenhum treino concluído no período.' }),
    };
  },
};

const getWorkout: ReadTool<z.ZodObject<{ workoutSessionId: z.ZodOptional<z.ZodString> }>> = {
  kind: 'read',
  name: 'get_workout_details',
  label: 'Abrindo o treino',
  description: 'Detalhes de um treino concluído: exercícios e séries feitas (carga × repetições). Sem ID, devolve o treino concluído mais recente.',
  parameters: { type: 'object', properties: { workoutSessionId: { type: 'string', description: 'ID vindo de list_recent_workouts. Omita para o mais recente.' } }, additionalProperties: false },
  args: z.object({ workoutSessionId: z.string().min(1).max(200).optional() }).strict(),
  async run(ctx, a) {
    let s: SessionDoc | null;
    if (a.workoutSessionId) s = await loadSession(ctx.pool, ctx.userId, a.workoutSessionId);
    else s = (await loadCompletedSessions(ctx.pool, ctx.userId, 0, ctx.now + 86_400_000, 1))[0] ?? null;
    if (!s) throw new ToolError('not_found', a.workoutSessionId ? 'Treino não encontrado nesta conta.' : 'Nenhum treino concluído registrado.');
    return {
      ...sessionHeader(s, ctx.timezone),
      status: s.status,
      notes: s.notes ?? null,
      exercises: s.exercises.map((e) => {
        const st = exerciseStats(e);
        return { name: e.name, muscleGroup: e.muscleGroup ?? null, doneSets: st.doneSets, sets: st.sets, volumeKg: st.volumeKg, bestSet: st.bestWeightKg !== null ? `${st.bestWeightKg} kg × ${st.bestWeightReps}` : null };
      }),
    };
  },
};

const listExercises: ReadTool = {
  kind: 'read',
  name: 'list_performed_exercises',
  label: 'Consultando seus exercícios',
  description: 'Nomes dos exercícios já registrados em treinos concluídos, com quantas vezes e a data do último. Use para descobrir o nome exato antes de get_exercise_progress.',
  parameters: NO_ARGS,
  args: z.object({}).strict(),
  async run(ctx) {
    const list = await performedExercises(ctx.pool, ctx.userId, 150);
    return { exercises: list.map((x) => ({ name: x.name, sessions: x.sessions, last: localDate(Date.parse(x.last), ctx.timezone) })) };
  },
};

const progressArgs = z.object({ exercise: z.string().trim().min(2).max(80), from: isoDate.nullish(), to: isoDate.nullish() }).strict();
const exerciseProgress: ReadTool<typeof progressArgs> = {
  kind: 'read',
  name: 'get_exercise_progress',
  label: 'Analisando a evolução do exercício',
  description:
    'Evolução de um exercício ao longo do tempo (busca por parte do nome, sem acento; ex.: "supino"): por treino, melhor série, 1RM estimada (Epley), repetições máximas e volume; e um resumo do período. Padrão: últimos 90 dias.',
  parameters: { type: 'object', properties: { exercise: { type: 'string', description: 'Nome ou parte do nome do exercício.' }, ...RANGE_PROPS }, required: ['exercise'], additionalProperties: false },
  args: progressArgs,
  async run(ctx, a) {
    const r = range(ctx, a.from, a.to, 90);
    const q = normalizeName(a.exercise);
    const sessions = await loadCompletedSessions(ctx.pool, ctx.userId, r.fromMs, r.toMs, 400);
    const groups = new Map<string, { name: string; points: Record<string, unknown>[] }>();
    for (const s of [...sessions].reverse()) {
      for (const e of s.exercises) {
        const n = normalizeName(e.name ?? '');
        if (!n.includes(q)) continue;
        const st = exerciseStats(e);
        if (!st.doneSets) continue;
        const g = groups.get(n) ?? { name: e.name, points: [] };
        g.points.push({ date: localDate(s.startedAt, ctx.timezone), bestSet: st.bestWeightKg !== null ? `${st.bestWeightKg} kg × ${st.bestWeightReps}` : null, bestWeightKg: st.bestWeightKg, e1rmKg: st.e1rmKg, maxReps: st.maxReps, doneSets: st.doneSets, volumeKg: st.volumeKg });
        groups.set(n, g);
      }
    }
    if (!groups.size) return { period: { from: r.from, to: r.to }, matches: [], note: `Nenhuma série feita de exercício com "${a.exercise}" no período. Use list_performed_exercises para ver os nomes registrados.` };
    const matches = [...groups.values()]
      .sort((x, y) => y.points.length - x.points.length)
      .slice(0, 4)
      .map((g) => {
        const pts = g.points;
        const e1 = pts.map((p) => p.e1rmKg as number | null).filter((v): v is number => v !== null);
        const w = pts.map((p) => p.bestWeightKg as number | null).filter((v): v is number => v !== null);
        return {
          exercise: g.name,
          sessions: pts.length,
          firstDate: pts[0].date,
          lastDate: pts[pts.length - 1].date,
          summary: {
            bestWeightKg: w.length ? Math.max(...w) : null,
            e1rmFirstKg: e1[0] ?? null,
            e1rmLastKg: e1.length ? e1[e1.length - 1] : null,
            e1rmBestKg: e1.length ? Math.max(...e1) : null,
            e1rmChangePct: e1.length >= 2 && e1[0] > 0 ? Math.round(((e1[e1.length - 1] - e1[0]) / e1[0]) * 1000) / 10 : null,
          },
          points: pts.slice(-40),
        };
      });
    return { period: { from: r.from, to: r.to }, formula: '1RM estimada por Epley (séries de até 12 repetições com carga); é estimativa, não teste real.', matches, ...(sessions.length >= 400 ? { note: 'Período muito longo: só os 400 treinos mais recentes foram analisados.' } : {}) };
  },
};

// ------------------------------------------------------------------ escrita (propostas)

const PROPOSED_EXERCISE_JSON = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    muscleGroup: { type: 'string', description: 'Grupo muscular em pt-BR (ex.: Peito, Costas, Ombros, Bíceps, Tríceps, Quadríceps, Posterior de coxa, Glúteos, Panturrilha, Abdômen).' },
    category: { type: 'string', enum: ['compound', 'isolation'] },
    equipment: { type: 'string', enum: ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'other'] },
    sets: { type: 'integer', minimum: 1, maximum: 20 },
    repMin: { type: 'integer', minimum: 1, maximum: 100 },
    repMax: { type: 'integer', minimum: 1, maximum: 100 },
    restSec: { type: 'integer', minimum: 0, maximum: 900 },
    warmupSets: { type: 'integer', minimum: 0, maximum: 5 },
    targetWeight: { type: ['number', 'null'], description: 'Carga planejada em kg. Só use se houver base nos registros; senão null.' },
    notes: { type: ['string', 'null'] },
  },
  required: ['name', 'muscleGroup', 'category', 'equipment', 'sets', 'repMin', 'repMax', 'restSec'],
  additionalProperties: false,
};
const PROPOSED_WORKOUT_JSON = {
  type: 'object',
  properties: { label: { type: 'string', description: 'Letra curta: A, B, C…' }, name: { type: 'string' }, notes: { type: ['string', 'null'] }, exercises: { type: 'array', items: PROPOSED_EXERCISE_JSON, minItems: 1, maxItems: 20 } },
  required: ['label', 'name', 'exercises'],
  additionalProperties: false,
};

const proposeCreate: WriteTool<typeof createRoutineArgsSchema> = {
  kind: 'write',
  name: 'propose_create_routine',
  label: 'Preparando a proposta de ficha',
  description:
    'Prepara a PROPOSTA de uma ficha nova. Não grava nada: o app mostra a prévia e a pessoa aprova ou cancela. Use só quando a pessoa pedir uma ficha. Depois, diga que a proposta está aguardando aprovação no cartão abaixo.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' }, description: { type: ['string', 'null'] }, workouts: { type: 'array', items: PROPOSED_WORKOUT_JSON, minItems: 1, maxItems: 7 }, rationale: { type: ['string', 'null'], description: 'Por que esta ficha (curto).' } },
    required: ['name', 'workouts'],
    additionalProperties: false,
  },
  args: createRoutineArgsSchema,
  async prepare(ctx, a) {
    const count = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM routines WHERE user_id = $1 AND NOT deleted', [ctx.userId]);
    if ((count.rows[0]?.n ?? 0) >= 50) throw new ToolError('too_many_routines', 'A conta já tem 50 fichas.');
    const ids: GeneratedIds = { routine: randomUUID(), workouts: {}, exercises: {} };
    a.workouts.forEach((w, i) => (ids.workouts[i] = { workout: randomUUID(), exercises: w.exercises.map(() => randomUUID()) }));
    const workouts = a.workouts.map((w, i) => toWorkout(w, ids.workouts[i]));
    const preview: PreviewSection[] = [
      { title: 'Ficha nova', lines: [{ kind: 'add', text: a.name }, ...(a.description ? [{ kind: 'info' as const, text: a.description }] : [])] },
      ...workouts.map((w) => ({ title: `Treino ${w.label} — ${w.name}`, lines: w.exercises.map((e) => ({ kind: 'add' as const, text: describeExercise(e) })) })),
    ];
    return { kind: 'create_routine', title: `Criar a ficha "${a.name}"`, rationale: a.rationale ?? null, payload: { args: a, ids }, preview, targetId: ids.routine!, baseVersion: null };
  },
};

const proposeUpdate: WriteTool<typeof updateRoutineArgsSchema> = {
  kind: 'write',
  name: 'propose_update_routine',
  label: 'Preparando a proposta de alteração',
  description:
    'Prepara a PROPOSTA de alterações numa ficha existente (renomear, adicionar/remover/mover exercícios, mudar séries, repetições, descanso, carga planejada, adicionar/remover treinos). Não grava nada: a pessoa vê a prévia e aprova. Antes, chame get_routine e use os IDs exatos.',
  parameters: {
    type: 'object',
    properties: {
      routineId: { type: 'string' },
      rationale: { type: ['string', 'null'] },
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: {
          type: 'object',
          description:
            'Uma alteração. op = rename_routine {name} | set_description {description} | add_workout {workout} | rename_workout {workoutId, label?, name?} | remove_workout {workoutId} | add_exercise {workoutId, exercise, position?} | update_exercise {workoutId, exerciseId, changes{name?, muscleGroup?, sets?, repMin?, repMax?, restSec?, warmupSets?, targetWeight?, notes?}} | remove_exercise {workoutId, exerciseId} | move_exercise {workoutId, exerciseId, toIndex}.',
          properties: {
            op: { type: 'string', enum: ['rename_routine', 'set_description', 'add_workout', 'rename_workout', 'remove_workout', 'add_exercise', 'update_exercise', 'remove_exercise', 'move_exercise'] },
            name: { type: 'string' },
            description: { type: 'string' },
            label: { type: 'string' },
            workoutId: { type: 'string' },
            exerciseId: { type: 'string' },
            position: { type: 'integer' },
            toIndex: { type: 'integer' },
            workout: PROPOSED_WORKOUT_JSON,
            exercise: PROPOSED_EXERCISE_JSON,
            changes: { type: 'object' },
          },
          required: ['op'],
        },
      },
    },
    required: ['routineId', 'changes'],
    additionalProperties: false,
  },
  args: updateRoutineArgsSchema,
  async prepare(ctx, a) {
    const r = await loadRoutine(ctx.pool, ctx.userId, a.routineId);
    if (!r) throw new ToolError('not_found', 'Ficha não encontrada nesta conta.');
    const ids = generateIds(a.changes);
    const { sections } = applyRoutineChanges(r.doc, a.changes, ids, ctx.now);
    return { kind: 'update_routine', title: `Alterar a ficha "${String(r.doc.name)}"`, rationale: a.rationale ?? null, payload: { args: a, ids }, preview: sections, targetId: r.id, baseVersion: r.version };
  },
};

// ------------------------------------------------------------------ aplicação (só depois da aprovação)

export class StaleError extends Error {}

const createHandler: ActionHandler = {
  kind: 'create_routine',
  async apply(c, ctx, action) {
    const { args, ids } = action.payload as { args: unknown; ids: GeneratedIds };
    const a = createRoutineArgsSchema.parse(args);
    const id = ids.routine!;
    const { seq, dataProfileId } = await lockUserSeq(c, ctx.userId);
    if (await lockRow(c, 'routines', ctx.userId, id)) throw new StaleError();
    const doc = normalizeRecord(
      'routines',
      id,
      { id, name: a.name, ...(a.description ? { description: a.description } : {}), workouts: a.workouts.map((w, i) => toWorkout(w, ids.workouts[i])), createdAt: ctx.now, updatedAt: ctx.now },
      dataProfileId,
    );
    await writeRow(c, 'routines', ctx.userId, id, doc, 1, seq + 1, null);
    await saveUserSeq(c, ctx.userId, seq + 1);
    return { collection: 'routines', entityId: id, summary: `Ficha "${a.name}" criada (${a.workouts.length} treino(s)).` };
  },
};

const updateHandler: ActionHandler = {
  kind: 'update_routine',
  async apply(c, ctx, action) {
    const { args, ids } = action.payload as { args: unknown; ids: GeneratedIds };
    const a = updateRoutineArgsSchema.parse(args);
    const { seq, dataProfileId } = await lockUserSeq(c, ctx.userId);
    const cur = await lockRow(c, 'routines', ctx.userId, a.routineId);
    // Mudou desde a proposta (outro aparelho, a própria pessoa, outra aprovação): nada é sobrescrito.
    if (!cur || cur.deleted || cur.version !== action.baseVersion) throw new StaleError();
    const { doc } = applyRoutineChanges(cur.doc, a.changes, ids, ctx.now);
    const normalized = normalizeRecord('routines', a.routineId, doc, dataProfileId);
    await writeRow(c, 'routines', ctx.userId, a.routineId, normalized, cur.version + 1, seq + 1, null);
    await saveUserSeq(c, ctx.userId, seq + 1);
    return { collection: 'routines', entityId: a.routineId, summary: `Ficha "${String(normalized.name)}" atualizada (${a.changes.length} alteração(ões)).` };
  },
};

export const trainingModule: AiModuleDef = {
  id: 'training',
  name: 'Treinos e fichas',
  status: 'available',
  scope: 'fichas (rotinas), treinos concluídos, séries, cargas, evolução de exercícios',
  tools: [getOverview, listRoutines, getRoutine, listWorkouts, getWorkout, listExercises, exerciseProgress, proposeCreate, proposeUpdate],
  actions: [createHandler, updateHandler],
};
