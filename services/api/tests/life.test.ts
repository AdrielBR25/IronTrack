// RPG de desenvolvimento pessoal (Fase 01): PostgreSQL real. Cobre fórmulas de XP/nível, idempotência, estorno,
// teto diário, missões automáticas (dias previstos, descanso), conquistas, rotinas sem XP em dobro, treinos integrados
// (uma vez por sessão, edição não duplica, exclusão estorna, histórico não gera XP), isolamento entre contas e fuso.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REWARD, attributeLevelFromXp, levelFromXp, titleForLevel, xpForLevel, xpToNext } from '../../../shared/life/protocol.ts';
import { applyPush } from '../src/modules/sync.ts';
import { setupApi, signup, uuid4, type Client, type TestEnv } from './helpers.ts';

let env: TestEnv;
let clock = Date.now();
beforeAll(async () => {
  env = await setupApi({}, { lifeNow: () => clock });
});
afterAll(async () => {
  await env?.close();
});

const TZ = 'America/Sao_Paulo';
const localToday = (ms = clock) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));
const wd = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

async function person(tag = 'rpg') {
  const s = await signup(env, 'Pessoa RPG', `${tag}.${uuid4().slice(0, 8)}@exemplo.test`);
  const d = await s.client.get(`/api/v1/life/dashboard?tz=${encodeURIComponent(TZ)}`);
  expect(d.status).toBe(200);
  return s;
}
const habit = (over: Record<string, unknown> = {}) => ({ name: 'Beber água', attribute: 'health', tag: 'water', icon: 'droplet', frequency: 'daily', goalKind: 'count', goalTarget: 8, goalUnit: 'copos', xp: 10, ...over });
const createHabit = async (c: Client, over: Record<string, unknown> = {}) => {
  const r = await c.post('/api/v1/life/habits', habit(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const ledger = async (userId: string) => (await env.pool.query('SELECT kind, source, source_key, amount, reversed_at FROM life_xp_events WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
const totals = async (userId: string) => {
  const p = (await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [userId])).rows[0];
  const sum = (await env.pool.query('SELECT coalesce(sum(amount),0)::int AS n FROM life_xp_events WHERE user_id = $1', [userId])).rows[0].n;
  const attrs = (await env.pool.query('SELECT coalesce(sum(xp),0)::int AS n FROM life_attributes WHERE user_id = $1', [userId])).rows[0].n;
  const attributed = (await env.pool.query('SELECT coalesce(sum(amount),0)::int AS n FROM life_xp_events WHERE user_id = $1 AND attribute IS NOT NULL', [userId])).rows[0].n;
  return { total: Number(p.total_xp), sum, attrs, attributed };
};

describe('fórmulas de progressão', () => {
  it('nível, XP para o próximo nível, atributos e títulos', () => {
    expect(xpToNext(1)).toBe(100);
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    expect(xpForLevel(3)).toBe(250);
    expect(xpForLevel(10)).toBe(2700);
    expect(levelFromXp(0)).toMatchObject({ level: 1, into: 0, need: 100 });
    expect(levelFromXp(99).level).toBe(1);
    expect(levelFromXp(100)).toMatchObject({ level: 2, into: 0, need: 150 });
    expect(levelFromXp(-50).level).toBe(1);
    expect(levelFromXp(10_000_000).level).toBe(100);
    for (let l = 1; l < 100; l++) expect(xpForLevel(l + 1) - xpForLevel(l)).toBe(xpToNext(l));
    expect(attributeLevelFromXp(60).level).toBe(2);
    expect(titleForLevel(1)).toBe('Iniciante');
    expect(titleForLevel(12)).toBe('Persistente');
  });
});

describe('hábitos e XP', () => {
  it('cumprir concede XP uma vez; repetir não duplica; desfazer estorna; total = soma do livro-razão', async () => {
    const { client, account } = await person();
    const id = await createHabit(client);
    const half = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 4 });
    expect(half.body.outcome.xpGained).toBe(0);
    const done = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 8 });
    expect(done.status).toBe(200);
    expect(done.body.completed).toBe(true);
    expect(done.body.outcome.xpGained).toBe(10);
    const again = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 9 });
    expect(again.body.outcome.xpGained).toBe(0);
    // Concorrência: vários registros simultâneos do mesmo dia continuam valendo uma concessão.
    await Promise.all([1, 2, 3, 4].map(() => client.post(`/api/v1/life/habits/${id}/log`, { amount: 8 })));
    expect((await ledger(account.id)).filter((e) => e.source === 'habit' && e.kind === 'grant' && !e.reversed_at)).toHaveLength(1);
    const undo = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 0 });
    expect(undo.body.outcome.xpReverted).toBe(10);
    const t = await totals(account.id);
    expect(t.total).toBe(t.sum);
    expect(t.attrs).toBe(t.attributed);
    expect(t.total).toBeGreaterThanOrEqual(0);
    const l = await ledger(account.id);
    expect(l.filter((e) => e.source === 'habit').map((e) => [e.kind, e.amount])).toEqual([
      ['grant', 10],
      ['reversal', -10],
    ]);
    // Recompletar depois do estorno vale de novo (o anterior foi estornado; saldo líquido continua uma vez).
    await client.post(`/api/v1/life/habits/${id}/log`, { amount: 8 });
    expect((await totals(account.id)).sum).toBe((await totals(account.id)).total);
  });

  it('XP configurável só dentro dos limites; datas só hoje/ontem; pausado não registra', async () => {
    const { client } = await person();
    expect((await client.post('/api/v1/life/habits', habit({ xp: 500 }))).status).toBe(422);
    expect((await client.post('/api/v1/life/habits', habit({ xp: 1 }))).status).toBe(422);
    const id = await createHabit(client, { goalKind: 'check' });
    const tomorrow = new Date(clock + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await client.post(`/api/v1/life/habits/${id}/log`, { amount: 1, date: tomorrow })).body.error.code).toBe('life_date_not_allowed');
    const h = (await client.get('/api/v1/life/habits')).body.habits[0];
    expect((await client.req('PATCH', `/api/v1/life/habits/${id}`, { version: h.version, patch: { status: 'paused' } })).status).toBe(200);
    expect((await client.req('PATCH', `/api/v1/life/habits/${id}`, { version: h.version, patch: { name: 'x' } })).body.error.code).toBe('life_stale');
    expect((await client.post(`/api/v1/life/habits/${id}/log`, { amount: 1 })).body.error.code).toBe('life_inactive');
  });

  it('semanal: XP só até a meta da semana', async () => {
    const { client } = await person();
    const id = await createHabit(client, { name: 'Estudar', attribute: 'knowledge', tag: 'study', frequency: 'weekly', timesPerWeek: 1, goalKind: 'check', xp: 20 });
    const today = localToday();
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const sameWeek = wd(today) !== 1; // ontem na mesma semana (segunda a domingo)
    await env.pool.query('UPDATE life_habits SET start_date = $2 WHERE id = $1', [id, yesterday]);
    const a = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 1 });
    expect(a.body.outcome.xpGained).toBe(20);
    if (sameWeek) {
      const b = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 1, date: yesterday });
      expect(b.body.outcome.xpGained).toBe(0);
    }
  });

  it('teto diário de XP', async () => {
    const { client, account } = await person();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await createHabit(client, { name: `Hábito ${i}`, goalKind: 'check', xp: 50 }));
    for (const id of ids) await client.post(`/api/v1/life/habits/${id}/log`, { amount: 1 });
    const day = (await env.pool.query("SELECT coalesce(sum(amount),0)::int AS n FROM life_xp_events WHERE user_id = $1 AND day = $2 AND source IN ('habit','mission','workout','routine')", [account.id, localToday()])).rows[0].n;
    expect(day).toBe(REWARD.dailyCap);
    const capped = (await ledger(account.id)).filter((e) => e.source === 'habit' && e.amount < 50);
    expect(capped.length).toBeGreaterThan(0);
  });
});

