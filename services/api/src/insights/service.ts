// "Minha Evolução" (Fase 06, docs/INTEGRACAO_LIFE.md §5): indicadores de todos os módulos por período, com comparação
// ao período anterior, calculados de forma DETERMINÍSTICA no servidor (SQL + regras fixas). Nenhuma chamada à OpenAI:
// a IA só interpreta estes números quando a pessoa pede (ferramenta get_life_overview).
//
// Regras:
//  - Ausência de registros = "sem dados" (value null), nunca desempenho ruim nem zero;
//  - Refeições planejadas não são consumo; só refeições consumidas contam no diário;
//  - Coincidências entre módulos são descritas como observação, nunca como causa.
import { levelFromXp } from '../../../../shared/life/protocol.ts';
import { PLANNER_PROTOCOL, type EvolutionInsight, type EvolutionMetric, type EvolutionPeriod, type EvolutionView } from '../../../../shared/planner/protocol.ts';
import type { Pool, PoolClient } from '../db/pool.ts';
import { addDays, localDate, localMidnight, mondayOf } from '../assistant/tools/time.ts';
import { accountTz } from '../planner/service.ts';

type Q = Pick<Pool | PoolClient, 'query'>;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
const fmt = (d: string) => d.split('-').reverse().slice(0, 2).join('/');

