// Operações do RPG (hábitos, rotinas, missões, perfil) e visões para o app. Usado pelas rotas (/api/v1/life/*) e pelos
// handlers das propostas aprovadas do assistente — o mesmo caminho e as mesmas validações nos dois casos.
// Toda consulta filtra por user_id; um ID de outra conta simplesmente "não existe".
import { randomUUID } from 'node:crypto';
import {
  ACHIEVEMENTS,
  ATTRIBUTES,
  ATTRIBUTE_LABEL,
  FUTURE_MODULES,
  LIFE_PROTOCOL,
  REWARD,
  attributeLevelFromXp,
  defaultMissionXp,
  levelFromXp,
  titleForLevel,
  unlockedTitles,
  type AchievementView,
  type Attribute,
  type DashboardView,
  type HabitInput,
  type HabitPatch,
  type HabitView,
  type MissionEntryView,
  type MissionInput,
  type MissionPatch,
  type MissionView,
  type NextActivityView,
  type ProfileView,
  type RoutineInput,
  type RoutinePatch,
  type RoutineView,
  type XpEventView,
} from '../../../../shared/life/protocol.ts';
import type { PoolClient } from '../db/pool.ts';
import { ApiError } from '../http/core.ts';
import { addDays, isValidTimezone, localDate } from '../assistant/tools/time.ts';
import { achievementProgress, grant, isRestDay, recomputeMission, reverse, scheduledOn, streakOf, validWorkoutsSql, weekOf, weekday, type LifeTx, type MissionRow, type ProfileRow } from './engine.ts';

type Q = Pick<PoolClient, 'query'>;

export const LIMITS = { habits: 60, routines: 20, activeMissions: 60 };

// ------------------------------------------------------------------ linhas

export interface HabitRow {
  id: string;
  name: string;
  description: string | null;
  attribute: Attribute;
  tag: HabitView['tag'];
  icon: HabitView['icon'];
  frequency: 'daily' | 'weekly';
  days: number[];
  times_per_week: number | null;
  goal_kind: HabitView['goalKind'];
  goal_target: number;
  goal_unit: string | null;
  preferred_time: string | null;
  xp: number;
  status: HabitView['status'];
  start_date: string;
  origin: 'user' | 'ai';
  version: number;
}

export interface RoutineRow {
  id: string;
  name: string;
  kind: RoutineView['kind'];
  days: number[];
  status: RoutineView['status'];
  version: number;
}

