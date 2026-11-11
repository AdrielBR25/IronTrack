// Bíblia (Fase 05): texto empacotado (integridade, licença, referências), versículo do dia, navegação, planos,
// cronômetro reaproveitado da Fase 04 com capítulos, XP sem duplicação, conquistas e isolamento entre contas.
// PostgreSQL real e relógio do servidor controlado. Nenhuma chamada à OpenAI.
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOOKS, TOTAL_CHAPTERS, TRANSLATION, chaptersBetween, findBook, formatKey, nextChapter, parseQuery, prevChapter, verseCount } from '../../../shared/bible/canon.ts';
import { BPM_INDEX } from '../../../shared/bible/data/bpm/index.ts';
import { PLAN_TEMPLATES, reschedule, templateSchedule } from '../../../shared/bible/plans.ts';
import { BIBLE_REWARD } from '../../../shared/bible/protocol.ts';
import { CURATED, VERSE_THEMES, dailyIndex, seedOf } from '../../../shared/bible/verses.ts';
import { passageByKey, search, verifyAll } from '../src/bible/text.ts';
import { setupApi, signup, uuid4, type Client, type TestEnv } from './helpers.ts';

const TZ = 'America/Sao_Paulo';
const realToday = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const BASE = Date.parse(`${realToday}T13:00:00Z`);
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
const B = '/api/v1/bible';
const tzq = `tz=${encodeURIComponent(TZ)}`;

async function person(tag = 'bb') {
  const s = await signup(env, 'Pessoa Leitora', `${tag}.${uuid4().slice(0, 8)}@exemplo.test`);
  expect((await s.client.get(`/api/v1/life/dashboard?${tzq}`)).status).toBe(200);
  return s;
}
const xpOf = async (userId: string, like: string) => (await env.pool.query('SELECT source_key, amount, reversed_at, kind, attribute FROM life_xp_events WHERE user_id = $1 AND source_key LIKE $2 ORDER BY created_at', [userId, like])).rows;
async function runFor(c: Client, id: string, min: number) {
  for (let i = 0; i < min; i++) {
    tick(1);
    if (i % 5 === 4 || i === min - 1) {
      const n = Math.min(5, i + 1);
      const events = Array.from({ length: n }, (_, k) => ({ type: 'seen', at: new Date(clock - (n - 1 - k) * MIN).toISOString() }));
      expect((await c.post(`/api/v1/knowledge/timer/${id}/events`, { events })).status).toBe(200);
    }
  }
}

