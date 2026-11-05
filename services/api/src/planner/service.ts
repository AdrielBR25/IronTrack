// "Minha Semana" (Fase 06, docs/INTEGRACAO_LIFE.md §2): agenda unificada montada SOB DEMANDA a partir dos registros de
// cada módulo. Nada aqui copia registros: cada item aponta para a origem (treino planejado, refeição, hábito, missão,
// meta de estudo, plano bíblico, item de rotina) e a situação vem do registro real. A agenda grava só atividades
// personalizadas (planner_items) e ajustes de exibição (planner_overrides). Nunca concede XP.
//
// Fuso: o da conta (life_profiles.timezone), o mesmo que os módulos usam para "dia local".
import { randomUUID } from 'node:crypto';
import { MEAL_KIND_LABEL } from '../../../../shared/nutrition/protocol.ts';
import {
  PLANNER_PROTOCOL,
  dayLoad,
  findConflicts,
  normalizeLayout,
  type AgendaCategory,
  type AgendaDay,
  type AgendaItem,
  type AgendaStatus,
  type HomeLayoutView,
  type OverrideInput,
  type PlannerItemInput,
  type WeekAgendaView,
} from '../../../../shared/planner/protocol.ts';
import type { Pool, PoolClient } from '../db/pool.ts';
import { ApiError } from '../http/core.ts';
import { addDays, isValidTimezone, localDate, localMidnight } from '../assistant/tools/time.ts';
import { planView, type PlanRow } from '../bible/service.ts';

