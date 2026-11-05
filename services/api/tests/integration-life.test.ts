// Integração Life (Fase 06): PostgreSQL real e OpenAI SIMULADA (nenhuma chamada real ou paga).
// Cobre o essencial: agenda unificada a partir dos registros (sem cópias), situação vinda do registro (nunca do relógio),
// conflitos e carga, ajustes, idempotência, fuso da conta, isolamento entre contas, Minha Evolução determinística,
// IA consultando vários módulos na mesma conversa, plano multimódulo (prévia, edição, aprovação, parcial, nova
// tentativa, desfazer, sem duplicar, sem XP) e preferências confirmadas × inferidas.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findConflicts } from '../../../shared/planner/protocol.ts';
import { applyPush } from '../src/modules/sync.ts';
import { setupApi, signup, uuid4, type Client, type TestEnv } from './helpers.ts';
import type { FetchLike } from '../../ai-gateway/src/providers/types.ts';

const KEY = 'sk-proj-chave-de-teste-0123456789abcdef';
type Call = { name: string; args: unknown };
type Plan = (body: any, n: number) => { text?: string; calls?: Call[] };

class FakeOpenAI {
  plan: Plan = () => ({ text: 'Olá!' });
  bodies: any[] = [];
  fetch: FetchLike = async (_url, init) => {
    if (init.method === 'GET') return new Response(JSON.stringify({ id: 'x', object: 'model' }), { status: 200 });
    const body = JSON.parse(init.body!);
    this.bodies.push(body);
    const p = this.plan(body, this.bodies.length);
    const output: unknown[] = [];
    const events: unknown[] = [{ type: 'response.created', response: { id: 'r', status: 'in_progress' } }];
    p.calls?.forEach((c, i) => output.push({ type: 'function_call', id: `fc_${i}`, call_id: `call_${this.bodies.length}_${i}`, name: c.name, arguments: JSON.stringify(c.args) }));
    if (p.text) {
      events.push({ type: 'response.output_text.delta', delta: p.text });
      output.push({ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: p.text }] });
    }
    events.push({ type: 'response.completed', response: { id: 'r', status: 'completed', output, usage: { input_tokens: 50, output_tokens: 10 } } });
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  toolOutputs(body = this.bodies[this.bodies.length - 1]): any[] {
    return (body.input as any[]).filter((i) => i.type === 'function_call_output').map((i) => JSON.parse(i.output));
  }
}

const fake = new FakeOpenAI();
const BASE_CONFIG = (await import('../config/assistant.json', { with: { type: 'json' } })).default;
// Quarta-feira, 04/11/2026, 12:00 em São Paulo (15:00 UTC) = 00:00 de quinta em Tóquio.
const clock = Date.parse('2026-11-04T15:00:00Z');
const TODAY = '2026-11-04';
const MON = '2026-11-02';
let env: TestEnv;
beforeAll(async () => {
  env = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { lifeNow: () => clock, serviceEnv: { OPENAI_API_KEY: KEY, ASSISTANT_CONFIG_JSON: JSON.stringify({ ...BASE_CONFIG, baseUrl: 'http://openai.invalid' }) }, assistant: { fetch: fake.fetch, now: () => clock } });
});
afterAll(async () => {
  await env?.close();
});
beforeEach(() => {
  fake.bodies = [];
});

async function person(tag: string, tz = 'America/Sao_Paulo') {
  const s = await signup(env, 'Pessoa Integração', `${tag}.${uuid4().slice(0, 8)}@exemplo.test`);
  expect((await s.client.get(`/api/v1/life/dashboard?tz=${encodeURIComponent(tz)}`)).status).toBe(200);
  expect((await s.client.post('/api/v1/assistant/notice', { version: 1 })).status).toBe(200);
  return s;
}

async function send(c: Client, conv: string, content: string) {
  const r = await fetch(`${env.base}/api/v1/assistant/conversations/${conv}/messages`, {
    method: 'POST',
    headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-irontrack-csrf': '1', origin: 'http://localhost:4173', 'x-forwarded-for': c.ip },
    body: JSON.stringify({ content, timezone: 'America/Sao_Paulo' }),
  });
  const text = await r.text();
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)) as { type: string; [k: string]: any });
}

