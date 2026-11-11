// Assistente IA central (Fase 00): OpenAI SIMULADA (nenhuma chamada real ou paga), PostgreSQL real.
// Cobre: formato da chamada à Responses API, streaming, ferramentas de leitura com registros reais, isolamento entre
// contas, propostas de escrita com aprovação/cancelamento/versão desatualizada, ferramentas não autorizadas,
// persistência de conversas e memórias, limites e erros do provedor.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPush } from '../src/modules/sync.ts';
import { Client, linkToken, setupApi, signup, uuid4, type TestEnv } from './helpers.ts';
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

async function ready(tag = 'pessoa') {
  const s = await signup(env, 'Pessoa Teste', `${tag}.${uuid4().slice(0, 8)}@exemplo.test`);
  expect((await s.client.post('/api/v1/assistant/notice', { version: 1 })).status).toBe(200);
  return s;
}

const DAY = 86_400_000;
const routineDoc = (id = 'r1') => ({
  id,
  name: 'ABC Hipertrofia',
  workouts: [
    {
      id: 'wA',
      label: 'A',
      name: 'Peito e tríceps',
      exercises: [
        { id: 'e1', name: 'Supino reto', muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', sets: 3, repMin: 8, repMax: 10, restSec: 90, warmupSets: 1 },
        { id: 'e2', name: 'Tríceps corda', muscleGroup: 'Tríceps', category: 'isolation', equipment: 'cable', sets: 3, repMin: 10, repMax: 12, restSec: 60, warmupSets: 0 },
      ],
    },
  ],
  createdAt: 1,
  updatedAt: 1,
});
const sessionDoc = (id: string, daysAgo: number, weight: number) => ({
  id,
  routineId: 'r1',
  workoutId: 'wA',
  workoutLabel: 'A',
  workoutName: 'Peito e tríceps',
  status: 'completed',
  startedAt: Date.now() - daysAgo * DAY,
  finishedAt: Date.now() - daysAgo * DAY + 3_600_000,
  durationSec: 3600,
  updatedAt: 1,
  exercises: [
    {
      id: `${id}-x`,
      exerciseKey: 'supino-reto',
      templateId: 'e1',
      name: 'Supino reto',
      muscleGroup: 'Peito',
      category: 'compound',
      equipment: 'barbell',
      repMin: 8,
      repMax: 10,
      restSec: 90,
      plannedSets: 3,
      sets: [
        { id: 'w', type: 'warmup', status: 'done', weight: 40, reps: 10 },
        { id: 's1', type: 'normal', status: 'done', weight, reps: 8 },
        { id: 's2', type: 'normal', status: 'done', weight, reps: 7 },
      ],
    },
  ],
});

async function seed(userId: string) {
  const ops = [
    { opId: uuid4(), collection: 'routines', entityId: 'r1', kind: 'put', baseVersion: 0, doc: routineDoc() },
    { opId: uuid4(), collection: 'sessions', entityId: 's-old', kind: 'put', baseVersion: 0, doc: sessionDoc('s-old', 60, 60) },
    { opId: uuid4(), collection: 'sessions', entityId: 's-new', kind: 'put', baseVersion: 0, doc: sessionDoc('s-new', 2, 70) },
  ];
  const r = await applyPush(env.pool, userId, uuid4(), ops);
  expect(r.every((x) => x.status === 'applied')).toBe(true);
}

const routineRow = async (userId: string, id = 'r1') => (await env.pool.query('SELECT version, doc FROM routines WHERE user_id = $1 AND id = $2', [userId, id])).rows[0];

describe('status e aviso de processamento', () => {
  it('sem sessão: 401; mostra modelos permitidos, aviso pendente e nunca a chave', async () => {
    expect((await new Client(env).get('/api/v1/assistant/status')).status).toBe(401);
    const { client } = await signup(env);
    const st = await client.get('/api/v1/assistant/status');
    expect(st.body).toMatchObject({ availability: 'ok', defaultModel: 'gpt-6.1-terra', notice: { version: 1, acceptedVersion: null } });
    expect(st.body.models.map((m: any) => m.id)).toEqual(['gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol']);
    expect(JSON.stringify(st.body)).not.toContain(KEY);
    expect(JSON.stringify(st.body)).not.toMatch(/apiKeyEnv|baseUrl|reasoningEffort/);
    // sem aceitar o aviso, nada é enviado ao provedor
    const r = await send(client, 'new', 'Oi');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('notice_required');
    expect(fake.bodies.length).toBe(0);
  });

  it('modelo fora da lista é recusado; mensagem vazia e longa demais também', async () => {
    const { client } = await ready();
    expect((await send(client, 'new', 'Oi', { model: 'gpt-qualquer' })).json.error.code).toBe('model_not_allowed');
    expect((await send(client, 'new', '   ')).json.error.code).toBe('message_empty');
    expect((await send(client, 'new', 'x'.repeat(8001))).json.error.code).toBe('message_too_long');
    expect((await send(client, 'new', 'Oi', { attachments: [{ tipo: 'imagem' }] })).status).toBe(400);
    expect(fake.bodies.length).toBe(0);
  });
});

describe('integração OpenAI (simulada) e persistência', () => {
  it('chama a Responses API com streaming, store:false, ferramentas e a chave só no cabeçalho; grava a conversa', async () => {
    const { client, account } = await ready();
    fake.plan = () => ({ text: 'Olá! Como posso ajudar no seu treino?' });
    const r = await send(client, 'new', 'Olá, tudo bem?', { model: 'gpt-6-luna' });
    expect(r.status).toBe(200);
    expect(r.events.map((e) => e.type)).toEqual(['start', 'text', 'text', 'done']);
    expect(r.events.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('Olá! Como posso ajudar no seu treino?');
    expect(fake.urls[0]).toBe(`${BASE}/v1/responses`);
    expect(fake.headers[0].authorization).toBe(`Bearer ${KEY}`);
    const body = fake.bodies[0];
    expect(body).toMatchObject({ model: 'gpt-6-luna', store: false, stream: true, reasoning: { effort: 'none' } });
    expect(body.include).toBeUndefined();
    expect(body.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['get_exercise_progress', 'list_routines', 'propose_create_routine', 'propose_update_routine']));
    expect(body.instructions).toContain('Nunca invente registros');
    expect(body.input).toEqual([{ role: 'user', content: 'Olá, tudo bem?' }]);
    // nenhum registro foi enviado sem que o modelo pedisse uma ferramenta
    expect(JSON.stringify(body)).not.toContain('Supino');

    const convId = r.events[0].conversationId;
    const list = await client.get('/api/v1/assistant/conversations');
    expect(list.body.conversations).toMatchObject([{ id: convId, title: 'Olá, tudo bem?', messageCount: 2 }]);
    const full = await client.get(`/api/v1/assistant/conversations/${convId}`);
    expect(full.body.conversation.messages.map((m: any) => [m.role, m.content])).toEqual([
      ['user', 'Olá, tudo bem?'],
      ['assistant', 'Olá! Como posso ajudar no seu treino?'],
    ]);
    // segunda mensagem: o histórico vai junto
    fake.plan = () => ({ text: 'Claro.' });
    await send(client, convId, 'E agora?');
    expect(fake.bodies[1].input.map((i: any) => i.content)).toEqual(['Olá, tudo bem?', 'Olá! Como posso ajudar no seu treino?', 'E agora?']);
    // renomear e apagar
    expect((await client.req('PATCH', `/api/v1/assistant/conversations/${convId}`, { title: 'Conversa inicial' })).status).toBe(200);
    expect((await client.get('/api/v1/assistant/conversations')).body.conversations[0].title).toBe('Conversa inicial');
    // uso contado no PostgreSQL; conteúdo fora dos logs
    const u = await client.get('/api/v1/assistant/status');
    expect(u.body.usage).toMatchObject({ messages: 2, tokens: 240 });
    expect(env.logs.join('\n')).not.toContain('tudo bem');
    expect(env.logs.join('\n')).not.toContain(KEY);
    expect((await client.req('DELETE', `/api/v1/assistant/conversations/${convId}`)).status).toBe(204);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM assistant_messages WHERE user_id = $1', [account.id])).rows[0].n).toBe(0);
  });

  it('erros do provedor: 401 vira erro no streaming, mensagem marcada com erro e o assistente fica indisponível', async () => {
    const e2 = new FakeOpenAI();
    const local = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { serviceEnv: assistantEnv(), assistant: { fetch: e2.fetch } });
    try {
      const { client } = await signup(local);
      await client.post('/api/v1/assistant/notice', { version: 1 });
      e2.plan = () => ({ status: 401 });
      const r = await (async () => {
        const res = await fetch(`${local.base}/api/v1/assistant/conversations/new/messages`, { method: 'POST', headers: { cookie: client.cookie, 'content-type': 'application/json', 'x-irontrack-csrf': '1', origin: 'http://localhost:4173' }, body: JSON.stringify({ content: 'Oi' }) });
        return res.text();
      })();
      expect(r).toContain('"code":"provider_auth_failed"');
      expect(r).not.toContain(KEY);
      expect((await client.get('/api/v1/assistant/status')).body.availability).toBe('auth_failed');
    } finally {
      await local.close();
    }
  });

  it('sem OPENAI_API_KEY: indisponível, nenhuma chamada', async () => {
    const local = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'false' }, { serviceEnv: {} });
    try {
      const { client } = await signup(local);
      expect((await client.get('/api/v1/assistant/status')).body.availability).toBe('missing_key');
      expect(local.api.aiStatus().join('\n')).toContain('OPENAI_API_KEY AUSENTE');
    } finally {
      await local.close();
    }
  });
});

