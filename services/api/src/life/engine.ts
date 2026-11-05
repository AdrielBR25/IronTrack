// Motor de recompensas do RPG (Fase 01, docs/RPG_DESENVOLVIMENTO.md). ÚNICO lugar que mexe em XP.
//
// Garantias:
//  - Toda alteração roda numa transação que começa bloqueando a linha do perfil (life_profiles … FOR UPDATE): as
//    operações da mesma conta ficam em série, e o total, os atributos e o livro-razão nunca divergem.
//  - XP só nasce de eventos válidos (hábito cumprido, missão concluída, treino concluído, rotina completa, conquista,
//    bônus único de histórico). Não existe rota nem ferramenta da IA que conceda XP "solto".
//  - Idempotência: uma concessão ativa por chave de origem (índice único parcial). Repetir a mesma ação não soma.
//  - Reversão: desfazer uma conclusão lança um estorno igual e oposto (nada é apagado; o total nunca fica negativo).
//  - Limites: XP por atividade (validação das entradas) e teto diário por dia local (REWARD.dailyCap).
import { randomUUID } from 'node:crypto';
import { ACHIEVEMENTS, REWARD, levelFromXp, type Attribute, type RewardOutcome, type Tag } from '../../../../shared/life/protocol.ts';
import { NUTRITION_REWARD } from '../../../../shared/nutrition/protocol.ts';
import { withTx, type Pool, type PoolClient } from '../db/pool.ts';
import { addDays, isValidTimezone, localDate, mondayOf } from '../assistant/tools/time.ts';

export const DEFAULT_TZ = 'America/Sao_Paulo';

export interface ProfileRow {
  user_id: string;
  timezone: string;
  activated_at: Date;
  total_xp: number;
  level: number;
  selected_title: string | null;
  weekly_workout_target: number | null;
  tz_changed_at: Date | null;
}

export interface LifeTx {
  c: PoolClient;
  userId: string;
  now: number;
  profile: ProfileRow;
  tz: string;
  today: string;
  /** Dias locais cujo XP mudou (as missões desses dias são recalculadas no fim). */
  touched: Set<string>;
  out: RewardOutcome;
}

export const emptyOutcome = (): RewardOutcome => ({ xpGained: 0, xpReverted: 0, events: [], levelUp: null, missionsCompleted: [], achievements: [] });

export const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
export const weekOf = (date: string): { start: string; end: string } => {
  const start = mondayOf(date);
  return { start, end: addDays(start, 6) };
};