export interface ItemRow {
  id: string;
  routine_id: string;
  position: number;
  title: string;
  start_time: string | null;
  duration_min: number | null;
  habit_id: string | null;
  mission_id: string | null;
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function getHabit(c: Q, userId: string, id: string, lock = false): Promise<HabitRow | null> {
  if (!isUuid(id)) return null;
  const r = await c.query<HabitRow>(`SELECT * FROM life_habits WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id]);
  return r.rows[0] ?? null;
}
export async function getRoutine(c: Q, userId: string, id: string, lock = false): Promise<RoutineRow | null> {
  if (!isUuid(id)) return null;
  const r = await c.query<RoutineRow>(`SELECT * FROM life_routines WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id]);
  return r.rows[0] ?? null;
}
export async function getMission(c: Q, userId: string, id: string, lock = false): Promise<MissionRow | null> {
  if (!isUuid(id)) return null;
  const r = await c.query<MissionRow>(`SELECT * FROM life_missions WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id]);
  return r.rows[0] ?? null;
}
const items = async (c: Q, userId: string, routineIds: string[]) =>
  routineIds.length ? (await c.query<ItemRow>('SELECT * FROM life_routine_items WHERE user_id = $1 AND routine_id = ANY($2) ORDER BY routine_id, position', [userId, routineIds])).rows : [];

/** Só hoje e ontem (no fuso da conta). Nada no futuro; nada antes do início do hábito. */
export function allowedDate(t: LifeTx, date: string | undefined, min?: string): string {
  const d = date ?? t.today;
  if (d > t.today || d < addDays(t.today, -1) || (min && d < min)) throw new ApiError('life_date_not_allowed');
  return d;
}

// ------------------------------------------------------------------ hábitos

const habitCols = (h: HabitInput | HabitRow) =>
  'goalKind' in h
    ? [h.name, h.description ?? null, h.attribute, h.tag, h.icon, h.frequency, h.days, h.timesPerWeek, h.goalKind, h.goalTarget, h.goalUnit ?? null, h.preferredTime ?? null, h.xp]
    : [h.name, h.description, h.attribute, h.tag, h.icon, h.frequency, h.days, h.times_per_week, h.goal_kind, h.goal_target, h.goal_unit, h.preferred_time, h.xp];

export async function createHabit(t: LifeTx, h: HabitInput, origin: 'user' | 'ai', id: string = randomUUID()): Promise<HabitRow> {
  const n = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM life_habits WHERE user_id = $1 AND status <> 'archived'", [t.userId])).rows[0].n;
  if (n >= LIMITS.habits) throw new ApiError('life_limit');
  const r = await t.c.query<HabitRow>(
    `INSERT INTO life_habits (id, user_id, name, description, attribute, tag, icon, frequency, days, times_per_week, goal_kind, goal_target, goal_unit, preferred_time, xp, start_date, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [id, t.userId, ...habitCols(h), t.today, origin],
  );
  return r.rows[0];
}

/** Aplica um patch validado (com conferência de versão quando informada). Devolve a linha nova e a anterior. */
export async function updateHabit(t: LifeTx, id: string, patch: HabitPatch, version?: number | null): Promise<{ before: HabitRow; after: HabitRow }> {
  const before = await getHabit(t.c, t.userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && before.version !== version) throw new ApiError('life_stale');
  const next: HabitRow = {
    ...before,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
    ...(patch.attribute ? { attribute: patch.attribute } : {}),
    ...(patch.tag ? { tag: patch.tag } : {}),
    ...(patch.icon ? { icon: patch.icon } : {}),
    ...(patch.frequency ? { frequency: patch.frequency } : {}),
    ...(patch.days ? { days: patch.days } : {}),
    ...(patch.timesPerWeek !== undefined ? { times_per_week: patch.timesPerWeek ?? null } : {}),
    ...(patch.goalKind ? { goal_kind: patch.goalKind } : {}),
    ...(patch.goalTarget !== undefined ? { goal_target: patch.goalTarget } : {}),
    ...(patch.goalUnit !== undefined ? { goal_unit: patch.goalUnit ?? null } : {}),
    ...(patch.preferredTime !== undefined ? { preferred_time: patch.preferredTime ?? null } : {}),
    ...(patch.xp !== undefined ? { xp: patch.xp } : {}),
    ...(patch.status ? { status: patch.status } : {}),
  };
  if (next.goal_kind === 'check') next.goal_target = 1;
  if (next.frequency === 'weekly' && !next.times_per_week) throw new ApiError('validation_failed', { timesPerWeek: 'Informe quantas vezes por semana.' });
  if (next.frequency === 'daily') next.times_per_week = null;
  if (before.status === 'archived' && next.status !== 'archived') {
    const n = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM life_habits WHERE user_id = $1 AND status <> 'archived'", [t.userId])).rows[0].n;
    if (n >= LIMITS.habits) throw new ApiError('life_limit');
  }
  const r = await t.c.query<HabitRow>(
    `UPDATE life_habits SET name = $3, description = $4, attribute = $5, tag = $6, icon = $7, frequency = $8, days = $9, times_per_week = $10, goal_kind = $11, goal_target = $12,
       goal_unit = $13, preferred_time = $14, xp = $15, status = $16, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [t.userId, id, ...habitCols(next), next.status],
  );
  return { before, after: r.rows[0] };
}

/** Registra quanto foi feito no dia (valor absoluto). Cumprir a meta concede o XP do hábito uma vez; desfazer estorna. */
export async function logHabit(t: LifeTx, id: string, amount: number, date?: string): Promise<{ completed: boolean }> {
  const h = await getHabit(t.c, t.userId, id, true);
  if (!h) throw new ApiError('not_found');
  if (h.status !== 'active') throw new ApiError('life_inactive');
  const d = allowedDate(t, date, h.start_date);
  const completed = amount >= h.goal_target;
  await t.c.query(
    `INSERT INTO life_habit_logs (user_id, habit_id, date, amount, completed) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, habit_id, date) DO UPDATE SET amount = EXCLUDED.amount, completed = EXCLUDED.completed, updated_at = now()`,
    [t.userId, id, d, amount, completed],
  );
  const key = `habit:${id}:${d}`;
  if (completed) {
    // Semanal: XP só até a meta da semana; além dela conta como atividade (sequência, missões) sem XP.
    let xp = h.xp;
    let reason = `Hábito cumprido: ${h.name}`;
    if (h.frequency === 'weekly') {
      const w = weekOf(d);
      const done = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM life_xp_events WHERE user_id = $1 AND source = 'habit' AND source_id = $2 AND kind = 'grant' AND reversed_at IS NULL AND amount > 0 AND day BETWEEN $3 AND $4", [t.userId, id, w.start, w.end])).rows[0].n;
      if (done >= (h.times_per_week ?? 0)) {
        xp = 0;
        reason = `Hábito cumprido além da meta semanal: ${h.name}`;
      }
    } else if (!h.days.includes(weekday(d))) {
      xp = 0;
      reason = `Hábito cumprido fora dos dias previstos: ${h.name}`;
    }
    await grant(t, { source: 'habit', key, sourceId: id, attribute: h.attribute, requested: xp, day: d, reason });
  } else await reverse(t, key, `Hábito desmarcado: ${h.name}`);
  await refreshRoutinesOf(t, d, { habitId: id });
  return { completed };
}

// ------------------------------------------------------------------ rotinas

async function validateLinks(t: LifeTx, list: { habitId?: string | null; missionId?: string | null }[]): Promise<void> {
  for (const i of list) {
    if (i.habitId && !(await getHabit(t.c, t.userId, i.habitId))) throw new ApiError('validation_failed', { habitId: 'Hábito não encontrado.' });
    if (i.missionId) {
      const m = await getMission(t.c, t.userId, i.missionId);
      if (!m || m.metric !== 'manual') throw new ApiError('validation_failed', { missionId: 'Missão não encontrada (só missões com registro manual).' });
    }
  }
}

async function writeItems(t: LifeTx, routineId: string, list: (RoutinePatch['items'] & object)[number][], keepIds: Set<string>): Promise<void> {
  await t.c.query('DELETE FROM life_routine_items WHERE user_id = $1 AND routine_id = $2 AND NOT (id = ANY($3))', [t.userId, routineId, [...keepIds]]);
  let pos = 0;
  for (const i of list) {
    const id = i.id && keepIds.has(i.id) ? i.id : randomUUID();
    await t.c.query(
      `INSERT INTO life_routine_items (id, user_id, routine_id, position, title, start_time, duration_min, habit_id, mission_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, title = EXCLUDED.title, start_time = EXCLUDED.start_time, duration_min = EXCLUDED.duration_min, habit_id = EXCLUDED.habit_id, mission_id = EXCLUDED.mission_id`,
      [id, t.userId, routineId, pos++, i.title, i.startTime ?? null, i.durationMin ?? null, i.habitId ?? null, i.missionId ?? null],
    );
  }
}

export async function createRoutine(t: LifeTx, r: RoutineInput, origin: 'user' | 'ai', id: string = randomUUID()): Promise<RoutineRow> {
  const n = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM life_routines WHERE user_id = $1 AND status <> 'archived'", [t.userId])).rows[0].n;
  if (n >= LIMITS.routines) throw new ApiError('life_limit');
  await validateLinks(t, r.items);
  const row = (await t.c.query<RoutineRow>('INSERT INTO life_routines (id, user_id, name, kind, days, origin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [id, t.userId, r.name, r.kind, r.days, origin])).rows[0];
  await writeItems(t, id, r.items, new Set());
  return row;
}

export interface RoutineSnapshot {
  row: RoutineRow;
  items: ItemRow[];
}

export async function routineSnapshot(c: Q, userId: string, id: string): Promise<RoutineSnapshot | null> {
  const row = await getRoutine(c, userId, id);
  return row ? { row, items: await items(c, userId, [id]) } : null;
}

export async function updateRoutine(t: LifeTx, id: string, patch: RoutinePatch, version?: number | null): Promise<{ before: RoutineSnapshot; after: RoutineRow }> {
  const row = await getRoutine(t.c, t.userId, id, true);
  if (!row) throw new ApiError('not_found');
  if (version != null && row.version !== version) throw new ApiError('life_stale');
  const before = { row, items: await items(t.c, t.userId, [id]) };
  if (patch.items) {
    await validateLinks(t, patch.items);
    await writeItems(t, id, patch.items, new Set(before.items.map((i) => i.id)));
  }
  const after = (
    await t.c.query<RoutineRow>('UPDATE life_routines SET name = $3, kind = $4, days = $5, status = $6, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *', [
      t.userId,
      id,
      patch.name ?? row.name,
      patch.kind ?? row.kind,
      patch.days ?? row.days,
      patch.status ?? row.status,
    ])
  ).rows[0];
  return { before, after };
}

/** Restaura uma rotina exatamente como estava (desfazer de proposta da IA). */
export async function restoreRoutine(t: LifeTx, snap: RoutineSnapshot): Promise<void> {
  await t.c.query('UPDATE life_routines SET name = $3, kind = $4, days = $5, status = $6, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2', [t.userId, snap.row.id, snap.row.name, snap.row.kind, snap.row.days, snap.row.status]);
  await writeItems(
    t,
    snap.row.id,
    snap.items.map((i) => ({ id: i.id, title: i.title, startTime: i.start_time, durationMin: i.duration_min, habitId: i.habit_id, missionId: i.mission_id })),
    new Set(snap.items.map((i) => i.id)),
  );
}

async function itemDone(c: Q, userId: string, i: ItemRow, date: string): Promise<boolean> {
  if (i.habit_id) return !!(await c.query('SELECT 1 FROM life_habit_logs WHERE user_id = $1 AND habit_id = $2 AND date = $3 AND completed', [userId, i.habit_id, date])).rowCount;
  if (i.mission_id) return !!(await c.query('SELECT 1 FROM life_mission_entries WHERE user_id = $1 AND source_key = $2', [userId, `routine:${i.id}:${date}`])).rowCount;
  return !!(await c.query('SELECT 1 FROM life_routine_checks WHERE user_id = $1 AND item_id = $2 AND date = $3', [userId, i.id, date])).rowCount;
}

/** Bônus de rotina completa (uma vez por rotina e dia); desmarcar uma atividade estorna. */
async function refreshRoutineBonus(t: LifeTx, r: RoutineRow, date: string): Promise<void> {
  const list = await items(t.c, t.userId, [r.id]);
  let all = list.length > 0 && r.status === 'active';
  for (const i of list) if (all && !(await itemDone(t.c, t.userId, i, date))) all = false;
  const key = `routine:${r.id}:${date}`;
  if (all) await grant(t, { source: 'routine', key, sourceId: r.id, attribute: 'discipline', requested: REWARD.routineBonus, day: date, reason: `Rotina completa: ${r.name}` });
  else await reverse(t, key, `Rotina incompleta: ${r.name}`);
}

async function refreshRoutinesOf(t: LifeTx, date: string, by: { habitId?: string; missionId?: string }): Promise<void> {
  const r = await t.c.query<RoutineRow>(
    `SELECT DISTINCT r.* FROM life_routines r JOIN life_routine_items i ON i.routine_id = r.id WHERE r.user_id = $1 AND r.status = 'active' AND (i.habit_id = $2 OR i.mission_id = $3)`,
    [t.userId, by.habitId ?? null, by.missionId ?? null],
  );
  for (const row of r.rows) await refreshRoutineBonus(t, row, date);
}

/** Marca/desmarca uma atividade da rotina. Vinculada a hábito → registra o hábito (XP do hábito, sem dobrar). */
export async function checkRoutineItem(t: LifeTx, routineId: string, itemId: string, done: boolean, date?: string): Promise<void> {
  const r = await getRoutine(t.c, t.userId, routineId, true);
  if (!r) throw new ApiError('not_found');
  if (r.status !== 'active') throw new ApiError('life_inactive');
  const d = allowedDate(t, date);
  const it = (await items(t.c, t.userId, [routineId])).find((i) => i.id === itemId);
  if (!it) throw new ApiError('not_found');
  if (it.habit_id) {
    const h = await getHabit(t.c, t.userId, it.habit_id);
    if (!h) throw new ApiError('not_found');
    const cur = (await t.c.query<{ amount: number }>('SELECT amount FROM life_habit_logs WHERE user_id = $1 AND habit_id = $2 AND date = $3', [t.userId, h.id, d])).rows[0]?.amount ?? 0;
    await logHabit(t, h.id, done ? Math.max(cur, h.goal_target) : 0, d);
  } else if (it.mission_id) {
    const m = await getMission(t.c, t.userId, it.mission_id, true);
    if (!m || m.metric !== 'manual') throw new ApiError('not_found');
    const key = `routine:${it.id}:${d}`;
    if (done) {
      if (m.status !== 'active' || d < m.starts_on || d > m.ends_on) throw new ApiError('life_inactive');
      const amount = m.unit === 'minutes' ? (it.duration_min ?? 1) : 1;
      await t.c.query('INSERT INTO life_mission_entries (id, user_id, mission_id, date, amount, source_key) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, source_key) WHERE source_key IS NOT NULL DO NOTHING', [randomUUID(), t.userId, m.id, d, amount, key]);
    } else await t.c.query('DELETE FROM life_mission_entries WHERE user_id = $1 AND source_key = $2', [t.userId, key]);
    await recomputeMission(t, m);
    await refreshRoutineBonus(t, r, d);
  } else {
    if (done) await t.c.query('INSERT INTO life_routine_checks (user_id, item_id, date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [t.userId, it.id, d]);
    else await t.c.query('DELETE FROM life_routine_checks WHERE user_id = $1 AND item_id = $2 AND date = $3', [t.userId, it.id, d]);
    await refreshRoutineBonus(t, r, d);
  }
}

// ------------------------------------------------------------------ missões

export function missionXp(input: Pick<MissionInput, 'type' | 'unit' | 'target' | 'xp'>, days: number, allowChoice: boolean): number {
  const lim = REWARD.mission[input.type];
  if (allowChoice && input.xp != null) return Math.min(lim.max, Math.max(lim.min, input.xp));
  return defaultMissionXp(input.type, input.unit, input.target, days);
}

export function missionPeriod(t: LifeTx, input: Pick<MissionInput, 'type' | 'startsOn' | 'endsOn'>): { starts: string; ends: string; days: number } {
  const starts = input.startsOn ?? t.today;
  const ends = input.endsOn;
  if (starts < t.today) throw new ApiError('validation_failed', { startsOn: 'O início não pode ser no passado.' });
  if (ends < starts) throw new ApiError('validation_failed', { endsOn: 'O prazo é antes do início.' });
  const days = Math.round((Date.parse(`${ends}T00:00:00Z`) - Date.parse(`${starts}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > 366) throw new ApiError('validation_failed', { endsOn: 'Prazo máximo de um ano.' });
  if (input.type === 'special' && (days < 3 || days > 90)) throw new ApiError('validation_failed', { endsOn: 'Missões especiais duram de 3 a 90 dias.' });
  return { starts, ends, days };
}

export async function createMission(t: LifeTx, m: MissionInput, origin: 'user' | 'ai', id: string = randomUUID()): Promise<MissionRow> {
  const n = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM life_missions WHERE user_id = $1 AND status IN ('active', 'paused') AND origin <> 'system'", [t.userId])).rows[0].n;
  if (n >= LIMITS.activeMissions) throw new ApiError('life_limit');
  if (m.habitId && !(await getHabit(t.c, t.userId, m.habitId))) throw new ApiError('validation_failed', { habitId: 'Hábito não encontrado.' });
  const p = missionPeriod(t, m);
  const xp = missionXp(m, p.days, origin === 'user');
  const row = (
    await t.c.query<MissionRow>(
      `INSERT INTO life_missions (id, user_id, type, origin, title, description, metric, habit_id, unit, tag, target, attribute, xp, starts_on, ends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [id, t.userId, m.type, origin, m.title, m.description ?? null, m.metric, m.habitId, m.unit, m.tag, m.target, m.attribute, xp, p.starts, p.ends],
    )
  ).rows[0];
  await recomputeMission(t, row);
  return row;
}

export async function updateMission(t: LifeTx, id: string, patch: MissionPatch, version?: number | null): Promise<{ before: MissionRow; after: MissionRow }> {
  const before = await getMission(t.c, t.userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && before.version !== version) throw new ApiError('life_stale');
  if (['completed', 'cancelled', 'expired'].includes(before.status) && patch.status !== undefined && before.status !== 'expired') throw new ApiError('life_inactive');
  if (before.origin === 'system' && (patch.target !== undefined || patch.endsOn !== undefined || patch.title !== undefined)) throw new ApiError('validation_failed', { target: 'Missões automáticas não podem ser editadas, só pausadas.' });
  if (patch.endsOn !== undefined && (patch.endsOn < before.starts_on || patch.endsOn < t.today)) throw new ApiError('validation_failed', { endsOn: 'Prazo inválido.' });
  let status = patch.status ?? before.status;
  if (before.status === 'expired' && patch.endsOn && patch.endsOn >= t.today) status = 'active';
  if (status === 'active' && (patch.endsOn ?? before.ends_on) < t.today) status = 'expired';
  const after = (
    await t.c.query<MissionRow>(
      'UPDATE life_missions SET title = $3, description = $4, target = $5, ends_on = $6, status = $7, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *',
      [t.userId, id, patch.title ?? before.title, patch.description !== undefined ? patch.description : before.description, patch.target ?? before.target, patch.endsOn ?? before.ends_on, status],
    )
  ).rows[0];
  if (after.status === 'cancelled' && before.status === 'completed') await reverse(t, `mission:${id}`, `Missão cancelada: ${after.title}`);
  await recomputeMission(t, after);
  return { before, after: (await getMission(t.c, t.userId, id))! };
}

export async function addMissionEntry(t: LifeTx, id: string, amount: number, date?: string, note?: string | null): Promise<void> {
  const m = await getMission(t.c, t.userId, id, true);
  if (!m) throw new ApiError('not_found');
  if (m.metric !== 'manual') throw new ApiError('validation_failed', { amount: 'Esta missão é medida automaticamente.' });
  if (m.status !== 'active') throw new ApiError('life_inactive');
  const d = allowedDate(t, date, m.starts_on);
  if (d > m.ends_on) throw new ApiError('life_inactive');
  await t.c.query('INSERT INTO life_mission_entries (id, user_id, mission_id, date, amount, note) VALUES ($1, $2, $3, $4, $5, $6)', [randomUUID(), t.userId, id, d, m.unit === 'check' ? 1 : amount, note ?? null]);
  await recomputeMission(t, m);
}

export async function deleteMissionEntry(t: LifeTx, id: string, entryId: string): Promise<void> {
  const m = await getMission(t.c, t.userId, id, true);
  if (!m || !isUuid(entryId)) throw new ApiError('not_found');
  const r = await t.c.query<{ source_key: string | null }>('DELETE FROM life_mission_entries WHERE user_id = $1 AND mission_id = $2 AND id = $3 RETURNING source_key', [t.userId, id, entryId]);
  if (!r.rowCount) throw new ApiError('not_found');
  await recomputeMission(t, m);
}

// ------------------------------------------------------------------ dias de descanso e perfil

export async function setRestDay(t: LifeTx, date: string, rest: boolean): Promise<void> {
  if (date < addDays(t.today, -1) || date > addDays(t.today, 30)) throw new ApiError('life_date_not_allowed');
  if (rest) {
    await t.c.query("INSERT INTO life_day_marks (user_id, date, kind) VALUES ($1, $2, 'rest') ON CONFLICT DO NOTHING", [t.userId, date]);
    await t.c.query("UPDATE life_missions SET status = 'paused', updated_at = now() WHERE user_id = $1 AND type = 'daily' AND origin = 'system' AND status = 'active' AND starts_on = $2", [t.userId, date]);
  } else {
    await t.c.query('DELETE FROM life_day_marks WHERE user_id = $1 AND date = $2', [t.userId, date]);
    const r = await t.c.query<MissionRow>("UPDATE life_missions SET status = 'active', updated_at = now() WHERE user_id = $1 AND type = 'daily' AND origin = 'system' AND status = 'paused' AND starts_on = $2 RETURNING *", [t.userId, date]);
    for (const m of r.rows) await recomputeMission(t, m);
  }
  t.touched.add(date);
}

export async function patchProfile(t: LifeTx, p: { timezone?: string; selectedTitle?: string | null; weeklyWorkoutTarget?: number | null }): Promise<void> {
  if (p.timezone !== undefined) {
    if (!isValidTimezone(p.timezone)) throw new ApiError('validation_failed', { timezone: 'Fuso horário inválido.' });
    // Trocar o fuso não recalcula dias já registrados (ficam com a data local da época): nada duplica nem some.
    if (p.timezone !== t.profile.timezone) await t.c.query('UPDATE life_profiles SET timezone = $2, tz_changed_at = now(), updated_at = now() WHERE user_id = $1', [t.userId, p.timezone]);
  }
  if (p.selectedTitle !== undefined) {
    if (p.selectedTitle !== null && !unlockedTitles(levelFromXp(Number(t.profile.total_xp)).level).includes(p.selectedTitle)) throw new ApiError('validation_failed', { selectedTitle: 'Título ainda não desbloqueado.' });
    await t.c.query('UPDATE life_profiles SET selected_title = $2, updated_at = now() WHERE user_id = $1', [t.userId, p.selectedTitle]);
  }
  if (p.weeklyWorkoutTarget !== undefined) await t.c.query('UPDATE life_profiles SET weekly_workout_target = $2, updated_at = now() WHERE user_id = $1', [t.userId, p.weeklyWorkoutTarget]);
}

// ------------------------------------------------------------------ visões

export async function profileView(c: Q, p: ProfileRow, today: string): Promise<ProfileView> {
  const attrs = (await c.query<{ attribute: Attribute; xp: number }>('SELECT attribute, xp FROM life_attributes WHERE user_id = $1', [p.user_id])).rows;
  const byAttr = new Map(attrs.map((a) => [a.attribute, Number(a.xp)]));
  const xpToday = (await c.query<{ n: number }>("SELECT coalesce(sum(amount), 0)::int AS n FROM life_xp_events WHERE user_id = $1 AND day = $2 AND source IN ('habit', 'mission', 'workout', 'routine')", [p.user_id, today])).rows[0].n;
  const total = Number(p.total_xp);
  const level = levelFromXp(total);
  const titles = unlockedTitles(level.level);
  return {
    timezone: p.timezone,
    today,
    activatedAt: p.activated_at.toISOString(),
    totalXp: total,
    level,
    title: p.selected_title && titles.includes(p.selected_title) ? p.selected_title : titleForLevel(level.level),
    titles,
    selectedTitle: p.selected_title,
    attributes: ATTRIBUTES.map((a) => ({ attribute: a, label: ATTRIBUTE_LABEL[a], xp: byAttr.get(a) ?? 0, level: attributeLevelFromXp(byAttr.get(a) ?? 0) })),
    streak: await streakOf(c as PoolClient, p.user_id, today),
    xpToday,
    dailyCap: REWARD.dailyCap,
    weeklyWorkoutTarget: p.weekly_workout_target,
  };
}

export async function habitViews(c: Q, userId: string, today: string, opts: { includeArchived?: boolean } = {}): Promise<HabitView[]> {
  const rows = (await c.query<HabitRow>(`SELECT * FROM life_habits WHERE user_id = $1 ${opts.includeArchived ? '' : "AND status <> 'archived'"} ORDER BY status, preferred_time NULLS LAST, created_at`, [userId])).rows;
  if (!rows.length) return [];
  const w = weekOf(today);
  const from = addDays(today, -120);
  const logs = (await c.query<{ habit_id: string; date: string; amount: number; completed: boolean }>('SELECT habit_id, date, amount, completed FROM life_habit_logs WHERE user_id = $1 AND date >= $2', [userId, from])).rows;
  const by = new Map<string, Map<string, { amount: number; completed: boolean }>>();
  for (const l of logs) {
    if (!by.has(l.habit_id)) by.set(l.habit_id, new Map());
    by.get(l.habit_id)!.set(l.date, l);
  }
  return rows.map((h) => {
    const m = by.get(h.id) ?? new Map();
    const t = m.get(today);
    let week = 0;
    for (let d = w.start; d <= w.end; d = addDays(d, 1)) if (m.get(d)?.completed) week++;
    // Sequência do hábito: dias previstos seguidos cumpridos (hoje em aberto não quebra; semanais contam semanas).
    let streak = 0;
    if (h.frequency === 'daily') {
      let d = m.get(today)?.completed ? today : addDays(today, -1);
      while (d >= from && d >= h.start_date) {
        if (h.days.includes(weekday(d))) {
          if (m.get(d)?.completed) streak++;
          else break;
        }
        d = addDays(d, -1);
      }
    } else {
      let ws = w.start;
      let first = true;
      while (ws >= from) {
        let n = 0;
        for (let d = ws; d <= addDays(ws, 6); d = addDays(d, 1)) if (m.get(d)?.completed) n++;
        if (n >= (h.times_per_week ?? 1)) streak++;
        else if (!first) break;
        first = false;
        ws = addDays(ws, -7);
      }
    }
    const sched = scheduledOn(h, today) && (h.frequency === 'daily' || week < (h.times_per_week ?? 0) || !!t?.completed);
    return {
      id: h.id,
      name: h.name,
      description: h.description,
      attribute: h.attribute,
      tag: h.tag,
      icon: h.icon,
      frequency: h.frequency,
      days: h.days,
      timesPerWeek: h.times_per_week,
      goalKind: h.goal_kind,
      goalTarget: h.goal_target,
      goalUnit: h.goal_unit,
      preferredTime: h.preferred_time,
      xp: h.xp,
      status: h.status,
      startDate: h.start_date,
      version: h.version,
      today: { scheduled: sched, amount: t?.amount ?? 0, completed: !!t?.completed },
      week: { completions: week },
      streak,
    };
  });
}

export async function routineViews(c: Q, userId: string, today: string, opts: { includeArchived?: boolean } = {}): Promise<RoutineView[]> {
  const rows = (await c.query<RoutineRow>(`SELECT * FROM life_routines WHERE user_id = $1 ${opts.includeArchived ? '' : "AND status <> 'archived'"} ORDER BY status, created_at`, [userId])).rows;
  const list = await items(c, userId, rows.map((r) => r.id));
  const out: RoutineView[] = [];
  for (const r of rows) {
    const its = list.filter((i) => i.routine_id === r.id);
    const views = [];
    for (const i of its) views.push({ id: i.id, position: i.position, title: i.title, startTime: i.start_time, durationMin: i.duration_min, habitId: i.habit_id, missionId: i.mission_id, done: await itemDone(c, userId, i, today) });
    out.push({ id: r.id, name: r.name, kind: r.kind, days: r.days, status: r.status, version: r.version, scheduledToday: r.status === 'active' && r.days.includes(weekday(today)), completedToday: views.length > 0 && views.every((v) => v.done), items: views });
  }
  return out;
}

export const missionView = (m: MissionRow): MissionView => ({
  id: m.id,
  type: m.type,
  origin: m.origin,
  title: m.title,
  description: m.description,
  metric: m.metric,
  habitId: m.habit_id,
  unit: m.unit,
  tag: m.tag,
  target: m.target,
  progress: m.progress,
  attribute: m.attribute,
  xp: m.xp,
  startsOn: m.starts_on,
  endsOn: m.ends_on,
  status: m.status,
  completedAt: m.completed_at?.toISOString() ?? null,
  version: m.version,
});

export async function missionViews(c: Q, userId: string, scope: 'current' | 'history', today: string): Promise<MissionView[]> {
  const sql =
    scope === 'current'
      ? "SELECT * FROM life_missions WHERE user_id = $1 AND (status IN ('active', 'paused') OR (status = 'completed' AND ends_on >= $2)) ORDER BY ends_on, created_at"
      : "SELECT * FROM life_missions WHERE user_id = $1 AND (status IN ('expired', 'cancelled') OR (status = 'completed' AND ends_on < $2)) ORDER BY ends_on DESC, created_at DESC LIMIT 100";
  return (await c.query<MissionRow>(sql, [userId, today])).rows.map(missionView);
}

export async function missionEntries(c: Q, userId: string, id: string): Promise<MissionEntryView[]> {
  const r = await c.query<{ id: string; date: string; amount: number; note: string | null; created_at: Date; source_key: string | null }>('SELECT * FROM life_mission_entries WHERE user_id = $1 AND mission_id = $2 ORDER BY date DESC, created_at DESC LIMIT 200', [userId, id]);
  return r.rows.map((e) => ({ id: e.id, date: e.date, amount: e.amount, note: e.note, createdAt: e.created_at.toISOString(), fromRoutine: !!e.source_key }));
}

export async function xpHistory(c: Q, userId: string, limit = 100, from?: string, to?: string): Promise<XpEventView[]> {
  const r = await c.query<{ id: string; kind: 'grant' | 'reversal'; source: XpEventView['source']; attribute: Attribute | null; amount: number; requested: number; day: string; reason: string; reversed_at: Date | null; created_at: Date }>(
    `SELECT * FROM life_xp_events WHERE user_id = $1 AND ($2::date IS NULL OR day >= $2) AND ($3::date IS NULL OR day <= $3) ORDER BY created_at DESC LIMIT $4`,
    [userId, from ?? null, to ?? null, limit],
  );
  return r.rows.map((e) => ({ id: e.id, kind: e.kind, source: e.source, attribute: e.attribute, amount: e.amount, requested: e.requested, day: e.day, reason: e.reason, reversed: !!e.reversed_at, createdAt: e.created_at.toISOString() }));
}

export async function achievementViews(c: Q, userId: string, today: string): Promise<AchievementView[]> {
  const got = new Map((await c.query<{ code: string; unlocked_at: Date }>('SELECT code, unlocked_at FROM life_achievements WHERE user_id = $1', [userId])).rows.map((r) => [r.code, r.unlocked_at]));
  const prog = await achievementProgress(c as PoolClient, userId, today);
  return ACHIEVEMENTS.map((a) => {
    const p = prog[a.code];
    const at = got.get(a.code);
    return { code: a.code, title: a.title, description: a.description, attribute: a.attribute, unlockedAt: at?.toISOString() ?? null, progress: p.available || at ? { value: at ? p.target : p.value, target: p.target } : null, available: p.available || !!at };
  });
}

/** Próximas atividades das rotinas de hoje: as não feitas, a partir do horário atual (as sem horário no fim). */
export function nextActivities(routines: RoutineView[], nowHHMM: string, limit = 4): NextActivityView[] {
  const list: (NextActivityView & { sort: string })[] = [];
  for (const r of routines) {
    if (!r.scheduledToday) continue;
    for (const i of r.items) if (!i.done) list.push({ routineId: r.id, routineName: r.name, itemId: i.id, title: i.title, startTime: i.startTime, durationMin: i.durationMin, sort: i.startTime ? (i.startTime >= nowHHMM ? `0${i.startTime}` : `1${i.startTime}`) : `2${String(i.position).padStart(2, '0')}` });
  }
  return list
    .sort((a, b) => a.sort.localeCompare(b.sort))
    .slice(0, limit)
    .map(({ sort: _s, ...x }) => x);
}

export async function dashboard(t: LifeTx, displayName: string, nowHHMM: string): Promise<Omit<DashboardView, 'outcome'>> {
  const { c, userId, today } = t;
  const [profile, habits, routines, missions] = [await profileView(c, t.profile, today), await habitViews(c, userId, today), await routineViews(c, userId, today), await missionViews(c, userId, 'current', today)];
  const rest = await isRestDay(c, userId, today);
  const habitsToday = habits.filter((h) => h.status === 'active' && h.today.scheduled);
  const missionsToday = missions.filter((m) => m.type === 'daily' && m.startsOn === today);
  const w = weekOf(today);
  const doneToday = habitsToday.filter((h) => h.today.completed).length + missionsToday.filter((m) => m.status === 'completed').length;
  const totalToday = rest ? 0 : habitsToday.length + missionsToday.filter((m) => m.status !== 'paused').length;
  const total = Number((await c.query<{ n: number }>(validWorkoutsSql('count'), [userId])).rows[0].n);
  const thisWeek = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM life_xp_events WHERE user_id = $1 AND source = 'workout' AND kind = 'grant' AND reversed_at IS NULL AND day BETWEEN $2 AND $3", [userId, w.start, w.end])).rows[0].n;
  const last = (await c.query<{ id: string; finished_at: Date; name: string | null; label: string | null }>(`${validWorkoutsSql('rows')} ORDER BY finished_at DESC LIMIT 1`, [userId])).rows[0];
  const weekly = missions.find((m) => m.type === 'weekly' && m.metric === 'workouts');
  const ach = (await achievementViews(c, userId, today)).filter((a) => a.unlockedAt).sort((a, b) => (b.unlockedAt! > a.unlockedAt! ? 1 : -1));
  return {
    protocol: LIFE_PROTOCOL,
    displayName,
    profile,
    missionsToday,
    missionsWeek: missions.filter((m) => m.type === 'weekly'),
    missionsCustom: missions.filter((m) => m.type === 'custom' || m.type === 'special'),
    habitsToday,
    dayProgress: { done: Math.min(doneToday, totalToday), total: totalToday },
    nextActivities: nextActivities(routines, nowHHMM),
    workouts: { total, thisWeek, last: last ? { id: last.id, date: localDate(last.finished_at.getTime(), t.tz), name: [last.label, last.name].filter(Boolean).join(' — ') || null } : null, weeklyTarget: weekly?.target ?? t.profile.weekly_workout_target ?? 3 },
    recentAchievements: ach.slice(0, 3),
    upcomingModules: FUTURE_MODULES.filter((m) => m.id === 'bible').map((m) => ({ id: m.id as 'nutrition' | 'reading' | 'bible', name: m.name, status: 'planned' as const })),
  };
}
