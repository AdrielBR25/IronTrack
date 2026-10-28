// Motor de desempenho por exercício (IronTrack 2.0 F01/P19): identidade, séries, recordes, 1RM, modalidades,
// comparações, períodos, tendências, estabilidade, sugestões e desempenho com histórico grande. Dados fictícios.
import { describe, expect, it } from 'vitest';
import type { SessionExercise, SessionSet, WorkoutSession } from '@/lib/types';
import {
  AGGREGATE_NOTICE,
  MIN_PRIOR_SESSIONS_FOR_RECORD,
  STABILITY_MIN_SESSIONS,
  buildPerformanceIndex,
  buildSeries,
  classifySets,
  compareSessions,
  identityPath,
  measureFamilyOf,
  metricsOf,
  observationsFor,
  paceBand,
  parseIdentityKey,
  perfRange,
  performanceOverview,
  primaryKeyOf,
  resolveIdentity,
  stabilityOf,
  suggestionsFor,
  type IdentityHistory,
} from '@/modules/performance';
import { canonicalE1rm, legacyChartE1rm } from '@/modules/analytics';
import { estimate1RM } from '@/modules/training';
import { localDate } from '@/modules/analytics';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 15); // segunda-feira, meio da tarde (mesma data em qualquer fuso do Brasil)
let seq = 0;

type SetIn = Partial<SessionSet>;
const st = (over: SetIn = {}): SessionSet => ({ id: `s${++seq}`, type: 'normal', status: 'done', weight: null, reps: null, ...over });

function ex(over: Partial<SessionExercise> & { sets: SessionSet[] }): SessionExercise {
  return {
    id: `x${++seq}`,
    exerciseKey: 'supino-reto',
    templateId: 'tpl-supino',
    name: 'Supino reto',
    muscleGroup: 'Peito',
    category: 'compound',
    equipment: 'barbell',
    repMin: 8,
    repMax: 10,
    restSec: 90,
    plannedSets: 3,
    ...over,
  };
}

function ses(id: string, day: number, exercises: SessionExercise[], over: Partial<WorkoutSession> = {}): WorkoutSession {
  const startedAt = T0 + day * DAY;
  return { id, profileId: 'p1', routineId: 'r1', workoutId: 'r1-A', workoutLabel: 'A', workoutName: 'Treino A', status: 'completed', startedAt, finishedAt: startedAt + 3_600_000, exercises, updatedAt: startedAt + 3_600_000, ...over };
}

/** Supino com N séries de trabalho iguais. */
const bench = (load: number, reps: number, n = 3, over: Partial<SessionExercise> = {}) => ex({ ...over, sets: Array.from({ length: n }, () => st({ weight: load, reps })) });

const today = (day: number) => localDate(T0 + day * DAY);
const get = (idx: ReturnType<typeof buildPerformanceIndex>, key: string) => idx.identities.get(key)!;

