// Assistente IA central × Bíblia (Fase 05): OpenAI SIMULADA (nenhuma chamada real ou paga), PostgreSQL real.
// Cobre: ferramentas registradas, texto bíblico vindo do arquivo (com referência e tradução), referência inexistente
// sem invenção, regras no prompt, propostas (plano, ajuste, meta, favorito, reflexão) com aprovação e desfazer,
// reflexões só com permissão e isolamento entre contas.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { passageByKey } from '../src/bible/text.ts';
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

const B = '/api/v1/bible';
const tzq = 'tz=America%2FSao_Paulo';

describe('IA central × Bíblia', () => {
  it('ferramentas registradas; passagens vêm do arquivo da tradução com referência; nunca inventa', async () => {
    const { client } = await ready('bb-ia');
    await client.post(`${B}/read?${tzq}`, { chapters: ['PSA.23'] });
    fake.plan = (_b, n) =>
      n === 1
        ? { calls: [{ name: 'get_bible_passage', args: { reference: 'Filipenses 4:13' } }, { name: 'get_bible_passage', args: { reference: 'João 30:1' } }, { name: 'find_bible_passages_by_theme', args: { theme: 'perseverança' } }, { name: 'get_bible_reading_progress', args: {} }, { name: 'get_bible_verse_of_day', args: {} }] }
        : { text: 'ok' };
    await send(client, 'new', 'Me mostre uma passagem sobre perseverança');
    const names = (fake.bodies[0].tools as any[]).map((t) => t.name);
    for (const n of ['get_bible_passage', 'search_bible', 'find_bible_passages_by_theme', 'get_bible_verse_of_day', 'get_bible_reading_progress', 'get_bible_plans', 'get_bible_goals', 'get_bible_favorites', 'get_bible_reflections', 'get_bible_stats', 'propose_create_bible_plan', 'propose_update_bible_plan', 'propose_create_bible_goal', 'propose_add_bible_favorite', 'propose_save_bible_reflection']) expect(names).toContain(n);
    expect(names.some((n) => /sql|xp|grant/i.test(n))).toBe(false);
    const outs = fake.toolOutputs();
    const php = outs[0].data;
    expect(php).toMatchObject({ reference: 'Filipenses 4:13', translation: expect.stringContaining('BPM') });
    expect(php.verses[0].text).toBe(passageByKey('PHP.4.13').verses[0].text);
    expect(outs[1].ok === false || outs[1].error).toBeTruthy();
    expect(JSON.stringify(outs[1])).toMatch(/não invente|Não invente/i);
    expect(outs[2].data.passages.length).toBeGreaterThan(0);
    expect(outs[3].data.chaptersByDay[0].chapters).toEqual(['Salmos 23']);
    expect(outs[4].data.reference).toBeTruthy();
    const ins = fake.bodies[0].instructions as string;
    expect(ins).toMatch(/NUNCA cite versículos de memória/);
    expect(ins).toMatch(/mensagem de Deus/);
    expect(ins).toMatch(/TEXTO.*CONTEXTO.*INTERPRETAÇÕES.*REFLEXÃO/s);
  });

  it('plano de leitura: prévia, nada gravado, aprovação cria, desfazer remove; XP intacto', async () => {
    const { client, account } = await ready('bb-plan');
    const xp0 = Number((await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [account.id])).rows[0].total_xp);
    const r = await callTool(client, 'propose_create_bible_plan', { books: ['MAT', 'MRK', 'LUK', 'JHN'], days: 30, title: 'Evangelhos em 30 dias' });
    expect(r.proposal, JSON.stringify(r.output)).toMatchObject({ kind: 'create_bible_plan', status: 'pending' });
    const text = JSON.stringify(r.proposal.preview);
    expect(text).toContain('30 dias · 89 capítulos');
    expect(text).toContain('Dia 1: Mateus 1');
    expect((await client.get(`${B}/plans?${tzq}`)).body.plans).toHaveLength(0);
    const ok = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.action).toMatchObject({ status: 'applied', undoable: true, result: { collection: 'bible_plans' } });
    const plans = (await client.get(`${B}/plans?${tzq}`)).body.plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ title: 'Evangelhos em 30 dias', totalDays: 30 });
    expect(Number((await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [account.id])).rows[0].total_xp)).toBe(xp0);
    const u = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect((await client.get(`${B}/plans?${tzq}`)).body.plans).toHaveLength(0);
  });

  it('ajuste de plano, meta, favorito e reflexão: aprovar e desfazer; reflexões só com permissão; outra conta não alcança', async () => {
    const { client } = await ready('bb-misc');
    const plan = (await client.post(`${B}/plans?${tzq}`, { template: 'proverbs' })).body.plan;
    await client.post(`${B}/plans/${plan.id}/days/0?${tzq}`, {});
    const up = await callTool(client, 'propose_update_bible_plan', { planId: plan.id, remainingDays: 10 });
    expect(up.proposal, JSON.stringify(up.output)).toMatchObject({ kind: 'update_bible_plan' });
    expect((await client.post(`/api/v1/assistant/actions/${up.proposal.id}/approve`)).status).toBe(200);
    expect((await client.get(`${B}/plans/${plan.id}?${tzq}`)).body.plan).toMatchObject({ totalDays: 11, doneDays: 1 });
    expect((await client.post(`/api/v1/assistant/actions/${up.proposal.id}/undo`)).status).toBe(200);
    expect((await client.get(`${B}/plans/${plan.id}?${tzq}`)).body.plan).toMatchObject({ totalDays: 31, doneDays: 1 });

    const g = await callTool(client, 'propose_create_bible_goal', { goal: { metric: 'chapters', period: 'weekly', target: 7, book: 'PRO', days: [] } });
    expect(g.proposal, JSON.stringify(g.output)).toMatchObject({ kind: 'create_bible_goal' });
    expect((await client.post(`/api/v1/assistant/actions/${g.proposal.id}/approve`)).status).toBe(200);
    expect((await client.get(`${B}/goals?${tzq}`)).body.goals[0]).toMatchObject({ title: 'Ler 7 capítulos de Provérbios por semana', module: 'bible', ref: 'PRO' });
    expect((await client.post(`/api/v1/assistant/actions/${g.proposal.id}/undo`)).status).toBe(200);
    expect((await client.get(`${B}/goals?${tzq}`)).body.goals).toHaveLength(0);

    const f = await callTool(client, 'propose_add_bible_favorite', { reference: 'Romanos 5:3-4', tags: ['Esperança'] });
    expect((await client.post(`/api/v1/assistant/actions/${f.proposal.id}/approve`)).status).toBe(200);
    const favs = (await client.get(`${B}/marks?kind=favorite`)).body.marks;
    expect(favs[0]).toMatchObject({ ref: 'ROM.5.3-4', tags: ['esperança'] });
    expect((await client.post(`/api/v1/assistant/actions/${f.proposal.id}/undo`)).status).toBe(200);
    expect((await client.get(`${B}/marks?kind=favorite`)).body.marks).toHaveLength(0);

    const rf = await callTool(client, 'propose_save_bible_reflection', { kind: 'gratitude', content: 'Grato pela caminhada de hoje.', reference: 'Salmo 23' });
    expect(JSON.stringify(rf.proposal.preview)).toContain('Grato pela caminhada de hoje.');
    expect((await client.get(`${B}/reflections`)).body.reflections).toHaveLength(0);
    expect((await client.post(`/api/v1/assistant/actions/${rf.proposal.id}/approve`)).status).toBe(200);
    expect((await client.get(`${B}/reflections`)).body.reflections[0]).toMatchObject({ kind: 'gratitude', ref: 'PSA.23' });

    // Leitura das reflexões: permitida por padrão quando a pessoa pede; desligada nos ajustes, a ferramenta recusa.
    const read1 = await callTool(client, 'get_bible_reflections', {});
    expect(read1.output.reflections[0].text).toContain('Grato');
    await client.req('PATCH', `${B}/prefs`, { patch: { shareAi: false } });
    const read2 = await callTool(client, 'get_bible_reflections', {});
    expect(JSON.stringify(fake.toolOutputs()[0])).toMatch(/desativou/);
    expect(JSON.stringify(read2.output ?? {})).not.toContain('Grato');

    // Outra conta não alcança o plano.
    const other = await ready('bb-other');
    const x = await callTool(other.client, 'propose_update_bible_plan', { planId: plan.id, status: 'paused' });
    expect(x.proposal).toBeUndefined();
  });
});
