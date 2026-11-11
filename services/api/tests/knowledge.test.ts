// Conhecimento (Fase 04): PostgreSQL real, relógio do servidor controlado. Cobre: livros e matérias (criação,
// validação, isolamento), cronômetro (tempo ativo, pausas, trechos sem presença, pomodoro, recuperação, reenvio),
// registros manuais conservadores, páginas e porcentagem, metas (progresso real, XP uma vez, estorno ao excluir),
// vínculo com hábito/missão sem XP duplicado, livro concluído, conquista de leitura e estatísticas sem "zeros".
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_REWARD, TIMER_RULES, addSeen, computeActive, sessionXp } from '../../../shared/knowledge/protocol.ts';
import { setupApi, signup, uuid4, type Client, type TestEnv } from './helpers.ts';

const TZ = 'America/Sao_Paulo';
const realToday = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const BASE = Date.parse(`${realToday}T13:00:00Z`); // 10:00 em São Paulo
let clock = BASE;
const MIN = 60_000;
const tick = (min: number) => {
  clock += min * MIN;
};
let env: TestEnv;
beforeAll(async () => {
  env = await setupApi({}, { lifeNow: () => clock });
});
afterAll(async () => {
  await env?.close();
});
beforeEach(() => {
  clock = BASE;
});

const today = realToday;
const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const K = '/api/v1/knowledge';