describe('identidade', () => {
  it('instância pelo templateId; histórico sem templateId; substituído nunca vira a instância', () => {
    const s = ses('a', 0, []);
    expect(resolveIdentity(s, bench(40, 10)).primary).toEqual({ kind: 'instancia', id: 'tpl-supino', key: 'i:tpl-supino' });
    const legacy = resolveIdentity(s, bench(40, 10, 3, { templateId: undefined }));
    expect(legacy.primary.kind).toBe('historico');
    expect(legacy.historicReason).toBe('sem_ficha');
    const swapped = resolveIdentity(s, bench(40, 10, 3, { substitutedFrom: 'Supino reto', name: 'Supino inclinado', exerciseKey: 'supino-inclinado' }));
    expect(swapped.primary.kind).toBe('historico');
    expect(swapped.historicReason).toBe('substituido');
    expect(swapped.aggregate).toBeNull();
  });

  it('origem só a registrada na sessão: catálogo ou personalizado viram visão agregada; sem origem, nenhuma', () => {
    const s = ses('a', 0, []);
    expect(resolveIdentity(s, bench(40, 10, 3, { catalogId: 'supino-reto-barra' })).aggregate?.key).toBe('c:supino-reto-barra');
    expect(resolveIdentity(s, bench(40, 10, 3, { customExerciseId: 'cx_abc' })).aggregate?.key).toBe('p:cx_abc');
    expect(resolveIdentity(s, bench(40, 10)).aggregate).toBeNull();
  });

  it('histórico sem vínculo: mesmo nome em treinos ou equipamentos diferentes não se junta; sem rotina fica isolado', () => {
    const s = ses('a', 0, []);
    const a = resolveIdentity(s, bench(40, 10, 3, { templateId: undefined })).primary.key;
    const otherWorkout = resolveIdentity(ses('b', 1, [], { workoutId: 'r1-B' }), bench(40, 10, 3, { templateId: undefined })).primary.key;
    const otherEquip = resolveIdentity(s, bench(40, 10, 3, { templateId: undefined, equipment: 'dumbbell' })).primary.key;
    const sameAgain = resolveIdentity(ses('c', 2, []), bench(50, 8, 3, { templateId: undefined })).primary.key;
    expect(new Set([a, otherWorkout, otherEquip]).size).toBe(3);
    expect(sameAgain).toBe(a);
    const isolated = resolveIdentity(ses('d', 3, [], { routineId: '' }), bench(40, 10, 3, { templateId: undefined }));
    expect(isolated.historicReason).toBe('isolado');
    expect(isolated.primary.key).not.toBe(resolveIdentity(ses('e', 4, [], { routineId: '' }), bench(40, 10, 3, { templateId: undefined })).primary.key);
  });

  it('a chave da rota é segura, codificada e não contém o nome; chaves inválidas são recusadas', () => {
    const key = resolveIdentity(ses('a', 0, []), bench(40, 10, 3, { templateId: undefined, name: 'Supino <b>' })).primary.key;
    expect(key).toMatch(/^h:[0-9a-f]{16}$/);
    expect(identityPath('i:tpl-supino')).toBe('/desempenho/exercicio/i%3Atpl-supino');
    expect(parseIdentityKey('i:tpl-supino')?.kind).toBe('instancia');
    for (const bad of ['', 'x:1', 'i:', 'i:a/b', 'i:<script>', 'supino reto', null, 42]) expect(parseIdentityKey(bad)).toBeNull();
    // templateId com caractere fora do formato não vira identidade de instância.
    expect(resolveIdentity(ses('a', 0, []), bench(40, 10, 3, { templateId: 'a b' })).primary.kind).toBe('historico');
  });

  it('instâncias diferentes com o mesmo catalogId ficam separadas; a visão agregada as lista', () => {
    const idx = buildPerformanceIndex([
      ses('a', 0, [bench(40, 10, 3, { templateId: 't-A', catalogId: 'supino' })]),
      ses('b', 2, [bench(60, 5, 3, { templateId: 't-B', catalogId: 'supino' })], { workoutId: 'r1-B', workoutLabel: 'B' }),
    ]);
    expect(get(idx, 'i:t-A').observations).toHaveLength(1);
    expect(get(idx, 'i:t-B').observations).toHaveLength(1);
    const agg = get(idx, 'c:supino');
    expect(agg.members.sort()).toEqual(['i:t-A', 'i:t-B']);
    expect(agg.templateIds.sort()).toEqual(['t-A', 't-B']);
    expect(get(idx, 'i:t-A').aggregates).toEqual(['c:supino']);
    expect(AGGREGATE_NOTICE).toBe('Visão agregada de instâncias vinculadas a este exercício.');
  });

  it('vínculo posterior na ficha não reclassifica sessões antigas: só a sessão que registrou a origem entra na visão agregada', () => {
    const idx = buildPerformanceIndex([ses('antes', 0, [bench(40, 10)]), ses('depois', 3, [bench(42, 10, 3, { catalogId: 'supino' })])]);
    expect(get(idx, 'i:tpl-supino').observations.map((o) => o.sessionId)).toEqual(['antes', 'depois']);
    expect(get(idx, 'c:supino').observations.map((o) => o.sessionId)).toEqual(['depois']);
  });

  it('não agrupa pelo nome: mesmo nome com templateIds diferentes são exercícios distintos', () => {
    const idx = buildPerformanceIndex([ses('a', 0, [bench(40, 10, 3, { templateId: 't1' }), bench(20, 12, 3, { templateId: 't2' })])]);
    expect(idx.identities.has('i:t1')).toBe(true);
    expect(idx.identities.has('i:t2')).toBe(true);
  });

  it('não modifica as sessões recebidas', () => {
    const list = [ses('a', 0, [bench(40, 10, 3, { catalogId: 'supino' })]), ses('b', 2, [bench(42, 10, 3, { templateId: undefined })])];
    const before = structuredClone(list);
    buildPerformanceIndex(list);
    expect(list).toEqual(before);
  });

  it('primaryKeyOf (histórico) coincide com o índice', () => {
    const s = ses('a', 0, [bench(40, 10, 3, { templateId: undefined })]);
    expect(buildPerformanceIndex([s]).identities.has(primaryKeyOf(s, s.exercises[0]))).toBe(true);
  });
});