describe('missões e conquistas', () => {
  it('missão diária aparece nos dias previstos, conclui com XP e libera "Primeira missão"; descanso pausa', async () => {
    const { client, account } = await person();
    const today = localToday();
    // Hábito que NÃO é de hoje: nenhuma missão diária.
    const other = (wd(today) + 1) % 7;
    await createHabit(client, { name: 'Outro dia', goalKind: 'check', days: [other] });
    let d = await client.get('/api/v1/life/dashboard');
    expect(d.body.missionsToday.filter((m: any) => m.metric === 'habit_completions')).toHaveLength(0);
    const id = await createHabit(client, { name: 'Ler', tag: 'reading', attribute: 'knowledge', goalKind: 'duration', goalTarget: 30, goalUnit: 'min', days: [wd(today)] });
    d = await client.get('/api/v1/life/dashboard');
    const m = d.body.missionsToday.find((x: any) => x.metric === 'habit_completions');
    expect(m).toMatchObject({ type: 'daily', target: 1, status: 'active' });
    // Recarregar não duplica.
    await client.get('/api/v1/life/dashboard');
    expect((await env.pool.query("SELECT count(*)::int AS n FROM life_missions WHERE user_id = $1 AND template = 'daily_habits'", [account.id])).rows[0].n).toBe(1);
    const r = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 30 });
    expect(r.body.outcome.missionsCompleted.map((x: any) => x.id)).toContain(m.id);
    expect(r.body.outcome.achievements.map((x: any) => x.code)).toContain('first_mission');
    expect(r.body.outcome.xpGained).toBe(10 + m.xp + REWARD.achievement);
    // Desfazer o hábito desfaz a missão (estorno), mas a conquista é permanente.
    const u = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 0 });
    expect(u.body.outcome.xpReverted).toBe(10 + m.xp);
    const ach = (await client.get('/api/v1/life/achievements')).body.achievements;
    expect(ach.find((a: any) => a.code === 'first_mission').unlockedAt).not.toBeNull();
    // Leitura: com dados reais a conquista de leitura fica disponível.
    expect(ach.find((a: any) => a.code === 'reading_100')).toMatchObject({ available: true, progress: { value: 0, target: 100 } });
    // Dia de descanso pausa a missão diária.
    await client.post(`/api/v1/life/days/${today}/rest`, { rest: true });
    d = await client.get('/api/v1/life/dashboard');
    expect(d.body.missionsToday.find((x: any) => x.id === m.id).status).toBe('paused');
    expect(d.body.profile.streak.restToday).toBe(true);
    await client.post(`/api/v1/life/days/${today}/rest`, { rest: false });
    d = await client.get('/api/v1/life/dashboard');
    expect(d.body.missionsToday.find((x: any) => x.id === m.id).status).toBe('active');
  });

  it('missão personalizada com registros manuais (desfazer registro estorna)', async () => {
    const { client } = await person();
    const ends = new Date(clock + 5 * 86_400_000).toISOString().slice(0, 10);
    const c = await client.post('/api/v1/life/missions', { type: 'custom', title: 'Ler 30 minutos', metric: 'manual', unit: 'minutes', tag: 'reading', target: 30, attribute: 'knowledge', endsOn: ends, xp: 250 });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const mission = (await client.get(`/api/v1/life/missions/${c.body.id}`)).body.mission;
    expect(mission.xp).toBe(REWARD.mission.custom.max); // escolha limitada pelo servidor
    await client.post(`/api/v1/life/missions/${c.body.id}/entries`, { amount: 20 });
    const done = await client.post(`/api/v1/life/missions/${c.body.id}/entries`, { amount: 10 });
    expect(done.body.outcome.missionsCompleted).toHaveLength(1);
    const det = (await client.get(`/api/v1/life/missions/${c.body.id}`)).body;
    expect(det.mission).toMatchObject({ status: 'completed', progress: 30 });
    const del = await client.req('DELETE', `/api/v1/life/missions/${c.body.id}/entries/${det.entries[0].id}`);
    expect(del.body.outcome.xpReverted).toBe(REWARD.mission.custom.max);
    expect((await client.get(`/api/v1/life/missions/${c.body.id}`)).body.mission.status).toBe('active');
  });

  it('rotina: atividade vinculada ao hábito não dá XP em dobro; rotina completa dá o bônus uma vez', async () => {
    const { client, account } = await person();
    const today = localToday();
    const h = await createHabit(client, { name: 'Ler a Bíblia', tag: 'bible', attribute: 'spirituality', goalKind: 'check', xp: 15 });
    const r = await client.post('/api/v1/life/routines', { name: 'Rotina matinal', kind: 'morning', days: [wd(today)], items: [{ title: 'Ler a Bíblia', startTime: '06:00', durationMin: 15, habitId: h }, { title: 'Arrumar a cama', durationMin: 2 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rt = (await client.get('/api/v1/life/routines')).body.routines[0];
    const [a, b] = rt.items;
    const x = await client.post(`/api/v1/life/routines/${rt.id}/items/${a.id}/check`, { done: true });
    expect(x.body.outcome.xpGained).toBe(15 + 0); // só o XP do hábito
    // Registrar o hábito diretamente depois não soma de novo.
    expect((await client.post(`/api/v1/life/habits/${h}/log`, { amount: 1 })).body.outcome.xpGained).toBe(0);
    const y = await client.post(`/api/v1/life/routines/${rt.id}/items/${b.id}/check`, { done: true });
    expect(y.body.outcome.events.some((e: any) => e.reason.startsWith('Rotina completa'))).toBe(true);
    await client.post(`/api/v1/life/routines/${rt.id}/items/${b.id}/check`, { done: true });
    expect((await ledger(account.id)).filter((e) => e.source === 'routine' && e.kind === 'grant')).toHaveLength(1);
    const z = await client.post(`/api/v1/life/routines/${rt.id}/items/${b.id}/check`, { done: false });
    expect(z.body.outcome.xpReverted).toBeGreaterThanOrEqual(REWARD.routineBonus);
  });
});

describe('treinos', () => {
  const session = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
    id,
    routineId: 'r1',
    workoutId: 'wA',
    workoutLabel: 'A',
    workoutName: 'Peito',
    status: 'completed',
    startedAt: at - 3_600_000,
    finishedAt: at,
    updatedAt: 1,
    exercises: [{ id: `${id}-x`, name: 'Supino', sets: [{ id: 'w', type: 'warmup', status: 'done', weight: 20, reps: 10 }, { id: 's1', type: 'normal', status: 'done', weight: 60, reps: 8 }, { id: 's2', type: 'normal', status: 'done', weight: 60, reps: 8 }] }],
    ...extra,
  });

  it('treino novo gera XP uma vez; edição não duplica; exclusão estorna; histórico só conta como bônus e conquista', async () => {
    const { client, account } = await signup(env, 'Pessoa Treino', `treino.${uuid4().slice(0, 8)}@exemplo.test`);
    const dev = uuid4();
    // 10 treinos antigos (antes do perfil do RPG existir)
    const old = Array.from({ length: 10 }, (_, i) => ({ opId: uuid4(), collection: 'sessions', entityId: `old${i}`, kind: 'put', baseVersion: 0, doc: session(`old${i}`, Date.now() - (30 - i) * 86_400_000) }));
    const res = await applyPush(env.pool, account.id, dev, old);
    expect(res.every((r) => r.status === 'applied')).toBe(true);
    let d = await client.get('/api/v1/life/dashboard');
    expect(d.body.outcome.events.find((e: any) => e.reason.startsWith('Bônus de histórico'))).toMatchObject({ amount: 10 * REWARD.legacyPerWorkout });
    expect(d.body.outcome.achievements.map((a: any) => a.code)).toContain('ten_workouts');
    expect((await ledger(account.id)).filter((e) => e.source === 'workout')).toHaveLength(0);
    // Editar um treino antigo não cria XP.
    await applyPush(env.pool, account.id, dev, [{ opId: uuid4(), collection: 'sessions', entityId: 'old0', kind: 'put', baseVersion: 1, doc: { ...session('old0', Date.now() - 30 * 86_400_000), notes: 'editado' } }]);
    d = await client.get('/api/v1/life/dashboard');
    expect((await ledger(account.id)).filter((e) => e.source === 'workout')).toHaveLength(0);
    // Treino novo (concluído depois da ativação).
    await new Promise((r) => setTimeout(r, 20));
    await applyPush(env.pool, account.id, dev, [{ opId: uuid4(), collection: 'sessions', entityId: 'novo', kind: 'put', baseVersion: 0, doc: session('novo', Date.now()) }]);
    d = await client.get('/api/v1/life/dashboard');
    const ev = d.body.outcome.events.find((e: any) => e.reason.startsWith('Treino concluído'));
    expect(ev).toMatchObject({ amount: REWARD.workout.base + 2 * REWARD.workout.perSet, attribute: 'strength' });
    expect(d.body.workouts.thisWeek).toBe(1);
    // Editar o treino recompensado (mais séries) e recarregar: nenhuma concessão nova.
    await applyPush(env.pool, account.id, dev, [{ opId: uuid4(), collection: 'sessions', entityId: 'novo', kind: 'put', baseVersion: 1, doc: { ...session('novo', Date.now()), notes: 'mais séries' } }]);
    await client.get('/api/v1/life/dashboard');
    await client.post('/api/v1/life/reconcile');
    expect((await ledger(account.id)).filter((e) => e.source === 'workout' && e.kind === 'grant')).toHaveLength(1);
    // Excluir → estorno.
    await applyPush(env.pool, account.id, dev, [{ opId: uuid4(), collection: 'sessions', entityId: 'novo', kind: 'delete', baseVersion: 2 }]);
    const rec = await client.post('/api/v1/life/reconcile');
    expect(rec.body.outcome.xpReverted).toBe(ev.amount);
    const t = await totals(account.id);
    expect(t.total).toBe(t.sum);
  });

  it('treino sem séries feitas não gera XP', async () => {
    const { client, account } = await person();
    await new Promise((r) => setTimeout(r, 20));
    const s = session('vazio', Date.now());
    s.exercises[0].sets = s.exercises[0].sets.map((x) => ({ ...x, status: 'skipped' }));
    await applyPush(env.pool, account.id, uuid4(), [{ opId: uuid4(), collection: 'sessions', entityId: 'vazio', kind: 'put', baseVersion: 0, doc: s }]);
    await client.post('/api/v1/life/reconcile');
    expect((await ledger(account.id)).filter((e) => e.source === 'workout')).toHaveLength(0);
  });
});

