// Assistente IA central × Conhecimento (Fase 04): OpenAI SIMULADA (nenhuma chamada real ou paga), PostgreSQL real.
// Cobre: ferramentas registradas, leitura com dados reais (livros, histórico de estudos, metas), nenhuma ferramenta de
// XP, plano de estudos com prévia → nada gravado antes → aprovação → desfazer, rotina de leitura numa rotina existente,
// progresso de leitura informado pela pessoa e isolamento entre contas.
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

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const K = '/api/v1/knowledge';

describe('IA central × conhecimento', () => {
  it('ferramentas registradas e leitura dos registros reais (sem inventar)', async () => {
    const { client } = await ready('kn-ia');
    const b = await client.post(`${K}/books`, { title: 'Sapiens', author: 'Yuval Harari', totalPages: 400, currentPage: 120, status: 'reading' });
    await client.post(`${K}/books`, { title: 'Duna', status: 'want' });
    const sj = (await client.post(`${K}/subjects`, { name: 'Programação', weeklyGoalMin: 300 })).body.id;
    await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'study', subjectId: sj, date: today, minutes: 50 });
    await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'reading', bookId: b.body.book.id, date: today, minutes: 20, pagesRead: 15 });
    await client.post(`${K}/goals`, { metric: 'minutes', scope: 'reading', period: 'daily', target: 30 });
    fake.plan = (_b, n) => (n === 1 ? { calls: [{ name: 'list_books', args: { status: 'reading' } }, { name: 'get_study_history', args: { subjectId: sj } }, { name: 'get_knowledge_goals', args: {} }, { name: 'get_focus_stats', args: {} }] } : { text: 'ok' });
    await send(client, 'new', 'Quantas horas estudei programação nesta semana? Quais livros estou lendo?');
    const names = (fake.bodies[0].tools as any[]).map((t) => t.name);
    for (const n of ['list_books', 'get_book_progress', 'list_reading_sessions', 'list_subjects', 'get_study_history', 'get_knowledge_goals', 'get_focus_stats', 'get_knowledge_notes', 'propose_create_book', 'propose_update_reading_progress', 'propose_create_subject', 'propose_create_topics', 'propose_create_study_plan', 'propose_update_knowledge_goals', 'propose_add_activity_to_mission', 'propose_schedule_knowledge_routine']) expect(names).toContain(n);
    expect(names.some((n) => /sql|xp|grant/i.test(n))).toBe(false);
    const [books, hist, goals, stats] = fake.toolOutputs().map((o) => o.data);
    expect(books.books.map((x: any) => x.title)).toEqual(['Sapiens']);
    expect(books.books[0]).toMatchObject({ pages: '135/400', minutesRead: 20 });
    expect(hist).toMatchObject({ subject: 'Programação', minutes: 50, sessions: 1 });
    expect(goals.goals[0].current).toMatchObject({ progress: 20, met: false });
    expect(stats.totals.minutes).toBe(70);
    expect(fake.bodies[0].instructions).toMatch(/Nunca invente livros lidos/);
  });

  it('"quero aprender inglês, monte uma rotina": prévia, nada gravado, aprovação cria tudo, desfazer remove', async () => {
    const { client, account } = await ready('kn-plan');
    const xp0 = Number((await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [account.id])).rows[0].total_xp);
    const args = {
      newSubject: { name: 'Inglês', description: 'Conversação e leitura', category: 'Idiomas', weeklyGoalMin: 150 },
      topics: [{ title: 'Verb to be' }, { title: 'Simple present' }, { title: 'Vocabulário do dia a dia' }],
      goals: [{ metric: 'minutes', scope: 'study', period: 'daily', target: 30, days: [1, 2, 3, 4, 5], preferredTime: '19:00' }],
      routine: { newRoutine: { name: 'Estudos à noite', kind: 'study', days: [1, 2, 3, 4, 5] }, items: [{ title: 'Inglês', startTime: '19:00', durationMin: 30 }] },
      rationale: 'Começar com pouco e todo dia útil.',
    };
    const r = await callTool(client, 'propose_create_study_plan', args);
    expect(r.proposal, JSON.stringify(r.output)).toMatchObject({ kind: 'create_study_plan', status: 'pending' });
    const text = JSON.stringify(r.proposal.preview);
    expect(text).toContain('Inglês');
    expect(text).toContain('Verb to be');
    expect(text).toContain('19:00 Inglês (30 min)');
    expect(text).toMatch(/Estudar Inglês 30 min por dia \(seg, ter, qua, qui, sex\)/);
    // Nada gravado antes da aprovação.
    expect((await client.get(`${K}/subjects`)).body.subjects).toHaveLength(0);
    expect((await client.get(`${K}/goals`)).body.goals).toHaveLength(0);
    const ok = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.action).toMatchObject({ status: 'applied', undoable: true, result: { collection: 'subjects' } });
    const subjects = (await client.get(`${K}/subjects`)).body.subjects;
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatchObject({ name: 'Inglês', origin: 'ai', topics: { total: 3 } });
    const goals = (await client.get(`${K}/goals`)).body.goals;
    expect(goals[0]).toMatchObject({ subjectId: subjects[0].id, scope: 'study', target: 30, origin: 'ai', days: [1, 2, 3, 4, 5] });
    const routines = (await client.get('/api/v1/life/routines')).body.routines;
    expect(routines.map((x: any) => x.name)).toContain('Estudos à noite');
    // A IA não concede XP por planejar.
    expect(Number((await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [account.id])).rows[0].total_xp)).toBe(xp0);
    const u = await client.post(`/api/v1/assistant/actions/${r.proposal.id}/undo`);
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect((await client.get(`${K}/subjects`)).body.subjects).toHaveLength(0);
    expect((await client.get(`${K}/goals`)).body.goals).toHaveLength(0);
    expect((await client.get('/api/v1/life/routines')).body.routines.map((x: any) => x.name)).not.toContain('Estudos à noite');
  });

  it('"ler 30 minutos antes de dormir" vai para a rotina noturna existente; progresso informado vira registro; outra conta não alcança', async () => {
    const { client } = await ready('kn-rot');
    const rt = await client.post('/api/v1/life/routines', { name: 'Rotina noturna', kind: 'night', items: [{ title: 'Escovar os dentes', startTime: '22:00' }] });
    expect(rt.status, JSON.stringify(rt.body)).toBe(201);
    const r = await callTool(client, 'propose_schedule_knowledge_routine', { routineId: rt.body.id, items: [{ title: 'Leitura antes de dormir', startTime: '22:15', durationMin: 30 }] });
    expect(r.proposal).toMatchObject({ kind: 'schedule_knowledge_routine' });
    expect((await client.post(`/api/v1/assistant/actions/${r.proposal.id}/approve`)).status).toBe(200);
    const items = (await client.get('/api/v1/life/routines')).body.routines[0].items.map((i: any) => i.title);
    expect(items).toEqual(['Escovar os dentes', 'Leitura antes de dormir']);
    // Progresso que a pessoa informou ("estou na página 80, li 25 minutos hoje").
    const b = (await client.post(`${K}/books`, { title: 'Hábitos Atômicos', totalPages: 320, currentPage: 50, status: 'reading' })).body.book;
    const p = await callTool(client, 'propose_update_reading_progress', { bookId: b.id, currentPage: 80, minutes: 25 });
    expect(JSON.stringify(p.proposal.preview)).toContain('50 → 80');
    expect((await client.get(`${K}/books/${b.id}`)).body.book.currentPage).toBe(50);
    expect((await client.post(`/api/v1/assistant/actions/${p.proposal.id}/approve`)).status).toBe(200);
    const det = (await client.get(`${K}/books/${b.id}`)).body;
    expect(det.book.currentPage).toBe(80);
    expect(det.sessions[0]).toMatchObject({ origin: 'ai', activeMin: 25, pagesRead: 30, xp: 5 });
    expect((await client.post(`/api/v1/assistant/actions/${p.proposal.id}/undo`)).status).toBe(200);
    const after = (await client.get(`${K}/books/${b.id}`)).body;
    expect(after.book.currentPage).toBe(50);
    expect(after.sessions).toHaveLength(0);
    // Outra conta: o id do livro "não existe".
    const other = await ready('kn-other');
    const x = await callTool(other.client, 'propose_update_reading_progress', { bookId: b.id, currentPage: 90 });
    expect(x.proposal).toBeUndefined();
    expect(JSON.stringify(fake.toolOutputs())).toContain('Livro não encontrado');
  });
});