describe('sessões e séries', () => {
  it('só sessões concluídas do perfil contam; ativas, descartadas e de outro perfil ficam de fora', () => {
    const idx = buildPerformanceIndex(
      [
        ses('ok', 0, [bench(40, 10)]),
        ses('ativa', 1, [bench(90, 10)], { status: 'active' }),
        ses('desc', 2, [bench(90, 10)], { status: 'discarded' }),
        ses('outro', 3, [bench(90, 10)], { profileId: 'p2' }),
        ses('legado', 4, [bench(41, 10)], { profileId: undefined }),
      ],
      { profileId: 'p1' },
    );
    expect(idx.sessions.map((s) => s.id)).toEqual(['ok', 'legado']);
    expect(idx.ignoredSessions).toBe(3);
  });

  it('classifica aquecimento, incompleta, pulada, drop e ignora pendentes; ordem conta as normais não executadas', () => {
    const sets = classifySets('carga', [
      st({ type: 'warmup', weight: 20, reps: 10 }),
      st({ weight: 40, reps: 10 }),
      st({ weight: 40, reps: null }),
      st({ status: 'skipped' }),
      st({ status: 'pending', weight: 40, reps: 10 }),
      st({ type: 'drop', weight: 30, reps: 8 }),
    ]);
    expect(sets.map((s) => [s.kind, s.ordinal])).toEqual([
      ['aquecimento', null],
      ['trabalho', 1],
      ['incompleta', 2],
      ['pulada', 3],
      ['drop', null],
    ]);
  });

  it('aquecimento nunca vira carga máxima, volume ou 1RM', () => {
    const m = metricsOf('carga', classifySets('carga', [st({ type: 'warmup', weight: 100, reps: 5 }), st({ weight: 40, reps: 10 })]));
    expect(m.topLoadKg).toBe(40);
    expect(m.volumeKg).toBe(400);
    expect(m.e1rm?.loadKg).toBe(40);
    expect(m.warmupSets).toBe(1);
  });

  it('volume = carga × repetições nas séries de trabalho com carga; sem carga, volume ausente (não zero)', () => {
    expect(metricsOf('carga', classifySets('carga', [st({ weight: 40, reps: 10 }), st({ weight: 40, reps: 8 }), st({ type: 'drop', weight: 30, reps: 6 })])).volumeKg).toBe(400 + 320 + 180);
    expect(metricsOf('carga', classifySets('carga', [st({ reps: 10 })])).volumeKg).toBeNull();
  });

  it('exercício repetido na mesma sessão soma as cópias em uma observação', () => {
    const idx = buildPerformanceIndex([ses('a', 0, [bench(40, 10, 2), bench(40, 10, 1)])]);
    const o = get(idx, 'i:tpl-supino').observations[0];
    expect(o.copies).toBe(2);
    expect(o.metrics.workSets).toBe(3);
  });

  it('cópia sem nenhuma série executada não gera observação', () => {
    const idx = buildPerformanceIndex([ses('a', 0, [ex({ sets: [st({ status: 'pending', weight: 40, reps: 10 })] })])]);
    expect(idx.identities.size).toBe(0);
  });
});