async function callTool(c: Client, name: string, args: unknown) {
  const start = fake.bodies.length;
  fake.plan = (_b, n) => (n === start + 1 ? { calls: [{ name, args }] } : { text: 'Pronto.' });
  const events = await send(c, 'new', 'pedido');
  return { events, output: fake.toolOutputs()[0], proposal: events.find((e) => e.type === 'proposal')?.action };
}

const week = async (c: Client, start = MON) => (await c.get(`/api/v1/planner/week?start=${start}`)).body;
const day = (w: any, date: string) => w.days.find((d: any) => d.date === date);
const xpOf = async (userId: string) => (await env.pool.query('SELECT coalesce(sum(amount),0)::int AS n FROM life_xp_events WHERE user_id = $1', [userId])).rows[0].n;

describe('Minha Semana: agenda unificada', () => {
  it('reúne registros de vários módulos sem copiar nada; situação vem do registro, não do relógio', async () => {
    const { client, account } = await person('ag');
    const h = (await client.post('/api/v1/life/habits', { name: 'Caminhar', attribute: 'health', tag: 'other', icon: 'check', frequency: 'daily', goalKind: 'check', goalTarget: 1, xp: 10, preferredTime: '07:00' })).body.id;
    const r = await client.post('/api/v1/life/routines', { name: 'Noite', kind: 'night', items: [{ title: 'Preparar a mochila', startTime: '21:00', durationMin: 10 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const meal = await client.post('/api/v1/nutrition/meals', { date: '2026-11-05', kind: 'lunch', status: 'planned', time: '12:30', items: [{ foodRef: 'taco:3', quantity: 150 }] });
    expect(meal.status, JSON.stringify(meal.body)).toBe(201);
    const g = await client.post('/api/v1/knowledge/goals', { metric: 'minutes', scope: 'reading', period: 'daily', target: 20, preferredTime: '22:00' });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const before = Number((await env.pool.query('SELECT count(*)::int AS n FROM life_habits WHERE user_id = $1', [account.id])).rows[0].n);

    let w = await week(client);
    expect(w.timezone).toBe('America/Sao_Paulo');
    expect(w.today).toBe(TODAY);
    expect(w.days).toHaveLength(7);
    const thu = day(w, '2026-11-05');
    const cats = new Set(thu.items.map((i: any) => i.category));
    for (const c of ['habit', 'routine', 'meal', 'reading']) expect(cats).toContain(c);
    const lunch = thu.items.find((i: any) => i.category === 'meal');
    expect(lunch).toMatchObject({ status: 'planned', statusSource: 'plan', startTime: '12:30' });
    // Hábito de ontem (07:00 já passou) continua planejado: nada é concluído pelo relógio.
    const tueWalk = day(w, '2026-11-03').items.find((i: any) => i.key === `habit:${h}`);
    expect(tueWalk).toBeUndefined(); // hábito criado hoje: não aparece antes do início
    const todayWalk = day(w, TODAY).items.find((i: any) => i.key === `habit:${h}`);
    expect(todayWalk.status).toBe('planned');
    // Registrar o hábito → concluído (vem do registro).
    await client.post(`/api/v1/life/habits/${h}/log`, { amount: 1 });
    w = await week(client);
    expect(day(w, TODAY).items.find((i: any) => i.key === `habit:${h}`)).toMatchObject({ status: 'done', statusSource: 'record' });
    // Consultar a agenda não cria nem copia registros.
    expect(Number((await env.pool.query('SELECT count(*)::int AS n FROM life_habits WHERE user_id = $1', [account.id])).rows[0].n)).toBe(before);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM planner_items WHERE user_id = $1', [account.id])).rows[0].n).toBe(0);
  });

  it('treino planejado × realizado (P13 + sessão sincronizada) e plano bíblico com previsão diária', async () => {
    const { client, account } = await person('tr');
    const dev = uuid4();
    const routine = { id: 'r1', name: 'ABC', workouts: [{ id: 'wA', label: 'A', name: 'Peito', exercises: [] }, { id: 'wB', label: 'B', name: 'Costas', exercises: [] }] };
    const entry = (id: string, weekday: number, workoutId: string) => ({ id, scope: 'weekly', weekday, date: null, kind: 'workout', routineId: 'r1', workoutId, enabled: true, validFrom: '2026-10-01', validUntil: null, createdAt: 1, updatedAt: 1, revision: 1 });
    const at = Date.parse('2026-11-04T10:00:00Z'); // 07:00 em São Paulo, quarta
    const session = { id: 'sess1', routineId: 'r1', workoutId: 'wA', workoutLabel: 'A', workoutName: 'Peito', status: 'completed', startedAt: at, finishedAt: at + 3_000_000, updatedAt: 1, exercises: [{ id: 'x', name: 'Supino', sets: [{ id: 's', type: 'normal', status: 'done', weight: 60, reps: 8 }] }] };
    const ops = [
      { opId: uuid4(), collection: 'routines', entityId: 'r1', kind: 'put', baseVersion: 0, doc: routine },
      { opId: uuid4(), collection: 'planEntries', entityId: 'pe-wed', kind: 'put', baseVersion: 0, doc: entry('pe-wed', 3, 'wA') },
      { opId: uuid4(), collection: 'planEntries', entityId: 'pe-fri', kind: 'put', baseVersion: 0, doc: entry('pe-fri', 5, 'wB') },
      { opId: uuid4(), collection: 'sessions', entityId: 'sess1', kind: 'put', baseVersion: 0, doc: session },
    ];
    const res = await applyPush(env.pool, account.id, dev, ops as never);
    expect(res.every((r: any) => r.status === 'applied'), JSON.stringify(res)).toBe(true);
    const bp = await client.post('/api/v1/bible/plans?tz=America%2FSao_Paulo', { books: ['RUT'], days: 4, title: 'Rute' });
    expect(bp.status, JSON.stringify(bp.body)).toBe(201);
    const w = await week(client);
    expect(day(w, TODAY).items.find((i: any) => i.key === 'workout:pe-wed')).toMatchObject({ status: 'done', statusSource: 'record', startTime: '07:00', link: '/historico/sess1' });
    expect(day(w, '2026-11-06').items.find((i: any) => i.key === 'workout:pe-fri')).toMatchObject({ status: 'planned', title: 'Treino B · Costas' });
    const bible = w.days.flatMap((d: any) => d.items.filter((i: any) => i.category === 'bible'));
    expect(bible.map((i: any) => i.date)).toEqual([TODAY, '2026-11-05', '2026-11-06', '2026-11-07']); // 4 dias de plano, um por dia, de hoje em diante
    expect(bible.every((i: any) => i.status === 'planned')).toBe(true);
    const t = (await client.get('/api/v1/planner/today')).body;
    expect(t.workout).toMatchObject({ status: 'done', title: 'Treino A · Peito' });
    expect(t.nextStudy).toMatchObject({ category: 'bible', status: 'planned' });
  });

  it('atividades personalizadas: idempotentes, conflitos, carga, ajustes e "não realizado" sem esconder registro', async () => {
    const { client, account } = await person('cu');
    const xp0 = await xpOf(account.id);
    const cid = uuid4();
    const a = await client.post('/api/v1/planner/items', { clientId: cid, date: '2026-11-06', startTime: '19:00', durationMin: 60, title: 'Estudar inglês', category: 'study' });
    const again = await client.post('/api/v1/planner/items', { clientId: cid, date: '2026-11-06', startTime: '19:00', durationMin: 60, title: 'Estudar inglês', category: 'study' });
    expect([a.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(a.body.id);
    await client.post('/api/v1/planner/items', { clientId: uuid4(), date: '2026-11-06', startTime: '19:30', durationMin: 45, title: 'Academia', category: 'workout' });
    let fri = day(await week(client), '2026-11-06');
    expect(fri.conflicts).toHaveLength(1);
    expect(fri.conflicts[0].overlapMin).toBe(30);
    // Mover o estudo resolve o conflito.
    const item = fri.items.find((i: any) => i.title === 'Estudar inglês');
    expect((await client.req('PATCH', `/api/v1/planner/items/${a.body.id}`, { version: item.version, patch: { startTime: '20:30' } })).status).toBe(200);
    expect((await client.req('PATCH', `/api/v1/planner/items/${a.body.id}`, { version: item.version, patch: { startTime: '21:00' } })).status).toBe(409); // versão antiga
    fri = day(await week(client), '2026-11-06');
    expect(fri.conflicts).toHaveLength(0);
    // Concluir atividade personalizada não gera XP.
    await client.req('PATCH', `/api/v1/planner/items/${a.body.id}`, { patch: { status: 'done' } });
    expect(await xpOf(account.id)).toBe(xp0);

    // Item derivado: mover horário e marcar "não realizado" (ajuste), sem tocar o registro de origem.
    const h = (await client.post('/api/v1/life/habits', { name: 'Alongar', attribute: 'health', tag: 'other', icon: 'check', frequency: 'daily', goalKind: 'check', goalTarget: 1, xp: 10, preferredTime: '06:00' })).body.id;
    expect((await client.post('/api/v1/planner/overrides', { key: `habit:${h}`, date: TODAY, startTime: '08:15' })).status).toBe(200);
    expect((await client.post('/api/v1/planner/overrides', { key: `habit:${h}`, date: TODAY, status: 'missed' })).status).toBe(200);
    let it2 = day(await week(client), TODAY).items.find((i: any) => i.key === `habit:${h}`);
    expect(it2).toMatchObject({ startTime: '08:15', status: 'missed', statusSource: 'user', adjusted: true });
    expect((await env.pool.query('SELECT preferred_time FROM life_habits WHERE id = $1', [h])).rows[0].preferred_time).toBe('06:00');
    // Se a pessoa registrar depois, o registro vence a marcação.
    await client.post(`/api/v1/life/habits/${h}/log`, { amount: 1 });
    it2 = day(await week(client), TODAY).items.find((i: any) => i.key === `habit:${h}`);
    expect(it2.status).toBe('done');
    // Reordenar o dia.
    const keys = day(await week(client), TODAY).items.map((i: any) => i.key).reverse();
    expect((await client.post('/api/v1/planner/reorder', { date: TODAY, keys })).status).toBe(200);
    expect(day(await week(client), TODAY).items.map((i: any) => i.key)).toEqual(keys);
  });

  it('fuso de cada conta e isolamento entre contas', async () => {
    const sp = await person('tz-sp');
    const tk = await person('tz-tk', 'Asia/Tokyo');
    expect((await week(sp.client)).today).toBe('2026-11-04');
    expect((await sp.client.get('/api/v1/planner/today')).body.today).toBe('2026-11-04');
    expect((await tk.client.get('/api/v1/planner/today')).body.today).toBe('2026-11-05');
    const mine = await sp.client.post('/api/v1/planner/items', { clientId: uuid4(), date: TODAY, title: 'Segredo', category: 'custom' });
    // Outra conta não vê, não altera, não apaga, nem ajusta pela chave.
    expect(JSON.stringify(await week(tk.client))).not.toContain('Segredo');
    expect((await tk.client.req('PATCH', `/api/v1/planner/items/${mine.body.id}`, { patch: { title: 'x' } })).status).toBe(404);
    expect((await tk.client.req('DELETE', `/api/v1/planner/items/${mine.body.id}`)).status).toBe(404);
    expect(JSON.stringify(await week(sp.client))).toContain('Segredo');
    expect((await new (sp.client.constructor as any)(env).get('/api/v1/planner/week')).status).toBe(401);
  });

  it('painel: layout por conta normalizado e resumo do dia', async () => {
    const { client } = await person('home');
    const l0 = (await client.get('/api/v1/planner/home-layout')).body;
    expect(l0.cards.length).toBeGreaterThan(8);
    const cards = [{ id: 'workout', visible: true }, { id: 'character', visible: false }];
    const s = await client.req('PATCH', '/api/v1/planner/home-layout', { version: l0.version, cards });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.cards[0]).toEqual({ id: 'workout', visible: true });
    expect(s.body.cards[1]).toEqual({ id: 'character', visible: false });
    expect(s.body.cards.length).toBe(l0.cards.length); // os que faltavam voltam no fim
    expect((await client.req('PATCH', '/api/v1/planner/home-layout', { version: 0, cards })).status).toBe(409);
    const t = (await client.get('/api/v1/planner/today')).body;
    expect(t.today).toBe(TODAY);
    expect(t.workout.status).toBe('none');
    expect(t.layout.cards[0].id).toBe('workout');
  });
});

describe('conflitos (função pura)', () => {
  it('sobreposição, itens sem duração, concluídos e descanso curto', () => {
    const base = { date: TODAY, status: 'planned' as const, category: 'custom' as const };
    expect(findConflicts([{ ...base, key: 'a', title: 'A', startTime: '10:00', durationMin: 60 }, { ...base, key: 'b', title: 'B', startTime: '10:59', durationMin: 10 }])).toHaveLength(1);
    expect(findConflicts([{ ...base, key: 'a', title: 'A', startTime: '10:00', durationMin: 60 }, { ...base, key: 'b', title: 'B', startTime: '11:00', durationMin: 10 }])).toHaveLength(0);
    expect(findConflicts([{ ...base, key: 'a', title: 'A', startTime: '10:00', durationMin: null }, { ...base, key: 'b', title: 'B', startTime: '10:10', durationMin: null }])).toHaveLength(1);
    expect(findConflicts([{ ...base, key: 'a', title: 'A', startTime: '10:00', durationMin: 60, status: 'done' }, { ...base, key: 'b', title: 'B', startTime: '10:10', durationMin: 30 }])).toHaveLength(0);
  });
});

describe('Minha Evolução', () => {
  it('sem registros = sem dados (não zero); com registros, números determinísticos e comparação', async () => {
    const { client } = await person('evo');
    let v = (await client.get('/api/v1/insights/evolution?period=week')).body;
    expect(v.period).toMatchObject({ from: MON, to: TODAY });
    expect(v.metrics.find((m: any) => m.id === 'workouts').value).toBeNull();
    expect(v.missing).toContain('Treinos');
    expect(v.notes.join(' ')).toMatch(/sem IA/);
    await client.post('/api/v1/nutrition/meals', { date: TODAY, kind: 'lunch', status: 'consumed', time: '12:00', items: [{ foodRef: 'taco:3', quantity: 100 }] });
    await client.post('/api/v1/knowledge/sessions', { clientId: uuid4(), kind: 'reading', label: 'Livro', date: TODAY, minutes: 25 });
    v = (await client.get('/api/v1/insights/evolution?period=week')).body;
    expect(v.metrics.find((m: any) => m.id === 'meal_days').value).toBe(1);
    expect(v.metrics.find((m: any) => m.id === 'reading_min').value).toBe(25);
    expect(v.daily.find((d: any) => d.date === TODAY)).toMatchObject({ mealsLogged: 1, knowledgeMin: 25 });
    expect(v.insights.some((i: any) => /sem dados, não com consumo zero/.test(i.text))).toBe(true);
    expect((await client.get('/api/v1/insights/evolution?period=ano')).status).toBe(422);
  });
});

describe('IA multimódulo', () => {
  it('consulta vários módulos na mesma resposta, separando registrado, planejado e sem dados', async () => {
    const { client } = await person('ia-q');
    const other = await person('ia-q-outra');
    await other.client.post('/api/v1/knowledge/sessions', { clientId: uuid4(), kind: 'study', label: 'Dado de outra conta', date: TODAY, minutes: 50 });
    await client.post('/api/v1/knowledge/sessions', { clientId: uuid4(), kind: 'study', label: 'Cálculo', date: TODAY, minutes: 40 });
    await client.post('/api/v1/planner/items', { clientId: uuid4(), date: '2026-11-07', startTime: '09:00', durationMin: 60, title: 'Revisão', category: 'study' });
    fake.plan = (_b, n) => (n === 1 ? { calls: [{ name: 'get_life_overview', args: { period: 'this_week' } }, { name: 'get_week_agenda', args: {} }, { name: 'get_personal_context', args: {} }] } : { text: 'Resumo da semana.' });
    const ev = await send(client, 'new', 'Como foi minha semana?');
    expect(ev.find((e) => e.type === 'done')).toBeTruthy();
    const names = (fake.bodies[0].tools as any[]).map((t) => t.name);
    for (const n of ['get_life_overview', 'get_week_agenda', 'check_schedule_conflicts', 'get_personal_context', 'propose_schedule_items', 'propose_life_plan']) expect(names).toContain(n);
    const [ov, ag, pc] = fake.toolOutputs();
    expect(ov.source).toBe('registros_do_app');
    expect(ov.data.dados_registrados.find((m: any) => m.indicador === 'Tempo de estudo e foco').valor).toBe(40);
    expect(ov.data.sem_dados).toContain('Treinos concluídos');
    expect(ov.data.planejado_x_realizado.por_categoria.study.Planejado).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ag.data)).toContain('Revisão');
    expect(pc.data.preferencias_confirmadas).toEqual([]);
    expect(JSON.stringify(fake.bodies[1].input)).not.toContain('Dado de outra conta');
    const ins = fake.bodies[0].instructions as string;
    expect(ins).toMatch(/\*\*Registrado\*\*.*\*\*Planejado\*\*.*\*\*Sem dados\*\*.*\*\*Estimativa\*\*.*\*\*Sugestão\*\*/s);
    expect(ins).toMatch(/Nunca afirme que uma atividade foi concluída/);
  });

  it('plano multimódulo: prévia, edição, aprovação por etapas, sem XP, sem duplicar, desfazer', async () => {
    const { client, account } = await person('ia-plan');
    const xp0 = await xpOf(account.id);
    const habitArgs = { habit: { name: 'Ler 20 minutos', attribute: 'knowledge', tag: 'reading', icon: 'book', frequency: 'daily', goalKind: 'duration', goalTarget: 20, xp: 15, preferredTime: '21:30' } };
    // Etapas repetidas são recusadas na proposta.
    const dup = await callTool(client, 'propose_life_plan', { title: 'Rotina', steps: [{ tool: 'propose_create_habit', args: habitArgs }, { tool: 'propose_create_habit', args: habitArgs }] });
    expect(dup.proposal).toBeUndefined();
    expect(JSON.stringify(dup.output)).toMatch(/repete outra etapa/);

    const schedule = [
      { date: '2026-11-05', startTime: '06:00', durationMin: 30, title: 'Leitura bíblica', category: 'bible' },
      { date: '2026-11-05', startTime: '19:00', durationMin: 60, title: 'Estudo', category: 'study' },
    ];
    const r = await callTool(client, 'propose_life_plan', { title: 'Rotina de segunda a sexta', steps: [{ tool: 'propose_create_habit', args: habitArgs }, { tool: 'propose_save_preference', args: { content: 'Prefere acordar às 5h30', category: 'schedule', inferred: false } }], schedule });
    expect(r.proposal, JSON.stringify(r.output)).toMatchObject({ kind: 'apply_life_plan', status: 'pending' });
    expect(r.proposal.steps.map((s: any) => s.kind)).toEqual(['create_habit', 'save_preference', 'create_planner_items']);
    expect(JSON.stringify(r.proposal.preview)).toMatch(/Planejar não gera XP/);
    // Nada gravado antes de aprovar.
    expect((await client.get('/api/v1/life/habits')).body.habits).toHaveLength(0);
    // Aprovar desmarcando a preferência e ajustando um horário.
    const ok = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`, { skip: [1], times: [{ step: 2, item: 1, startTime: '20:00' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.action.status).toBe('applied');
    expect(ok.body.action.steps.map((s: any) => s.status)).toEqual(['applied', 'skipped', 'applied']);
    expect((await client.get('/api/v1/life/habits')).body.habits).toHaveLength(1);
    expect((await client.get('/api/v1/assistant/memories')).body.memories).toHaveLength(0);
    const items = (await env.pool.query('SELECT title, start_time, origin FROM planner_items WHERE user_id = $1 ORDER BY start_time', [account.id])).rows;
    expect(items).toEqual([{ title: 'Leitura bíblica', start_time: '06:00', origin: 'ai' }, { title: 'Estudo', start_time: '20:00', origin: 'ai' }]);
    expect(await xpOf(account.id)).toBe(xp0); // planejar não gera XP
    // Aprovar de novo não duplica.
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).status).toBe(409);
    // Mesmo bloco proposto de novo: a prévia avisa e a aplicação ignora.
    const again = await callTool(client, 'propose_schedule_items', { items: [schedule[0]] });
    expect(JSON.stringify(again.proposal.preview)).toMatch(/já está na agenda/);
    const ap2 = await client.post(`/api/v1/assistant/actions/${again.proposal.id}/approve`);
    expect(ap2.body.action.status).toBe('applied');
    expect((await env.pool.query('SELECT count(*)::int AS n FROM planner_items WHERE user_id = $1', [account.id])).rows[0].n).toBe(2);
    // Desfazer o plano remove o que ele criou.
    const un = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`);
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    expect(un.body.action.status).toBe('reverted');
    expect((await client.get('/api/v1/life/habits')).body.habits).toHaveLength(0);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM planner_items WHERE user_id = $1', [account.id])).rows[0].n).toBe(0);
  });

  it('falha parcial: grava o que deu certo, marca "parcial", nunca diz que salvou tudo; nova tentativa só do que falta', async () => {
    const { client, account } = await person('ia-part');
    const h = (await client.post('/api/v1/life/habits', { name: 'Beber água', attribute: 'health', tag: 'water', icon: 'droplet', frequency: 'daily', goalKind: 'count', goalTarget: 8, goalUnit: 'copos', xp: 10 })).body.id;
    const r = await callTool(client, 'propose_life_plan', {
      title: 'Ajustes da semana',
      steps: [{ tool: 'propose_update_habit', args: { habitId: h, changes: { goalTarget: 10 } } }],
      schedule: [{ date: '2026-11-06', startTime: '18:00', durationMin: 45, title: 'Caminhada', category: 'custom' }],
    });
    expect(r.proposal?.kind).toBe('apply_life_plan');
    // O hábito muda em outro aparelho depois da proposta → a etapa 1 fica desatualizada.
    const cur = (await client.get('/api/v1/life/habits')).body.habits[0];
    expect((await client.req('PATCH', `/api/v1/life/habits/${h}`, { version: cur.version, patch: { name: 'Água' } })).status).toBe(200);
    const ap = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`);
    expect(ap.status).toBe(200);
    expect(ap.body.action.status).toBe('partial');
    expect(ap.body.action.steps.map((s: any) => s.status)).toEqual(['failed', 'applied']);
    expect(ap.body.action.steps[0].error).toMatch(/mudou depois da proposta/);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM planner_items WHERE user_id = $1', [account.id])).rows[0].n).toBe(1);
    const conv = r.events.find((e) => e.type === 'start')!.conversationId;
    const msgs = (await client.get(`/api/v1/assistant/conversations/${conv}`)).body.conversation.messages;
    expect(msgs[msgs.length - 1].content).toMatch(/SÓ PARTE do plano/);
    // Nova tentativa pulando a etapa que falhou: completa sem duplicar a agenda.
    const retry = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`, { skip: [0] });
    expect(retry.body.action.status).toBe('applied');
    expect(retry.body.action.steps.map((s: any) => s.status)).toEqual(['skipped', 'applied']);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM planner_items WHERE user_id = $1', [account.id])).rows[0].n).toBe(1);
    expect((await env.pool.query('SELECT goal_target FROM life_habits WHERE id = $1', [h])).rows[0].goal_target).toBe(8);
  });

  it('preferências: inferidas separadas das confirmadas; editar, confirmar e excluir; isolamento', async () => {
    const { client } = await person('ia-pref');
    const other = await person('ia-pref-b');
    const r = await callTool(client, 'propose_save_preference', { content: 'Costuma treinar à noite', category: 'training', inferred: true });
    expect(JSON.stringify(r.proposal.preview)).toMatch(/inferida pela IA/);
    await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`);
    await client.post('/api/v1/assistant/memories', { content: 'Sem lactose', category: 'food' });
    let mem = (await client.get('/api/v1/assistant/memories')).body.memories;
    expect(mem.map((m: any) => [m.content, m.category, m.confirmed])).toEqual([
      ['Costuma treinar à noite', 'training', false],
      ['Sem lactose', 'food', true],
    ]);
    fake.plan = () => ({ text: 'ok' });
    await send(client, 'new', 'oi');
    const ins = fake.bodies[fake.bodies.length - 1].instructions as string;
    expect(ins).toMatch(/Preferências salvas pela pessoa \(confirmadas[^]*Sem lactose/);
    expect(ins).toMatch(/Inferências guardadas[^]*Costuma treinar à noite/);
    const inf = mem.find((m: any) => !m.confirmed);
    expect((await other.client.req('PATCH', `/api/v1/assistant/memories/${inf.id}`, { confirmed: true })).status).toBe(404);
    mem = (await client.req('PATCH', `/api/v1/assistant/memories/${inf.id}`, { confirmed: true })).body.memories;
    expect(mem.every((m: any) => m.confirmed)).toBe(true);
    expect((await client.req('DELETE', `/api/v1/assistant/memories/${inf.id}`)).status).toBe(204);
    expect((await client.get('/api/v1/assistant/memories')).body.memories).toHaveLength(1);
  });
});
