// Assistente IA central + alimentação (Fase 02): OpenAI SIMULADA (nenhuma chamada real ou paga), PostgreSQL real.
// Cobre: ferramentas de leitura com dados reais (diário, totais, metas, planejamento), propostas com prévia e aprovação
// (adicionar ao almoço, planejamento semanal, metas, alimento do rótulo), nada gravado antes da aprovação, XP de
// registro só pelo motor (uma vez), desfazer, versão desatualizada e isolamento entre contas.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, setupApi, signup, uuid4, type TestEnv } from './helpers.ts';
import type { FetchLike } from '../../ai-gateway/src/providers/types.ts';

const KEY = 'sk-proj-chave-de-teste-0123456789abcdef';
const BASE = 'http://openai.invalid';

type Call = { name: string; args: unknown };
type Plan = (body: any, n: number) => { text?: string; calls?: Call[]; status?: number; errorType?: string };

/** OpenAI simulada: devolve SSE no formato da Responses API e guarda os corpos recebidos. */
class FakeOpenAI {
  plan: Plan = () => ({ text: 'Olá!' });
  bodies: any[] = [];
  headers: Record<string, string>[] = [];
  urls: string[] = [];
  fetch: FetchLike = async (url, init) => {
    this.urls.push(url);
    this.headers.push(init.headers);
    if (init.method === 'GET') return new Response(JSON.stringify({ id: 'x', object: 'model' }), { status: 200 });
    const body = JSON.parse(init.body!);
    this.bodies.push(body);
    const p = this.plan(body, this.bodies.length);
    if (p.status) return new Response(JSON.stringify({ error: { type: p.errorType ?? 'x', message: 'falhou' } }), { status: p.status });
    const events: unknown[] = [{ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }];
    const output: unknown[] = [];
    if (p.calls) {
      output.push({ type: 'reasoning', id: 'rs_1', encrypted_content: 'cifrado', summary: [] });
      p.calls.forEach((c, i) => output.push({ type: 'function_call', id: `fc_${i}`, call_id: `call_${this.bodies.length}_${i}`, name: c.name, arguments: JSON.stringify(c.args) }));
    }
    if (p.text) {
      const half = Math.ceil(p.text.length / 2);
      events.push({ type: 'response.output_text.delta', delta: p.text.slice(0, half) }, { type: 'response.output_text.delta', delta: p.text.slice(half) });
      output.push({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: p.text }] });
    }
    events.push({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20 } } });
    return new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  /** Saídas de ferramentas que o "modelo" recebeu na última chamada. */
  toolOutputs(body = this.bodies[this.bodies.length - 1]): any[] {
    return (body.input as any[]).filter((i) => i.type === 'function_call_output').map((i) => JSON.parse(i.output));
  }
}

const fake = new FakeOpenAI();
const BASE_CONFIG = (await import('../config/assistant.json', { with: { type: 'json' } })).default;
const assistantEnv = (over: Record<string, unknown> = {}) => ({ OPENAI_API_KEY: KEY, ASSISTANT_CONFIG_JSON: JSON.stringify({ ...BASE_CONFIG, baseUrl: BASE, ...over }) });
let env: TestEnv;
beforeAll(async () => {
  env = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { serviceEnv: assistantEnv(), assistant: { fetch: fake.fetch } });
});
afterAll(async () => {
  await env?.close();
});
beforeEach(() => {
  fake.bodies = [];
  fake.headers = [];
  fake.urls = [];
});

interface Ev {
  type: string;
  [k: string]: any;
}

async function send(c: Client, conv: string, content: string, extra: Record<string, unknown> = {}): Promise<{ status: number; events: Ev[]; json?: any }> {
  const r = await fetch(`${env.base}/api/v1/assistant/conversations/${conv}/messages`, {
    method: 'POST',
    headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-irontrack-csrf': '1', origin: 'http://localhost:4173', 'x-forwarded-for': c.ip },
    body: JSON.stringify({ content, timezone: 'America/Sao_Paulo', ...extra }),
  });
  const text = await r.text();
  if (!(r.headers.get('content-type') ?? '').startsWith('text/event-stream')) return { status: r.status, events: [], json: JSON.parse(text) };
  const events = text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as Ev);
  return { status: r.status, events };
}

async function ready(tag = 'nut-ia') {
  const s = await signup(env, 'Pessoa Teste', `${tag}.${uuid4().slice(0, 8)}@exemplo.test`);
  expect((await s.client.post('/api/v1/assistant/notice', { version: 1 })).status).toBe(200);
  expect((await s.client.get('/api/v1/life/dashboard?tz=America%2FSao_Paulo')).status).toBe(200);
  return s;
}