describe('1RM', () => {
  it('usa o contrato canônico epley-1a12-v1: 1 rep = carga real; 2–12 Epley; acima de 12 sem estimativa', () => {
    const one = metricsOf('carga', classifySets('carga', [st({ weight: 100, reps: 1 })])).e1rm!;
    expect(one).toMatchObject({ valueKg: 100, kind: 'direta', method: 'epley-1a12-v1' });
    const ten = metricsOf('carga', classifySets('carga', [st({ weight: 60, reps: 10 })])).e1rm!;
    expect(ten.valueKg).toBeCloseTo(80, 10);
    expect(ten.kind).toBe('estimada');
    expect(metricsOf('carga', classifySets('carga', [st({ weight: 60, reps: 15 })])).e1rm).toBeNull();
  });

  it('as fórmulas antigas continuam iguais (gráfico antigo e recordes antigos)', () => {
    expect(legacyChartE1rm(100, 1)).toBeCloseTo(103.333, 2);
    expect(estimate1RM(100, 1)).toBe(100);
    expect(estimate1RM(60, 15)).toBe(90);
    const c = canonicalE1rm(60, 15);
    expect(c.ok).toBe(false);
  });

  it('peso corporal, tempo e cardio nunca têm 1RM', () => {
    for (const f of ['corporal', 'tempo', 'cardio'] as const) expect(metricsOf(f, classifySets(f, [st({ weight: 20, reps: 5, durationSec: 30, distance: 1000 })])).e1rm).toBeNull();
  });
});

describe('modalidades', () => {
  it('família pela modalidade gravada; sem ela, equipamento peso corporal = corporal; senão carga', () => {
    expect(measureFamilyOf({ modality: 'cardio', equipment: 'other' })).toBe('cardio');
    expect(measureFamilyOf({ modality: 'timed', equipment: 'bodyweight' })).toBe('tempo');
    expect(measureFamilyOf({ modality: undefined, equipment: 'bodyweight' })).toBe('corporal');
    expect(measureFamilyOf({ modality: undefined, equipment: 'barbell' })).toBe('carga');
  });

  it('peso corporal: repetições só com o corpo, carga adicional e menor assistência separadas; nunca misturadas', () => {
    const m = metricsOf(
      'corporal',
      classifySets('corporal', [st({ reps: 12 }), st({ weight: 10, reps: 6 }), st({ assistanceKg: 20, reps: 15 }), st({ assistanceKg: 10, reps: 8 }), st({ weight: 5, assistanceKg: 5, reps: 9 })]),
    );
    expect(m.bodyOnlyBestReps).toBe(12);
    expect(m.addedLoadKg).toBe(10);
    expect(m.minAssistanceKg).toBe(10);
    expect(m.minAssistanceReps).toBe(8);
    expect(m.incompleteSets).toBe(1); // carga adicional + assistência ao mesmo tempo
    expect(m.volumeKg).toBeNull();
  });

  it('maior assistência não é recorde; menor assistência é', () => {
    const pull = (a: number) => ex({ templateId: 'pull', exerciseKey: 'barra', name: 'Barra assistida', modality: 'bodyweight', loadMode: 'assistida', equipment: 'machine', sets: [st({ assistanceKg: a, reps: 8 })] });
    const idx = buildPerformanceIndex([ses('a', 0, [pull(30)]), ses('b', 2, [pull(25)]), ses('c', 4, [pull(35)]), ses('d', 6, [pull(20)])]);
    const h = get(idx, 'i:pull');
    expect(h.records.find((r) => r.type === 'menor_assistencia')?.value).toBe(20);
    expect(h.recordEvents.map((e) => [e.type, e.value])).toEqual([['menor_assistencia', 20]]);
  });

  it('tempo: maior duração sustentada; cardio: distância, duração e ritmo só das mesmas séries', () => {
    expect(metricsOf('tempo', classifySets('tempo', [st({ durationSec: 45 }), st({ durationSec: 60 }), st({ reps: 10 })])).bestDurationSec).toBe(60);
    const c = metricsOf('cardio', classifySets('cardio', [st({ durationSec: 1500, distance: 5000 }), st({ durationSec: 600 })]));
    expect(c.distanceM).toBe(5000);
    expect(c.cardioDurationSec).toBe(2100);
    expect(c.paceSecPerKm).toBe(300);
    expect(c.pacedDistanceM).toBe(5000);
  });

  it('ritmo: recordes por faixa de distância (1 km não se compara com 10 km)', () => {
    const run = (dur: number, dist: number) => ex({ templateId: 'run', exerciseKey: 'corrida', name: 'Corrida', modality: 'cardio', equipment: 'other', sets: [st({ durationSec: dur, distance: dist })] });
    const idx = buildPerformanceIndex([ses('a', 0, [run(240, 1000)]), ses('b', 2, [run(3300, 10000)]), ses('c', 4, [run(3000, 10000)])]);
    const paces = get(idx, 'i:run').records.filter((r) => r.type === 'ritmo');
    expect(paces.map((r) => [r.band, r.value])).toEqual([
      ['ate_1km', 240],
      ['5_10km', 300],
    ]);
    expect(paceBand(1000)).toBe('ate_1km');
    expect(paceBand(1001)).toBe('1_3km');
    expect(paceBand(21097.5)).toBe('10_21km');
  });

  it('unilateral: ordem das séries por lado', () => {
    const sets = classifySets('carga', [st({ side: 'direito', weight: 20, reps: 10 }), st({ side: 'esquerdo', weight: 20, reps: 9 }), st({ side: 'direito', weight: 20, reps: 8 })]);
    expect(sets.map((s) => `${s.side}${s.ordinal}`)).toEqual(['direito1', 'esquerdo1', 'direito2']);
  });

  it('modalidade alterada: sessões de outra família ficam listadas, fora de gráficos e recordes', () => {
    const idx = buildPerformanceIndex([ses('a', 0, [bench(40, 10)]), ses('b', 2, [ex({ modality: 'timed', sets: [st({ durationSec: 60 })] })])]);
    const h = get(idx, 'i:tpl-supino');
    expect(h.family).toBe('tempo');
    expect(h.observations.map((o) => o.sessionId)).toEqual(['b']);
    expect(h.otherFamily.map((o) => o.sessionId)).toEqual(['a']);
    expect(h.records.map((r) => r.type)).toEqual(['duracao']);
  });
});