type Q = Pick<Pool | PoolClient, 'query'>;
export const DEFAULT_TZ = 'America/Sao_Paulo';
export const MAX_DAYS = 14;

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const dates = (start: string, n: number) => Array.from({ length: n }, (_, i) => addDays(start, i));
const hhmm = (ms: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function accountTz(q: Q, userId: string): Promise<string> {
  const r = await q.query<{ timezone: string }>('SELECT timezone FROM life_profiles WHERE user_id = $1', [userId]);
  const tz = r.rows[0]?.timezone;
  return isValidTimezone(tz) ? tz : DEFAULT_TZ;
}

const CATEGORY_ORDER: Record<AgendaCategory, number> = { rest: 0, workout: 1, routine: 2, habit: 3, meal: 4, study: 5, reading: 6, bible: 7, custom: 8, mission: 9, free: 10 };

type Draft = Omit<AgendaItem, 'adjusted' | 'position' | 'can'> & { can?: Partial<AgendaItem['can']> };

interface PlanEntryDoc {
  id: string;
  scope: 'weekly' | 'date';
  weekday?: number | null;
  date?: string | null;
  kind: 'workout' | 'rest' | 'free';
  routineId?: string | null;
  workoutId?: string | null;
  enabled?: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
  createdAt?: number;
}

/**
 * Mesma regra de `planForDate` do app (src/modules/planner/operations.ts, P13): exceções de uma data substituem o
 * modelo semanal inteiro naquela data; entradas pausadas e fora da vigência não valem.
 */
export function planEntriesFor(all: PlanEntryDoc[], date: string): PlanEntryDoc[] {
  const ex = all.filter((e) => e.scope === 'date' && e.date === date);
  if (ex.length) return ex;
  const wd = weekdayOf(date);
  return all.filter((e) => e.scope === 'weekly' && e.enabled !== false && e.weekday === wd && !!e.validFrom && e.validFrom <= date && (e.validUntil == null || e.validUntil >= date));
}

/** Monta a agenda de `days` dias a partir de `start` (datas locais da conta). */
export async function buildAgenda(q: Q, userId: string, now: number, start: string, days: number, tzIn?: string): Promise<WeekAgendaView> {
  const tz = tzIn ?? (await accountTz(q, userId));
  const today = localDate(now, tz);
  const n = Math.max(1, Math.min(MAX_DAYS, days));
  const list = dates(start, n);
  const end = list[list.length - 1];
  const fromMs = localMidnight(start, tz);
  const toMs = localMidnight(addDays(end, 1), tz);
  const items: Draft[] = [];
  const restDays = new Set<string>();

  const [entries, routinesDoc, sessions, meals, habits, habitLogs, lifeRoutines, routineChecks, missions, kGoals, kSessions, kTimer, plans, prefs, marks, custom, overrides] = await Promise.all([
    q.query<{ doc: PlanEntryDoc }>('SELECT doc FROM plan_entries WHERE user_id = $1 AND NOT deleted', [userId]),
    q.query<{ id: string; doc: { name?: string; workouts?: { id: string; label?: string; name?: string }[] } }>('SELECT id, doc FROM routines WHERE user_id = $1 AND NOT deleted', [userId]),
    q.query<{ id: string; status: string; routine_id: string | null; workout_id: string | null; started_at: Date; finished_at: Date | null; name: string | null; label: string | null }>(
      `SELECT id, status, routine_id, workout_id, started_at, finished_at, doc->>'workoutName' AS name, doc->>'workoutLabel' AS label FROM workout_sessions
        WHERE user_id = $1 AND NOT deleted AND status IN ('active', 'completed') AND started_at >= to_timestamp($2 / 1000.0) AND started_at < to_timestamp($3 / 1000.0)`,
      [userId, fromMs, toMs],
    ),
    q.query<{ id: string; date: string; kind: string; name: string | null; time: string | null; status: 'planned' | 'consumed'; kcal: number | null; n: number }>(
      `SELECT m.id, m.date, m.kind, m.name, m.time, m.status, (SELECT round(sum(i.kcal))::int FROM nutrition_meal_items i WHERE i.meal_id = m.id) AS kcal,
              (SELECT count(*)::int FROM nutrition_meal_items i WHERE i.meal_id = m.id) AS n
         FROM nutrition_meals m WHERE m.user_id = $1 AND m.date BETWEEN $2 AND $3`,
      [userId, start, end],
    ),
    q.query<{ id: string; name: string; frequency: string; days: number[]; goal_kind: string; goal_target: number; goal_unit: string | null; preferred_time: string | null; status: string; start_date: string; tag: string }>(
      "SELECT id, name, frequency, days, goal_kind, goal_target, goal_unit, preferred_time, status, start_date, tag FROM life_habits WHERE user_id = $1 AND status IN ('active', 'paused')",
      [userId],
    ),
    q.query<{ habit_id: string; date: string; completed: boolean; amount: number }>('SELECT habit_id, date, completed, amount FROM life_habit_logs WHERE user_id = $1 AND date BETWEEN $2 AND $3', [userId, start, end]),
    q.query<{ routine_id: string; routine_name: string; days: number[]; item_id: string; title: string; start_time: string | null; duration_min: number | null; habit_id: string | null; position: number; kind: string }>(
      `SELECT r.id AS routine_id, r.name AS routine_name, r.days, r.kind, i.id AS item_id, i.title, i.start_time, i.duration_min, i.habit_id, i.position
         FROM life_routines r JOIN life_routine_items i ON i.routine_id = r.id WHERE r.user_id = $1 AND r.status = 'active' ORDER BY r.name, i.position`,
      [userId],
    ),
    q.query<{ item_id: string; date: string }>('SELECT item_id, date FROM life_routine_checks WHERE user_id = $1 AND date BETWEEN $2 AND $3', [userId, start, end]),
    q.query<{ id: string; type: string; title: string; status: string; starts_on: string; ends_on: string; progress: number; target: number; unit: string; tag: string }>(
      "SELECT id, type, title, status, starts_on, ends_on, progress, target, unit, tag FROM life_missions WHERE user_id = $1 AND status IN ('active', 'completed', 'paused', 'expired') AND ends_on BETWEEN $2 AND $3 AND (type <> 'daily' OR starts_on = ends_on)",
      [userId, start, end],
    ),
    q.query<{ id: string; module: string; title: string; metric: string; scope: string; period: string; target: number; days: number[]; preferred_time: string | null; status: string; starts_on: string; subject_id: string | null; book_id: string | null }>(
      "SELECT id, module, title, metric, scope, period, target, days, preferred_time, status, starts_on, subject_id, book_id FROM knowledge_goals WHERE user_id = $1 AND status IN ('active', 'paused') AND period = 'daily'",
      [userId],
    ),
    q.query<{ id: string; module: string; kind: string; title: string; date: string; active_sec: number; pages_read: number; started_at: Date | null; book_id: string | null; subject_id: string | null }>(
      'SELECT id, module, kind, title, date, active_sec, pages_read, started_at, book_id, subject_id FROM knowledge_sessions WHERE user_id = $1 AND date BETWEEN $2 AND $3',
      [userId, start, end],
    ),
    q.query<{ id: string; module: string; kind: string; title: string; started_at: Date }>('SELECT id, module, kind, title, started_at FROM knowledge_timers WHERE user_id = $1', [userId]),
    q.query<PlanRow>("SELECT * FROM bible_plans WHERE user_id = $1 AND status IN ('active', 'paused')", [userId]),
    q.query<{ reminders: { kind: string; enabled: boolean; time: string; days: number[] }[] }>('SELECT reminders FROM bible_prefs WHERE user_id = $1', [userId]),
    q.query<{ date: string }>("SELECT date FROM life_day_marks WHERE user_id = $1 AND kind = 'rest' AND date BETWEEN $2 AND $3", [userId, start, end]),
    q.query<{ id: string; date: string; start_time: string | null; duration_min: number | null; title: string; category: AgendaCategory; notes: string | null; status: 'planned' | 'done' | 'missed' | 'paused'; position: number; origin: string; version: number }>(
      'SELECT id, date, start_time, duration_min, title, category, notes, status, position, origin, version FROM planner_items WHERE user_id = $1 AND date BETWEEN $2 AND $3',
      [userId, start, end],
    ),
    q.query<{ item_key: string; date: string; start_time: string | null; duration_min: number | null; position: number | null; status: 'missed' | 'paused' | null }>(
      'SELECT item_key, date, start_time, duration_min, position, status FROM planner_overrides WHERE user_id = $1 AND date BETWEEN $2 AND $3',
      [userId, start, end],
    ),
  ]);

  // ---------------------------------------------------------------- treinos (planejamento P13 × sessões)
  const routineById = new Map(routinesDoc.rows.map((r) => [r.id, r.doc]));
  const sessionsByDate = new Map<string, typeof sessions.rows>();
  for (const s of sessions.rows) {
    const d = localDate(s.started_at.getTime(), tz);
    if (!sessionsByDate.has(d)) sessionsByDate.set(d, []);
    sessionsByDate.get(d)!.push(s);
  }
  const allEntries = entries.rows.map((r) => r.doc).filter((e) => e && typeof e === 'object' && typeof e.id === 'string');
  for (const date of list) {
    const daySessions = [...(sessionsByDate.get(date) ?? [])];
    for (const e of planEntriesFor(allEntries, date)) {
      if (e.kind === 'rest') {
        items.push({ key: `trainrest:${e.id}`, category: 'rest', title: 'Descanso do treino', subtitle: 'Planejamento de treinos', date, startTime: null, durationMin: null, status: 'planned', statusSource: 'plan', source: { module: 'training', kind: 'plan_entry', id: e.id }, link: '/planejamento' });
        continue;
      }
      if (e.kind === 'free') {
        items.push({ key: `trainfree:${e.id}`, category: 'free', title: 'Dia livre', subtitle: 'Planejamento de treinos', date, startTime: null, durationMin: null, status: 'planned', statusSource: 'plan', source: { module: 'training', kind: 'plan_entry', id: e.id }, link: '/planejamento' });
        continue;
      }
      const r = e.routineId ? routineById.get(e.routineId) : undefined;
      const w = e.workoutId ? r?.workouts?.find((x) => x.id === e.workoutId) : undefined;
      const title = w ? `Treino ${w.label ?? ''}${w.name ? ` · ${w.name}` : ''}`.replace(/\s+/g, ' ').trim() : 'Treino (próximo da rotação)';
      // Associação planejado × realizado: mesma rotina (e mesmo treino, se escolhido) no mesmo dia local.
      const idx = daySessions.findIndex((s) => s.routine_id === e.routineId && (!e.workoutId || s.workout_id === e.workoutId));
      const match = idx >= 0 ? daySessions.splice(idx, 1)[0] : null;
      const status: AgendaStatus = match ? (match.status === 'active' ? 'in_progress' : 'done') : 'planned';
      items.push({
        key: `workout:${e.id}`,
        category: 'workout',
        title,
        subtitle: r?.name ?? null,
        date,
        startTime: match ? hhmm(match.started_at.getTime(), tz) : null,
        durationMin: match?.finished_at ? Math.max(1, Math.round((match.finished_at.getTime() - match.started_at.getTime()) / 60000)) : 60,
        status,
        statusSource: match ? 'record' : 'plan',
        source: { module: 'training', kind: 'plan_entry', id: e.id },
        link: match && match.status === 'completed' ? `/historico/${encodeURIComponent(match.id)}` : match ? '/treino' : '/treinar',
      });
    }
    // Treinos feitos sem planejamento também aparecem (registro real).
    for (const s of daySessions) {
      items.push({
        key: `session:${s.id}`,
        category: 'workout',
        title: `Treino ${s.label ?? ''}${s.name ? ` · ${s.name}` : ''}`.replace(/\s+/g, ' ').trim(),
        subtitle: 'Registrado',
        date,
        startTime: hhmm(s.started_at.getTime(), tz),
        durationMin: s.finished_at ? Math.max(1, Math.round((s.finished_at.getTime() - s.started_at.getTime()) / 60000)) : null,
        status: s.status === 'active' ? 'in_progress' : 'done',
        statusSource: 'record',
        source: { module: 'training', kind: 'session', id: s.id },
        link: s.status === 'completed' ? `/historico/${encodeURIComponent(s.id)}` : '/treino',
        can: { move: false, mark: [] },
      });
    }
  }

  // ---------------------------------------------------------------- refeições (planejada ≠ consumida)
  for (const m of meals.rows) {
    items.push({
      key: `meal:${m.id}`,
      category: 'meal',
      title: m.name ?? MEAL_KIND_LABEL[m.kind as keyof typeof MEAL_KIND_LABEL] ?? 'Refeição',
      subtitle: `${m.status === 'consumed' ? 'Consumida' : 'Planejada'}${m.n ? ` · ${m.n} ${m.n === 1 ? 'item' : 'itens'}` : ''}${m.kcal != null && m.n ? ` · ${m.kcal} kcal` : ''}`,
      date: m.date,
      startTime: m.time,
      durationMin: 30,
      status: m.status === 'consumed' ? 'done' : 'planned',
      statusSource: m.status === 'consumed' ? 'record' : 'plan',
      source: { module: 'nutrition', kind: 'meal', id: m.id },
      link: m.status === 'consumed' ? `/alimentacao?data=${m.date}` : `/alimentacao/planejar?data=${m.date}`,
    });
  }

  // ---------------------------------------------------------------- hábitos
  const logs = new Map(habitLogs.rows.map((l) => [`${l.habit_id}|${l.date}`, l]));
  const habitDays = new Map<string, Set<string>>();
  for (const h of habits.rows) {
    for (const date of list) {
      if (h.start_date > date || !h.days.includes(weekdayOf(date))) continue;
      const log = logs.get(`${h.id}|${date}`);
      if (!habitDays.has(h.id)) habitDays.set(h.id, new Set());
      habitDays.get(h.id)!.add(date);
      items.push({
        key: `habit:${h.id}`,
        category: h.tag === 'reading' ? 'reading' : h.tag === 'study' ? 'study' : h.tag === 'bible' ? 'bible' : 'habit',
        title: h.name,
        subtitle: h.goal_kind === 'check' ? 'Hábito' : `Hábito · meta ${h.goal_target}${h.goal_kind === 'duration' ? ' min' : h.goal_unit ? ` ${h.goal_unit}` : ''}${log && !log.completed ? ` (feito ${log.amount})` : ''}`,
        date,
        startTime: h.preferred_time,
        durationMin: h.goal_kind === 'duration' ? Math.min(720, Math.max(5, h.goal_target)) : null,
        status: log?.completed ? 'done' : h.status === 'paused' ? 'paused' : 'planned',
        statusSource: log?.completed || h.status === 'paused' ? 'record' : 'plan',
        source: { module: 'life', kind: 'habit', id: h.id },
        link: '/missoes?aba=habitos',
      });
    }
  }

  // ---------------------------------------------------------------- rotinas (itens com horário)
  const checks = new Set(routineChecks.rows.map((c) => `${c.item_id}|${c.date}`));
  for (const it of lifeRoutines.rows) {
    for (const date of list) {
      if (!it.days.includes(weekdayOf(date))) continue;
      // Item vinculado a hábito que já aparece no dia: o hábito representa a atividade (sem duplicar).
      if (it.habit_id && habitDays.get(it.habit_id)?.has(date)) continue;
      const done = checks.has(`${it.item_id}|${date}`);
      items.push({
        key: `routine:${it.item_id}`,
        category: it.kind === 'study' ? 'study' : it.kind === 'training' ? 'workout' : 'routine',
        title: it.title,
        subtitle: `Rotina ${it.routine_name}`,
        date,
        startTime: it.start_time,
        durationMin: it.duration_min,
        status: done ? 'done' : 'planned',
        statusSource: done ? 'record' : 'plan',
        source: { module: 'life', kind: 'routine_item', id: it.item_id },
        link: '/missoes?aba=rotinas',
      });
    }
  }

  // ---------------------------------------------------------------- missões (prazo no dia)
  for (const m of missions.rows) {
    items.push({
      key: `mission:${m.id}`,
      category: 'mission',
      title: m.title,
      subtitle: `${m.type === 'daily' ? 'Missão do dia' : 'Prazo da missão'} · ${Math.min(m.progress, m.target)}/${m.target}${m.status === 'expired' ? ' · prazo encerrado' : ''}`,
      date: m.ends_on,
      startTime: null,
      durationMin: null,
      status: m.status === 'completed' ? 'done' : m.status === 'paused' ? 'paused' : 'planned',
      statusSource: m.status === 'completed' || m.status === 'paused' ? 'record' : 'plan',
      source: { module: 'life', kind: 'mission', id: m.id },
      link: '/missoes',
      can: { move: false },
    });
  }

  // ---------------------------------------------------------------- leitura, estudos e Bíblia (metas diárias + sessões)
  const usedSessions = new Set<string>();
  const kindToCat = (module: string, kind: string): AgendaCategory => (module === 'bible' ? 'bible' : kind === 'reading' ? 'reading' : 'study');
  const timer = kTimer.rows[0];
  for (const g of kGoals.rows) {
    for (const date of list) {
      if (g.starts_on > date || !g.days.includes(weekdayOf(date))) continue;
      const matching = kSessions.rows.filter(
        (s) => s.date === date && s.module === g.module && (g.scope === 'any' || s.kind === g.scope) && (!g.subject_id || s.subject_id === g.subject_id) && (!g.book_id || s.book_id === g.book_id),
      );
      matching.forEach((s) => usedSessions.add(s.id));
      const minutes = Math.round(matching.reduce((n, s) => n + s.active_sec, 0) / 60);
      const pages = matching.reduce((n, s) => n + s.pages_read, 0);
      const value = g.metric === 'minutes' ? minutes : g.metric === 'pages' ? pages : g.metric === 'sessions' ? matching.length : matching.length ? 1 : 0;
      const target = g.metric === 'days' ? 1 : g.target;
      const running = !!timer && date === today && timer.module === g.module && (g.scope === 'any' || timer.kind === g.scope);
      const status: AgendaStatus = value >= target ? 'done' : running ? 'in_progress' : g.status === 'paused' ? 'paused' : 'planned';
      const unit = g.metric === 'minutes' ? 'min' : g.metric === 'pages' ? 'pág.' : g.metric === 'sessions' ? 'sessões' : 'dia';
      items.push({
        key: `kgoal:${g.id}`,
        category: kindToCat(g.module, g.scope === 'reading' ? 'reading' : 'study'),
        title: g.title,
        subtitle: `Meta diária · ${value}/${target} ${unit}`,
        date,
        startTime: g.preferred_time,
        durationMin: g.metric === 'minutes' ? Math.min(720, Math.max(5, g.target)) : 30,
        status,
        statusSource: status === 'planned' ? 'plan' : 'record',
        source: { module: g.module === 'bible' ? 'bible' : 'knowledge', kind: 'goal', id: g.id },
        link: g.module === 'bible' ? '/biblia/metas' : '/conhecimento/metas',
      });
    }
  }
  for (const s of kSessions.rows) {
    if (usedSessions.has(s.id)) continue;
    items.push({
      key: `ksession:${s.id}`,
      category: kindToCat(s.module, s.kind),
      title: s.title,
      subtitle: `Registrado · ${Math.round(s.active_sec / 60)} min${s.pages_read ? ` · ${s.pages_read} pág.` : ''}`,
      date: s.date,
      startTime: s.started_at ? hhmm(s.started_at.getTime(), tz) : null,
      durationMin: Math.max(1, Math.round(s.active_sec / 60)),
      status: 'done',
      statusSource: 'record',
      source: { module: s.module === 'bible' ? 'bible' : 'knowledge', kind: 'session', id: s.id },
      link: s.module === 'bible' ? '/biblia/progresso' : '/conhecimento',
      can: { move: false, mark: [] },
    });
  }
  if (timer && list.includes(today) && !items.some((i) => i.status === 'in_progress' && i.date === today && (i.source.module === 'knowledge' || i.source.module === 'bible'))) {
    items.push({
      key: `ktimer:${timer.id}`,
      category: kindToCat(timer.module, timer.kind),
      title: timer.title,
      subtitle: 'Cronômetro em andamento',
      date: today,
      startTime: hhmm(timer.started_at.getTime(), tz),
      durationMin: null,
      status: 'in_progress',
      statusSource: 'record',
      source: { module: timer.module === 'bible' ? 'bible' : 'knowledge', kind: 'timer', id: timer.id },
      link: timer.module === 'bible' ? '/biblia' : '/conhecimento/foco',
      can: { move: false, mark: [] },
    });
  }

  // ---------------------------------------------------------------- planos bíblicos
  const reminderTime = (date: string): string | null => {
    const rs = prefs.rows[0]?.reminders ?? [];
    const r = rs.find((x) => x && x.enabled && (x.kind === 'plan' || x.kind === 'reading') && Array.isArray(x.days) && x.days.includes(weekdayOf(date)));
    return r?.time ?? null;
  };
  if (plans.rows.length) {
    const doneRows = await q.query<{ plan_id: string; day: number; completed_on: string }>('SELECT plan_id, day, completed_on FROM bible_plan_days WHERE user_id = $1 AND plan_id = ANY($2)', [userId, plans.rows.map((p) => p.id)]);
    for (const p of plans.rows) {
      const done = new Map<number, string>();
      for (const r of doneRows.rows) if (r.plan_id === p.id) done.set(r.day, r.completed_on);
      const v = planView(p, done, today, true);
      // Dias concluídos dentro do período (registro real).
      for (const d of v.days ?? []) {
        if (d.completedOn && d.completedOn >= start && d.completedOn <= end) {
          items.push({ key: `bplan:${p.id}.${d.day}`, category: 'bible', title: `${p.title} · dia ${d.day + 1}`, subtitle: d.label, date: d.completedOn, startTime: null, durationMin: d.minutes, status: 'done', statusSource: 'record', source: { module: 'bible', kind: 'plan_day', id: p.id }, link: `/biblia/planos/${p.id}`, can: { move: false, mark: [] } });
        }
      }
      // Próximos dias: um por dia, de hoje em diante (só previsão; atraso não vira "não realizado").
      const pending = (v.days ?? []).filter((d) => !d.completedOn);
      let k = 0;
      for (const date of list) {
        if (date < today) continue;
        const d = pending[k];
        if (!d) break;
        if (p.status === 'paused') {
          if (date === today) items.push({ key: `bplan:${p.id}.${d.day}`, category: 'bible', title: `${p.title} · dia ${d.day + 1}`, subtitle: 'Plano pausado', date, startTime: reminderTime(date), durationMin: d.minutes, status: 'paused', statusSource: 'record', source: { module: 'bible', kind: 'plan_day', id: p.id }, link: `/biblia/planos/${p.id}` });
          break;
        }
        if (date === today && [...done.values()].includes(today)) continue; // já leu o dia de hoje: o próximo fica para amanhã
        items.push({ key: `bplan:${p.id}.${d.day}`, category: 'bible', title: `${p.title} · dia ${d.day + 1}`, subtitle: d.label, date, startTime: reminderTime(date), durationMin: d.minutes, status: 'planned', statusSource: 'plan', source: { module: 'bible', kind: 'plan_day', id: p.id }, link: `/biblia/planos/${p.id}` });
        k++;
      }
    }
  }

  // ---------------------------------------------------------------- descanso (RPG) e atividades personalizadas
  for (const m of marks.rows) {
    restDays.add(m.date);
    items.push({ key: 'rest:day', category: 'rest', title: 'Dia de descanso', subtitle: 'Sequência protegida', date: m.date, startTime: null, durationMin: null, status: 'planned', statusSource: 'record', source: { module: 'life', kind: 'rest_day', id: m.date }, link: '/', can: { move: false, mark: [] } });
  }
  for (const c of custom.rows) {
    items.push({
      key: `custom:${c.id}`,
      category: c.category,
      title: c.title,
      subtitle: c.origin === 'ai' ? 'Planejado com a IA' : 'Atividade personalizada',
      date: c.date,
      startTime: c.start_time,
      durationMin: c.duration_min,
      status: c.status,
      statusSource: c.status === 'planned' ? 'plan' : 'user',
      source: { module: 'planner', kind: 'item', id: c.id },
      link: null,
      notes: c.notes,
      version: c.version,
      can: { move: true, mark: ['planned', 'done', 'missed', 'paused'], edit: true, remove: true },
      position: c.position,
    } as Draft & { position: number });
  }

  // ---------------------------------------------------------------- ajustes da agenda + ordenação
  const ov = new Map(overrides.rows.map((o) => [`${o.item_key}|${o.date}`, o]));
  const byDate = new Map<string, AgendaItem[]>(list.map((d) => [d, []]));
  for (const d of items) {
    const o = d.source.module === 'planner' ? undefined : ov.get(`${d.key}|${d.date}`);
    let status = d.status;
    let statusSource = d.statusSource;
    // A marcação da pessoa nunca esconde um registro real: se o registro diz "concluído", vale o registro.
    if (o?.status && status !== 'done' && status !== 'in_progress') {
      status = o.status;
      statusSource = 'user';
    }
    const isCustom = d.source.module === 'planner';
    const canMark: AgendaStatus[] = isCustom ? ['planned', 'done', 'missed', 'paused'] : d.status === 'done' || d.status === 'in_progress' ? [] : ['planned', 'missed', 'paused'];
    const item: AgendaItem = {
      ...d,
      startTime: o && o.start_time !== null ? o.start_time : d.startTime,
      durationMin: o && o.duration_min !== null ? o.duration_min : d.durationMin,
      status,
      statusSource,
      adjusted: !!o && (o.start_time !== null || o.duration_min !== null || o.position !== null),
      position: o?.position ?? (d as Draft & { position?: number }).position ?? 500,
      can: { move: d.can?.move ?? true, mark: d.can?.mark ?? canMark, edit: d.can?.edit ?? false, remove: d.can?.remove ?? false },
    };
    byDate.get(d.date)?.push(item);
  }
  const daysOut: AgendaDay[] = list.map((date) => {
    const its = (byDate.get(date) ?? []).sort(
      (a, b) => a.position - b.position || (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99') || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.title.localeCompare(b.title, 'pt-BR'),
    );
    return { date, weekday: weekdayOf(date), isToday: date === today, isPast: date < today, rest: restDays.has(date), items: its, load: dayLoad(its), conflicts: findConflicts(its) };
  });
  return { protocol: PLANNER_PROTOCOL, timezone: tz, today, start, days: daysOut };
}

// ------------------------------------------------------------------ escrita (atividades personalizadas e ajustes)

export interface ItemRow {
  id: string;
  date: string;
  start_time: string | null;
  duration_min: number | null;
  title: string;
  category: string;
  notes: string | null;
  status: string;
  position: number;
  origin: 'user' | 'ai';
  version: number;
}

export const dedupeKey = (x: { date: string; startTime?: string | null; title: string }) => `${x.date}|${x.startTime ?? ''}|${x.title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()}`.slice(0, 200);

/** Cria (ou devolve, se o mesmo clientId/dedupe já existe) uma atividade personalizada. Nunca concede XP. */
export async function createItem(q: Q, userId: string, x: PlannerItemInput, origin: 'user' | 'ai', o: { dedupe?: boolean; id?: string } = {}): Promise<{ row: ItemRow; created: boolean }> {
  const id = o.id ?? randomUUID();
  const dk = o.dedupe ? dedupeKey(x) : null;
  const ins = await q.query<ItemRow>(
    `INSERT INTO planner_items (id, user_id, date, start_time, duration_min, title, category, notes, origin, client_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT DO NOTHING RETURNING *`,
    [id, userId, x.date, x.startTime ?? null, x.durationMin ?? null, x.title, x.category, x.notes ?? null, origin, x.clientId, dk],
  );
  if (ins.rows[0]) return { row: ins.rows[0], created: true };
  const ex = await q.query<ItemRow>('SELECT * FROM planner_items WHERE user_id = $1 AND (client_id = $2 OR ($3::text IS NOT NULL AND dedupe_key = $3))', [userId, x.clientId, dk]);
  if (!ex.rows[0]) throw new ApiError('planner_duplicate');
  return { row: ex.rows[0], created: false };
}

export async function getItem(q: Q, userId: string, id: string, lock = false): Promise<ItemRow | null> {
  if (!isUuid(id)) return null;
  return (await q.query<ItemRow>(`SELECT * FROM planner_items WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}

export async function patchItem(c: PoolClient, userId: string, id: string, p: Record<string, unknown>, version?: number): Promise<ItemRow> {
  const cur = await getItem(c, userId, id, true);
  if (!cur) throw new ApiError('not_found');
  if (version !== undefined && version !== cur.version) throw new ApiError('life_stale');
  const next = {
    date: (p.date as string | undefined) ?? cur.date,
    start_time: p.startTime !== undefined ? (p.startTime as string | null) : cur.start_time,
    duration_min: p.durationMin !== undefined ? (p.durationMin as number | null) : cur.duration_min,
    title: (p.title as string | undefined) ?? cur.title,
    notes: p.notes !== undefined ? (p.notes as string | null) : cur.notes,
    status: (p.status as string | undefined) ?? cur.status,
    position: (p.position as number | undefined) ?? cur.position,
  };
  const r = await c.query<ItemRow>(
    `UPDATE planner_items SET date = $3, start_time = $4, duration_min = $5, title = $6, notes = $7, status = $8, position = $9, dedupe_key = NULL,
            version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, id, next.date, next.start_time, next.duration_min, next.title, next.notes, next.status, next.position],
  );
  return r.rows[0];
}

export async function deleteItem(q: Q, userId: string, id: string): Promise<ItemRow | null> {
  if (!isUuid(id)) return null;
  return (await q.query<ItemRow>('DELETE FROM planner_items WHERE user_id = $1 AND id = $2 RETURNING *', [userId, id])).rows[0] ?? null;
}

/** Ajuste de um item derivado. Campos ausentes mantêm o ajuste anterior; null limpa o campo. */
export async function setOverride(q: Q, userId: string, o: OverrideInput): Promise<void> {
  if (o.key.startsWith('custom:')) throw new ApiError('validation_failed', { key: 'Atividades personalizadas são alteradas diretamente.' });
  const cur = (await q.query<{ start_time: string | null; duration_min: number | null; position: number | null; status: string | null }>('SELECT start_time, duration_min, position, status FROM planner_overrides WHERE user_id = $1 AND item_key = $2 AND date = $3', [userId, o.key, o.date])).rows[0];
  const next = {
    start_time: o.startTime !== undefined ? o.startTime : (cur?.start_time ?? null),
    duration_min: o.durationMin !== undefined ? o.durationMin : (cur?.duration_min ?? null),
    position: o.position !== undefined ? o.position : (cur?.position ?? null),
    status: o.status !== undefined ? o.status : (cur?.status ?? null),
  };
  if (next.start_time === null && next.duration_min === null && next.position === null && next.status === null) {
    await q.query('DELETE FROM planner_overrides WHERE user_id = $1 AND item_key = $2 AND date = $3', [userId, o.key, o.date]);
    return;
  }
  await q.query(
    `INSERT INTO planner_overrides (user_id, item_key, date, start_time, duration_min, position, status) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, item_key, date) DO UPDATE SET start_time = $4, duration_min = $5, position = $6, status = $7, updated_at = now()`,
    [userId, o.key, o.date, next.start_time, next.duration_min, next.position, next.status],
  );
}

/** Reordena os itens de um dia (grava só a posição: custom no próprio item, derivados como ajuste). */
export async function reorder(c: PoolClient, userId: string, date: string, keys: string[]): Promise<void> {
  let pos = 10;
  for (const key of keys) {
    if (key.startsWith('custom:')) await c.query('UPDATE planner_items SET position = $3, updated_at = now() WHERE user_id = $1 AND id::text = $2', [userId, key.slice(7), pos]);
    else await setOverride(c, userId, { key, date, position: pos });
    pos += 10;
  }
}

// ------------------------------------------------------------------ painel inicial

export async function getLayout(q: Q, userId: string): Promise<HomeLayoutView> {
  const r = await q.query<{ cards: { id: string; visible: boolean }[]; version: number }>('SELECT cards, version FROM life_home_layout WHERE user_id = $1', [userId]);
  return { cards: normalizeLayout(r.rows[0]?.cards), version: r.rows[0]?.version ?? 0 };
}

export async function saveLayout(c: PoolClient, userId: string, cards: { id: string; visible: boolean }[], version?: number): Promise<HomeLayoutView> {
  const cur = await c.query<{ version: number }>('SELECT version FROM life_home_layout WHERE user_id = $1 FOR UPDATE', [userId]);
  if (version !== undefined && (cur.rows[0]?.version ?? 0) !== version) throw new ApiError('life_stale');
  const norm = normalizeLayout(cards);
  await c.query(
    `INSERT INTO life_home_layout (user_id, cards) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET cards = $2, version = life_home_layout.version + 1, updated_at = now()`,
    [userId, JSON.stringify(norm)],
  );
  return getLayout(c, userId);
}

export { hhmm as localHHMM };