/** Turno em que o "modelo" chama `name(args)` e depois responde com texto. */
async function callTool(c: Client, name: string, args: unknown, conv = 'new') {
  const start = fake.bodies.length;
  fake.plan = (_b, n) => (n === start + 1 ? { calls: [{ name, args }] } : { text: 'Pronto.' });
  const r = await send(c, conv, 'pedido');
  return { ...r, output: fake.toolOutputs()[0]?.data ?? fake.toolOutputs()[0], proposal: r.events.find((e) => e.type === 'proposal')?.action };
}

const xpTotal = async (userId: string) => Number((await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [userId])).rows[0].total_xp);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const plus = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const day = async (c: Client, date = today) => (await c.get(`/api/v1/nutrition/days/${date}`)).body.day;

describe('IA central × alimentação', () => {
  it('ferramentas registradas e leitura dos registros reais', async () => {
    const { client } = await ready();
    await client.post('/api/v1/nutrition/meals', { date: today, kind: 'lunch', status: 'consumed', items: [{ foodRef: 'taco:3', quantity: 150 }, { foodRef: 'taco:410', quantity: 160 }] });
    await client.post('/api/v1/nutrition/meals', { date: plus(1), kind: 'lunch', status: 'planned', items: [{ foodRef: 'taco:3', quantity: 100 }] });
    await client.req('PATCH', '/api/v1/nutrition/goals', { goals: { objective: 'muscle_gain', kcal: 2600, protein: 150, preferences: 'Sem lactose' } });
    fake.plan = (_b, n) => (n === 1 ? { calls: [{ name: 'get_food_diary', args: {} }, { name: 'get_nutrition_totals', args: {} }, { name: 'get_nutrition_goals', args: {} }, { name: 'get_meal_plan', args: {} }, { name: 'compare_nutrition_goals', args: {} }, { name: 'search_foods', args: { query: 'arroz' } }] } : { text: 'ok' });
    await send(client, 'new', 'O que eu comi hoje?');
    const names = (fake.bodies[0].tools as any[]).map((t) => t.name);
    for (const n of ['get_food_diary', 'list_recent_meals', 'search_foods', 'get_nutrition_goals', 'get_meal_plan', 'get_nutrition_totals', 'compare_nutrition_goals', 'propose_create_meal', 'propose_add_foods_to_meal', 'propose_update_meal', 'propose_create_food', 'propose_update_nutrition_goals', 'propose_create_meal_plan', 'propose_update_meal_plan']) expect(names).toContain(n);
    expect(names.some((n) => /sql|query_db|xp|grant/i.test(n))).toBe(false);
    const [diary, totals, goals, plan, cmp, search] = fake.toolOutputs().map((o) => o.data);
    expect(diary.days[today].consumed[0].totals.kcal).toBe(Math.round(192 + 254.4));
    expect(diary.days[today].planned).toHaveLength(0);
    expect(totals.loggedDays).toBe(1);
    expect(totals.totalInLoggedDays.p).toBeCloseTo(3.75 + 51.2, 0);
    expect(goals.goals).toMatchObject({ protein: 150, preferences: 'Sem lactose' });
    expect(plan.planned[0]).toMatchObject({ date: plus(1), status: 'planned' });
    expect(cmp.averageVsGoal.protein).toBe(Math.round(3.75 + 51.2 - 150));
    expect(search.foods[0].foodRef).toBe('taco:3');
    expect(fake.bodies[0].instructions).toMatch(/não são consumo|PLANEJADAS não são consumo/);
    expect(fake.bodies[0].instructions).toMatch(/restrição extrema/);
  });

  it('"adicione no meu almoço 150 g de arroz, 120 g de feijão e 160 g de frango": prévia, aprovação, XP pelo motor e desfazer', async () => {
    const { client, account } = await ready();
    await client.post('/api/v1/nutrition/meals', { date: today, kind: 'breakfast', status: 'consumed', items: [{ foodRef: 'taco:53', quantity: 50 }] });
    const before = await xpTotal(account.id);
    const r = await callTool(client, 'propose_add_foods_to_meal', { kind: 'lunch', items: [{ food: 'arroz', quantity: 150 }, { foodRef: 'taco:561', quantity: 120 }, { food: 'peito de frango grelhado', quantity: 160 }] });
    expect(r.proposal, JSON.stringify(r.output)).toMatchObject({ kind: 'add_meal_items', status: 'pending' });
    const text = JSON.stringify(r.proposal.preview);
    expect(text).toContain('Arroz, tipo 1, cozido');
    expect(text).toContain('Confira o preparo');
    expect(text).toContain('538 kcal');
    // Nada gravado antes da aprovação.
    expect((await day(client)).meals).toHaveLength(1);
    const ok = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.action).toMatchObject({ status: 'applied', undoable: true, result: { collection: 'meals' } });
    const d = await day(client);
    expect(d.consumed.kcal).toBe(538 + 150);
    // XP de registro do diário: só uma vez, pelo motor (2 refeições consumidas).
    expect(await xpTotal(account.id)).toBe(before + 15);
    // Desfazer remove o almoço e estorna.
    const u = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect((await day(client)).meals).toHaveLength(1);
    expect(await xpTotal(account.id)).toBe(before);
  });

  it('acrescentar a uma refeição existente; versão desatualizada recusa', async () => {
    const { client } = await ready();
    const m = await client.post('/api/v1/nutrition/meals', { date: today, kind: 'lunch', status: 'consumed', items: [{ foodRef: 'taco:3', quantity: 100 }] });
    const r = await callTool(client, 'propose_add_foods_to_meal', { kind: 'lunch', items: [{ foodRef: 'taco:561', quantity: 100 }] });
    expect(r.proposal.preview[0].title).toMatch(/acrescentar/);
    // A pessoa edita antes de aprovar → desatualizada.
    await client.req('PATCH', `/api/v1/nutrition/meals/${m.body.id}`, { patch: { time: '12:00' } });
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).body.error.code).toBe('action_stale');
    const r2 = await callTool(client, 'propose_add_foods_to_meal', { kind: 'lunch', items: [{ foodRef: 'taco:561', quantity: 100 }] });
    expect((await client.post(`/api/v1/assistant/actions/${r2.proposal.id}/approve`)).status).toBe(200);
    const d = await day(client);
    expect(d.meals).toHaveLength(1);
    expect(d.meals[0].items.map((i: any) => i.foodRef)).toEqual(['taco:3', 'taco:561']);
    expect((await client.post(`/api/v1/assistant/actions/${r2.proposal.id}/undo`)).status).toBe(200);
    expect((await day(client)).meals[0].items).toHaveLength(1);
  });

  it('planejamento semanal: só planejado (nada consumido), ajuste e desfazer', async () => {
    const { client, account } = await ready();
    const meals = [1, 2, 3].flatMap((n) => [
      { date: plus(n), kind: 'lunch', time: '12:30', items: [{ foodRef: 'taco:3', quantity: 150 }, { foodRef: 'taco:410', quantity: 150 }] },
      { date: plus(n), kind: 'dinner', time: '20:00', items: [{ food: 'ovo cozido', quantity: 100 }] },
    ]);
    const r = await callTool(client, 'propose_create_meal_plan', { meals, rationale: 'Com base no que você costuma comer.' });
    expect(r.proposal, JSON.stringify(r.output)).toMatchObject({ kind: 'create_meal_plan' });
    expect(r.proposal.preview.length).toBeGreaterThanOrEqual(3);
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).status).toBe(200);
    const d1 = await day(client, plus(1));
    expect(d1.consumed.kcal).toBe(0);
    expect(d1.meals.every((m: any) => m.status === 'planned')).toBe(true);
    expect(await xpTotal(account.id)).toBe(0);
    // Ajustar: remover o jantar do dia 1 e trocar o horário do almoço do dia 2.
    const plan = (await client.get(`/api/v1/nutrition/meals?from=${plus(1)}&to=${plus(3)}`)).body.meals;
    const dinner1 = plan.find((m: any) => m.date === plus(1) && m.kind === 'dinner');
    const lunch2 = plan.find((m: any) => m.date === plus(2) && m.kind === 'lunch');
    const up = await callTool(client, 'propose_update_meal_plan', { remove: [dinner1.id], update: [{ mealId: lunch2.id, time: '13:00' }] });
    expect(up.proposal, JSON.stringify(up.output)).toMatchObject({ kind: 'update_meal_plan' });
    expect((await client.post(`/api/v1/assistant/actions/${up.proposal.id}/approve`)).status).toBe(200);
    expect((await day(client, plus(1))).meals).toHaveLength(1);
    expect((await day(client, plus(2))).meals.find((m: any) => m.kind === 'lunch').time).toBe('13:00');
    const und = await client.post(`/api/v1/assistant/actions/${up.proposal.id}/undo`);
    expect(und.status, JSON.stringify(und.body)).toBe(200);
    expect((await day(client, plus(1))).meals).toHaveLength(2);
    expect((await day(client, plus(2))).meals.find((m: any) => m.kind === 'lunch').time).toBe('12:30');
    // O planejamento original mudou depois (ajuste aplicado e desfeito): desfazer o plano inteiro é recusado.
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`)).body.error.code).toBe('action_undo_stale');
    // Um plano novo, sem mudanças posteriores, é desfeito por inteiro.
    const r2 = await callTool(client, 'propose_create_meal_plan', { meals: [{ date: plus(5), kind: 'lunch', items: [{ foodRef: 'taco:3', quantity: 150 }] }] });
    expect((await client.post(`/api/v1/assistant/actions/${r2.proposal.id}/approve`)).status).toBe(200);
    expect((await day(client, plus(5))).meals).toHaveLength(1);
    expect((await client.post(`/api/v1/assistant/actions/${r2.proposal.id}/undo`)).status).toBe(200);
    expect((await day(client, plus(5))).meals).toHaveLength(0);
  });

  it('metas e alimento do rótulo por proposta; meta extrema recusada', async () => {
    const { client } = await ready();
    const bad = await callTool(client, 'propose_update_nutrition_goals', { changes: { objective: 'fat_loss', kcal: 900 } });
    expect(bad.proposal).toBeUndefined();
    const g = await callTool(client, 'propose_update_nutrition_goals', { changes: { objective: 'fat_loss', kcal: 2000, protein: 140, preferences: 'Não como carne de porco' } });
    expect(g.proposal, JSON.stringify(g.output)).toMatchObject({ kind: 'update_nutrition_goals' });
    expect((await client.get('/api/v1/nutrition/goals')).body.goals).toBeNull();
    expect((await client.post(`/api/v1/assistant/actions/${g.proposal.id}/approve`)).status).toBe(200);
    expect((await client.get('/api/v1/nutrition/goals')).body.goals).toMatchObject({ objective: 'fat_loss', kcal: 2000, origin: 'ai' });
    expect((await client.post(`/api/v1/assistant/actions/${g.proposal.id}/undo`)).status).toBe(200);
    expect((await client.get('/api/v1/nutrition/goals')).body.goals).toBeNull();
    const f = await callTool(client, 'propose_create_food', { food: { name: 'Pão de queijo congelado', brand: 'Marca Y', baseUnit: 'g', state: 'packaged', kcal: 290, protein: 6, carbs: 35, fat: 14, sourceNote: 'rótulo informado pela pessoa' } });
    expect(f.proposal, JSON.stringify(f.output)).toMatchObject({ kind: 'create_food' });
    expect((await client.post(`/api/v1/assistant/actions/${f.proposal.id}/approve`)).status).toBe(200);
    expect((await client.get('/api/v1/nutrition/foods?q=pao de queijo')).body.foods[0]).toMatchObject({ name: 'Pão de queijo congelado', source: { kind: 'custom' } });
  });

  it('marcar planejada como consumida por proposta e isolamento entre contas', async () => {
    const a = await ready('a');
    const b = await ready('b');
    const m = await a.client.post('/api/v1/nutrition/meals', { date: today, kind: 'dinner', status: 'planned', items: [{ foodRef: 'taco:3', quantity: 100 }] });
    const other = await callTool(b.client, 'propose_update_meal', { mealId: m.body.id, changes: { markConsumed: true } });
    expect(other.proposal).toBeUndefined();
    expect(other.output.error).toMatch(/não encontrada/);
    const start = fake.bodies.length;
    fake.plan = (_b, n) => (n === start + 1 ? { calls: [{ name: 'get_food_diary', args: {} }] } : { text: 'ok' });
    await send(b.client, 'new', 'o que comi?');
    expect(Object.keys(fake.toolOutputs()[0].data.days)).toHaveLength(0);
    const r = await callTool(a.client, 'propose_update_meal', { mealId: m.body.id, changes: { markConsumed: true, items: [{ foodRef: 'taco:3', quantity: 120 }] } });
    expect((await a.client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).status).toBe(200);
    const d = await day(a.client);
    expect(d.meals[0]).toMatchObject({ status: 'consumed', plannedTotals: { kcal: 128 } });
    expect(d.consumed.kcal).toBe(Math.round(128 * 1.2));
    expect((await a.client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`)).status).toBe(200);
    expect((await day(a.client)).meals[0]).toMatchObject({ status: 'planned', totals: { kcal: 128 } });
  });
});