describe('recordes', () => {
  const hist = (loads: number[]) => buildPerformanceIndex(loads.map((l, i) => ses(`s${i}`, i * 3, [bench(l, 10)])));

  it(`evento de recorde só depois de ${MIN_PRIOR_SESSIONS_FOR_RECORD} sessões anteriores; a primeira é só a primeira marca`, () => {
    const h = get(hist([40, 42, 44]), 'i:tpl-supino');
    expect(h.records.find((r) => r.type === 'carga_maxima')).toMatchObject({ value: 44, sessionId: 's2', previous: 42 });
    expect(h.recordEvents.filter((e) => e.type === 'carga_maxima').map((e) => e.sessionId)).toEqual(['s2']);
  });

  it('empate não cria recorde novo: fica a primeira data e o empate é listado', () => {
    const h = get(hist([40, 42, 44, 44]), 'i:tpl-supino');
    const r = h.records.find((x) => x.type === 'carga_maxima')!;
    expect(r.sessionId).toBe('s2');
    expect(r.ties.map((t) => t.sessionId)).toEqual(['s3']);
    expect(h.recordEvents.filter((e) => e.type === 'carga_maxima')).toHaveLength(1);
  });

  it('recordes de musculação: carga, repetições, volume e 1RM com contexto', () => {
    const h = get(buildPerformanceIndex([ses('a', 0, [ex({ sets: [st({ weight: 50, reps: 5 }), st({ weight: 30, reps: 15 })] })])]), 'i:tpl-supino');
    const by = Object.fromEntries(h.records.map((r) => [r.type, r]));
    expect(by.carga_maxima).toMatchObject({ value: 50, reps: 5 });
    expect(by.repeticoes).toMatchObject({ value: 15, loadKg: 30 });
    expect(by.volume_sessao.value).toBe(700);
    expect(by.e1rm).toMatchObject({ e1rmKind: 'estimada', loadKg: 50, reps: 5 });
  });

  it('recalculáveis: o mesmo histórico em outra ordem gera os mesmos recordes', () => {
    const list = [40, 45, 43, 47].map((l, i) => ses(`s${i}`, i * 3, [bench(l, 8)]));
    const a = get(buildPerformanceIndex(list), 'i:tpl-supino').records;
    const b = get(buildPerformanceIndex([...list].reverse()), 'i:tpl-supino').records;
    expect(b).toEqual(a);
  });
});

