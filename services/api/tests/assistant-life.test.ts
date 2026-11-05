// Assistente IA central + RPG (Fase 01): OpenAI SIMULADA (nenhuma chamada real ou paga), PostgreSQL real.
// Cobre: ferramentas de leitura do RPG com dados reais, propostas de hábito/rotina/missão/pausa com aprovação, a IA não
// conseguir conceder XP (nem escolher a recompensa), versão desatualizada e o desfazer das alterações aplicadas.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultMissionXp } from '../../../shared/life/protocol.ts';
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

async function ready(tag = 'rpg-ia') {
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

describe('IA central × RPG', () => {
  it('ferramentas registradas e leitura de dados reais da conta', async () => {
    const { client } = await ready();
    const h = await client.post('/api/v1/life/habits', { name: 'Ler', attribute: 'knowledge', tag: 'reading', frequency: 'daily', goalKind: 'duration', goalTarget: 20, goalUnit: 'min' });
    await client.post(`/api/v1/life/habits/${h.body.id}/log`, { amount: 20 });
    fake.plan = (_b, n) => (n === 1 ? { calls: [{ name: 'get_rpg_profile', args: {} }, { name: 'list_habits', args: {} }, { name: 'list_life_missions', args: { scope: 'today' } }, { name: 'get_life_progress', args: {} }] } : { text: 'ok' });
    await send(client, 'new', 'Como está minha disciplina nesta semana?');
    const names = (fake.bodies[0].tools as any[]).map((t) => t.name);
    for (const n of ['get_rpg_profile', 'list_life_missions', 'list_habits', 'list_life_routines', 'get_life_progress', 'list_achievements', 'propose_create_habit', 'propose_update_habit', 'propose_create_life_routine', 'propose_update_life_routine', 'propose_create_missions', 'propose_update_mission']) expect(names).toContain(n);
    expect(names.some((n) => /xp|grant|reward/i.test(n))).toBe(false);
    const [profile, habits, missions, progress] = fake.toolOutputs().map((o) => o.data);
    expect(profile.totalXp).toBeGreaterThan(0);
    expect(habits.habits[0]).toMatchObject({ name: 'Ler', today: { completed: true } });
    expect(missions.habitsToday[0]).toMatchObject({ name: 'Ler', done: true });
    expect(progress.habits[0]).toMatchObject({ name: 'Ler', done: 1 });
    expect(fake.bodies[0].instructions).toMatch(/NUNCA concede/);
  });

  it('criar hábito por proposta: nada antes da aprovação, nenhum XP ao aprovar, desfazer remove', async () => {
    const { client, account } = await ready();
    const before = await xpTotal(account.id);
    const r = await callTool(client, 'propose_create_habit', { habit: { name: 'Estudar inglês', attribute: 'knowledge', tag: 'study', frequency: 'daily', goalKind: 'duration', goalTarget: 60, goalUnit: 'min', xp: 20 } });
    expect(r.proposal).toMatchObject({ kind: 'create_habit', status: 'pending' });
    expect((await client.get('/api/v1/life/habits')).body.habits).toHaveLength(0);
    const ok = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.action).toMatchObject({ status: 'applied', undoable: true, result: { collection: 'habits' } });
    const habits = (await client.get('/api/v1/life/habits')).body.habits;
    expect(habits[0]).toMatchObject({ name: 'Estudar inglês', goalTarget: 60, xp: 20 });
    expect(await xpTotal(account.id)).toBe(before);
    const u = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body.action).toMatchObject({ status: 'reverted', undoable: false });
    expect((await client.get('/api/v1/life/habits')).body.habits).toHaveLength(0);
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`)).status).toBe(409);
  });

  it('missões propostas pela IA: recompensa calculada pelo servidor (a IA não escolhe XP)', async () => {
    const { client, account } = await ready();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const end = new Date(Date.parse(`${today}T12:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    const m = { type: 'custom', title: 'Ler 120 minutos', metric: 'manual', unit: 'minutes', tag: 'reading', target: 120, attribute: 'knowledge', endsOn: end };
    // Tentar escolher XP: o servidor ignora.
    const r = await callTool(client, 'propose_create_missions', { missions: [{ ...m, xp: 300 }, { ...m, title: 'Ler um capítulo bíblico', unit: 'chapters', tag: 'bible', target: 1, attribute: 'spirituality' }] });
    expect(r.proposal, JSON.stringify(r.output)).toMatchObject({ kind: 'create_missions' });
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).status).toBe(200);
    const list = (await client.get('/api/v1/life/missions')).body.missions.filter((x: any) => x.origin === 'ai');
    expect(list).toHaveLength(2);
    expect(list.find((x: any) => x.title === 'Ler 120 minutos').xp).toBe(defaultMissionXp('custom', 'minutes', 120, 7));
    expect(await xpTotal(account.id)).toBe(0);
    // Desfazer cancela as missões criadas.
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`)).status).toBe(200);
    expect((await client.get('/api/v1/life/missions?scope=history')).body.missions.filter((x: any) => x.origin === 'ai' && x.status === 'cancelled')).toHaveLength(2);
  });

  it('pausar hábito e criar rotina por proposta; versão desatualizada recusa; desfazer recusado se mudou depois', async () => {
    const { client } = await ready();
    const h = (await client.post('/api/v1/life/habits', { name: 'Beber água', attribute: 'health', tag: 'water', frequency: 'daily', goalKind: 'count', goalTarget: 8 })).body.id;
    const p = await callTool(client, 'propose_update_habit', { habitId: h, changes: { status: 'paused' } });
    expect(p.proposal.title).toMatch(/Pausar/);
    // A pessoa edita manualmente antes de aprovar → proposta desatualizada.
    const cur = (await client.get('/api/v1/life/habits')).body.habits[0];
    await client.req('PATCH', `/api/v1/life/habits/${h}`, { version: cur.version, patch: { goalTarget: 10 } });
    expect((await client.post(`/api/v1/assistant/actions/${p.proposal.id}/approve`)).body.error.code).toBe('action_stale');
    const p2 = await callTool(client, 'propose_update_habit', { habitId: h, changes: { status: 'paused' } });
    expect((await client.post(`/api/v1/assistant/actions/${p2.proposal.id}/approve`)).status).toBe(200);
    expect((await client.get('/api/v1/life/habits')).body.habits[0].status).toBe('paused');
    const r = await callTool(client, 'propose_create_life_routine', { routine: { name: 'Rotina matinal', kind: 'morning', items: [{ title: 'Beber água', startTime: '06:30', habitId: h }, { title: 'Alongar', durationMin: 10 }] } });
    expect(r.proposal, JSON.stringify(r.output)).toMatchObject({ kind: 'create_life_routine' });
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).status).toBe(200);
    const rt = (await client.get('/api/v1/life/routines')).body.routines[0];
    expect(rt.items.map((i: any) => i.title)).toEqual(['Beber água', 'Alongar']);
    // Mudou depois (a pessoa renomeou) → desfazer recusa para não perder a mudança.
    await client.req('PATCH', `/api/v1/life/routines/${rt.id}`, { version: rt.version, patch: { name: 'Manhã' } });
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`)).body.error.code).toBe('action_undo_stale');
    // Desfazer a pausa: o hábito volta a ativo.
    expect((await client.post(`/api/v1/assistant/actions/${p2.proposal.id}/undo`)).status).toBe(200);
    expect((await client.get('/api/v1/life/habits')).body.habits[0].status).toBe('active');
  });

  it('isolamento: a IA não alcança hábitos de outra conta', async () => {
    const a = await ready('a');
    const b = await ready('b');
    const h = (await a.client.post('/api/v1/life/habits', { name: 'Segredo', attribute: 'health', frequency: 'daily', goalKind: 'check' })).body.id;
    const r = await callTool(b.client, 'propose_update_habit', { habitId: h, changes: { status: 'archived' } });
    expect(r.proposal).toBeUndefined();
    expect(r.output.error).toMatch(/não encontrado/);
    const start = fake.bodies.length;
    fake.plan = (_b, n) => (n === start + 1 ? { calls: [{ name: 'list_habits', args: {} }] } : { text: 'ok' });
    await send(b.client, 'new', 'meus hábitos');
    expect(fake.toolOutputs()[0].data.habits).toHaveLength(0);
  });

  it('desfazer também vale para fichas de treino criadas pela IA (Fase 00)', async () => {
    const { client } = await ready();
    const r = await callTool(client, 'propose_create_routine', { name: 'Full body', workouts: [{ label: 'A', name: 'Corpo todo', exercises: [{ name: 'Agachamento', muscleGroup: 'Pernas', category: 'compound', equipment: 'barbell', sets: 3, repMin: 8, repMax: 10, restSec: 90 }] }] });
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).status).toBe(200);
    const id = (await env.pool.query("SELECT id FROM routines WHERE user_id = (SELECT user_id FROM assistant_actions WHERE id = $1) AND NOT deleted", [r.proposal.id])).rows[0].id;
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`)).status).toBe(200);
    expect((await env.pool.query('SELECT deleted FROM routines WHERE id = $1', [id])).rows[0].deleted).toBe(true);
  });
});