async function person(tag = 'kn') {
  const s = await signup(env, 'Pessoa Leitora', `${tag}.${uuid4().slice(0, 8)}@exemplo.test`);
  expect((await s.client.get(`/api/v1/life/dashboard?tz=${encodeURIComponent(TZ)}`)).status).toBe(200);
  return s;
}
const xpOf = async (userId: string, like: string) => (await env.pool.query("SELECT source_key, amount, reversed_at, kind, attribute FROM life_xp_events WHERE user_id = $1 AND source_key LIKE $2 ORDER BY created_at", [userId, like])).rows;
const totalXp = async (userId: string) => Number((await env.pool.query('SELECT total_xp FROM life_profiles WHERE user_id = $1', [userId])).rows[0].total_xp);
const book = async (c: Client, over: Record<string, unknown> = {}) => {
  const r = await c.post(`${K}/books`, { title: 'O Hobbit', author: 'J. R. R. Tolkien', totalPages: 300, status: 'reading', ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.book;
};
/** Cronômetro com sinais de presença a cada minuto durante `min` minutos. */
async function runFor(c: Client, id: string, min: number) {
  for (let i = 0; i < min; i++) {
    tick(1);
    if (i % 5 === 4 || i === min - 1) {
      const events = Array.from({ length: Math.min(5, i + 1) }, (_, k) => ({ type: 'seen', at: new Date(clock - (Math.min(5, i + 1) - 1 - k) * MIN).toISOString() }));
      expect((await c.post(`${K}/timer/${id}/events`, { events })).status).toBe(200);
    }
  }
}

describe('tempo ativo (função pura)', () => {
  it('pausas não contam; trechos sem presença contam até o limite; teto da sessão', () => {
    const t0 = 1_000_000_000_000;
    let seen = addSeen([], t0);
    for (let m = 1; m <= 20; m++) seen = addSeen(seen, t0 + m * MIN);
    expect(seen).toHaveLength(1);
    // 20 min com presença + 10 min pausado + 10 min com presença
    const segs = [{ s: t0, e: t0 + 20 * MIN }, { s: t0 + 30 * MIN, e: t0 + 40 * MIN }];
    for (let m = 30; m <= 40; m++) seen = addSeen(seen, t0 + m * MIN);
    const a = computeActive(segs, seen, t0 + 41 * MIN);
    expect(a.activeSec).toBe(30 * 60);
    expect(a.excludedSec).toBe(0);
    // 3 h sem nenhum sinal: só 1 h (limite por trecho) + a cobertura do primeiro sinal contam.
    const b = computeActive([{ s: t0, e: t0 + 180 * MIN }], [[t0, t0]], t0 + 180 * MIN);
    expect(b.activeSec).toBe(TIMER_RULES.seenCoverSec + TIMER_RULES.unattendedMaxSec);
    expect(b.excludedSec).toBe(180 * 60 - b.activeSec);
    // Trecho limitado (pomodoro de 25 min) e teto total.
    expect(computeActive([{ s: t0, e: t0 + 40 * MIN }], [[t0, t0 + 40 * MIN]], t0 + 40 * MIN, { segmentMaxMs: 25 * MIN }).activeSec).toBe(25 * 60);
    expect(computeActive([{ s: t0, e: null }], [[t0, t0 + 500 * MIN]], t0 + 500 * MIN).activeSec).toBe(TIMER_RULES.sessionMaxSec);
  });

  it('XP por duração: mínimo de 10 min, teto, manual pela metade', () => {
    expect(sessionXp(9 * 60, 'timer')).toBe(0);
    expect(sessionXp(10 * 60, 'timer')).toBe(5);
    expect(sessionXp(30 * 60, 'timer')).toBe(11);
    expect(sessionXp(5 * 3600, 'timer')).toBe(KNOWLEDGE_REWARD.sessionMax);
    expect(sessionXp(30 * 60, 'manual')).toBe(5);
    expect(sessionXp(5 * 3600, 'manual')).toBe(KNOWLEDGE_REWARD.manualMax);
  });
});

describe('livros, matérias e isolamento', () => {
  it('cria livro com progresso em %, valida páginas e matéria com tópicos', async () => {
    const { client, account } = await person();
    const b = await book(client, { currentPage: 75 });
    expect(b).toMatchObject({ title: 'O Hobbit', totalPages: 300, currentPage: 75, percent: 25, status: 'reading', startedOn: today });
    expect((await client.post(`${K}/books`, { title: 'X', totalPages: 10, currentPage: 11 })).status).toBe(422);
    expect((await client.post(`${K}/books`, { title: '' })).status).toBe(422);
    expect((await client.post(`${K}/books`, { title: 'Capa ruim', cover: 'javascript:alert(1)' })).status).toBe(422);
    const p = await client.req('PATCH', `${K}/books/${b.id}`, { version: b.version, patch: { currentPage: 400 } });
    expect(p.body.error.code).toBe('knowledge_pages');
    const s = await client.post(`${K}/subjects`, { name: 'Inglês', category: 'Idiomas', weeklyGoalMin: 180, topics: [{ title: 'Verb to be' }, { title: 'Present perfect' }] });
    expect(s.status).toBe(201);
    expect((await client.post(`${K}/subjects`, { name: 'inglês' })).status).toBe(422);
    const det = (await client.get(`${K}/subjects/${s.body.id}`)).body.subject;
    expect(det.topicList.map((x: any) => x.title)).toEqual(['Verb to be', 'Present perfect']);
    expect(det.topics).toEqual({ total: 2, done: 0, studying: 0 });
    const done = await client.req('PATCH', `${K}/topics/${det.topicList[0].id}`, { patch: { status: 'done' } });
    expect(done.body.topic.status).toBe('done');
    // Nenhum XP por cadastrar.
    expect(await xpOf(account.id, 'knowledge:%')).toHaveLength(0);
  });

  it('outra conta não vê nem altera livros, matérias, sessões ou o cronômetro', async () => {
    const a = await person('a');
    const b = await person('b');
    const bk = await book(a.client);
    const sj = (await a.client.post(`${K}/subjects`, { name: 'Matemática' })).body.id;
    const tid = uuid4();
    expect((await a.client.post(`${K}/timer`, { id: tid, kind: 'reading', mode: 'stopwatch', bookId: bk.id })).status).toBe(201);
    expect((await b.client.get(`${K}/books/${bk.id}`)).status).toBe(404);
    expect((await b.client.req('PATCH', `${K}/books/${bk.id}`, { patch: { title: 'invadido' } })).status).toBe(404);
    expect((await b.client.get(`${K}/subjects/${sj}`)).status).toBe(404);
    expect((await b.client.get(`${K}/books`)).body.books).toHaveLength(0);
    expect((await b.client.get(`${K}/timer`)).body.timer).toBeNull();
    expect((await b.client.post(`${K}/timer/${tid}/finish`, {})).body.error.code).toBe('knowledge_timer_missing');
    // Usar o livro de outra conta numa sessão: "não existe".
    expect((await b.client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'reading', bookId: bk.id, date: today, minutes: 20 })).status).toBe(422);
    expect((await b.client.post(`${K}/timer`, { id: uuid4(), kind: 'study', mode: 'stopwatch', subjectId: sj })).status).toBe(422);
    expect((await new (await import('./helpers.ts')).Client(env).get(`${K}/books`)).status).toBe(401);
  });
});

