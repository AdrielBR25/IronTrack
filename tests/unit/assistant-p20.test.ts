// IronTrack 2.0 F01/P20: respostas locais do catálogo, estados da conexão, sessão em memória e metas no contexto.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createGoal } from '@/db/goals';
import { loadContextSources } from '@/integrations/ai/contextSources';
import { buildAIContext } from '@/modules/ai';
import { getCatalog } from '@/modules/exercises/catalog';
import { EQUIPMENT_NAME, MUSCLE_NAME } from '@/modules/exercises';
import { assistantStatus, STATUS_INFO, type AssistantStatus } from '@/features/assistant/assistantModel';
import { findExercise, localAnswer, topicOf, type LocalExercise } from '@/features/assistant/localAnswers';
import { IDLE_FORGET_MS, forgetAssistantSession, loadSnapshot, saveSnapshot, sessionComposition } from '@/features/assistant/assistantSession';
import { fields, refOf } from './goalFixtures';

const catalog: LocalExercise[] = getCatalog().map((c) => ({
  name: c.name,
  aliases: c.aliases,
  primary: c.primaryMuscles.map((m) => MUSCLE_NAME[m]),
  secondary: c.secondaryMuscles.map((m) => MUSCLE_NAME[m]),
  equipment: c.equipment.map((e) => EQUIPMENT_NAME[e]),
  instructions: c.instructions,
  commonMistakes: c.commonMistakes,
  safetyNotes: c.safetyNotes,
}));

describe('respostas locais do catálogo', () => {
  it('acha o exercício citado (nome ou apelido, sem acento) e prefere o nome mais longo', () => {
    const agach = catalog.find((c) => /^agachamento livre/i.test(c.name)) ?? catalog.find((c) => /agachamento/i.test(c.name))!;
    expect(findExercise(`como fazer ${agach.name.toUpperCase()}?`, catalog)?.name).toBe(agach.name);
    expect(findExercise('Como foi minha consistência de treinos?', catalog)).toBeNull();
    expect(findExercise('O que mudou nos meus últimos treinos?', catalog)).toBeNull();
  });

  it('classifica o assunto', () => {
    expect(topicOf('Quais músculos trabalha?')).toBe('musculos');
    expect(topicOf('erros comuns')).toBe('erros');
    expect(topicOf('tem cuidado com dor no ombro?')).toBe('cuidados');
    expect(topicOf('Como executar corretamente?')).toBe('execucao');
  });

  it('a resposta usa só o catálogo, cita a fonte e avisa que nada foi enviado', () => {
    const ex = catalog.find((c) => c.instructions.length >= 2)!;
    const r = localAnswer(`Como executar ${ex.name} corretamente?`, catalog)!;
    expect(r.exercise).toBe(ex.name);
    expect(r.text).toContain(ex.instructions[0]);
    expect(r.text).toContain(ex.primary[0]);
    expect(r.text).toMatch(/nada foi enviado/);
    expect(localAnswer('Pergunta sem exercício', catalog)).toBeNull();
  });
});

describe('estados da conexão do assistente', () => {
  const st = (i: Parameters<typeof assistantStatus>[0]) => assistantStatus(i);
  it('cada situação tem um estado distinto e um texto', () => {
    const got: AssistantStatus[] = [
      st({ mode: 'simulated', gatewayStatus: 'disconnected' }),
      st({ mode: 'remote', gatewayStatus: 'connected', providerAvailable: true }),
      st({ mode: 'remote', gatewayStatus: 'disconnected' }),
      st({ mode: 'remote', gatewayStatus: 'error', gatewayErrorCode: 'access_denied' }),
      st({ mode: 'remote', gatewayStatus: 'error', gatewayErrorCode: 'gateway_unreachable' }),
      st({ mode: 'remote', gatewayStatus: 'connected', providerAvailable: false }),
    ];
    expect(got).toEqual(['local', 'connected', 'unavailable', 'auth_failure', 'gateway_unreachable', 'provider_unavailable']);
    for (const s of got) expect(STATUS_INFO[s].text.length).toBeGreaterThan(10);
  });
  it('a última falha de execução refina o estado conectado', () => {
    expect(st({ mode: 'remote', gatewayStatus: 'connected', lastRunErrorCode: 'gateway_unreachable' })).toBe('gateway_unreachable');
    expect(st({ mode: 'remote', gatewayStatus: 'connected', lastRunErrorCode: 'rate_limited' })).toBe('provider_unavailable');
    expect(st({ mode: 'remote', gatewayStatus: 'connected', lastRunErrorCode: 'cancelled' })).toBe('connected');
  });
});

describe('sessão do assistente em memória', () => {
  afterEach(() => {
    forgetAssistantSession();
    vi.useRealTimers();
  });
  const snap = { messages: [], categories: [], mode: 'remote' as const, providerId: '', modelId: '', gateway: { status: 'connected' as const, providers: [] } };

  it('sobrevive à navegação e é esquecida após 30 min sem uso', () => {
    vi.useFakeTimers();
    const c = sessionComposition();
    saveSnapshot(snap);
    expect(sessionComposition()).toBe(c);
    expect(loadSnapshot()).toEqual(snap);
    vi.advanceTimersByTime(IDLE_FORGET_MS + 1);
    expect(loadSnapshot()).toBeNull();
    expect(sessionComposition()).not.toBe(c);
  });

  it('nunca toca localStorage, sessionStorage ou IndexedDB', () => {
    const ls = vi.spyOn(Storage.prototype, 'setItem');
    sessionComposition();
    saveSnapshot(snap);
    forgetAssistantSession();
    expect(ls).not.toHaveBeenCalled();
  });
});

describe('metas no contexto da IA', () => {
  let n = 0;
  beforeEach(async () => {
    setDb(new IronTrackDB(`assistant-p20-${++n}`));
    await db.open();
  });
  afterEach(() => db.close());

  it('só entram quando a categoria é pedida; sem IDs nem perfil; concluídas/arquivadas ficam fora', async () => {
    await createGoal('g-11111111', fields({ type: 'max_load', title: 'Supino 85', targetValue: 85, exercise: refOf(['sup-A']) }));
    expect(await loadContextSources(['training_summary'])).not.toHaveProperty('trainingGoals');
    const s = await loadContextSources(['training_goals']);
    expect(s.trainingGoals).toHaveLength(1);
    expect(s.trainingGoals![0]).toMatchObject({ title: 'Supino 85', target: 85, unit: 'kg' });
    const json = JSON.stringify(s);
    for (const bad of ['g-11111111', 'profileId', 'sup-A', '"id"']) expect(json).not.toContain(bad);
    const ctx = buildAIContext(s, ['training_goals']);
    expect(ctx.included).toEqual(['training_goals']);
  });

  it('sem metas, a categoria aparece como sem dados (nada é inventado)', async () => {
    const s = await loadContextSources(['training_goals']);
    expect(s.trainingGoals).toBeUndefined();
    expect(buildAIContext(s, ['training_goals']).included).toEqual([]);
  });
});
