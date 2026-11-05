// Alimentação (Fase 02): PostgreSQL real. Cobre cálculos (por 100 g, porções, totais), catálogo TACO e busca,
// registro/edição/exclusão, planejado × consumido, idempotência de reenvio, cópia de dia, refeições salvas, metas e
// estimativa, água, isolamento entre contas e a integração com o RPG (XP de registro uma vez, estorno, teto diário,
// hábito vinculado sem XP em dobro, missão semanal).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NUTRITION_REWARD, estimateGoals, itemMacros, macroSplit, roundMacros, sumMacros } from '../../../shared/nutrition/protocol.ts';
import { catalog, catalogFood, searchCatalog } from '../src/nutrition/catalog.ts';
import { setupApi, signup, uuid4, type Client, type TestEnv } from './helpers.ts';

let env: TestEnv;
const clock = Date.now();
beforeAll(async () => {
  env = await setupApi({}, { lifeNow: () => clock });
});
afterAll(async () => {
  await env?.close();
});

const TZ = 'America/Sao_Paulo';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(clock));
const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const RICE = 'taco:3'; // Arroz, tipo 1, cozido: 128 kcal, 2,5 P, 28,1 C, 0,2 G, 1,6 fibra
const BEANS = 'taco:561'; // Feijão, carioca, cozido: 76 kcal, 4,8 P, 13,6 C, 0,5 G, 8,5 fibra
const CHICKEN = 'taco:410'; // Frango, peito, sem pele, grelhado: 159 kcal, 32 P, 0 C, 2,5 G, fibra não informada