/** Período e período anterior de mesmo tamanho (datas locais). `offset` volta períodos inteiros. */
export function periodRange(kind: EvolutionPeriod, today: string, offset = 0): { from: string; to: string; prevFrom: string; prevTo: string; label: string; prevLabel: string } {
  if (kind === 'week') {
    const mon = addDays(mondayOf(today), -7 * offset);
    const to = offset === 0 ? today : addDays(mon, 6);
    const len = daysBetween(mon, to);
    const prevFrom = addDays(mon, -7);
    return { from: mon, to, prevFrom, prevTo: addDays(prevFrom, len - 1), label: offset === 0 ? 'Esta semana' : offset === 1 ? 'Semana passada' : `Semana de ${fmt(mon)}`, prevLabel: 'semana anterior' };
  }
  if (kind === 'month') {
    const [y, m] = today.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1 - offset, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, m - offset, 0)).toISOString().slice(0, 10);
    const to = offset === 0 ? today : last;
    const len = daysBetween(first, to);
    const prevFirst = new Date(Date.UTC(y, m - 2 - offset, 1)).toISOString().slice(0, 10);
    const prevLast = new Date(Date.UTC(y, m - 1 - offset, 0)).toISOString().slice(0, 10);
    const prevTo = addDays(prevFirst, len - 1) > prevLast ? prevLast : addDays(prevFirst, len - 1);
    const name = new Date(`${first}T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' });
    return { from: first, to, prevFrom: prevFirst, prevTo, label: offset === 0 ? 'Este mês' : name.charAt(0).toUpperCase() + name.slice(1), prevLabel: 'mês anterior' };
  }
  const n = kind === 'last7' ? 7 : 30;
  const to = addDays(today, -n * offset);
  const from = addDays(to, -(n - 1));
  return { from, to, prevFrom: addDays(from, -n), prevTo: addDays(from, -1), label: `Últimos ${n} dias`, prevLabel: `${n} dias anteriores` };
}

interface Raw {
  workouts: { date: string; id: string }[];
  mealDays: Map<string, { kcal: number; protein: number; meals: number }>;
  habitsDone: Map<string, number>;
  habitExpected: number;
  habitDoneTotal: number;
  perHabit: { name: string; done: number; expected: number }[];
  xpByDay: Map<string, number>;
  xpSum: number;
  xpBefore: number;
  knowledge: { date: string; module: string; kind: string; sec: number; pages: number }[];
  planDays: number;
  chapters: number;
}

async function collect(q: Q, userId: string, tz: string, from: string, to: string, today: string): Promise<Raw> {
  const fromMs = localMidnight(from, tz);
  const toMs = localMidnight(addDays(to, 1), tz);
  const [w, meals, habitLogs, habits, xp, xpBefore, ks, pd, ch] = await Promise.all([
    q.query<{ id: string; started_at: Date }>(
      `SELECT s.id, s.started_at FROM workout_sessions s WHERE s.user_id = $1 AND NOT s.deleted AND s.status = 'completed'
         AND s.started_at >= to_timestamp($2 / 1000.0) AND s.started_at < to_timestamp($3 / 1000.0)
         AND (SELECT count(*) FROM workout_sets ws WHERE ws.user_id = s.user_id AND ws.session_id = s.id AND ws.status = 'done' AND ws.type <> 'warmup') > 0`,
      [userId, fromMs, toMs],
    ),
    q.query<{ date: string; kcal: number; protein: number; meals: number }>(
      `SELECT m.date, coalesce(sum(i.kcal), 0)::float AS kcal, coalesce(sum(i.protein), 0)::float AS protein, count(DISTINCT m.id)::int AS meals
         FROM nutrition_meals m LEFT JOIN nutrition_meal_items i ON i.meal_id = m.id
        WHERE m.user_id = $1 AND m.status = 'consumed' AND m.date BETWEEN $2 AND $3 GROUP BY m.date`,
      [userId, from, to],
    ),
    q.query<{ habit_id: string; date: string }>('SELECT habit_id, date FROM life_habit_logs WHERE user_id = $1 AND completed AND date BETWEEN $2 AND $3', [userId, from, to]),
    q.query<{ id: string; name: string; days: number[]; start_date: string; status: string; frequency: string; times_per_week: number | null }>(
      "SELECT id, name, days, start_date, status, frequency, times_per_week FROM life_habits WHERE user_id = $1 AND status <> 'archived'",
      [userId],
    ),
    q.query<{ day: string; n: number }>('SELECT day, sum(amount)::int AS n FROM life_xp_events WHERE user_id = $1 AND day BETWEEN $2 AND $3 GROUP BY day', [userId, from, to]),
    q.query<{ n: number }>('SELECT coalesce(sum(amount), 0)::int AS n FROM life_xp_events WHERE user_id = $1 AND day < $2', [userId, from]),
    q.query<{ date: string; module: string; kind: string; sec: number; pages: number }>('SELECT date, module, kind, active_sec AS sec, pages_read AS pages FROM knowledge_sessions WHERE user_id = $1 AND date BETWEEN $2 AND $3', [userId, from, to]),
    q.query<{ n: number }>('SELECT count(*)::int AS n FROM bible_plan_days WHERE user_id = $1 AND completed_on BETWEEN $2 AND $3', [userId, from, to]),
    q.query<{ n: number }>('SELECT count(*)::int AS n FROM bible_chapter_logs WHERE user_id = $1 AND date BETWEEN $2 AND $3', [userId, from, to]),
  ]);
  const habitsDone = new Map<string, number>();
  const doneBy = new Map<string, number>();
  for (const l of habitLogs.rows) {
    habitsDone.set(l.date, (habitsDone.get(l.date) ?? 0) + 1);
    doneBy.set(l.habit_id, (doneBy.get(l.habit_id) ?? 0) + 1);
  }
  // Ocorrências previstas até hoje (dias futuros não contam como "não feito").
  const last = to < today ? to : today;
  const perHabit: Raw['perHabit'] = [];
  let expected = 0;
  for (const h of habits.rows) {
    let e = 0;
    for (let d = from > h.start_date ? from : h.start_date; d <= last; d = addDays(d, 1)) if (h.days.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) e++;
    if (h.frequency === 'weekly' && h.times_per_week) e = Math.min(e, Math.ceil((daysBetween(from, last) / 7) * h.times_per_week));
    if (h.status === 'paused') e = Math.min(e, doneBy.get(h.id) ?? 0);
    expected += e;
    perHabit.push({ name: h.name, done: doneBy.get(h.id) ?? 0, expected: e });
  }
  return {
    workouts: w.rows.map((r) => ({ id: r.id, date: localDate(r.started_at.getTime(), tz) })),
    mealDays: new Map(meals.rows.map((m) => [m.date, { kcal: m.kcal, protein: m.protein, meals: m.meals }])),
    habitsDone,
    habitExpected: expected,
    habitDoneTotal: habitLogs.rows.length,
    perHabit,
    xpByDay: new Map(xp.rows.map((r) => [r.day, r.n])),
    xpSum: xp.rows.reduce((n, r) => n + r.n, 0),
    xpBefore: xpBefore.rows[0]?.n ?? 0,
    knowledge: ks.rows,
    planDays: pd.rows[0]?.n ?? 0,
    chapters: ch.rows[0]?.n ?? 0,
  };
}

const sumMin = (rows: Raw['knowledge'], f: (r: Raw['knowledge'][number]) => boolean) => {
  const s = rows.filter(f).reduce((n, r) => n + r.sec, 0);
  return Math.round(s / 60);
};

export async function evolution(q: Q, userId: string, now: number, kind: EvolutionPeriod, offset = 0): Promise<EvolutionView> {
  const tz = await accountTz(q, userId);
  const today = localDate(now, tz);
  const p = periodRange(kind, today, Math.max(0, Math.min(24, offset)));
  const [cur, prev, goals, bibleOn, loads] = await Promise.all([
    collect(q, userId, tz, p.from, p.to, today),
    collect(q, userId, tz, p.prevFrom, p.prevTo, today),
    q.query<{ kcal: number | null; protein: number | null; objective: string }>('SELECT kcal, protein, objective FROM nutrition_goals WHERE user_id = $1', [userId]),
    q.query<{ n: number }>("SELECT ((SELECT count(*) FROM bible_prefs WHERE user_id = $1) + (SELECT count(*) FROM bible_plans WHERE user_id = $1) + (SELECT count(*) FROM knowledge_sessions WHERE user_id = $1 AND module = 'bible'))::int AS n", [userId]),
    loadEvolution(q, userId, tz, p.from, p.to),
  ]);
  const days = daysBetween(p.from, p.to);
  const elapsed = daysBetween(p.from, p.to < today ? p.to : today);
  const goal = goals.rows[0] ?? null;
  const metrics: EvolutionMetric[] = [];
  const missing: string[] = [];
  const nz = (v: number) => (v > 0 ? v : null);
  const push = (m: Omit<EvolutionMetric, 'delta'>) => metrics.push({ ...m, delta: m.value != null && m.previous != null ? Math.round((m.value - m.previous) * 10) / 10 : null });

  // Treinos
  const wc = cur.workouts.length;
  const wp = prev.workouts.length;
  push({ id: 'workouts', module: 'training', label: 'Treinos concluídos', unit: 'treinos', value: nz(wc), previous: nz(wp), detail: wc ? `${new Set(cur.workouts.map((w) => w.date)).size} dias com treino` : null });
  push({ id: 'workouts_per_week', module: 'training', label: 'Frequência semanal', unit: 'treinos/semana', value: wc ? Math.round((wc / Math.max(1, days / 7)) * 10) / 10 : null, previous: wp ? Math.round((wp / Math.max(1, days / 7)) * 10) / 10 : null, detail: null });
  if (!wc) missing.push('Treinos');

  // Alimentação
  const logged = cur.mealDays.size;
  const loggedPrev = prev.mealDays.size;
  push({ id: 'meal_days', module: 'nutrition', label: 'Dias com refeições registradas', unit: 'dias', value: nz(logged), previous: nz(loggedPrev), detail: logged ? `${logged} de ${elapsed} dias (${Math.round((logged / elapsed) * 100)}%)` : null });
  if (goal?.kcal && logged) {
    const within = [...cur.mealDays.values()].filter((d) => Math.abs(d.kcal - goal.kcal!) <= goal.kcal! * 0.1).length;
    const withinPrev = goal.kcal && loggedPrev ? [...prev.mealDays.values()].filter((d) => Math.abs(d.kcal - goal.kcal!) <= goal.kcal! * 0.1).length : null;
    const avg = Math.round([...cur.mealDays.values()].reduce((n, d) => n + d.kcal, 0) / logged);
    push({ id: 'kcal_goal_days', module: 'nutrition', label: 'Dias registrados perto da meta de kcal (±10%)', unit: 'dias', value: within, previous: withinPrev, detail: `Média registrada ${avg} kcal/dia × meta ${goal.kcal} kcal (só dias com registro)` });
  }
  if (goal?.protein && logged) {
    const avgP = Math.round([...cur.mealDays.values()].reduce((n, d) => n + d.protein, 0) / logged);
    const avgPrev = loggedPrev ? Math.round([...prev.mealDays.values()].reduce((n, d) => n + d.protein, 0) / loggedPrev) : null;
    push({ id: 'protein_avg', module: 'nutrition', label: 'Proteína média nos dias registrados', unit: 'g/dia', value: avgP, previous: avgPrev, detail: `Meta ${goal.protein} g/dia` });
  }
  if (!logged) missing.push('Diário alimentar');

  // RPG
  push({ id: 'habits_done', module: 'life', label: 'Hábitos cumpridos', unit: 'vezes', value: cur.habitExpected || cur.habitDoneTotal ? cur.habitDoneTotal : null, previous: prev.habitExpected || prev.habitDoneTotal ? prev.habitDoneTotal : null, detail: cur.habitExpected ? `${cur.habitDoneTotal} de ${cur.habitExpected} previstos até hoje` : null });
  push({ id: 'xp', module: 'life', label: 'XP conquistado', unit: 'XP', value: cur.xpSum || null, previous: prev.xpSum || null, detail: null });
  const lvStart = levelFromXp(Math.max(0, cur.xpBefore)).level;
  const lvEnd = levelFromXp(Math.max(0, cur.xpBefore + cur.xpSum)).level;
  push({ id: 'levels', module: 'life', label: 'Níveis conquistados', unit: 'níveis', value: cur.xpSum ? lvEnd - lvStart : null, previous: null, detail: `Nível ${lvEnd} ao fim do período` });
  if (!cur.habitExpected && !cur.habitDoneTotal && !cur.xpSum) missing.push('Hábitos e XP');

  // Conhecimento
  const read = sumMin(cur.knowledge, (r) => r.module === 'knowledge' && r.kind === 'reading');
  const study = sumMin(cur.knowledge, (r) => r.module === 'knowledge' && r.kind !== 'reading');
  push({ id: 'reading_min', module: 'knowledge', label: 'Minutos de leitura', unit: 'min', value: nz(read), previous: nz(sumMin(prev.knowledge, (r) => r.module === 'knowledge' && r.kind === 'reading')), detail: read ? `${cur.knowledge.filter((r) => r.module === 'knowledge' && r.kind === 'reading').reduce((n, r) => n + r.pages, 0)} páginas registradas` : null });
  push({ id: 'study_min', module: 'knowledge', label: 'Tempo de estudo e foco', unit: 'min', value: nz(study), previous: nz(sumMin(prev.knowledge, (r) => r.module === 'knowledge' && r.kind !== 'reading')), detail: null });
  if (!read && !study) missing.push('Leitura e estudos');

  // Bíblia (só quando a área foi usada)
  if (bibleOn.rows[0]?.n) {
    const bm = sumMin(cur.knowledge, (r) => r.module === 'bible');
    push({ id: 'bible_min', module: 'bible', label: 'Minutos de leitura bíblica', unit: 'min', value: nz(bm), previous: nz(sumMin(prev.knowledge, (r) => r.module === 'bible')), detail: cur.chapters ? `${cur.chapters} capítulos marcados` : null });
    push({ id: 'bible_plan_days', module: 'bible', label: 'Dias de plano bíblico concluídos', unit: 'dias', value: nz(cur.planDays), previous: nz(prev.planDays), detail: null });
    if (!bm && !cur.planDays && !cur.chapters) missing.push('Bíblia');
  }

  // Série diária
  const wByDay = new Map<string, number>();
  for (const x of cur.workouts) wByDay.set(x.date, (wByDay.get(x.date) ?? 0) + 1);
  const daily: EvolutionView['daily'] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
    daily.push({
      date: d,
      workouts: wByDay.get(d) ?? 0,
      knowledgeMin: sumMin(cur.knowledge, (r) => r.date === d && r.module === 'knowledge'),
      bibleMin: sumMin(cur.knowledge, (r) => r.date === d && r.module === 'bible'),
      mealsLogged: cur.mealDays.get(d)?.meals ?? 0,
      habitsDone: cur.habitsDone.get(d) ?? 0,
      xp: cur.xpByDay.get(d) ?? 0,
    });
  }

  return {
    protocol: PLANNER_PROTOCOL,
    period: { kind, from: p.from, to: p.to, label: p.label, days },
    previous: { from: p.prevFrom, to: p.prevTo, label: p.prevLabel },
    metrics,
    daily,
    loads,
    insights: buildInsights(metrics, cur, elapsed, wByDay),
    missing,
    notes: [
      'Indicadores calculados pelo app a partir dos seus registros (sem IA).',
      'Dias sem registro aparecem como "sem dados", não como desempenho ruim.',
      'Relações entre áreas são coincidências observadas, não prova de causa.',
    ],
  };
}

/** Evolução de cargas: maior carga de trabalho na primeira e na última sessão do período, por exercício (≥ 2 sessões). */
async function loadEvolution(q: Q, userId: string, tz: string, from: string, to: string): Promise<EvolutionView['loads']> {
  const r = await q.query<{ exercise: string; first: number; last: number; sessions: number }>(
    `WITH tops AS (
       SELECT e.exercise_key, min(e.name) AS name, s.id, s.started_at, max(ws.weight_kg)::float AS top
         FROM workout_sessions s
         JOIN workout_exercises e ON e.user_id = s.user_id AND e.session_id = s.id
         JOIN workout_sets ws ON ws.user_id = e.user_id AND ws.session_id = e.session_id AND ws.exercise_id = e.id
        WHERE s.user_id = $1 AND NOT s.deleted AND s.status = 'completed' AND ws.status = 'done' AND ws.type <> 'warmup' AND ws.weight_kg > 0
          AND s.started_at >= to_timestamp($2 / 1000.0) AND s.started_at < to_timestamp($3 / 1000.0)
        GROUP BY e.exercise_key, s.id, s.started_at)
     SELECT min(name) AS exercise, (array_agg(top ORDER BY started_at))[1] AS first, (array_agg(top ORDER BY started_at DESC))[1] AS last, count(*)::int AS sessions
       FROM tops GROUP BY exercise_key HAVING count(*) >= 2 ORDER BY count(*) DESC, min(name) LIMIT 6`,
    [userId, localMidnight(from, tz), localMidnight(addDays(to, 1), tz)],
  );
  return r.rows.map((x) => ({ exercise: x.exercise, first: Math.round(x.first * 10) / 10, last: Math.round(x.last * 10) / 10, sessions: x.sessions }));
}

function buildInsights(metrics: EvolutionMetric[], cur: Raw, elapsed: number, wByDay: Map<string, number>): EvolutionInsight[] {
  const out: EvolutionInsight[] = [];
  const m = (id: string) => metrics.find((x) => x.id === id);
  const w = m('workouts');
  if (w?.value != null && w.previous != null && w.delta) {
    out.push({ tone: w.delta > 0 ? 'positive' : 'neutral', text: `${w.value} treinos no período, ${Math.abs(w.delta)} ${w.delta > 0 ? 'a mais' : 'a menos'} que no período anterior.`, basis: 'Treinos concluídos com pelo menos uma série de trabalho.' });
  }
  const behind = cur.perHabit.filter((h) => h.expected >= 3 && h.done / h.expected < 0.5).sort((a, b) => a.done / a.expected - b.done / b.expected)[0];
  if (behind) out.push({ tone: 'attention', text: `O hábito "${behind.name}" foi cumprido em ${behind.done} de ${behind.expected} dias previstos.`, basis: 'Registros de hábitos até hoje (dias futuros não contam).' });
  const md = m('meal_days');
  if (md?.value != null && md.value < elapsed) out.push({ tone: 'neutral', text: `Refeições registradas em ${md.value} de ${elapsed} dias. Os outros dias estão sem dados, não com consumo zero.`, basis: 'Só refeições marcadas como consumidas.' });
  const r = m('reading_min');
  if (r?.value != null && r.previous != null && r.delta && Math.abs(r.delta) >= 10) out.push({ tone: r.delta > 0 ? 'positive' : 'neutral', text: `Leitura: ${r.value} min, ${Math.abs(r.delta)} min ${r.delta > 0 ? 'a mais' : 'a menos'} que no período anterior.`, basis: 'Sessões de leitura registradas.' });
  // Coincidência entre módulos (sem causalidade).
  if (wByDay.size >= 3 && cur.mealDays.size >= 3) {
    const both = [...wByDay.keys()].filter((d) => cur.mealDays.has(d)).length;
    out.push({ tone: 'neutral', text: `Em ${both} dos ${wByDay.size} dias com treino também houve refeições registradas.`, basis: 'Coincidência observada nos registros, não relação de causa.' });
  }
  return out.slice(0, 5);
}