describe('consulta de registros reais', () => {
  it('evolução do supino: a ferramenta lê os treinos da conta e o modelo recebe os números reais', async () => {
    const { client, account } = await ready();
    await seed(account.id);
    fake.plan = (body) => {
      const outs = (body.input as any[]).filter((i) => i.type === 'function_call_output');
      if (!outs.length) return { calls: [{ name: 'get_exercise_progress', args: { exercise: 'supino' } }] };
      const data = JSON.parse(outs[0].output).data;
      const m = data.matches[0];
      return { text: `Seu supino foi de ${m.summary.e1rmFirstKg} para ${m.summary.e1rmLastKg} kg (1RM estimada) em ${m.sessions} treinos.` };
    };
    const r = await send(client, 'new', 'Como foi minha evolução no supino nos últimos três meses?');
    expect(r.events.map((e) => e.type)).toEqual(['start', 'tool', 'tool', 'text', 'text', 'done']);
    expect(r.events[1]).toMatchObject({ name: 'get_exercise_progress', kind: 'read', state: 'start' });
    expect(r.events[2]).toMatchObject({ state: 'end', ok: true });
    // 60 × 8 → Epley 76; 70 × 8 → 88,7. O aquecimento (40 × 10) não conta.
    const done = r.events.at(-1)!;
    expect(done.message.content).toBe('Seu supino foi de 76 para 88.7 kg (1RM estimada) em 2 treinos.');
    expect(done.message.tools).toEqual([{ name: 'get_exercise_progress', label: 'Analisando a evolução do exercício', kind: 'read', ok: true }]);
    // 2ª chamada reenvia o raciocínio e a chamada de função antes do resultado (store:false)
    const second = fake.bodies[1].input as any[];
    expect(second.map((i) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(fake.toolOutputs()[0]).toMatchObject({ source: 'registros_do_app', data: { matches: [{ exercise: 'Supino reto', sessions: 2 }] } });
  });

  it('treino mais recente e falta de dados', async () => {
    const { client, account } = await ready();
    fake.plan = (body) => (body.input.some((i: any) => i.type === 'function_call_output') ? { text: 'ok' } : { calls: [{ name: 'get_workout_details', args: {} }, { name: 'list_goals', args: {} }] });
    await send(client, 'new', 'Qual foi meu treino mais recente?');
    const [w, g] = fake.toolOutputs();
    expect(w).toEqual({ error: 'Nenhum treino concluído registrado.' });
    expect(g.data).toMatchObject({ goals: [], note: 'Nenhuma meta cadastrada.' });
    await seed(account.id);
    await send(client, 'new', 'Qual foi meu treino mais recente?');
    expect(fake.toolOutputs()[0].data).toMatchObject({ id: 's-new', workout: 'A — Peito e tríceps', exercises: [{ name: 'Supino reto', doneSets: 2, sets: ['70 kg × 8', '70 kg × 7'] }] });
  });
});

describe('isolamento entre contas', () => {
  it('a IA de B não lê a ficha, a conversa nem aprova a proposta de A', async () => {
    const a = await ready('a');
    await seed(a.account.id);
    fake.plan = (body) => (body.input.some((i: any) => i.type === 'function_call_output') ? { text: 'feito' } : { calls: [{ name: 'propose_update_routine', args: { routineId: 'r1', changes: [{ op: 'rename_routine', name: 'Nova' }] } }] });
    const ra = await send(a.client, 'new', 'Renomeie minha ficha');
    const action = ra.events.find((e) => e.type === 'proposal')!.action;
    const convA = ra.events[0].conversationId;

    const b = await ready('b');
    fake.bodies = [];
    fake.plan = (body) =>
      body.input.some((i: any) => i.type === 'function_call_output')
        ? { text: 'nada' }
        : { calls: [{ name: 'get_routine', args: { routineId: 'r1' } }, { name: 'list_routines', args: {} }, { name: 'get_workout_details', args: { workoutSessionId: 's-new' } }, { name: 'get_exercise_progress', args: { exercise: 'supino' } }] };
    await send(b.client, 'new', 'Mostre a ficha r1');
    const outs = fake.toolOutputs();
    expect(outs[0]).toEqual({ error: 'Ficha não encontrada nesta conta.' });
    expect(outs[1].data).toEqual({ routines: [], total: 0 });
    expect(outs[2]).toEqual({ error: 'Treino não encontrado nesta conta.' });
    expect(outs[3].data.matches).toEqual([]);
    expect(JSON.stringify(fake.bodies)).not.toContain('ABC Hipertrofia');

    expect((await b.client.get(`/api/v1/assistant/conversations/${convA}`)).status).toBe(404);
    expect((await send(b.client, convA, 'oi')).status).toBe(404);
    expect((await b.client.post(`/api/v1/assistant/actions/${action.id}/approve`)).status).toBe(404);
    expect((await b.client.req('DELETE', `/api/v1/assistant/conversations/${convA}`)).status).toBe(404);
    expect((await routineRow(a.account.id)).doc.name).toBe('ABC Hipertrofia');
    expect((await b.client.get('/api/v1/assistant/conversations')).body.conversations.every((c: any) => c.id !== convA)).toBe(true);
  });
});

describe('ações de escrita com aprovação', () => {
  const addExercise = { routineId: 'r1', rationale: 'Mais volume de peito.', changes: [{ op: 'add_exercise', workoutId: 'wA', exercise: { name: 'Crucifixo', muscleGroup: 'Peito', category: 'isolation', equipment: 'dumbbell', sets: 3, repMin: 10, repMax: 12, restSec: 60 } }, { op: 'update_exercise', workoutId: 'wA', exerciseId: 'e1', changes: { sets: 4 } }] };

  it('proposta não grava nada; aprovar aplica, sobe a versão, entra na sincronização e registra o aviso', async () => {
    const { client, account } = await ready();
    await seed(account.id);
    const before = await routineRow(account.id);
    fake.plan = (body) => (body.input.some((i: any) => i.type === 'function_call_output') ? { text: 'Preparei a proposta: confira no cartão abaixo.' } : { calls: [{ name: 'propose_update_routine', args: addExercise }] });
    const r = await send(client, 'new', 'Adicione um crucifixo no treino A e mais uma série no supino');
    const p = r.events.find((e) => e.type === 'proposal')!.action;
    expect(p).toMatchObject({ kind: 'update_routine', status: 'pending', title: 'Alterar a ficha "ABC Hipertrofia"', rationale: 'Mais volume de peito.' });
    expect(JSON.stringify(p.preview)).toContain('Crucifixo (Peito) — 3×10–12');
    expect(JSON.stringify(p.preview)).toContain('Supino reto (Peito) — 3×8–10');
    expect(fake.toolOutputs()[0]).toMatchObject({ status: 'awaiting_user_approval', actionId: p.id });
    expect(await routineRow(account.id)).toEqual(before);
    expect(r.events.at(-1)!.message.actionIds).toEqual([p.id]);

    const ok = await client.post(`/api/v1/assistant/actions/${p.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.action).toMatchObject({ status: 'applied', result: { collection: 'routines', entityId: 'r1' } });
    const after = await routineRow(account.id);
    expect(after.version).toBe(before.version + 1);
    const w = after.doc.workouts[0];
    expect(w.exercises.map((e: any) => e.name)).toEqual(['Supino reto', 'Tríceps corda', 'Crucifixo']);
    expect(w.exercises[0].sets).toBe(4);
    expect(after.doc.profileId).toBe(account.dataProfileId);
    // o app recebe pela sincronização
    const pull = await client.get('/api/v1/sync/pull?cursor=0');
    expect(pull.body.changes.find((c: any) => c.entityId === 'r1').version).toBe(after.version);
    // duas vezes não
    expect((await client.post(`/api/v1/assistant/actions/${p.id}/approve`)).body.error.code).toBe('action_not_pending');
    const conv = await client.get(`/api/v1/assistant/conversations/${r.events[0].conversationId}`);
    expect(conv.body.conversation.messages.at(-1)).toMatchObject({ role: 'event', content: expect.stringContaining('aprovou e o app aplicou') });
    // o aviso vai como registro do app na próxima pergunta
    fake.plan = () => ({ text: 'ok' });
    await send(client, r.events[0].conversationId, 'Valeu');
    expect(fake.bodies.at(-1).input.at(-2).content).toMatch(/^\[Aviso automático do app\] A pessoa aprovou/);
  });

  it('cancelar não altera nada; ficha alterada depois da proposta é recusada (sem sobrescrever)', async () => {
    const { client, account } = await ready();
    await seed(account.id);
    fake.plan = (body) => (body.input.some((i: any) => i.type === 'function_call_output') ? { text: 'ok' } : { calls: [{ name: 'propose_update_routine', args: addExercise }] });
    const p1 = (await send(client, 'new', 'proponha')).events.find((e) => e.type === 'proposal')!.action;
    const rej = await client.post(`/api/v1/assistant/actions/${p1.id}/reject`);
    expect(rej.body.action.status).toBe('rejected');
    expect((await routineRow(account.id)).version).toBe(1);

    const p2 = (await send(client, 'new', 'proponha de novo')).events.find((e) => e.type === 'proposal')!.action;
    // outro aparelho altera a ficha antes da aprovação
    await applyPush(env.pool, account.id, uuid4(), [{ opId: uuid4(), collection: 'routines', entityId: 'r1', kind: 'put', baseVersion: 1, doc: { ...routineDoc(), name: 'Editada no celular' } }]);
    const stale = await client.post(`/api/v1/assistant/actions/${p2.id}/approve`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('action_stale');
    const row = await routineRow(account.id);
    expect(row.doc.name).toBe('Editada no celular');
    expect(row.doc.workouts[0].exercises).toHaveLength(2);
  });

  it('criar ficha após aprovação', async () => {
    const { client, account } = await ready();
    const args = {
      name: 'Full body 3x',
      workouts: [{ label: 'A', name: 'Corpo todo', exercises: [{ name: 'Agachamento', muscleGroup: 'Quadríceps', category: 'compound', equipment: 'barbell', sets: 3, repMin: 6, repMax: 8, restSec: 120, warmupSets: 1, targetWeight: null }] }],
    };
    fake.plan = (body) => (body.input.some((i: any) => i.type === 'function_call_output') ? { text: 'Proposta pronta.' } : { calls: [{ name: 'propose_create_routine', args }] });
    const p = (await send(client, 'new', 'Crie uma ficha full body')).events.find((e) => e.type === 'proposal')!.action;
    expect((await env.pool.query('SELECT count(*)::int AS n FROM routines WHERE user_id = $1', [account.id])).rows[0].n).toBe(0);
    const ok = await client.post(`/api/v1/assistant/actions/${p.id}/approve`);
    const id = ok.body.action.result.entityId;
    const row = await routineRow(account.id, id);
    expect(row.version).toBe(1);
    expect(row.doc).toMatchObject({ name: 'Full body 3x', workouts: [{ label: 'A', exercises: [{ name: 'Agachamento', sets: 3, repMin: 6, repMax: 8, restSec: 120, warmupSets: 1 }] }] });
    expect(row.doc.workouts[0].exercises[0].targetWeight).toBeUndefined();
  });

  it('ferramentas não autorizadas ou argumentos inválidos não executam nada', async () => {
    const { client, account } = await ready();
    await seed(account.id);
    fake.plan = (body) =>
      body.input.some((i: any) => i.type === 'function_call_output')
        ? { text: 'não consegui' }
        : {
            calls: [
              { name: 'run_sql', args: { sql: 'DELETE FROM routines' } },
              { name: 'propose_update_routine', args: { routineId: 'r1', changes: [{ op: 'drop_table' }] } },
              { name: 'propose_update_routine', args: { routineId: 'r1', changes: [{ op: 'remove_exercise', workoutId: 'wA', exerciseId: 'nao-existe' }] } },
              { name: 'get_routine', args: { routineId: 'r1', userId: 'outra-conta' } },
            ],
          };
    const r = await send(client, 'new', 'Apague tudo');
    const outs = fake.toolOutputs();
    expect(outs[0]).toEqual({ error: 'Ferramenta inexistente. Use apenas as ferramentas listadas.' });
    expect(outs[1].error).toMatch(/^Argumentos inválidos/);
    expect(outs[2].error).toMatch(/não existe no treino A/);
    expect(outs[3].error).toMatch(/^Argumentos inválidos/);
    expect(r.events.some((e) => e.type === 'proposal')).toBe(false);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM assistant_actions WHERE user_id = $1', [account.id])).rows[0].n).toBe(0);
    expect((await routineRow(account.id)).version).toBe(1);
  });
});

describe('memórias e limites', () => {
  it('preferência proposta pela IA só é salva com aprovação; entra no contexto rotulada; pode ser apagada', async () => {
    const { client } = await ready();
    fake.plan = (body) => (body.input.some((i: any) => i.type === 'function_call_output') ? { text: 'ok' } : { calls: [{ name: 'propose_save_preference', args: { content: 'Prefere treinos de até 45 minutos.' } }] });
    const r = await send(client, 'new', 'Lembre que prefiro treinos curtos');
    const p = r.events.find((e) => e.type === 'proposal')!.action;
    expect((await client.get('/api/v1/assistant/memories')).body.memories).toEqual([]);
    await client.post(`/api/v1/assistant/actions/${p.id}/approve`);
    expect((await client.get('/api/v1/assistant/memories')).body.memories).toMatchObject([{ content: 'Prefere treinos de até 45 minutos.', source: 'ai_approved' }]);
    fake.plan = () => ({ text: 'ok' });
    await send(client, 'new', 'Oi');
    expect(fake.bodies.at(-1).instructions).toContain('## Preferências salvas pela pessoa');
    expect(fake.bodies.at(-1).instructions).toContain('Prefere treinos de até 45 minutos.');
    expect((await client.req('DELETE', '/api/v1/assistant/memories')).body.deleted).toBe(1);
    expect((await client.req('DELETE', '/api/v1/assistant/conversations')).body.deleted).toBe(2);
  });

  it('e-mail não verificado bloqueia quando exigido; cota diária por conta', async () => {
    const local = await setupApi({ AI_REQUIRE_VERIFIED_EMAIL: 'true' }, { serviceEnv: assistantEnv({ limits: { ...BASE_CONFIG.limits, messagesPerDay: 2 } }), assistant: { fetch: fake.fetch } });
    try {
      const s = await signup(local);
      await s.client.post('/api/v1/assistant/notice', { version: 1 });
      const go = async () => {
        const res = await fetch(`${local.base}/api/v1/assistant/conversations/new/messages`, { method: 'POST', headers: { cookie: s.client.cookie, 'content-type': 'application/json', 'x-irontrack-csrf': '1', origin: 'http://localhost:4173' }, body: JSON.stringify({ content: 'Oi' }) });
        return { status: res.status, text: await res.text() };
      };
      expect((await go()).text).toContain('email_not_verified');
      await new Client(local).post('/api/v1/auth/verify-email', { token: linkToken(local.mailbox.for(s.email)[0].text) });
      fake.plan = () => ({ text: 'ok' });
      expect((await go()).status).toBe(200);
      expect((await go()).status).toBe(200);
      const third = await go();
      expect(third.status).toBe(429);
      expect(third.text).toContain('daily_limit');
    } finally {
      await local.close();
    }
  });
});
