// Fontes de contexto do assistente (P05): leitura mínima do banco, dados ausentes, nenhuma
// gravação e detecção de mudanças (inclusive por outra conexão, como outra aba). Dados fictícios.
import { beforeEach, describe, expect, it } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { contextFingerprint, loadContextSources, watchContextSources, ASSISTANT_CATEGORIES } from '@/integrations/ai/contextSources';
import { buildAIContext } from '@/modules/ai';
import { addDays, fromISODate, todayISO } from '@/lib/dates';
import { entry, photo, session, settings } from './fixtures';

let n = 0;
let name = '';
const PROFILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

beforeEach(async () => {
  name = `assistant-src-${++n}`;
  setDb(new IronTrackDB(name));
  await db.open();
});

const recent = (daysAgo: number) => fromISODate(addDays(todayISO(), -daysAgo)).getTime() + 10 * 3600_000;

async function seed() {
  await db.settings.put(settings({ userName: 'Pessoa Fictícia', trainingDays: [1, 3, 5], goal: 'hypertrophy' }));
  await db.sessions.bulkPut([
    session('s-11111111-2222-4333-8444-555555555555', { startedAt: recent(2), notes: 'observação pessoal', profileId: PROFILE }),
    session('s2', { startedAt: recent(5) }),
    session('s-old', { startedAt: recent(200) }),
    session('s-active', { status: 'active', startedAt: recent(0) }),
  ]);
  await db.bodyEntries.bulkPut([
    entry('b1', { date: '2026-01-10', notes: 'nota da avaliação', skinfolds: { Tricipital: 12 }, profileId: PROFILE }),
    entry('b2', { date: '2026-02-10', weightKg: 79 }),
  ]);
  await db.photos.put(photo('p1', 'b1'));
}

async function dump() {
  return JSON.stringify(await Promise.all([db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos, db.profiles].map((t) => t.toArray())));
}

describe('fontes de contexto do assistente', () => {
  it('sem categorias, nada é lido nem oferecido', async () => {
    await seed();
    expect(await loadContextSources([])).toEqual({});
  });

  it('lê só as categorias pedidas', async () => {
    await seed();
    const s = await loadContextSources(['body_measurements']);
    expect(Object.keys(s)).toEqual(['bodyEntries']);
  });

  it('resumos mínimos: sem IDs, profileId, nome, observações, dobras ou fotos', async () => {
    await seed();
    const s = await loadContextSources(ASSISTANT_CATEGORIES);
    const json = JSON.stringify(s);
    for (const bad of ['profileId', PROFILE, 's-11111111', '"id"', 'observação pessoal', 'nota da avaliação', 'Tricipital', 'Pessoa Fictícia', 'data:image', 'routineId', 'workoutId'])
      expect(json).not.toContain(bad);
    expect(s.trainingSummary).toMatchObject({ periodDays: 28, sessions: 2 });
    expect(s.trainingSessions).toHaveLength(3); // só concluídas (a ativa fica fora)
    expect(s.bodyEntries?.map((e) => e.date)).toEqual(['2026-02-10', '2026-01-10']);
    expect(s.bodyEvolution?.find((c) => c.metric.key === 'weightKg')).toMatchObject({ first: 80, last: 79, delta: -1 });
    expect(s.profilePreferences).toEqual({ weightUnit: 'kg', trainingDays: [1, 3, 5], goal: 'Hipertrofia' });
    const ctx = buildAIContext(s, ASSISTANT_CATEGORIES);
    // Sem metas cadastradas, a categoria fica fora (sem dados); nada é inventado.
    expect(ctx.included).toEqual(ASSISTANT_CATEGORIES.filter((c) => c !== 'training_goals'));
  });

  it('dados ausentes: nada é inventado e a categoria aparece como "sem dados"', async () => {
    const cats = ['training_summary', 'training_history', 'body_measurements', 'body_evolution'] as const;
    const s = await loadContextSources(cats);
    expect(s).toEqual({});
    const ctx = buildAIContext(s, cats);
    expect(ctx.included).toEqual([]);
    expect(ctx.excluded.map((x) => x.reason)).toEqual(['no_data', 'no_data', 'no_data', 'no_data']);
  });

  it('uma avaliação só: medidas sim, evolução não', async () => {
    await db.bodyEntries.put(entry('b1'));
    const s = await loadContextSources(['body_measurements', 'body_evolution']);
    expect(s.bodyEntries).toHaveLength(1);
    expect(s.bodyEvolution).toBeUndefined();
  });

  it('respeita os limites do Prompt 04 (12 treinos)', async () => {
    await db.sessions.bulkPut(Array.from({ length: 20 }, (_, i) => session(`s${i}`, { startedAt: recent(i + 1) })));
    const s = await loadContextSources(['training_history']);
    expect(s.trainingSessions).toHaveLength(12);
  });

  it('nenhuma leitura modifica treinos, avaliações, fotos, perfil ou configurações', async () => {
    await seed();
    const before = await dump();
    await loadContextSources(ASSISTANT_CATEGORIES);
    await loadContextSources(['training_history']);
    expect(await dump()).toBe(before);
  });

  it('impressão digital muda quando um registro usado muda, e só então', async () => {
    await seed();
    const cats = ['body_measurements'] as const;
    const a = contextFingerprint(await loadContextSources(cats), cats);
    await db.sessions.put(session('s-new', { startedAt: recent(1) })); // categoria não usada
    expect(contextFingerprint(await loadContextSources(cats), cats)).toBe(a);
    await db.bodyEntries.update('b2', { weightKg: 78 });
    expect(contextFingerprint(await loadContextSources(cats), cats)).not.toBe(a);
  });

  it('observa mudanças feitas por outra conexão ao mesmo banco (como outra aba)', async () => {
    await seed();
    const seen: number[] = [];
    const stop = watchContextSources(['body_measurements'], (s) => seen.push(s.bodyEntries?.[0]?.weightKg ?? -1));
    await expect.poll(() => seen.length).toBe(1);
    const otherTab = new IronTrackDB(name);
    await otherTab.open();
    await otherTab.bodyEntries.update('b2', { weightKg: 77 });
    await expect.poll(() => seen.at(-1)).toBe(77);
    stop();
    otherTab.close();
  });
});