describe('cronômetro', () => {
  it('fluxo de leitura: pausa não conta, página alcançada atualiza o livro, XP uma vez (reenvio não soma)', async () => {
    const { client, account } = await person();
    const bk = await book(client, { currentPage: 40 });
    const id = uuid4();
    const st = await client.post(`${K}/timer`, { id, kind: 'reading', mode: 'stopwatch', bookId: bk.id });
    expect(st.body.timer).toMatchObject({ id, title: 'O Hobbit', phase: 'focus', startPage: 40 });
    // Repetir o início (aba duplicada) devolve o mesmo cronômetro; outro id é recusado.
    expect((await client.post(`${K}/timer`, { id, kind: 'reading', mode: 'stopwatch', bookId: bk.id })).body.timer.id).toBe(id);
    expect((await client.post(`${K}/timer`, { id: uuid4(), kind: 'study', mode: 'stopwatch' })).body.error.code).toBe('knowledge_timer_active');
    await runFor(client, id, 20);
    expect((await client.post(`${K}/timer/${id}/events`, { events: [{ type: 'pause' }] })).body.timer.phase).toBe('paused');
    tick(15); // pausa
    // Recarregar: o servidor devolve o cronômetro preservado.
    const again = (await client.get(`${K}/timer`)).body.timer;
    expect(again.id).toBe(id);
    expect(again.active.activeSec).toBe(20 * 60);
    expect((await client.post(`${K}/timer/${id}/events`, { events: [{ type: 'resume' }] })).body.timer.phase).toBe('focus');
    await runFor(client, id, 10);
    const fin = await client.post(`${K}/timer/${id}/finish`, { pageEnd: 70, note: 'Capítulo 3 ótimo' });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.session).toMatchObject({ id, activeMin: 30, pagesRead: 30, pageStart: 40, pageEnd: 70, origin: 'timer', mode: 'stopwatch', date: today, xp: sessionXp(30 * 60, 'timer') });
    expect(fin.body.session.pauseSec).toBe(15 * 60);
    expect(fin.body.outcome.xpGained).toBe(sessionXp(30 * 60, 'timer'));
    const b2 = (await client.get(`${K}/books/${bk.id}`)).body.book;
    expect(b2).toMatchObject({ currentPage: 70, percent: 23.3 });
    expect(b2.stats).toMatchObject({ minutes: 30, sessions: 1, pagesRead: 30 });
    // Reenvio do encerramento (rede caiu na resposta): mesma sessão, sem XP novo.
    const re = await client.post(`${K}/timer/${id}/finish`, { pageEnd: 70 });
    expect(re.body).toMatchObject({ id, existed: true });
    expect(re.body.outcome.xpGained).toBe(0);
    const grants = await xpOf(account.id, 'knowledge:session:%');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ amount: sessionXp(30 * 60, 'timer'), attribute: 'knowledge' });
    expect((await client.get(`${K}/timer`)).body.timer).toBeNull();
  });

  it('tela bloqueada/sem conexão: horas sem presença não viram horas de estudo; sessão interrompida é recuperável', async () => {
    const { client } = await person();
    const id = uuid4();
    await client.post(`${K}/timer`, { id, kind: 'study', mode: 'stopwatch', label: 'Artigo sobre IA' });
    tick(14 * 60); // esqueceu o cronômetro ligado
    const t = (await client.get(`${K}/timer`)).body.timer;
    expect(t.stale).toBe(true);
    expect(t.active.activeSec).toBe(TIMER_RULES.seenCoverSec + TIMER_RULES.unattendedMaxSec);
    expect(t.active.excludedSec).toBeGreaterThan(12 * 3600);
    // Pode reduzir (disse que estudou só 40 min), nunca aumentar.
    const fin = await client.post(`${K}/timer/${id}/finish`, { activeMin: 40 });
    expect(fin.body.session).toMatchObject({ activeMin: 40, title: 'Artigo sobre IA', kind: 'study' });
    expect(fin.body.session.excludedSec).toBeGreaterThan(12 * 3600);
  });

  it('eventos atrasados (fila offline) são limitados ao intervalo válido; sessão curta demais não salva', async () => {
    const { client } = await person();
    const id = uuid4();
    await client.post(`${K}/timer`, { id, kind: 'focus', mode: 'stopwatch' });
    tick(10);
    // Pausa "no futuro" vira agora; retomada "antes da pausa" vira o horário da pausa.
    const p = await client.post(`${K}/timer/${id}/events`, { events: [{ type: 'seen', at: new Date(clock - 5 * MIN).toISOString() }, { type: 'pause', at: new Date(clock + 60 * MIN).toISOString() }, { type: 'resume', at: new Date(clock - 30 * MIN).toISOString() }] });
    const segs = p.body.timer.segments;
    expect(segs[0].e).toBe(clock);
    expect(segs[1].s).toBe(clock);
    await client.req('DELETE', `${K}/timer/${id}`);
    const id2 = uuid4();
    await client.post(`${K}/timer`, { id: id2, kind: 'focus', mode: 'stopwatch' });
    clock += 30_000;
    expect((await client.post(`${K}/timer/${id2}/finish`, {})).status).toBe(422);
    expect((await client.req('DELETE', `${K}/timer/${id2}`)).status).toBe(200);
  });

  it('pomodoro: foco limitado ao configurado, pausas não contam, blocos contados', async () => {
    const { client } = await person();
    const sj = (await client.post(`${K}/subjects`, { name: 'Programação' })).body.id;
    const id = uuid4();
    const pomodoro = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4, autoContinue: true };
    const st = await client.post(`${K}/timer`, { id, kind: 'study', mode: 'pomodoro', subjectId: sj, pomodoro });
    expect(st.body.timer.phaseEndsAt).toBe(clock + 25 * MIN);
    await runFor(client, id, 30); // o app ficou aberto 5 min além do foco
    const br = await client.post(`${K}/timer/${id}/events`, { events: [{ type: 'break', at: new Date(BASE + 25 * MIN).toISOString() }] });
    expect(br.body.timer).toMatchObject({ phase: 'short_break', focusDone: 1, phaseEndsAt: BASE + 30 * MIN });
    expect(br.body.timer.active.activeSec).toBe(25 * 60);
    expect((await client.post(`${K}/timer/${id}/events`, { events: [{ type: 'resume' }] })).body.timer.phase).toBe('focus');
    await runFor(client, id, 25);
    const fin = await client.post(`${K}/timer/${id}/finish`, {});
    expect(fin.body.session).toMatchObject({ activeMin: 50, focusBlocks: 2, mode: 'pomodoro', subjectId: sj });
    expect(fin.body.session.pauseSec).toBe(5 * 60);
  });
});