describe('isolamento, fuso e persistência', () => {
  it('outra conta não vê nem altera hábitos, rotinas ou missões', async () => {
    const a = await person('a');
    const b = await person('b');
    const id = await createHabit(a.client);
    expect((await b.client.post(`/api/v1/life/habits/${id}/log`, { amount: 8 })).status).toBe(404);
    expect((await b.client.req('PATCH', `/api/v1/life/habits/${id}`, { patch: { name: 'roubado' } })).status).toBe(404);
    expect((await b.client.get('/api/v1/life/habits')).body.habits).toHaveLength(0);
    // Vincular rotina a hábito de outra conta é recusado.
    expect((await b.client.post('/api/v1/life/routines', { name: 'R', kind: 'custom', items: [{ title: 'x', habitId: id }] })).status).toBe(422);
    expect((await b.client.get('/api/v1/life/xp')).body.events).toHaveLength(0);
  });

  it('virada do dia pelo fuso da conta e troca de fuso sem duplicar', async () => {
    const saved = clock;
    try {
      // 02:30 UTC = 23:30 do dia anterior em São Paulo.
      const base = new Date();
      base.setUTCHours(2, 30, 0, 0);
      clock = base.getTime();
      const { client, account } = await person();
      const id = await createHabit(client, { goalKind: 'check' });
      const r = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 1 });
      expect(r.status).toBe(200);
      const day = (await env.pool.query("SELECT day FROM life_xp_events WHERE user_id = $1 AND source = 'habit'", [account.id])).rows[0].day;
      expect(day).toBe(localToday(clock));
      expect(day).not.toBe(new Date(clock).toISOString().slice(0, 10));
      // Troca para UTC: "hoje" passa a ser o dia seguinte; o registro anterior continua no dia dele.
      expect((await client.req('PATCH', '/api/v1/life/profile', { timezone: 'UTC' })).status).toBe(200);
      const again = await client.post(`/api/v1/life/habits/${id}/log`, { amount: 1, date: day });
      expect(again.body.outcome.xpGained).toBe(0);
      expect((await client.req('PATCH', '/api/v1/life/profile', { timezone: 'Lua/Base' })).status).toBe(422);
    } finally {
      clock = saved;
    }
  });

  it('dados persistem no PostgreSQL e excluir a conta apaga tudo do RPG', async () => {
    const { client, account } = await person();
    await createHabit(client);
    for (const t of ['life_profiles', 'life_habits', 'life_attributes']) expect((await env.pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [account.id])).rows[0].n).toBeGreaterThan(0);
    await env.pool.query('DELETE FROM users WHERE id = $1', [account.id]);
    for (const t of ['life_profiles', 'life_habits', 'life_attributes', 'life_xp_events', 'life_missions']) expect((await env.pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [account.id])).rows[0].n).toBe(0);
  });
});