async function person(tag = 'nut') {
  const s = await signup(env, 'Pessoa Alimentação', `${tag}.${uuid4().slice(0, 8)}@exemplo.test`);
  expect((await s.client.get(`/api/v1/life/dashboard?tz=${encodeURIComponent(TZ)}`)).status).toBe(200);
  return s;
}
const lunch = (over: Record<string, unknown> = {}) => ({
  date: today,
  kind: 'lunch',
  status: 'consumed',
  time: '12:30',
  items: [
    { foodRef: RICE, quantity: 150 },
    { foodRef: BEANS, quantity: 120 },
    { foodRef: CHICKEN, quantity: 160 },
  ],
  ...over,
});
const meal = async (c: Client, over: Record<string, unknown> = {}) => {
  const r = await c.post('/api/v1/nutrition/meals', lunch(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const grants = async (userId: string, like = 'nutrition:%') => (await env.pool.query("SELECT source_key, amount, source_id, reversed_at, kind FROM life_xp_events WHERE user_id = $1 AND source_key LIKE $2 ORDER BY created_at", [userId, like])).rows;
const totalXp = async (userId: string) => Number((await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [userId])).rows[0].total_xp);

describe('cálculos e catálogo', () => {
  it('valores por 100 g, totais e distribuição de energia', () => {
    const rice = catalogFood(RICE)!;
    expect(rice.name).toBe('Arroz, tipo 1, cozido');
    expect(rice.per100).toEqual({ kcal: 128, protein: 2.5, carbs: 28.1, fat: 0.2, fiber: 1.6 });
    expect(rice.state).toBe('cooked');
    expect(rice.source.label).toContain('TACO');
    const r = itemMacros(rice.per100, 150);
    expect(roundMacros(r)).toEqual({ kcal: 192, protein: 3.8, carbs: 42.2, fat: 0.3, fiber: 2.4 });
    // Nutriente ausente na tabela (fibra do frango) conta como 0, sem inventar valor.
    const ch = catalogFood(CHICKEN)!;
    expect(ch.per100.fiber).toBeNull();
    expect(itemMacros(ch.per100, 160).fiber).toBe(0);
    const tot = roundMacros(sumMacros([itemMacros(rice.per100, 150), itemMacros(catalogFood(BEANS)!.per100, 120), itemMacros(ch.per100, 160)]));
    // 192 + 91,2 + 254,4 = 537,6 → 538
    expect(tot).toEqual({ kcal: 538, protein: 60.7, carbs: 58.5, fat: 4.9, fiber: 12.6 });
    expect(macroSplit({ kcal: 0, protein: 25, carbs: 50, fat: 11.1, fiber: 0 })).toEqual({ protein: 25, carbs: 50, fat: 25 });
    expect(macroSplit({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 })).toBeNull();
  });

  it('catálogo TACO completo, cru × cozido distinguidos e busca útil', () => {
    expect(catalog().list.length).toBeGreaterThan(580);
    expect(catalogFood('taco:4')!.state).toBe('raw'); // Arroz, tipo 1, cru
    expect(catalogFood('taco:4')!.per100.kcal).toBeGreaterThan(catalogFood(RICE)!.per100.kcal * 2);
    expect(searchCatalog('arroz', 1)[0].ref).toBe(RICE);
    expect(searchCatalog('peito de frango', 1)[0].ref).toBe(CHICKEN);
    expect(searchCatalog('ovos', 3).every((f) => f.name.startsWith('Ovo'))).toBe(true);
    expect(searchCatalog('arroz cru', 1)[0].state).toBe('raw');
    expect(searchCatalog('whey', 1)[0].source.kind).toBe('generic');
  });

  it('estimativa de metas: moderada, explicada e com piso de segurança', () => {
    const e = estimateGoals({ objective: 'fat_loss', sex: 'female', age: 30, weightKg: 50, heightCm: 155, activity: 'sedentary' });
    expect(e.kcal).toBeGreaterThanOrEqual(1200);
    expect(e.kcal).toBeGreaterThanOrEqual(e.bmr);
    expect(e.assumptions.join(' ')).toContain('não uma prescrição');
    const g = estimateGoals({ objective: 'muscle_gain', sex: 'male', age: 28, weightKg: 80, heightCm: 180, activity: 'moderate' });
    expect(g.kcal - g.maintenance).toBeLessThanOrEqual(300);
    expect(g.protein).toBe(144);
  });
});

describe('diário alimentar', () => {
  it('registra, calcula, edita, marca planejada como consumida e exclui', async () => {
    const { client: c, account } = await person();
    const r = await meal(c);
    expect(r.day.consumed).toEqual({ kcal: 538, protein: 60.7, carbs: 58.5, fat: 4.9, fiber: 12.6 });
    expect(r.day.meals).toHaveLength(1);
    expect(r.day.meals[0].title).toBe('Almoço');

    // Planejada NÃO conta como consumo.
    const p = await meal(c, { kind: 'dinner', status: 'planned', time: '20:00', items: [{ foodRef: RICE, quantity: 100 }] });
    expect(p.day.consumed.kcal).toBe(538);
    expect(p.day.plannedPending.kcal).toBe(128);
    expect(p.day.planTotal.kcal).toBe(128);

    // Corrigir quantidade e horário.
    const m = r.day.meals[0];
    const e = await c.req('PATCH', `/api/v1/nutrition/meals/${m.id}`, { version: m.version, patch: { time: '13:10', items: [{ foodRef: RICE, quantity: 100 }, { foodRef: CHICKEN, quantity: 160 }] } });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const edited = e.body.day.meals.find((x: any) => x.id === m.id);
    expect(edited.time).toBe('13:10');
    expect(edited.totals.kcal).toBe(Math.round(128 + 254.4));
    // Versão antiga → conflito.
    expect((await c.req('PATCH', `/api/v1/nutrition/meals/${m.id}`, { version: m.version, patch: { time: '14:00' } })).status).toBe(409);

    // Planejada → consumida: guarda o planejado para comparar.
    const consumed = await c.post(`/api/v1/nutrition/meals/${p.id}/consume`, {});
    expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);
    const dinner = consumed.body.day.meals.find((x: any) => x.id === p.id);
    expect(dinner.status).toBe('consumed');
    expect(dinner.plannedTotals.kcal).toBe(128);
    expect(consumed.body.day.consumed.kcal).toBe(382 + 128);
    expect((await c.post(`/api/v1/nutrition/meals/${p.id}/consume`, {})).status).toBe(409);

    // Excluir.
    const del = await c.req('DELETE', `/api/v1/nutrition/meals/${p.id}`);
    expect(del.status).toBe(200);
    expect(del.body.day.meals).toHaveLength(1);
    expect(account.id).toBeTruthy();
  });

  it('não aceita consumida no futuro; planejada no futuro sim', async () => {
    const { client: c } = await person();
    const tomorrow = addDays(today, 1);
    expect((await c.post('/api/v1/nutrition/meals', lunch({ date: tomorrow }))).status).toBe(422);
    const p = await meal(c, { date: tomorrow, status: 'planned' });
    expect(p.day.date).toBe(tomorrow);
    expect(p.day.consumed.kcal).toBe(0);
    expect((await c.post(`/api/v1/nutrition/meals/${p.id}/consume`, {})).status).toBe(422);
  });

  it('reenvio com o mesmo clientId não duplica', async () => {
    const { client: c } = await person();
    const clientId = uuid4();
    const [a, b] = await Promise.all([c.post('/api/v1/nutrition/meals', lunch({ clientId })), c.post('/api/v1/nutrition/meals', lunch({ clientId }))]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(b.body.day.meals).toHaveLength(1);
  });

  it('duplicar, copiar dia anterior como planejamento e refeições salvas', async () => {
    const { client: c } = await person();
    const y = addDays(today, -1);
    const r = await meal(c, { date: y });
    const dup = await c.post(`/api/v1/nutrition/meals/${r.id}/duplicate`, { date: today });
    expect(dup.status).toBe(201);
    expect(dup.body.day.consumed.kcal).toBe(538);
    // Copiar o dia de ontem para os próximos 3 dias: futuro vira planejado, não consumo.
    const to = [1, 2, 3].map((n) => addDays(today, n));
    const cp = await c.post(`/api/v1/nutrition/days/${y}/copy`, { to, status: 'consumed' });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    expect(cp.body.ids).toHaveLength(3);
    const d1 = await c.get(`/api/v1/nutrition/days/${to[0]}`);
    expect(d1.body.day.consumed.kcal).toBe(0);
    expect(d1.body.day.plannedPending.kcal).toBe(538);
    // Refeição salva e uso em poucos toques.
    const s = await c.post('/api/v1/nutrition/saved-meals', { name: 'Almoço padrão', kind: 'lunch', fromMealId: r.id });
    expect(s.status).toBe(201);
    const u = await c.post(`/api/v1/nutrition/saved-meals/${s.body.id}/use`, { date: today, status: 'consumed' });
    expect(u.status).toBe(201);
    expect(u.body.day.consumed.kcal).toBe(538 * 2);
    const q = await c.get('/api/v1/nutrition/quick');
    expect(q.body.quick.savedMeals[0]).toMatchObject({ name: 'Almoço padrão', useCount: 1 });
    expect(q.body.quick.recentFoods.map((f: any) => f.ref)).toEqual(expect.arrayContaining([RICE, BEANS, CHICKEN]));
    expect(q.body.quick.lastByKind.lunch.totals.kcal).toBe(538);
    // Histórico por período: dias sem registro não aparecem (nem como zero).
    const days = await c.get(`/api/v1/nutrition/days?from=${addDays(today, -6)}&to=${today}`);
    expect(days.body.days.map((d: any) => d.date)).toEqual([y, today]);
    const st = await c.get(`/api/v1/nutrition/stats?from=${addDays(today, -6)}&to=${addDays(today, 3)}`);
    expect(st.body.stats.loggedDays).toBe(2);
    expect(st.body.stats.average.kcal).toBe(Math.round((538 + 538 * 2) / 2));
    expect(st.body.stats.to).toBe(today);
  });

  it('alimento próprio do rótulo, favoritos, busca e isolamento entre contas', async () => {
    const a = await person('a');
    const b = await person('b');
    const f = await a.client.post('/api/v1/nutrition/foods', { name: 'Iogurte proteico', brand: 'Marca X', state: 'packaged', baseUnit: 'g', kcal: 70, protein: 10, carbs: 5, fat: 1, portionLabel: 'pote', portionAmount: 160 });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    const ref = f.body.food.ref;
    expect((await a.client.post('/api/v1/nutrition/foods', { name: 'Errado', baseUnit: 'g', kcal: 100, protein: 60, carbs: 50, fat: 1 })).status).toBe(422);
    expect((await a.client.post('/api/v1/nutrition/favorites', { foodRef: ref, favorite: true })).status).toBe(200);
    const s = await a.client.get('/api/v1/nutrition/foods?q=iogurte');
    expect(s.body.foods[0]).toMatchObject({ ref, favorite: true });
    const m = await meal(a.client, { kind: 'snack', items: [{ foodRef: ref, quantity: 160, portionLabel: 'pote', portionCount: 1 }] });
    expect(m.day.consumed).toMatchObject({ kcal: 112, protein: 16 });
    // Outra conta: não vê, não usa, não edita.
    expect((await b.client.get(`/api/v1/nutrition/foods/${ref}`)).status).toBe(404);
    expect((await b.client.post('/api/v1/nutrition/meals', lunch({ items: [{ foodRef: ref, quantity: 100 }] }))).status).toBe(422);
    expect((await b.client.req('PATCH', `/api/v1/nutrition/meals/${m.id}`, { patch: { time: '10:00' } })).status).toBe(404);
    expect((await b.client.req('DELETE', `/api/v1/nutrition/meals/${m.id}`)).status).toBe(404);
    expect((await b.client.get(`/api/v1/nutrition/days/${today}`)).body.day.meals).toHaveLength(0);
    expect((await b.client.get('/api/v1/nutrition/foods?q=iogurte')).body.foods.some((x: any) => x.ref === ref)).toBe(false);
    // Corrigir o alimento não muda o histórico já registrado (cópia dos valores).
    const id = ref.slice(7);
    expect((await a.client.req('PATCH', `/api/v1/nutrition/foods/${id}`, { patch: { kcal: 90 } })).status).toBe(200);
    expect((await a.client.get(`/api/v1/nutrition/days/${today}`)).body.day.consumed.kcal).toBe(112);
    // Arquivado não entra em registros novos.
    await a.client.req('PATCH', `/api/v1/nutrition/foods/${id}`, { patch: { archived: true } });
    expect((await a.client.post('/api/v1/nutrition/meals', lunch({ items: [{ foodRef: ref, quantity: 100 }] }))).status).toBe(422);
  });

  it('metas, estimativa (só calcula) e água', async () => {
    const { client: c } = await person();
    const est = await c.post('/api/v1/nutrition/goals/estimate', { objective: 'maintenance', sex: 'male', age: 30, weightKg: 80, heightCm: 180, activity: 'light' });
    expect(est.status).toBe(200);
    expect((await c.get('/api/v1/nutrition/goals')).body.goals).toBeNull();
    const g = await c.req('PATCH', '/api/v1/nutrition/goals', { goals: { objective: 'maintenance', kcal: est.body.estimate.kcal, protein: 130, carbs: 300, fat: 70, waterMl: 2800, preferences: 'Sem lactose', mealTimes: { lunch: '12:00' } } });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.goals).toMatchObject({ objective: 'maintenance', protein: 130, preferences: 'Sem lactose', version: 1 });
    expect((await c.req('PATCH', '/api/v1/nutrition/goals', { goals: { objective: 'maintenance', kcal: 500 } })).status).toBe(422);
    const w = await c.post(`/api/v1/nutrition/days/${today}/water`, { ml: 750 });
    expect(w.body.day.water).toEqual({ ml: 750, goalMl: 2800 });
    expect((await c.post(`/api/v1/nutrition/days/${addDays(today, 1)}/water`, { ml: 500 })).status).toBe(422);
  });
});

describe('integração com o RPG', () => {
  it('XP pelo registro do diário uma vez por dia, com estorno, e água', async () => {
    const { client: c, account } = await person();
    const before = await totalXp(account.id);
    const a = await meal(c, { kind: 'breakfast', items: [{ foodRef: 'taco:53', quantity: 50 }] });
    expect(a.outcome.xpGained).toBe(0); // 1 refeição: ainda não
    const b = await meal(c);
    expect(b.outcome.xpGained).toBe(NUTRITION_REWARD.diaryDay);
    expect(b.day.diary).toMatchObject({ consumedMeals: 2, rewarded: true });
    const c3 = await meal(c, { kind: 'dinner' });
    expect(c3.outcome.xpGained).toBe(0); // terceira refeição não soma de novo
    // Editar não gera de novo.
    const m = c3.day.meals.find((x: any) => x.kind === 'dinner');
    expect((await c.req('PATCH', `/api/v1/nutrition/meals/${m.id}`, { patch: { time: '21:00' } })).body.outcome.xpGained).toBe(0);
    // Excluir até ficar abaixo do mínimo estorna; registrar de novo concede de novo (uma concessão ativa por vez).
    await c.req('DELETE', `/api/v1/nutrition/meals/${m.id}`);
    const del = await c.req('DELETE', `/api/v1/nutrition/meals/${b.id}`);
    expect(del.body.outcome.xpReverted).toBe(NUTRITION_REWARD.diaryDay);
    const again = await meal(c);
    expect(again.outcome.xpGained).toBe(NUTRITION_REWARD.diaryDay);
    const g = await grants(account.id, 'nutrition:day:%');
    expect(g.filter((x: any) => x.kind === 'grant' && !x.reversed_at)).toHaveLength(1);
    // Água: primeira anotação do dia.
    const w1 = await c.post(`/api/v1/nutrition/days/${today}/water`, { ml: 250 });
    expect(w1.body.outcome.xpGained).toBe(NUTRITION_REWARD.water);
    expect((await c.post(`/api/v1/nutrition/days/${today}/water`, { ml: 500 })).body.outcome.xpGained).toBe(0);
    expect(await totalXp(account.id)).toBeGreaterThanOrEqual(before + NUTRITION_REWARD.diaryDay + NUTRITION_REWARD.water);
    // Planejar não rende XP.
    const { client: c2, account: acc2 } = await person();
    await meal(c2, { status: 'planned' });
    await meal(c2, { status: 'planned', kind: 'dinner' });
    expect(await grants(acc2.id)).toHaveLength(0);
  });

  it('dias antigos não rendem XP; o registro continua valendo', async () => {
    const { client: c, account } = await person();
    const old = addDays(today, -5);
    await meal(c, { date: old });
    const r = await meal(c, { date: old, kind: 'dinner' });
    expect(r.outcome.xpGained).toBe(0);
    expect(r.day.diary.rewardAllowed).toBe(false);
    expect(await grants(account.id)).toHaveLength(0);
  });

  it('hábito de alimentação vinculado: o registro conclui o hábito sem XP em dobro', async () => {
    const { client: c, account } = await person();
    const h = await c.post('/api/v1/life/habits', { name: 'Registrar alimentação', attribute: 'health', tag: 'nutrition', icon: 'apple', frequency: 'daily', goalKind: 'check', goalTarget: 1, xp: 10 });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    await meal(c, { kind: 'breakfast' });
    const r = await meal(c);
    expect(r.outcome.xpGained).toBe(10); // só o XP do hábito
    const habits = (await c.get('/api/v1/life/habits')).body.habits;
    expect(habits.find((x: any) => x.id === h.body.id).today.completed).toBe(true);
    const g = await grants(account.id, 'nutrition:day:%');
    expect(g[0]).toMatchObject({ amount: 0, source_id: h.body.id });
    // Desfazer o registro devolve o hábito para aberto e estorna o XP do hábito.
    const del = await c.req('DELETE', `/api/v1/nutrition/meals/${r.id}`);
    expect(del.body.outcome.xpReverted).toBe(10);
    expect((await c.get('/api/v1/life/habits')).body.habits.find((x: any) => x.id === h.body.id).today.completed).toBe(false);
  });

  it('missão semanal de diário alimentar e teto diário compartilhado', async () => {
    const { client: c, account } = await person();
    await c.req('PATCH', '/api/v1/nutrition/goals', { goals: { objective: 'organization' } });
    const ms = (await c.get('/api/v1/life/missions')).body.missions;
    const mission = ms.find((m: any) => m.template === 'weekly_nutrition' || m.title.startsWith('Registrar a alimentação'));
    expect(mission).toBeTruthy();
    expect(mission.target).toBe(NUTRITION_REWARD.weeklyDays);
    await meal(c, { kind: 'breakfast' });
    await meal(c);
    const after = (await c.get('/api/v1/life/missions')).body.missions.find((m: any) => m.id === mission.id);
    expect(after.progress).toBe(1);
    // Teto diário: o XP de registro respeita o limite (400) somado a outras fontes.
    await env.pool.query("UPDATE life_xp_events SET amount = 400, requested = 400 WHERE user_id = $1 AND source_key LIKE 'nutrition:day:%'", [account.id]);
    const w = await c.post(`/api/v1/nutrition/days/${today}/water`, { ml: 300 });
    expect(w.body.outcome.xpGained).toBe(0);
    expect(w.body.outcome.events[0]).toMatchObject({ capped: true });
  });
});

describe('rascunho para revisão (base da foto na Fase 03)', () => {
  it('resolve descrições em sugestões com aviso de preparo', async () => {
    const { client: c } = await person();
    const r = await c.post('/api/v1/nutrition/drafts/resolve', { items: [{ label: 'arroz', quantity: 150 }, { label: 'peito de frango grelhado', quantity: 160 }, { label: 'xyzabc' }] });
    expect(r.status).toBe(200);
    expect(r.body.items[0].match.ref).toBe(RICE);
    expect(r.body.items[0].warning).toContain('Confira o preparo');
    expect(r.body.items[1].match.ref).toBe(CHICKEN);
    expect(r.body.items[2].match).toBeNull();
  });
});