describe('registros manuais, metas, vínculos e XP', () => {
  it('manual: conservador, idempotente por clientId, só hoje/ontem rende XP, teto manual diário', async () => {
    const { client, account } = await person();
    const bk = await book(client);
    const cid = uuid4();
    const m = await client.post(`${K}/sessions`, { clientId: cid, kind: 'reading', bookId: bk.id, date: addDays(today, -1), minutes: 40, pagesRead: 25 });
    expect(m.status).toBe(201);
    expect(m.body.session).toMatchObject({ origin: 'manual', mode: 'manual', activeMin: 40, pagesRead: 25, xp: sessionXp(40 * 60, 'manual') });
    expect((await client.post(`${K}/sessions`, { clientId: cid, kind: 'reading', bookId: bk.id, date: addDays(today, -1), minutes: 40 })).body.existed).toBe(true);
    expect((await client.get(`${K}/books/${bk.id}`)).body.book.currentPage).toBe(25);
    // Antigo (5 dias): salva para estatísticas, sem XP. Fora do limite (40 dias) ou futuro: recusado.
    expect((await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'study', label: 'Curso', date: addDays(today, -5), minutes: 90 })).body.session.xp).toBe(0);
    expect((await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'study', date: addDays(today, -40), minutes: 30 })).body.error.code).toBe('knowledge_date_not_allowed');
    expect((await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'study', date: addDays(today, 1), minutes: 30 })).body.error.code).toBe('knowledge_date_not_allowed');
    for (let i = 0; i < 4; i++) await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'study', label: `Bloco ${i}`, date: today, minutes: 300 });
    const manualToday = (await xpOf(account.id, 'knowledge:manual:%')).filter((g: any) => g.kind === 'grant');
    const sumToday = (await env.pool.query("SELECT coalesce(sum(amount),0)::int AS n FROM life_xp_events WHERE user_id = $1 AND day = $2 AND source_key LIKE 'knowledge:manual:%'", [account.id, today])).rows[0].n;
    expect(sumToday).toBe(KNOWLEDGE_REWARD.manualDailyMax);
    expect(manualToday.length).toBeGreaterThan(2);
  });

  it('meta diária: progresso real, XP uma vez; excluir a sessão estorna sessão e meta e devolve a página', async () => {
    const { client, account } = await person();
    const bk = await book(client, { currentPage: 10 });
    const g = await client.post(`${K}/goals`, { metric: 'minutes', scope: 'reading', period: 'daily', target: 30 });
    expect(g.status).toBe(201);
    const before = await totalXp(account.id);
    const id = uuid4();
    await client.post(`${K}/timer`, { id, kind: 'reading', mode: 'stopwatch', bookId: bk.id });
    await runFor(client, id, 32);
    const fin = await client.post(`${K}/timer/${id}/finish`, { pageEnd: 40 });
    const goals = (await client.get(`${K}/goals`)).body.goals;
    expect(goals[0]).toMatchObject({ title: 'Ler 30 min por dia', current: { progress: 32, met: true } });
    expect(goals[0].week.met).toBe(1);
    const gx = await xpOf(account.id, 'knowledge:goal:%');
    expect(gx).toHaveLength(1);
    expect(gx[0]).toMatchObject({ amount: KNOWLEDGE_REWARD.goalDaily, attribute: 'discipline' });
    expect(await totalXp(account.id)).toBe(before + fin.body.outcome.xpGained);
    // Segunda sessão no mesmo dia: a meta não paga de novo.
    const id2 = uuid4();
    await client.post(`${K}/timer`, { id: id2, kind: 'reading', mode: 'stopwatch', bookId: bk.id });
    await runFor(client, id2, 12);
    const f2 = await client.post(`${K}/timer/${id2}/finish`, {});
    expect(f2.body.outcome.xpGained).toBe(sessionXp(12 * 60, 'timer'));
    // Excluir a primeira: estorna a sessão; a meta continua? 12 min < 30 → estorna a meta também.
    const del = await client.req('DELETE', `${K}/sessions/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.outcome.xpReverted).toBe(sessionXp(32 * 60, 'timer') + KNOWLEDGE_REWARD.goalDaily);
    expect((await client.get(`${K}/books/${bk.id}`)).body.book.currentPage).toBe(10);
    expect((await client.get(`${K}/goals`)).body.goals[0].current).toMatchObject({ progress: 12, met: false });
  });

  it('meta vinculada a hábito: o hábito paga, a meta fica com 0 XP; sessão alimenta UMA missão só', async () => {
    const { client, account } = await person();
    const h = await client.post('/api/v1/life/habits', { name: 'Ler', attribute: 'knowledge', tag: 'reading', icon: 'book', frequency: 'daily', goalKind: 'duration', goalTarget: 20, goalUnit: 'min', xp: 15 });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    const ends = addDays(today, 6);
    const m1 = await client.post('/api/v1/life/missions', { type: 'custom', title: 'Ler 120 minutos', metric: 'manual', unit: 'minutes', tag: 'reading', target: 120, attribute: 'knowledge', endsOn: ends });
    const m2 = await client.post('/api/v1/life/missions', { type: 'custom', title: 'Ler 60 minutos', metric: 'manual', unit: 'minutes', tag: 'reading', target: 60, attribute: 'knowledge', endsOn: ends });
    expect(m1.status).toBe(201);
    await client.post(`${K}/goals`, { metric: 'minutes', scope: 'reading', period: 'daily', target: 20, habitId: h.body.id });
    await client.post(`${K}/goals`, { metric: 'minutes', scope: 'reading', period: 'weekly', target: 120, missionId: m1.body.id });
    await client.post(`${K}/goals`, { metric: 'minutes', scope: 'reading', period: 'weekly', target: 60, missionId: m2.body.id });
    const id = uuid4();
    await client.post(`${K}/timer`, { id, kind: 'reading', mode: 'stopwatch', label: 'Revista' });
    await runFor(client, id, 25);
    const fin = await client.post(`${K}/timer/${id}/finish`, {});
    expect(fin.status).toBe(200);
    const habitXp = await xpOf(account.id, `habit:${h.body.id}:%`);
    expect(habitXp).toHaveLength(1);
    expect(habitXp[0].amount).toBe(15);
    const goalXp = (await xpOf(account.id, 'knowledge:goal:%')).filter((x: any) => x.kind === 'grant');
    expect(goalXp.every((x: any) => x.amount === 0)).toBe(true);
    const entries = (await env.pool.query("SELECT mission_id, amount FROM life_mission_entries WHERE user_id = $1 AND source_key = $2", [account.id, `knowledge:session:${id}`])).rows;
    expect(entries).toEqual([{ mission_id: m1.body.id, amount: 25 }]);
    // Excluir a sessão desfaz o hábito e o registro na missão.
    await client.req('DELETE', `${K}/sessions/${id}`);
    expect((await xpOf(account.id, `habit:${h.body.id}:%`)).find((x: any) => x.kind === 'grant').reversed_at).not.toBeNull();
    expect((await env.pool.query('SELECT count(*)::int AS n FROM life_mission_entries WHERE user_id = $1', [account.id])).rows[0].n).toBe(0);
  });

  it('livro concluído: XP só com leitura registrada; conquistas de leitura; reabrir estorna', async () => {
    const { client, account } = await person();
    const quick = await book(client, { title: 'Livro relâmpago', totalPages: 100 });
    const p = await client.req('PATCH', `${K}/books/${quick.id}`, { version: quick.version, patch: { status: 'done', rating: 4, review: 'Bom' } });
    expect(p.body.book).toMatchObject({ status: 'done', currentPage: 100, percent: 100, finishedOn: today, rating: 4 });
    expect(await xpOf(account.id, 'knowledge:book:%')).toHaveLength(0);
    const bk = await book(client, { title: 'Livro longo', totalPages: 120 });
    const id = uuid4();
    await client.post(`${K}/timer`, { id, kind: 'reading', mode: 'stopwatch', bookId: bk.id });
    await runFor(client, id, 105);
    const fin = await client.post(`${K}/timer/${id}/finish`, { pageEnd: 120, finishBook: true });
    expect(fin.status).toBe(200);
    expect((await client.get(`${K}/books/${bk.id}`)).body.book.status).toBe('done');
    const bx = await xpOf(account.id, 'knowledge:book:%');
    expect(bx).toHaveLength(1);
    expect(bx[0].amount).toBe(KNOWLEDGE_REWARD.book);
    const ach = (await env.pool.query('SELECT code FROM life_achievements WHERE user_id = $1', [account.id])).rows.map((r: any) => r.code);
    expect(ach).toEqual(expect.arrayContaining(['reading_100', 'first_book']));
    const b2 = (await client.get(`${K}/books/${bk.id}`)).body.book;
    await client.req('PATCH', `${K}/books/${bk.id}`, { version: b2.version, patch: { status: 'reading' } });
    expect((await xpOf(account.id, 'knowledge:book:%'))[0].reversed_at).not.toBeNull();
  });
});

describe('painel e estatísticas', () => {
  it('dias sem registro ficam de fora (não viram zero); painel do dia; meta de "dias por semana"', async () => {
    const { client } = await person();
    const sj = (await client.post(`${K}/subjects`, { name: 'Inglês', weeklyGoalMin: 120 })).body.id;
    await client.post(`${K}/goals`, { metric: 'days', scope: 'study', subjectId: sj, period: 'weekly', target: 3 });
    await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'study', subjectId: sj, date: addDays(today, -3), minutes: 30 });
    await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'study', subjectId: sj, date: today, minutes: 45 });
    await client.post(`${K}/sessions`, { clientId: uuid4(), kind: 'reading', label: 'Artigo', date: today, minutes: 15, pagesRead: 8 });
    const st = (await client.get(`${K}/stats?from=${addDays(today, -6)}&to=${today}`)).body.stats;
    expect(st.days.map((d: any) => d.date)).toEqual([addDays(today, -3), today]);
    expect(st.totals).toMatchObject({ minutes: 90, daysWithRecords: 2, daysInRange: 7, pages: 8 });
    expect(st.bySubject.find((x: any) => x.id === sj).minutes).toBe(75);
    const dash = (await client.get(`${K}/dashboard?tz=${encodeURIComponent(TZ)}`)).body;
    expect(dash).toMatchObject({ today, studyMin: 45, readingMin: 15, sessionsToday: 2, pagesToday: 8 });
    expect(dash.week.find((w: any) => w.date === addDays(today, -1)).study).toBeNull();
    expect(dash.week.find((w: any) => w.date === today).study).toBe(45);
    expect(dash.subjectsWeek[0]).toMatchObject({ name: 'Inglês', goal: 120 });
    const g = (await client.get(`${K}/goals`)).body.goals[0];
    expect(g.title).toBe('Estudar Inglês 3× (dias) por semana');
    const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
    expect(g.current.progress).toBe(addDays(today, -3) >= monday ? 2 : 1);
    expect(g.current.met).toBe(false);
  });
});