describe('gráficos e períodos', () => {
  it('séries com data real, sem pontos inventados, e lacunas longas marcadas', () => {
    const idx = buildPerformanceIndex([ses('a', 0, [bench(40, 10)]), ses('b', 3, [bench(42, 10)]), ses('c', 50, [bench(41, 10)]), ses('d', 52, [ex({ sets: [st({ reps: 10 })] })])]);
    const s = buildSeries(get(idx, 'i:tpl-supino').observations, 'carga');
    expect(s.points.map((p) => p.sessionId)).toEqual(['a', 'b', 'c']); // 'd' sem carga: sem ponto (não zero)
    expect(s.points.map((p) => p.gapBefore)).toEqual([false, false, true]);
    expect(s.points[2].gapDays).toBe(47);
  });

  it('filtros de 7 a 365 dias e todo o histórico, pela data da sessão (não pela edição)', () => {
    const t = today(400);
    expect(perfRange('7d', t, null)).toMatchObject({ to: t, days: 7 });
    expect(perfRange('365d', t, null).days).toBe(365);
    expect(perfRange('all', t, today(0))).toMatchObject({ from: today(0), days: 401 });
    expect(perfRange('all', t, null)).toMatchObject({ from: t, days: 1 });
    const s = ses('velha', 0, [bench(40, 10)], { updatedAt: T0 + 399 * DAY });
    const idx = buildPerformanceIndex([s]);
    expect(performanceOverview(idx, perfRange('30d', t, idx.firstDate)).sessions).toBe(0);
    expect(performanceOverview(idx, perfRange('all', t, idx.firstDate)).sessions).toBe(1);
  });
});

describe('comparação', () => {
  const idx = buildPerformanceIndex([ses('a', 0, [bench(40, 10)]), ses('b', 3, [bench(42, 10)])]);
  const h = get(idx, 'i:tpl-supino');

  it('diferenças absolutas e percentuais com unidade; resumo só aponta diferença favorável em condições equivalentes', () => {
    const c = compareSessions(h, h.observations[1], h.observations[0]);
    expect(c.a.sessionId).toBe('a');
    expect(c.compatible).toBe(true);
    const load = c.metrics.find((m) => m.key === 'carga')!;
    expect(load).toMatchObject({ a: 40, b: 42, diff: 2, unit: 'kg' });
    expect(load.pct).toBeCloseTo(5, 10);
    expect(c.metrics.find((m) => m.key === 'series')!.pct).toBeNull();
    expect(c.summary).toMatch(/Carga máxima maior/);
  });

  it('série a série: correspondência pela ordem, ausente nunca vira zero, incompleta marcada', () => {
    const idx2 = buildPerformanceIndex([
      ses('a', 0, [ex({ sets: [st({ type: 'warmup', weight: 20, reps: 10 }), st({ weight: 40, reps: 10 }), st({ weight: 40, reps: 10 }), st({ weight: 40, reps: 8 })] })]),
      ses('b', 3, [ex({ sets: [st({ weight: 42, reps: 10 }), st({ weight: 42, reps: null })] })]),
    ]);
    const hh = get(idx2, 'i:tpl-supino');
    const c = compareSessions(hh, hh.observations[0], hh.observations[1]);
    expect(c.sets.rows.map((r) => r.state)).toEqual(['comparavel', 'incompleta', 'ausente_b']);
    expect(c.sets.rows[0]).toMatchObject({ loadDiffKg: 2, repsDiff: 0 });
    expect(c.sets.rows[2].b).toBeNull();
    expect(c.sets.excluded).toEqual({ a: 1, b: 0 });
  });

  it('dados ausentes ficam marcados; sem afirmar melhora quando faltam dados', () => {
    const idx2 = buildPerformanceIndex([ses('a', 0, [bench(40, 10)]), ses('b', 3, [ex({ sets: [st({ reps: 12 })] })])]);
    const hh = get(idx2, 'i:tpl-supino');
    const c = compareSessions(hh, hh.observations[0], hh.observations[1]);
    expect(c.metrics.find((m) => m.key === 'carga')).toMatchObject({ missing: 'b', diff: null, pct: null });
    expect(c.summary).not.toMatch(/maior/);
  });

  it('visão agregada com instâncias diferentes, modo de carga ou lateralidade diferentes: incompatível', () => {
    const idx2 = buildPerformanceIndex([
      ses('a', 0, [bench(40, 10, 3, { templateId: 't-A', catalogId: 'supino' })]),
      ses('b', 3, [bench(60, 10, 3, { templateId: 't-B', catalogId: 'supino' })]),
    ]);
    const agg = get(idx2, 'c:supino');
    const c = compareSessions(agg, agg.observations[0], agg.observations[1]);
    expect(c.issues).toContain('instancias_diferentes');
    expect(c.compatible).toBe(false);
    expect(c.summary).toMatch(/não são equivalentes/);
    const u = (lat: 'unilateral' | 'bilateral') => bench(20, 10, 2, { laterality: lat });
    const idx3 = buildPerformanceIndex([ses('x', 0, [u('bilateral')]), ses('y', 2, [u('unilateral')])]);
    const h3 = get(idx3, 'i:tpl-supino');
    expect(compareSessions(h3, h3.observations[0], h3.observations[1]).issues).toContain('lateralidade_diferente');
  });

  it('unilateral sem lado registrado: sem comparação série a série; cardio compara a sessão inteira', () => {
    const uni = (side?: 'direito') => ex({ laterality: 'unilateral', sets: [st({ weight: 20, reps: 10, side })] });
    const idx2 = buildPerformanceIndex([ses('a', 0, [uni('direito')]), ses('b', 3, [uni()])]);
    const hh = get(idx2, 'i:tpl-supino');
    expect(compareSessions(hh, hh.observations[0], hh.observations[1]).sets.reason).toBe('lados_nao_registrados');
    const run = (dur: number, dist: number) => ex({ templateId: 'run', modality: 'cardio', equipment: 'other', sets: [st({ durationSec: dur, distance: dist })] });
    const idx3 = buildPerformanceIndex([ses('a', 0, [run(240, 1000)]), ses('b', 3, [run(3000, 10000)])]);
    const hr = get(idx3, 'i:run');
    const c = compareSessions(hr, hr.observations[0], hr.observations[1]);
    expect(c.sets.reason).toBe('cardio');
    expect(c.issues).toContain('faixa_de_distancia_diferente');
    expect(c.metrics.find((m) => m.key === 'ritmo')!.diff).toBeNull();
    expect(c.metrics.find((m) => m.key === 'distancia')!.diff).toBe(9000);
  });
});