/** Cria o perfil na primeira vez (com o fuso do aparelho, se válido) e devolve a linha BLOQUEADA. */
export async function lockProfile(c: PoolClient, userId: string, tzHint?: string | null): Promise<ProfileRow> {
  const tz = isValidTimezone(tzHint) ? tzHint : DEFAULT_TZ;
  const ins = await c.query('INSERT INTO life_profiles (user_id, timezone) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, tz]);
  if (ins.rowCount) await c.query("INSERT INTO life_attributes (user_id, attribute) SELECT $1, a FROM unnest(ARRAY['strength','knowledge','discipline','health','spirituality']) AS a ON CONFLICT DO NOTHING", [userId]);
  const r = await c.query<ProfileRow>('SELECT * FROM life_profiles WHERE user_id = $1 FOR UPDATE', [userId]);
  return r.rows[0];
}

/**
 * Executa `fn` numa transação da conta. No fim: recalcula as missões dos dias afetados, confere as conquistas e o
 * nível. Erros desfazem tudo (inclusive XP).
 */
export async function lifeTx<T, V = undefined>(
  pool: Pool,
  userId: string,
  now: number,
  fn: (t: LifeTx) => Promise<T>,
  opts: { tzHint?: string | null; view?: (t: LifeTx) => Promise<V> } = {},
): Promise<{ value: T; view: V; outcome: RewardOutcome; profile: ProfileRow; today: string }> {
  return withTx(pool, (c) => runLife(c, userId, now, fn, opts));
}

/** Mesmo que lifeTx, numa transação JÁ aberta (ex.: aprovação de proposta do assistente). */
export async function runLife<T, V = undefined>(
  c: PoolClient,
  userId: string,
  now: number,
  fn: (t: LifeTx) => Promise<T>,
  opts: { tzHint?: string | null; view?: (t: LifeTx) => Promise<V> } = {},
): Promise<{ value: T; view: V; outcome: RewardOutcome; profile: ProfileRow; today: string }> {
  const profile = await lockProfile(c, userId, opts.tzHint);
  const tz = isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TZ;
  const t: LifeTx = { c, userId, now, profile, tz, today: localDate(now, tz), touched: new Set(), out: emptyOutcome() };
  const value = await fn(t);
  await settle(t);
  // Visão montada depois do acerto (missões, conquistas e nível já recalculados), na mesma transação.
  const view = (opts.view ? await opts.view(t) : undefined) as V;
  return { value, view, outcome: t.out, profile: t.profile, today: t.today };
}

/** Recalcula missões, conquistas e nível depois das mudanças da transação. */
export async function settle(t: LifeTx): Promise<void> {
  // Duas passadas: concluir uma missão pode liberar a conquista "primeira missão", que não afeta missões.
  if (t.touched.size) await refreshMissions(t, [...t.touched]);
  await checkAchievements(t);
  const info = levelFromXp(Number(t.profile.total_xp));
  if (info.level !== t.profile.level) {
    if (info.level > t.profile.level) t.out.levelUp = { from: t.profile.level, to: info.level };
    await t.c.query('UPDATE life_profiles SET level = $2, updated_at = now() WHERE user_id = $1', [t.userId, info.level]);
    t.profile.level = info.level;
  }
}

// ------------------------------------------------------------------ livro-razão

export type Source = 'habit' | 'mission' | 'workout' | 'routine' | 'achievement' | 'legacy' | 'nutrition' | 'knowledge';
// Fase 02: registro alimentar ('nutrition') também entra no teto diário. Fase 04: leitura/estudos ('knowledge') também.
const CAPPED: readonly Source[] = ['habit', 'mission', 'workout', 'routine', 'nutrition', 'knowledge'];

export interface GrantInput {
  source: Source;
  key: string;
  sourceId: string | null;
  attribute: Attribute | null;
  requested: number;
  day: string;
  reason: string;
}

export async function activeGrant(c: PoolClient, userId: string, key: string): Promise<{ id: string; amount: number; attribute: Attribute | null; day: string } | null> {
  const r = await c.query<{ id: string; amount: number; attribute: Attribute | null; day: string }>("SELECT id, amount, attribute, day FROM life_xp_events WHERE user_id = $1 AND source_key = $2 AND kind = 'grant' AND reversed_at IS NULL", [userId, key]);
  return r.rows[0] ?? null;
}

/** Concede XP uma única vez por chave. Devolve false se já havia concessão ativa (nada muda). */
export async function grant(t: LifeTx, g: GrantInput): Promise<{ granted: boolean; amount: number }> {
  if (await activeGrant(t.c, t.userId, g.key)) return { granted: false, amount: 0 };
  const requested = Math.max(0, Math.floor(g.requested));
  let amount = requested;
  if (CAPPED.includes(g.source) && amount > 0) {
    const used = await t.c.query<{ n: number }>("SELECT coalesce(sum(amount), 0)::int AS n FROM life_xp_events WHERE user_id = $1 AND day = $2 AND source = ANY($3)", [t.userId, g.day, CAPPED]);
    amount = Math.min(amount, Math.max(0, REWARD.dailyCap - (used.rows[0]?.n ?? 0)));
  }
  await t.c.query(
    "INSERT INTO life_xp_events (id, user_id, kind, source, source_key, source_id, attribute, amount, requested, day, reason) VALUES ($1, $2, 'grant', $3, $4, $5, $6, $7, $8, $9, $10)",
    [randomUUID(), t.userId, g.source, g.key, g.sourceId, g.attribute, amount, requested, g.day, g.reason.slice(0, 200)],
  );
  if (amount > 0) await applyDelta(t, g.attribute, amount);
  t.touched.add(g.day);
  t.out.xpGained += amount;
  t.out.events.push({ amount, attribute: g.attribute, reason: g.reason, capped: amount < requested });
  return { granted: true, amount };
}

/** Estorna a concessão ativa da chave (se houver). A concessão fica marcada e o estorno aponta para ela. */
export async function reverse(t: LifeTx, key: string, reason: string): Promise<number> {
  const g = await activeGrant(t.c, t.userId, key);
  if (!g) return 0;
  const src = await t.c.query<{ source: Source; source_id: string | null }>('SELECT source, source_id FROM life_xp_events WHERE id = $1', [g.id]);
  await t.c.query('UPDATE life_xp_events SET reversed_at = now() WHERE id = $1', [g.id]);
  await t.c.query(
    "INSERT INTO life_xp_events (id, user_id, kind, source, source_key, source_id, attribute, amount, requested, day, reason, reverses) VALUES ($1, $2, 'reversal', $3, $4, $5, $6, $7, $7, $8, $9, $10)",
    [randomUUID(), t.userId, src.rows[0].source, key, src.rows[0].source_id, g.attribute, -g.amount, g.day, reason.slice(0, 200), g.id],
  );
  if (g.amount > 0) await applyDelta(t, g.attribute, -g.amount);
  t.touched.add(g.day);
  t.out.xpReverted += g.amount;
  return g.amount;
}

async function applyDelta(t: LifeTx, attribute: Attribute | null, delta: number): Promise<void> {
  // O total nunca fica negativo: um estorno só devolve o que a própria concessão somou (CHECK total_xp >= 0).
  const r = await t.c.query<{ total_xp: number }>('UPDATE life_profiles SET total_xp = total_xp + $2, updated_at = now() WHERE user_id = $1 RETURNING total_xp', [t.userId, delta]);
  t.profile.total_xp = Number(r.rows[0].total_xp);
  if (attribute) await t.c.query('UPDATE life_attributes SET xp = xp + $3 WHERE user_id = $1 AND attribute = $2', [t.userId, attribute, delta]);
}

// ------------------------------------------------------------------ missões (progresso derivado dos eventos)

export interface MissionRow {
  id: string;
  type: 'daily' | 'weekly' | 'custom' | 'special';
  origin: 'system' | 'user' | 'ai';
  template: string | null;
  title: string;
  description: string | null;
  metric: 'habit_completions' | 'habit' | 'workouts' | 'active_days' | 'routine_completions' | 'manual' | 'nutrition_days';
  habit_id: string | null;
  routine_id: string | null;
  unit: 'times' | 'minutes' | 'pages' | 'chapters' | 'check';
  tag: Tag;
  target: number;
  progress: number;
  attribute: Attribute;
  xp: number;
  starts_on: string;
  ends_on: string;
  status: 'active' | 'completed' | 'expired' | 'paused' | 'cancelled';
  completed_at: Date | null;
  version: number;
  created_at: Date;
}

const ACTIVE_GRANT = "kind = 'grant' AND reversed_at IS NULL";

export async function missionProgress(c: PoolClient, userId: string, m: MissionRow): Promise<number> {
  const p = [userId, m.starts_on, m.ends_on];
  const count = async (where: string, extra: unknown[] = []) =>
    (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM life_xp_events WHERE user_id = $1 AND day BETWEEN $2 AND $3 AND ${ACTIVE_GRANT} AND ${where}`, [...p, ...extra])).rows[0].n;
  switch (m.metric) {
    case 'habit_completions':
      return count("source = 'habit'");
    case 'habit':
      return m.habit_id ? count("source = 'habit' AND source_id = $4", [m.habit_id]) : 0;
    case 'workouts':
      return count("source = 'workout'");
    case 'routine_completions':
      return m.routine_id ? count("source = 'routine' AND source_id = $4", [m.routine_id]) : count("source = 'routine'");
    case 'active_days':
      return (await c.query<{ n: number }>(`SELECT count(DISTINCT day)::int AS n FROM life_xp_events WHERE user_id = $1 AND day BETWEEN $2 AND $3 AND ${ACTIVE_GRANT} AND source IN ('habit', 'workout', 'routine', 'nutrition', 'knowledge')`, p)).rows[0].n;
    case 'nutrition_days':
      // Dias com diário alimentar registrado (o lançamento existe mesmo com 0 XP, quando o XP foi do hábito vinculado).
      return count("source = 'nutrition' AND source_key LIKE 'nutrition:day:%'");
    case 'manual':
      return (await c.query<{ n: number }>('SELECT coalesce(sum(amount), 0)::int AS n FROM life_mission_entries WHERE user_id = $1 AND mission_id = $2', [userId, m.id])).rows[0].n;
  }
}

/** Recalcula uma missão; conclui (com XP) ou desfaz a conclusão (com estorno) conforme o progresso. */
export async function recomputeMission(t: LifeTx, m: MissionRow): Promise<void> {
  if (m.status === 'cancelled' || m.status === 'paused') return;
  const progress = await missionProgress(t.c, t.userId, m);
  const key = `mission:${m.id}`;
  if (progress >= m.target && (m.status === 'active' || m.status === 'expired')) {
    // Expirada só volta a concluir se o progresso que faltava foi registrado dentro do período (o cálculo já filtra).
    await t.c.query("UPDATE life_missions SET progress = $3, status = 'completed', completed_at = now(), updated_at = now() WHERE user_id = $1 AND id = $2", [t.userId, m.id, progress]);
    const day = t.today < m.ends_on ? (t.today > m.starts_on ? t.today : m.starts_on) : m.ends_on;
    await grant(t, { source: 'mission', key, sourceId: m.id, attribute: m.attribute, requested: m.xp, day, reason: `Missão concluída: ${m.title}` });
    t.out.missionsCompleted.push({ id: m.id, title: m.title });
    return;
  }
  if (progress < m.target && m.status === 'completed') {
    await reverse(t, key, `Missão desfeita: ${m.title}`);
    const status = t.today > m.ends_on ? 'expired' : 'active';
    await t.c.query('UPDATE life_missions SET progress = $3, status = $4, completed_at = NULL, updated_at = now() WHERE user_id = $1 AND id = $2', [t.userId, m.id, progress, status]);
    return;
  }
  if (progress !== m.progress) await t.c.query('UPDATE life_missions SET progress = $3, updated_at = now() WHERE user_id = $1 AND id = $2', [t.userId, m.id, progress]);
}

async function refreshMissions(t: LifeTx, days: string[]): Promise<void> {
  const min = days.reduce((a, b) => (a < b ? a : b));
  const max = days.reduce((a, b) => (a > b ? a : b));
  const r = await t.c.query<MissionRow>(
    "SELECT * FROM life_missions WHERE user_id = $1 AND metric <> 'manual' AND status IN ('active', 'completed', 'expired') AND starts_on <= $3 AND ends_on >= $2 ORDER BY created_at",
    [t.userId, min, max],
  );
  for (const m of r.rows) await recomputeMission(t, m);
}

// ------------------------------------------------------------------ sequência de consistência

/** Dias com atividade válida (concessão ativa de hábito, treino, rotina ou missão). Dias de descanso não quebram. */
export async function streakOf(c: PoolClient, userId: string, today: string): Promise<{ current: number; best: number; activeToday: boolean; restToday: boolean }> {
  const from = addDays(today, -730);
  const act = await c.query<{ day: string }>(`SELECT DISTINCT day FROM life_xp_events WHERE user_id = $1 AND day BETWEEN $2 AND $3 AND ${ACTIVE_GRANT} AND source IN ('habit', 'workout', 'routine', 'mission', 'nutrition', 'knowledge')`, [userId, from, today]);
  const rest = await c.query<{ date: string }>("SELECT date FROM life_day_marks WHERE user_id = $1 AND kind = 'rest' AND date BETWEEN $2 AND $3", [userId, from, today]);
  const active = new Set(act.rows.map((r) => r.day));
  const rests = new Set(rest.rows.map((r) => r.date));
  // Atual: hoje ainda em aberto não quebra; conta para trás até o primeiro dia sem atividade e sem descanso.
  let current = 0;
  let d = today;
  if (!active.has(d)) d = addDays(d, -1);
  while (d >= from) {
    if (active.has(d)) current++;
    else if (!rests.has(d)) break;
    d = addDays(d, -1);
  }
  let best = 0;
  let run = 0;
  for (let x = from; x <= today; x = addDays(x, 1)) {
    if (active.has(x)) best = Math.max(best, ++run);
    else if (!rests.has(x) && x !== today) run = 0;
  }
  return { current, best: Math.max(best, current), activeToday: active.has(today), restToday: rests.has(today) };
}

// ------------------------------------------------------------------ conquistas

export interface AchievementProgress {
  value: number;
  target: number;
  available: boolean;
}

/** Progresso real de cada conquista. Módulos sem dados (ex.: leitura sem nenhum registro) ficam indisponíveis. */
export async function achievementProgress(c: PoolClient, userId: string, today: string): Promise<Record<string, AchievementProgress>> {
  const one = async (sql: string, p: unknown[] = [userId]) => Number((await c.query<{ n: number }>(sql, p)).rows[0]?.n ?? 0);
  const missions = await one("SELECT count(*)::int AS n FROM life_missions WHERE user_id = $1 AND status = 'completed'");
  const habitDays = await one(`SELECT count(DISTINCT day)::int AS n FROM life_xp_events WHERE user_id = $1 AND source = 'habit' AND ${ACTIVE_GRANT}`);
  const workouts = await one(validWorkoutsSql('count'));
  // Leitura existe como dado real quando há sessões de leitura (Fase 04) ou hábitos/missões de leitura em minutos.
  const readingRows = await one(
    `SELECT ((SELECT count(*) FROM life_habits h WHERE h.user_id = $1 AND h.tag = 'reading' AND h.goal_kind = 'duration')
          + (SELECT count(*) FROM life_missions m WHERE m.user_id = $1 AND m.tag = 'reading' AND m.unit = 'minutes')
          + (SELECT count(*) FROM knowledge_sessions k WHERE k.user_id = $1 AND k.module = 'knowledge' AND k.kind = 'reading'))::int AS n`,
  );
  // Minutos de leitura: sessões do módulo Conhecimento + hábitos/missões de leitura que NÃO vêm das sessões (registros
  // de hábito/missão alimentados pelas sessões ficam de fora para não contar o mesmo minuto duas vezes).
  const reading = await one(
    `SELECT ((SELECT coalesce(sum(l.amount), 0) FROM life_habit_logs l JOIN life_habits h ON h.id = l.habit_id WHERE l.user_id = $1 AND h.tag = 'reading' AND h.goal_kind = 'duration'
                AND NOT EXISTS (SELECT 1 FROM knowledge_goals g WHERE g.user_id = $1 AND g.habit_id = h.id))
          + (SELECT coalesce(sum(e.amount), 0) FROM life_mission_entries e JOIN life_missions m ON m.id = e.mission_id WHERE e.user_id = $1 AND m.tag = 'reading' AND m.unit = 'minutes' AND (e.source_key IS NULL OR e.source_key NOT LIKE 'knowledge:%'))
          + (SELECT coalesce(sum(k.active_sec), 0) / 60 FROM knowledge_sessions k WHERE k.user_id = $1 AND k.module = 'knowledge' AND k.kind = 'reading'))::int AS n`,
  );
  const booksDone = await one("SELECT count(*)::int AS n FROM knowledge_books WHERE user_id = $1 AND status = 'done'");
  const hasBooks = booksDone > 0 || (await one('SELECT count(*)::int AS n FROM knowledge_books WHERE user_id = $1')) > 0;
  const studyMin = await one("SELECT (coalesce(sum(active_sec), 0) / 60)::int AS n FROM knowledge_sessions WHERE user_id = $1 AND module = 'knowledge' AND kind = 'study'");
  const hasStudy = studyMin > 0 || (await one('SELECT count(*)::int AS n FROM knowledge_subjects WHERE user_id = $1')) > 0;
  const streak = await streakOf(c, userId, today);
  const diaryDays = await one(`SELECT count(DISTINCT day)::int AS n FROM life_xp_events WHERE user_id = $1 AND source = 'nutrition' AND source_key LIKE 'nutrition:day:%' AND ${ACTIVE_GRANT}`);
  const hasNutrition = diaryDays > 0 || (await one('SELECT count(*)::int AS n FROM nutrition_meals WHERE user_id = $1')) > 0;
  return {
    first_mission: { value: Math.min(missions, 1), target: 1, available: true },
    habit_week: { value: Math.min(habitDays, 7), target: 7, available: true },
    ten_workouts: { value: Math.min(workouts, 10), target: 10, available: true },
    reading_100: { value: Math.min(reading, 100), target: 100, available: readingRows > 0 },
    streak_7: { value: Math.min(Math.max(streak.current, streak.best), 7), target: 7, available: true },
    nutrition_week: { value: Math.min(diaryDays, 7), target: 7, available: hasNutrition },
    first_book: { value: Math.min(booksDone, 1), target: 1, available: hasBooks },
    study_10h: { value: Math.min(studyMin, 600), target: 600, available: hasStudy },
  };
}

async function checkAchievements(t: LifeTx): Promise<void> {
  const have = new Set((await t.c.query<{ code: string }>('SELECT code FROM life_achievements WHERE user_id = $1', [t.userId])).rows.map((r) => r.code));
  if (have.size === ACHIEVEMENTS.length) return;
  const prog = await achievementProgress(t.c, t.userId, t.today);
  for (const a of ACHIEVEMENTS) {
    const p = prog[a.code];
    if (have.has(a.code) || !p.available || p.value < p.target) continue;
    // Conquista é permanente: não é estornada se algo for desfeito depois (o XP dela é fixo e único).
    await grant(t, { source: 'achievement', key: `achievement:${a.code}`, sourceId: a.code, attribute: a.attribute, requested: REWARD.achievement, day: t.today, reason: `Conquista: ${a.title}` });
    const ev = await activeGrant(t.c, t.userId, `achievement:${a.code}`);
    await t.c.query('INSERT INTO life_achievements (user_id, code, xp_event_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [t.userId, a.code, ev?.id ?? null]);
    t.out.achievements.push({ code: a.code, title: a.title });
  }
}

// ------------------------------------------------------------------ treinos (módulo existente)

/** Treino válido = concluído, não excluído e com ao menos uma série de trabalho feita. */
export function validWorkoutsSql(mode: 'count' | 'rows'): string {
  const sets = "(SELECT count(*) FROM workout_sets ws WHERE ws.user_id = s.user_id AND ws.session_id = s.id AND ws.status = 'done' AND ws.type <> 'warmup')";
  return mode === 'count'
    ? `SELECT count(*)::int AS n FROM workout_sessions s WHERE s.user_id = $1 AND NOT s.deleted AND s.status = 'completed' AND ${sets} > 0`
    : `SELECT s.id, s.started_at, coalesce(s.finished_at, s.started_at) AS finished_at, s.doc->>'workoutName' AS name, s.doc->>'workoutLabel' AS label, ${sets}::int AS sets
         FROM workout_sessions s WHERE s.user_id = $1 AND NOT s.deleted AND s.status = 'completed' AND ${sets} > 0`;
}

export const workoutXp = (sets: number) => REWARD.workout.base + Math.min(REWARD.workout.maxBonus, REWARD.workout.perSet * Math.max(0, sets));

/**
 * Concilia os treinos sincronizados com o livro-razão:
 *  - treino válido concluído DEPOIS da ativação do perfil e ainda sem concessão → concede (uma vez por sessão);
 *  - concessão de treino cuja sessão foi excluída ou deixou de estar concluída → estorna;
 *  - bônus único de histórico pelos treinos anteriores à ativação (uma vez por conta).
 * Editar um treino já recompensado não muda nada (a chave é a sessão); treinos antigos editados nunca geram XP.
 */
export async function reconcileWorkouts(t: LifeTx): Promise<void> {
  const activated = t.profile.activated_at;
  const rows = await t.c.query<{ id: string; started_at: Date; finished_at: Date; name: string | null; label: string | null; sets: number }>(
    `${validWorkoutsSql('rows')}
       AND coalesce(s.finished_at, s.started_at) >= $2 AND s.started_at >= $2::timestamptz - interval '1 day'
       AND coalesce(s.finished_at, s.started_at) <= now() + interval '10 minutes'
       AND NOT EXISTS (SELECT 1 FROM life_xp_events e WHERE e.user_id = s.user_id AND e.source_key = 'workout:' || s.id AND e.kind = 'grant' AND e.reversed_at IS NULL)
     ORDER BY finished_at LIMIT 50`,
    [t.userId, activated],
  );
  for (const s of rows.rows) {
    const name = [s.label, s.name].filter(Boolean).join(' — ') || 'Treino';
    await grant(t, { source: 'workout', key: `workout:${s.id}`, sourceId: s.id, attribute: 'strength', requested: workoutXp(s.sets), day: localDate(s.finished_at.getTime(), t.tz), reason: `Treino concluído: ${name}` });
  }
  const gone = await t.c.query<{ source_key: string }>(
    `SELECT e.source_key FROM life_xp_events e WHERE e.user_id = $1 AND e.source = 'workout' AND e.kind = 'grant' AND e.reversed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM workout_sessions s WHERE s.user_id = e.user_id AND s.id = e.source_id AND NOT s.deleted AND s.status = 'completed')`,
    [t.userId],
  );
  for (const g of gone.rows) await reverse(t, g.source_key, 'Treino excluído ou reaberto');
  if (!(await activeGrant(t.c, t.userId, 'legacy:workouts'))) {
    const n = Number((await t.c.query<{ n: number }>(`${validWorkoutsSql('count')} AND coalesce(s.finished_at, s.started_at) < $2`, [t.userId, activated])).rows[0].n);
    if (n > 0) await grant(t, { source: 'legacy', key: 'legacy:workouts', sourceId: null, attribute: 'strength', requested: Math.min(REWARD.legacyMax, n * REWARD.legacyPerWorkout), day: t.today, reason: `Bônus de histórico: ${n} treino(s) anteriores` });
  }
}

// ------------------------------------------------------------------ missões automáticas

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface HabitSchedRow {
  id: string;
  frequency: 'daily' | 'weekly';
  days: number[];
  times_per_week: number | null;
  status: string;
  start_date: string;
}

export const scheduledOn = (h: HabitSchedRow, date: string) => h.status === 'active' && date >= h.start_date && (h.frequency === 'weekly' || h.days.includes(weekday(date)));

export async function isRestDay(c: PoolClient, userId: string, date: string): Promise<boolean> {
  return !!(await c.query("SELECT 1 FROM life_day_marks WHERE user_id = $1 AND date = $2 AND kind = 'rest'", [userId, date])).rowCount;
}

/**
 * Gera as missões automáticas do dia e da semana (idempotente: uma por modelo e período) e expira as vencidas.
 * Respeita dias de descanso (as diárias do dia ficam pausadas) e atividades pausadas (fora da contagem).
 */
export async function ensureMissions(t: LifeTx): Promise<void> {
  const { c, userId, today } = t;
  await c.query("UPDATE life_missions SET status = 'expired', updated_at = now() WHERE user_id = $1 AND status = 'active' AND ends_on < $2", [userId, today]);
  const habits = (await c.query<HabitSchedRow>("SELECT id, frequency, days, times_per_week, status, start_date FROM life_habits WHERE user_id = $1 AND status = 'active'", [userId])).rows;
  const routines = (await c.query<{ id: string; name: string; days: number[] }>("SELECT id, name, days FROM life_routines WHERE user_id = $1 AND status = 'active' ORDER BY created_at", [userId])).rows;
  const rest = await isRestDay(c, userId, today);
  const add = async (m: Omit<MissionRow, 'id' | 'progress' | 'status' | 'completed_at' | 'version' | 'created_at' | 'origin' | 'description' | 'habit_id'> & { description?: string | null }) => {
    const r = await c.query<MissionRow>(
      `INSERT INTO life_missions (id, user_id, type, origin, template, title, description, metric, routine_id, unit, tag, target, attribute, xp, starts_on, ends_on)
       VALUES ($1, $2, $3, 'system', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (user_id, template, starts_on) WHERE template IS NOT NULL DO NOTHING RETURNING *`,
      [randomUUID(), userId, m.type, m.template, m.title, m.description ?? null, m.metric, m.routine_id, m.unit, m.tag, m.target, m.attribute, m.xp, m.starts_on, m.ends_on],
    );
    // Missão nova num período já em andamento: o progresso existente conta.
    if (r.rows[0]) await recomputeMission(t, r.rows[0]);
  };
  // Diárias
  if (!rest) {
    const todays = habits.filter((h) => scheduledOn(h, today) && h.frequency === 'daily');
    if (todays.length) {
      const target = clamp(Math.round(todays.length * 0.6), 1, 5);
      await add({ type: 'daily', template: 'daily_habits', title: target === 1 ? 'Cumprir 1 hábito hoje' : `Cumprir ${target} hábitos hoje`, metric: 'habit_completions', routine_id: null, unit: 'times', tag: 'other', target, attribute: 'discipline', xp: clamp(10 + 5 * target, REWARD.mission.daily.min, REWARD.mission.daily.max), starts_on: today, ends_on: today });
    }
    const rt = routines.find((r) => r.days.includes(weekday(today)));
    if (rt) await add({ type: 'daily', template: 'daily_routine', title: `Completar a ${rt.name.toLowerCase().startsWith('rotina') ? rt.name : `rotina "${rt.name}"`}`, metric: 'routine_completions', routine_id: rt.id, unit: 'times', tag: 'routine', target: 1, attribute: 'discipline', xp: 15, starts_on: today, ends_on: today });
  } else {
    await c.query("UPDATE life_missions SET status = 'paused', updated_at = now() WHERE user_id = $1 AND type = 'daily' AND origin = 'system' AND status = 'active' AND starts_on = $2", [userId, today]);
  }
  // Semanais (segunda a domingo)
  const w = weekOf(today);
  const recent = Number((await c.query<{ n: number }>(`${validWorkoutsSql('count')} AND s.started_at >= now() - interval '28 days'`, [userId])).rows[0].n);
  const hasRoutines = !!(await c.query('SELECT 1 FROM routines WHERE user_id = $1 AND NOT deleted LIMIT 1', [userId])).rowCount;
  if (recent > 0 || hasRoutines || t.profile.weekly_workout_target) {
    const target = t.profile.weekly_workout_target ?? clamp(Math.round(recent / 4) || 3, 2, 6);
    await add({ type: 'weekly', template: 'weekly_workouts', title: `Concluir ${target} treinos na semana`, metric: 'workouts', routine_id: null, unit: 'times', tag: 'workout', target, attribute: 'strength', xp: clamp(20 * target, REWARD.mission.weekly.min, REWARD.mission.weekly.max), starts_on: w.start, ends_on: w.end });
  }
  if (habits.length) {
    let expected = 0;
    for (let d = w.start; d <= w.end; d = addDays(d, 1)) expected += habits.filter((h) => h.frequency === 'daily' && scheduledOn(h, d)).length;
    expected += habits.filter((h) => h.frequency === 'weekly').reduce((s, h) => s + (h.times_per_week ?? 0), 0);
    if (expected > 0) {
      const target = clamp(Math.round(expected * 0.7), 3, 40);
      await add({ type: 'weekly', template: 'weekly_habits', title: `Cumprir ${target} hábitos na semana`, metric: 'habit_completions', routine_id: null, unit: 'times', tag: 'other', target, attribute: 'discipline', xp: clamp(30 + 2 * target, REWARD.mission.weekly.min, REWARD.mission.weekly.max), starts_on: w.start, ends_on: w.end });
    }
  }
  // Fase 02: diário alimentar (só para quem usa a alimentação: metas definidas ou refeição registrada em 14 dias).
  const eats = !!(await c.query("SELECT 1 FROM nutrition_goals WHERE user_id = $1 UNION ALL SELECT 1 FROM nutrition_meals WHERE user_id = $1 AND status = 'consumed' AND date >= $2 LIMIT 1", [userId, addDays(today, -14)])).rowCount;
  if (eats) await add({ type: 'weekly', template: 'weekly_nutrition', title: `Registrar a alimentação em ${NUTRITION_REWARD.weeklyDays} dias`, description: 'Conta o registro, não a quantidade: basta anotar ao menos 2 refeições no dia.', metric: 'nutrition_days', routine_id: null, unit: 'times', tag: 'nutrition', target: NUTRITION_REWARD.weeklyDays, attribute: 'health', xp: NUTRITION_REWARD.weeklyXp, starts_on: w.start, ends_on: w.end });
  if (habits.length || routines.length || recent > 0) await add({ type: 'weekly', template: 'weekly_consistency', title: 'Ter 5 dias ativos na semana', metric: 'active_days', routine_id: null, unit: 'times', tag: 'other', target: 5, attribute: 'discipline', xp: 50, starts_on: w.start, ends_on: w.end });
}