describe('texto bíblico empacotado', () => {
  it('integridade: 66 livros, 1189 capítulos, 31103 versículos; hashes conferem; numeração contínua', () => {
    expect(verifyAll()).toEqual({ books: 66, chapters: 1189, verses: 31103 });
    expect(TOTAL_CHAPTERS).toBe(1189);
    expect(BOOKS.filter((b) => b.testament === 'OT')).toHaveLength(39);
    expect(BOOKS.filter((b) => b.testament === 'NT')).toHaveLength(27);
    const files = readdirSync(new URL('../../../shared/bible/data/bpm/', import.meta.url)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(66);
  });

  it('licença e atribuição registradas: BPM, domínio público, fonte e data', () => {
    expect(BPM_INDEX).toMatchObject({ translation: 'BPM', ebibleId: 'porbrbsl', license: 'Domínio público', sourceDate: '2026-04-25' });
    expect(BPM_INDEX.licenseUrl).toMatch(/^https:\/\/ebible\.org\//);
    expect(TRANSLATION.credit).toContain('domínio público');
    expect(TRANSLATION.draftNotice).toBeTruthy();
    const doc = readFileSync(new URL('../../../docs/BIBLIA.md', import.meta.url), 'utf8');
    expect(doc).toContain('porbrbsl');
    expect(doc).toMatch(/dom[ií]nio p[uú]blico/i);
  });

  it('versículos conhecidos vêm exatamente do arquivo; versículo ausente no texto-base fica marcado, não inventado', () => {
    const jo = passageByKey('JHN.3.16');
    expect(jo.label).toBe('João 3:16');
    expect(jo.verses[0].text).toMatch(/^Porque Deus amou o mundo de tal maneira/);
    expect(passageByKey('GEN.1.1').verses[0].text).toMatch(/princípio/);
    const omitted = passageByKey('LUK.17.36').verses[0];
    expect(omitted.omitted).toBe(true);
    expect(omitted.text).toBe('');
    expect(verseCount('PSA', 119)).toBe(176);
    expect(verseCount('MAL', 4)).toBe(6);
    const s = search('amou mundo maneira', { book: 'JHN' });
    expect(s.hits.map((h) => h.ref)).toContain('JHN.3.16');
    expect(search('xyzabc').total).toBe(0);
  });

  it('seleção do versículo do dia: só referências válidas, sem cortar frase e em todos os temas', () => {
    for (const p of CURATED) {
      const x = passageByKey(p.ref);
      expect(x.verses.every((v) => !v.omitted && v.text.length > 0), p.ref).toBe(true);
      const last = x.verses[x.verses.length - 1].text.trim();
      expect(/[.!?»”"’)]$/.test(last) || p.context, `${p.ref} termina no meio da frase sem contexto`).toBeTruthy();
    }
    for (const t of VERSE_THEMES) expect(CURATED.some((p) => p.theme === t), t).toBe(true);
    expect(new Set(CURATED.map((p) => p.ref)).size).toBe(CURATED.length);
  });
});

describe('referências e navegação', () => {
  it('busca por referência, livros com acento, inválidos e texto', () => {
    expect(parseQuery('João 3:16')).toEqual({ kind: 'ref', ref: { b: 'JHN', c: 3, v1: 16 } });
    expect(parseQuery('jo 3.16-18')).toEqual({ kind: 'ref', ref: { b: 'JHN', c: 3, v1: 16, v2: 18 } });
    expect(findBook('Jó')?.id).toBe('JOB');
    expect(findBook('1 coríntios')?.id).toBe('1CO');
    expect(parseQuery('Salmo 23')).toEqual({ kind: 'ref', ref: { b: 'PSA', c: 23 } });
    expect(parseQuery('João 22').kind).toBe('invalid');
    expect(parseQuery('João 3:99').kind).toBe('invalid');
    expect(parseQuery('graça e paz').kind).toBe('text');
    expect(formatKey('PHP.4.13')).toBe('Filipenses 4:13');
  });

  it('capítulo anterior/próximo atravessa livros e para nas pontas', () => {
    expect(nextChapter({ b: 'MAL', c: 4 })).toEqual({ b: 'MAT', c: 1 });
    expect(prevChapter({ b: 'MAT', c: 1 })).toEqual({ b: 'MAL', c: 4 });
    expect(prevChapter({ b: 'GEN', c: 1 })).toBeNull();
    expect(nextChapter({ b: 'REV', c: 22 })).toBeNull();
    expect(chaptersBetween({ b: 'JHN', c: 20 }, { b: 'ACT', c: 2 }, 150).map((x) => `${x.b}.${x.c}`)).toEqual(['JHN.20', 'JHN.21', 'ACT.1', 'ACT.2']);
  });
});

describe('planos (funções puras)', () => {
  it('modelos cobrem o que prometem; Bíblia completa em 365 dias com todos os capítulos uma vez', () => {
    const whole = templateSchedule('whole');
    expect(whole).toHaveLength(365);
    const all = whole.flat();
    expect(all).toHaveLength(1189);
    expect(new Set(all).size).toBe(1189);
    expect(templateSchedule('proverbs')).toHaveLength(31);
    expect(templateSchedule('gospels').flat()[0]).toBe('MAT.1');
    for (const t of PLAN_TEMPLATES) expect(templateSchedule(t).every((d) => d.length > 0), t).toBe(true);
  });

  it('reorganizar mantém os dias concluídos e redistribui só o que falta', () => {
    const s = templateSchedule('proverbs');
    const r = reschedule(s, new Set([0, 1, 2]), 7);
    expect(r.schedule.slice(0, 3)).toEqual(s.slice(0, 3));
    expect(r.schedule).toHaveLength(10);
    expect(r.schedule.slice(3).flat()).toEqual(s.slice(3).flat());
  });
});

describe('versículo do dia (API)', () => {
  it('estável ao atualizar, determinístico por conta e data, histórico e "outra passagem"', async () => {
    const { client, account } = await person();
    const a = (await client.get(`${B}/verse?${tzq}`)).body.verse;
    const b = (await client.get(`${B}/verse?${tzq}`)).body.verse;
    expect(a.passage.ref).toBe(b.passage.ref);
    expect(a.date).toBe(today);
    expect(a.passage.translation).toBe('BPM');
    expect(a.passage.ref).toBe(CURATED[dailyIndex(seedOf(account.id), today)].ref);
    const other = (await client.post(`${B}/verse/another?${tzq}`, {})).body.verse;
    expect(other.seq).toBe(1);
    expect(other.passage.ref).not.toBe(a.passage.ref);
    // A principal do dia não muda depois de pedir outra.
    expect((await client.get(`${B}/verse?${tzq}`)).body.verse.passage.ref).toBe(a.passage.ref);
    const hist = (await client.get(`${B}/verse/history`)).body.verses;
    expect(hist.map((v: any) => v.seq)).toEqual([1, 0]);
  });

  it('o dia segue o fuso da conta (perto da meia-noite)', async () => {
    const { client } = await person();
    // 01:30 UTC = 22:30 do dia anterior em São Paulo.
    clock = Date.parse(`${today}T01:30:00Z`);
    const v = (await client.get(`${B}/verse?${tzq}`)).body.verse;
    expect(v.date).toBe(addDays(today, -1));
  });

  it('modo "só quando eu pedir" não mostra versículo no painel', async () => {
    const { client } = await person();
    const p = await client.req('PATCH', `${B}/prefs`, { patch: { verseMode: 'on_request' } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const h = (await client.get(`${B}/home?${tzq}`)).body;
    expect(h.verse).toBeNull();
    expect(h.prefs.verseMode).toBe('on_request');
  });
});

describe('leitura, sessões e XP', () => {
  it('cronômetro bíblico: capítulos do início ao alcançado, sessão com referência, XP de espiritualidade uma vez', async () => {
    const { client, account } = await person();
    const id = uuid4();
    const st = await client.post(`${B}/timer?${tzq}`, { id, ref: 'JHN.1', mode: 'stopwatch' });
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    expect(st.body.timer).toMatchObject({ id, module: 'bible', ref: 'JHN.1' });
    // O cronômetro é o mesmo da Fase 04: não dá para abrir um segundo.
    expect((await client.post('/api/v1/knowledge/timer', { id: uuid4(), kind: 'study', mode: 'stopwatch' })).body.error.code).toBe('knowledge_timer_active');
    await runFor(client, id, 20);
    const fin = await client.post(`${B}/timer/${id}/finish?${tzq}`, { reached: 'JHN.3' });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.session).toMatchObject({ activeMin: 20, ref: 'JHN.1-JHN.3', module: 'bible' });
    expect(fin.body.session.pageEnd ?? null).toBeNull(); // capítulo não vira página
    const logs = (await env.pool.query("SELECT book || '.' || chapter AS k, source FROM bible_chapter_logs WHERE user_id = $1 ORDER BY chapter", [account.id])).rows;
    expect(logs).toEqual([{ k: 'JHN.1', source: 'session' }, { k: 'JHN.2', source: 'session' }, { k: 'JHN.3', source: 'session' }]);
    const xp = await xpOf(account.id, 'bible:session:%');
    expect(xp).toHaveLength(1);
    expect(xp[0].attribute).toBe('spirituality');
    expect(xp[0].amount).toBeGreaterThan(0);
    // Reenvio não soma; a sessão não aparece no Conhecimento.
    expect((await client.post(`${B}/timer/${id}/finish?${tzq}`, { reached: 'JHN.3' })).body.outcome.xpGained).toBe(0);
    expect((await client.get(`/api/v1/knowledge/sessions?from=${today}&to=${today}&${tzq}`)).body.sessions).toHaveLength(0);
    expect((await client.get(`${B}/sessions?${tzq}`)).body.sessions).toHaveLength(1);
    // Excluir a sessão estorna o XP e tira os capítulos.
    expect((await client.req('DELETE', `${B}/sessions/${id}?${tzq}`)).status).toBe(200);
    expect((await xpOf(account.id, 'bible:session:%')).find((x: any) => x.kind === 'grant').reversed_at).not.toBeNull();
    expect((await client.get(`${B}/progress`)).body.progress.chaptersRead).toBe(0);
  });

  it('marcar como lido é idempotente e não rende XP sozinho; datas muito antigas são recusadas', async () => {
    const { client, account } = await person();
    const r = await client.post(`${B}/read?${tzq}`, { chapters: ['PSA.23', 'PSA.23'] });
    expect(r.body.added).toEqual(['PSA.23']);
    expect((await client.post(`${B}/read?${tzq}`, { chapters: ['PSA.23'] })).body.added).toEqual([]);
    expect((await client.post(`${B}/read?${tzq}`, { chapters: ['PSA.24'], date: addDays(today, -60) })).body.error.code).toBe('bible_date_not_allowed');
    expect((await client.post(`${B}/read?${tzq}`, { chapters: ['XYZ.1'] })).status).toBe(422);
    expect((await xpOf(account.id, 'bible:%')).length).toBe(0);
  });

  it('plano: progresso, dia concluído dá XP com teto diário, conclusão exige datas suficientes, pausar mantém histórico', async () => {
    const { client, account } = await person();
    const c = await client.post(`${B}/plans?${tzq}`, { books: ['RUT'], days: 4, title: 'Rute' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const plan = c.body.plan;
    expect(plan).toMatchObject({ totalDays: 4, doneDays: 0, status: 'active' });
    expect(plan.next.day).toBe(0);
    const d0 = await client.post(`${B}/plans/${plan.id}/days/0?${tzq}`, {});
    expect(d0.body.plan.doneDays).toBe(1);
    expect((await xpOf(account.id, `bible:planday:${plan.id}:0`))[0].amount).toBe(BIBLE_REWARD.planDay);
    expect((await client.post(`${B}/plans/${plan.id}/days/0?${tzq}`, {})).body.already).toBe(true);
    await client.post(`${B}/plans/${plan.id}/days/1?${tzq}`, {});
    await client.post(`${B}/plans/${plan.id}/days/2?${tzq}`, {});
    expect((await xpOf(account.id, `bible:planday:${plan.id}:2`))[0].amount).toBe(0); // teto de dias com XP por dia
    // Pausar e retomar: os dias concluídos continuam.
    const pz = await client.req('PATCH', `${B}/plans/${plan.id}?${tzq}`, { patch: { status: 'paused' } });
    expect(pz.body.plan.status).toBe('paused');
    expect((await client.post(`${B}/plans/${plan.id}/days/3?${tzq}`, {})).body.error.code).toBe('bible_plan_inactive');
    const back = await client.req('PATCH', `${B}/plans/${plan.id}?${tzq}`, { patch: { status: 'active' } });
    expect(back.body.plan.doneDays).toBe(3);
    const done = await client.post(`${B}/plans/${plan.id}/days/3?${tzq}`, {});
    expect(done.body.plan.status).toBe('completed');
    // Tudo num dia só: plano concluído, mas sem o bônus (evita "concluir" um plano em minutos).
    const bonus = await xpOf(account.id, `bible:plan:${plan.id}`);
    expect(bonus).toHaveLength(1);
    expect(bonus[0].amount).toBe(0);
    expect((await client.get(`${B}/progress`)).body.progress.chaptersRead).toBe(4);
    // Conquista "primeiro plano concluído" e "primeira leitura".
    const ach = (await env.pool.query("SELECT code FROM life_achievements WHERE user_id = $1 AND code LIKE 'bible_%'", [account.id])).rows.map((r: any) => r.code);
    expect(ach).toEqual(expect.arrayContaining(['bible_first', 'bible_plan']));
  });

  it('reorganizar o plano mantém os concluídos; atrasado é só informativo', async () => {
    const { client } = await person();
    const plan = (await client.post(`${B}/plans?${tzq}`, { template: 'proverbs', startDate: addDays(today, -10) })).body.plan;
    expect(plan.behind).toBeGreaterThan(0);
    await client.post(`${B}/plans/${plan.id}/days/0?${tzq}`, {});
    const r = await client.req('PATCH', `${B}/plans/${plan.id}?${tzq}`, { patch: { remainingDays: 10 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.plan).toMatchObject({ totalDays: 11, doneDays: 1 });
  });

  it('meta de capítulos vinculada a hábito: o hábito paga, a meta não duplica XP', async () => {
    const { client, account } = await person();
    const h = await client.post('/api/v1/life/habits', { name: 'Ler a Bíblia', attribute: 'spirituality', tag: 'bible', icon: 'book', frequency: 'daily', goalKind: 'check', xp: 10 });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    const g = await client.post(`${B}/goals?${tzq}`, { metric: 'chapters', period: 'daily', target: 2, habitId: h.body.id });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    await client.post(`${B}/read?${tzq}`, { chapters: ['PRO.1'] });
    expect((await client.get(`${B}/goals?${tzq}`)).body.goals[0].current).toMatchObject({ progress: 1, met: false });
    await client.post(`${B}/read?${tzq}`, { chapters: ['PRO.2'] });
    const goal = (await client.get(`${B}/goals?${tzq}`)).body.goals[0];
    expect(goal.current.met).toBe(true);
    expect(goal.module).toBe('bible');
    const habitXp = (await xpOf(account.id, `habit:${h.body.id}:%`)).filter((x: any) => x.kind === 'grant');
    expect(habitXp).toHaveLength(1);
    expect((await xpOf(account.id, 'knowledge:goal:%')).every((x: any) => x.amount === 0)).toBe(true);
    // Metas da Bíblia não aparecem no Conhecimento.
    expect((await client.get(`/api/v1/knowledge/goals?${tzq}`)).body.goals).toHaveLength(0);
  });

  it('dez capítulos e sete dias com leitura liberam as conquistas uma vez', async () => {
    const { client, account } = await person();
    for (let i = 0; i < 7; i++) {
      const date = addDays(today, -i);
      const r = await client.post(`${B}/read?${tzq}`, { chapters: [`MRK.${i * 2 + 1}`, `MRK.${i * 2 + 2}`], date });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    await client.post(`${B}/read?${tzq}`, { chapters: ['MRK.1'] });
    const ach = (await env.pool.query("SELECT code FROM life_achievements WHERE user_id = $1 AND code LIKE 'bible_%' ORDER BY code", [account.id])).rows.map((r: any) => r.code);
    expect(ach).toEqual(expect.arrayContaining(['bible_10_chapters', 'bible_first', 'bible_week']));
    expect(new Set(ach).size).toBe(ach.length);
  });
});

describe('favoritos, reflexões e privacidade', () => {
  it('favorito idempotente; reflexão idempotente por clientId, busca e edição com versão', async () => {
    const { client } = await person();
    const f1 = await client.post(`${B}/marks`, { kind: 'favorite', ref: 'PHP.4.13', tags: ['coragem'] });
    expect(f1.status).toBe(201);
    expect((await client.post(`${B}/marks`, { kind: 'favorite', ref: 'PHP.4.13' })).status).toBe(200);
    const marks = (await client.get(`${B}/marks?kind=favorite&text=1`)).body.marks;
    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe(passageByKey('PHP.4.13').verses[0].text);
    const clientId = uuid4();
    const r1 = await client.post(`${B}/reflections?${tzq}`, { clientId, kind: 'gratitude', content: 'Grato pela família.', ref: 'PSA.23', tags: ['família'] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect((await client.post(`${B}/reflections?${tzq}`, { clientId, kind: 'gratitude', content: 'Grato pela família.' })).status).toBe(200);
    expect((await client.get(`${B}/reflections?q=familia`)).body.reflections).toHaveLength(1);
    const up = await client.req('PATCH', `${B}/reflections/${r1.body.reflection.id}?${tzq}`, { version: r1.body.reflection.version, patch: { favorite: true } });
    expect(up.body.reflection.favorite).toBe(true);
    expect((await client.req('PATCH', `${B}/reflections/${r1.body.reflection.id}?${tzq}`, { version: 1, patch: { title: 'x' } })).status).toBe(409);
  });

  it('outra conta não vê nem altera favoritos, reflexões, planos, sessões ou metas', async () => {
    const a = await person('a');
    const b = await person('b');
    const mark = (await a.client.post(`${B}/marks`, { kind: 'favorite', ref: 'JHN.3.16' })).body.mark;
    const refl = (await a.client.post(`${B}/reflections?${tzq}`, { clientId: uuid4(), content: 'Particular.' })).body.reflection;
    const plan = (await a.client.post(`${B}/plans?${tzq}`, { template: 'proverbs' })).body.plan;
    const goal = (await a.client.post(`${B}/goals?${tzq}`, { metric: 'minutes', period: 'daily', target: 15 })).body;
    expect((await b.client.get(`${B}/marks`)).body.marks).toHaveLength(0);
    expect((await b.client.get(`${B}/reflections`)).body.reflections).toHaveLength(0);
    expect((await b.client.get(`${B}/plans?${tzq}`)).body.plans).toHaveLength(0);
    expect((await b.client.get(`${B}/plans/${plan.id}?${tzq}`)).status).toBe(404);
    expect((await b.client.post(`${B}/plans/${plan.id}/days/0?${tzq}`, {})).status).toBe(404);
    expect((await b.client.req('PATCH', `${B}/reflections/${refl.id}?${tzq}`, { patch: { content: 'hack' } })).status).toBe(404);
    expect((await b.client.req('DELETE', `${B}/goals/${goal.id}?${tzq}`)).status).toBe(404);
    await b.client.req('DELETE', `${B}/marks/${mark.id}`);
    expect((await a.client.get(`${B}/marks`)).body.marks).toHaveLength(1);
    expect((await a.client.get(`${B}/reflections`)).body.reflections[0].content).toBe('Particular.');
  });
});