describe('observações, estabilidade e sugestões', () => {
  const range = (h: IdentityHistory, last: number) => perfRange('all', today(last), h.observations[0].date);

  it('carga maior e mesma carga com mais repetições, com critério e sessões de origem', () => {
    const idx = buildPerformanceIndex([ses('a', 0, [bench(40, 8)]), ses('b', 3, [bench(42, 8)]), ses('c', 6, [bench(42, 10)])]);
    const h = get(idx, 'i:tpl-supino');
    const notes = observationsFor(h, range(h, 6));
    const more = notes.find((n) => n.kind === 'mais_repeticoes_mesma_carga')!;
    expect(more.text).toBe('Você manteve a mesma carga e registrou mais repetições.');
    expect(more.criterion).toMatch(/10 repetições/);
    expect(more.sessionIds).toEqual(['b', 'c']);
    const notes2 = observationsFor(h, perfRange('all', today(3), h.observations[0].date));
    expect(notes2.find((n) => n.kind === 'carga_maior')?.text).toBe('Sua carga máxima registrada aumentou nas últimas sessões comparáveis.');
  });

  it('poucas sessões: "Ainda não há sessões suficientes…", nunca regressão', () => {
    const idx = buildPerformanceIndex([ses('a', 0, [bench(40, 10)]), ses('b', 3, [bench(38, 10)])]);
    const h = get(idx, 'i:tpl-supino');
    const notes = observationsFor(h, range(h, 3));
    expect(notes.map((n) => n.kind)).toEqual(['insuficiente']);
    expect(notes[0].text).toBe('Ainda não há sessões suficientes para avaliar uma tendência.');
  });

  it(`estabilidade: ${STABILITY_MIN_SESSIONS}+ sessões em 21+ dias sem mudança nem recorde; diferencia ausência e poucas sessões`, () => {
    const list = [0, 7, 14, 21, 28].map((d, i) => ses(`s${i}`, d, [bench(40, 10)]));
    const h = get(buildPerformanceIndex(list), 'i:tpl-supino');
    expect(stabilityOf(h, range(h, 28)).state).toBe('estavel');
    expect(observationsFor(h, range(h, 28)).find((n) => n.kind === 'estavel')?.text).toBe('Desempenho estável no período.');
    expect(stabilityOf(h, perfRange('7d', today(200), null)).state).toBe('sem_registros');
    expect(stabilityOf(h, perfRange('7d', today(28), null)).state).toBe('poucas_sessoes');
  });

  it('variação: valores oscilando geram "Os registros recentes apresentam variação."', () => {
    const loads = [40, 55, 38, 57, 40, 56, 39, 58];
    const h = get(buildPerformanceIndex(loads.map((l, i) => ses(`s${i}`, i * 4, [bench(l, 10)]))), 'i:tpl-supino');
    const kinds = observationsFor(h, range(h, 28)).map((n) => n.kind);
    expect(kinds).toContain('variacao');
  });

  it('sugestões conservadoras: nunca uma carga a usar, sempre com motivo; nada é alterado', () => {
    const list = [0, 3, 6].map((d, i) => ses(`s${i}`, d, [bench(40, 10)]));
    const h = get(buildPerformanceIndex(list), 'i:tpl-supino');
    const before = structuredClone(list);
    const sug = suggestionsFor(h, range(h, 6));
    expect(sug.map((s) => s.id)).toEqual(['progressao_gradual']);
    expect(sug[0].text).toBe('Se a execução estiver confortável e consistente, avalie uma progressão gradual com orientação adequada.');
    expect(sug[0].basis).toMatch(/topo da faixa/);
    expect(sug[0].text).not.toMatch(/\d/);
    expect(list).toEqual(before);
    // Abaixo do topo da faixa: sem sugestão de progressão.
    const h2 = get(buildPerformanceIndex([0, 3, 6].map((d, i) => ses(`t${i}`, d, [bench(40, 9)]))), 'i:tpl-supino');
    expect(suggestionsFor(h2, range(h2, 6))).toEqual([]);
  });
});

describe('visão geral', () => {
  it('resumo calculável: sessões, exercícios, recordes, com evolução e sem comparação suficiente', () => {
    const list = [
      ses('a', 0, [bench(40, 10), ex({ templateId: 'plank', exerciseKey: 'prancha', name: 'Prancha', modality: 'timed', equipment: 'bodyweight', sets: [st({ durationSec: 45 })] })]),
      ses('b', 3, [bench(42, 10)]),
      ses('c', 6, [bench(44, 10)]),
    ];
    const idx = buildPerformanceIndex(list);
    const o = performanceOverview(idx, perfRange('30d', today(6), idx.firstDate));
    expect(o.sessions).toBe(3);
    expect(o.exercisesWithRecords).toBe(2);
    expect(o.records.map((r) => [r.type, r.sessionId])).toEqual(expect.arrayContaining([['carga_maxima', 'c']]));
    expect(o.withEvolution).toBe(1);
    expect(o.withoutComparison).toBe(1);
    expect(o.recent.length).toBeGreaterThan(0);
  });

  it('histórico grande (2.000 sessões × 8 exercícios) continua rápido e sem duplicar', () => {
    const list: WorkoutSession[] = [];
    for (let i = 0; i < 2000; i++) list.push(ses(`s${i}`, i, Array.from({ length: 8 }, (_, k) => bench(40 + (i % 20), 8 + (i % 4), 4, { templateId: `t${k}`, catalogId: k < 4 ? `c${k}` : undefined }))));
    const t0 = performance.now();
    const idx = buildPerformanceIndex(list);
    const o = performanceOverview(idx, perfRange('all', today(2000), idx.firstDate));
    const ms = performance.now() - t0;
    expect(idx.identities.size).toBe(12);
    expect(get(idx, 'i:t0').observations).toHaveLength(2000);
    expect(o.sessions).toBe(2000);
    expect(ms).toBeLessThan(3000);
  });
});
