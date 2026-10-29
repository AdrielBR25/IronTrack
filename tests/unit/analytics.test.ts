// Motor de análise de treinos (IronTrack 2.0 F01/P08). Dados fictícios apenas.
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeTraining,
  buildInsights,
  computeTrend,
  createTrainingAnalytics,
  MIN_PRIOR_SESSIONS_FOR_RECORD,
  normalizeSessions,
  previousRange,
  resolvePeriod,
  toAnalyticsSummary,
  weekStart,
  localDate,
  type TrainingReport,
} from '@/modules/analytics';
import { estimate1RM, exerciseSeries, type SessionExercise, type SessionSet, type WorkoutSession } from '@/modules/training';

// ---------------------------------------------------------------------------------------------
// Fixtures

type SetSpec = [weight: number | null, reps: number | null] | Partial<SessionSet>;
interface ExSpec {
  key?: string;
  name?: string;
  group?: string;
  equipment?: SessionExercise['equipment'];
  sets: SetSpec[];
}

let seq = 0;
/** Instante local (fuso do processo) de uma data yyyy-mm-dd. */
const at = (iso: string, h = 10, m = 0) => {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d, h, m).getTime();
};

function ex(spec: ExSpec): SessionExercise {
  const key = spec.key ?? 'supino';
  return {
    id: `x${++seq}`,
    exerciseKey: key,
    name: spec.name ?? key[0].toUpperCase() + key.slice(1),
    muscleGroup: spec.group ?? 'Peito',
    category: 'compound',
    equipment: spec.equipment ?? 'barbell',
    repMin: 6,
    repMax: 10,
    restSec: 120,
    plannedSets: spec.sets.length,
    sets: spec.sets.map((s) => {
      const base: SessionSet = { id: `s${++seq}`, type: 'normal', status: 'done', weight: null, reps: null };
      return Array.isArray(s) ? { ...base, weight: s[0], reps: s[1] } : { ...base, ...s };
    }),
  };
}

function sess(date: string | number, exercises: ExSpec[], over: Partial<WorkoutSession> = {}): WorkoutSession {
  const startedAt = typeof date === 'number' ? date : at(date);
  return {
    id: `w${++seq}`,
    routineId: 'r1',
    workoutId: 'r1-A',
    workoutLabel: 'A',
    workoutName: 'Treino A',
    status: 'completed',
    startedAt,
    finishedAt: startedAt + 3_600_000,
    durationSec: 3600,
    exercises: exercises.map(ex),
    updatedAt: startedAt,
    ...over,
  };
}

/** Uma sessão de supino por data com a carga indicada (3 × 8). */
const bench = (date: string | number, load: number, reps = 8) => sess(date, [{ sets: [[load, reps], [load, reps], [load, reps]] }]);

/** Garante que nenhum número do objeto é NaN ou infinito. */
function assertFinite(value: unknown, path = 'root') {
  if (typeof value === 'number') expect(Number.isFinite(value), path).toBe(true);
  else if (Array.isArray(value)) value.forEach((v, i) => assertFinite(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}.${k}`);
}

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

// ---------------------------------------------------------------------------------------------

describe('períodos e calendário', () => {
  it('últimos N dias terminam hoje, incluindo hoje; o anterior tem a mesma duração', () => {
    const r = resolvePeriod('30d', '2026-10-27', null);
    expect(r).toEqual({ from: '2026-09-28', to: '2026-10-27', days: 30 });
    expect(previousRange(r)).toEqual({ from: '2026-08-29', to: '2026-09-27', days: 30 });
    expect(resolvePeriod('7d', '2026-10-27', null).from).toBe('2026-10-21');
    expect(resolvePeriod('all', '2026-10-27', '2025-01-15')).toEqual({ from: '2025-01-15', to: '2026-10-27', days: 651 });
    expect(resolvePeriod('all', '2026-10-27', null)).toEqual({ from: '2026-10-27', to: '2026-10-27', days: 1 });
  });

  it('virada de semana: domingo e segunda ficam em semanas diferentes (semana começa na segunda)', () => {
    expect(weekStart('2026-10-25')).toBe('2026-10-19'); // domingo
    expect(weekStart('2026-10-26')).toBe('2026-10-26'); // segunda
    const r = analyzeTraining([bench(at('2026-10-25', 23, 30), 60), sess(at('2026-10-26', 0, 10), [{ sets: [[60, 8]] }])], '30d', '2026-10-27');
    expect(r.buckets.filter((b) => b.sessions).map((b) => [b.start, b.sessions])).toEqual([
      ['2026-10-19', 1],
      ['2026-10-26', 1],
    ]);
  });

  it('virada de mês e de ano', () => {
    expect(weekStart('2026-03-01')).toBe('2026-02-23');
    expect(weekStart('2026-01-01')).toBe('2025-12-29');
    expect(resolvePeriod('7d', '2026-01-03', null)).toEqual({ from: '2025-12-28', to: '2026-01-03', days: 7 });
    const r = analyzeTraining([bench('2025-12-31', 60), bench('2026-01-01', 60), bench('2026-01-05', 60)], '30d', '2026-01-10');
    const weeks = r.buckets.filter((b) => b.sessions).map((b) => [b.start, b.sessions]);
    expect(weeks).toEqual([
      ['2025-12-29', 2],
      ['2026-01-05', 1],
    ]);
    expect(r.frequency.distinctDays).toBe(3);
  });

  it('histórico longo agrupa os gráficos por mês, com a virada de mês correta', () => {
    const list = [bench('2026-01-31', 60), bench('2026-02-01', 60), bench('2026-10-01', 60)];
    const r = analyzeTraining(list, 'all', '2026-10-27');
    expect(r.buckets[0].kind).toBe('month');
    expect(r.buckets.map((b) => b.start)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
    expect(r.buckets.map((b) => b.sessions)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(r.buckets.at(-1)!.partial).toBe(true);
  });

  it('fuso horário: a data do treino é a do calendário local do aparelho', () => {
    const ts = Date.UTC(2026, 2, 10, 2, 30); // 10/03 02:30 UTC
    process.env.TZ = 'America/Sao_Paulo';
    expect(localDate(ts)).toBe('2026-03-09');
    expect(normalizeSessions([sess(ts, [{ sets: [[50, 8]] }])]).sessions[0].date).toBe('2026-03-09');
    process.env.TZ = 'Asia/Tokyo';
    expect(localDate(ts)).toBe('2026-03-10');
    // Contagem de dias é aritmética de calendário: não muda com horário de verão.
    process.env.TZ = 'America/Sao_Paulo';
    expect(resolvePeriod('30d', '2018-11-20', null)).toEqual({ from: '2018-10-22', to: '2018-11-20', days: 30 });
  });
});

describe('frequência semanal', () => {
  it('sessões por semana, média semanal, semanas ativas e dias distintos', () => {
    // 4 semanas completas (seg 28/09 a dom 25/10) + semana atual.
    const list = [
      bench('2026-09-28', 60),
      bench('2026-09-30', 60),
      bench('2026-10-02', 60),
      bench('2026-10-06', 60),
      bench('2026-10-06', 60), // duas no mesmo dia
      bench('2026-10-21', 60),
      bench('2026-10-26', 60),
    ];
    const r = analyzeTraining(list, '30d', '2026-10-27');
    expect(r.range).toEqual({ from: '2026-09-28', to: '2026-10-27', days: 30 });
    expect(r.frequency.sessions).toBe(7);
    expect(r.frequency.distinctDays).toBe(6);
    expect(r.frequency.weeklyAverage).toBeCloseTo(7 / (30 / 7), 10);
    expect(r.frequency.weeks).toBe(5);
    expect(r.frequency.activeWeeks).toBe(4);
    expect(r.buckets.map((b) => b.sessions)).toEqual([3, 2, 0, 1, 1]);
    expect(r.buckets.map((b) => b.partial)).toEqual([false, false, false, false, true]);
  });

  it('não calcula média semanal com menos de 7 dias de histórico (seria extrapolação)', () => {
    const r = analyzeTraining([bench('2026-10-25', 60), bench('2026-10-26', 60)], '30d', '2026-10-27');
    expect(r.covered).toEqual({ from: '2026-10-25', to: '2026-10-27', days: 3 });
    expect(r.frequency.weeklyAverage).toBeNull();
  });

  it('sessões em andamento ou descartadas não contam como concluídas', () => {
    const list = [bench('2026-10-20', 60), sess('2026-10-26', [{ sets: [[60, 8]] }], { status: 'active' }), sess('2026-10-25', [{ sets: [[60, 8]] }], { status: 'discarded' })];
    const r = analyzeTraining(list, '30d', '2026-10-27');
    expect(r.totals.sessions).toBe(1);
    expect(r.quality).toMatchObject({ completedSessions: 1, ignoredSessions: 2 });
  });
});

describe('volume e séries', () => {
  const day = sess('2026-10-20', [
    { key: 'supino', sets: [[60, 10], [70, 8], { type: 'warmup', weight: 40, reps: 12 }, { status: 'pending', weight: 70, reps: null }, { status: 'skipped', weight: 70, reps: 8 }] },
    { key: 'remada', name: 'Remada', group: 'Costas', sets: [[50, 10], [50, 10]] },
  ]);

  it('séries incompletas, puladas, planejadas e aquecimento não entram como realizadas', () => {
    const r = analyzeTraining([day], '30d', '2026-10-27');
    expect(r.totals.sets).toBe(4);
    expect(r.exercises.find((e) => e.key === 'supino')!.sets).toBe(2);
  });

  it('volume por exercício, por sessão, por semana e no período (carga × repetições)', () => {
    const r = analyzeTraining([day, bench('2026-10-27', 100, 5)], '30d', '2026-10-27');
    const supino = r.exercises.find((e) => e.key === 'supino')!;
    expect(supino.volume).toBe(60 * 10 + 70 * 8 + 3 * 100 * 5);
    expect(r.exercises.find((e) => e.key === 'remada')!.volume).toBe(1000);
    // por sessão (o índice guarda um ponto por exercício e sessão)
    const pts = createTrainingAnalytics([day]).history('supino')!.points;
    expect(pts[0].volume).toBe(1160);
    const week = r.buckets.find((b) => b.start === '2026-10-19')!;
    expect(week.volume).toBe(1160 + 1000);
    expect(r.buckets.find((b) => b.start === '2026-10-26')!.volume).toBe(1500);
    expect(r.totals.volume).toBe(1160 + 1000 + 1500);
  });

  it('séries por exercício, por semana e por grupo muscular (sem grupo fica à parte)', () => {
    const other = sess('2026-10-22', [{ key: 'prancha', name: 'Prancha', group: '  ', equipment: 'bodyweight', sets: [[null, 30]] }]);
    const r = analyzeTraining([day, other], '30d', '2026-10-27');
    expect(r.buckets.find((b) => b.start === '2026-10-19')!.sets).toBe(5);
    expect(r.muscleGroups).toEqual([
      { group: 'Costas', sets: 2 },
      { group: 'Peito', sets: 2 },
    ]);
    expect(r.unclassifiedSets).toBe(1);
  });

  it('exercícios sem carga: contam séries e repetições, nunca quilos inventados', () => {
    const list = [5, 6, 7, 8, 9].map((reps, i) => sess(`2026-10-${String(1 + i * 5).padStart(2, '0')}`, [{ key: 'barra', name: 'Barra fixa', group: 'Costas', equipment: 'bodyweight', sets: [[null, reps], [0, reps - 1]] }]));
    const r = analyzeTraining(list, '30d', '2026-10-27');
    const barra = r.exercises[0];
    expect(barra.volume).toBe(0);
    expect(barra.loadedSets).toBe(0);
    expect(barra.unloadedSets).toBe(10);
    expect(r.totals.volume).toBe(0);
    expect(barra.periodBest.maxLoad).toBeNull();
    expect(barra.records.bestE1rm).toBeNull();
    expect(barra.records.maxUnloadedReps!.value).toBe(9);
    expect(barra.trend.metric).toBe('reps');
    expect(barra.trend.direction).toBe('positiva');
  });

  it('peso corporal com carga extra: só a carga externa entra no volume', () => {
    const r = analyzeTraining([sess('2026-10-20', [{ key: 'barra', equipment: 'bodyweight', sets: [[10, 6], [null, 8]] }])], '30d', '2026-10-27');
    expect(r.exercises[0].volume).toBe(60);
    expect(r.exercises[0].loadedSets).toBe(1);
    expect(r.exercises[0].unloadedSets).toBe(1);
  });
});

describe('evolução de carga e tendências', () => {
  it('evolução positiva com cargas crescentes e séries comparáveis', () => {
    const list = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06'].map((d, i) => bench(d, 60 + i * 2.5));
    const r = analyzeTraining(list, '60d', '2026-10-10');
    const t = r.exercises[0].trend;
    expect(t).toMatchObject({ direction: 'positiva', metric: 'e1rm', points: 6, spanDays: 35, maxGapDays: 7, confidence: 'media' });
    expect(t.firstMean).toBeCloseTo((estimate1RM(60, 8) + estimate1RM(62.5, 8) + estimate1RM(65, 8)) / 3, 10);
    expect(t.lastMean).toBeCloseTo((estimate1RM(67.5, 8) + estimate1RM(70, 8) + estimate1RM(72.5, 8)) / 3, 10);
  });

  it('estabilidade: oscilação dentro do ruído natural não vira evolução nem queda', () => {
    const loads = [80, 82.5, 80, 82.5, 80, 82.5, 81, 81];
    const list = loads.map((l, i) => bench(`2026-09-${String(1 + i * 4).padStart(2, '0')}`, l));
    const t = analyzeTraining(list, '60d', '2026-10-10').exercises[0].trend;
    expect(t.direction).toBe('estavel');
    expect(Math.abs(t.changePct!)).toBeLessThan(t.thresholdPct!);
  });

  it('queda: média menor na segunda metade', () => {
    const list = [100, 100, 100, 90, 90, 90].map((l, i) => bench(`2026-09-${String(1 + i * 5).padStart(2, '0')}`, l));
    expect(analyzeTraining(list, '60d', '2026-10-10').exercises[0].trend.direction).toBe('queda');
  });

  it('dados insuficientes: duas sessões nunca classificam estagnação; poucas sessões ou intervalo curto', () => {
    const two = analyzeTraining([bench('2026-10-01', 60), bench('2026-10-20', 60)], '30d', '2026-10-27').exercises[0].trend;
    expect(two).toMatchObject({ direction: 'insuficiente', reason: 'poucas_sessoes', changePct: null });
    const short = analyzeTraining(['2026-10-20', '2026-10-22', '2026-10-24', '2026-10-26'].map((d) => bench(d, 60)), '30d', '2026-10-27').exercises[0].trend;
    expect(short).toMatchObject({ direction: 'insuficiente', reason: 'intervalo_curto' });
    expect(computeTrend([], 'e1rm')).toMatchObject({ direction: 'insuficiente', reason: 'sem_metrica' });
  });

  it('não compara uma série pesada de 1 repetição com uma de 15 como equivalentes', () => {
    // 1RM estimado só existe em séries de até 12 repetições; séries longas usam a própria métrica.
    const p = createTrainingAnalytics([sess('2026-10-20', [{ sets: [[100, 1], [60, 15]] }])]).history('supino')!.points[0];
    expect(p.e1rm).toBe(estimate1RM(100, 1));
    expect(p.topLoadByBand).toEqual({ '1-5': 100, '13+': 60 });
    const longOnly = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22'].map((d, i) => sess(d, [{ key: 'leg', sets: [[100 + i * 10, 15]] }]));
    const t = analyzeTraining(longOnly, '60d', '2026-10-10').exercises[0].trend;
    expect(t.metric).toBe('carga_13');
    expect(t.direction).toBe('positiva');
  });

  it('a série reduzida para gráficos mantém no máximo o limite de pontos', () => {
    const list = Array.from({ length: 300 }, (_, i) => bench(`2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, 50 + (i % 7)));
    const a = createTrainingAnalytics(list);
    const r = a.report('all', '2026-12-31');
    const pts = a.series('supino', r.range, (p) => p.topLoad, 120);
    expect(pts.length).toBeLessThanOrEqual(120);
    expect(Math.max(...pts.map((p) => p.topLoad!))).toBe(56);
  });
});

describe('comparação de períodos', () => {
  it('compara com a janela anterior de mesma duração quando o histórico a cobre', () => {
    const list = [bench('2026-08-29', 60), bench('2026-09-10', 60), bench('2026-10-01', 60), bench('2026-10-10', 60), bench('2026-10-20', 60)];
    const r = analyzeTraining(list, '30d', '2026-10-27');
    expect(r.comparison.available).toBe(true);
    expect(r.comparison.previous).toEqual({ from: '2026-08-29', to: '2026-09-27', days: 30 });
    expect(r.comparison.sessions).toEqual({ current: 3, previous: 2, diff: 1, pct: 50 });
    expect(r.comparison.volume!.pct).toBeCloseTo(50, 10);
  });

  it('sem comparação quando o histórico começa depois do início da janela anterior', () => {
    const r = analyzeTraining([bench('2026-09-01', 60), bench('2026-10-20', 60)], '30d', '2026-10-27');
    expect(r.comparison).toMatchObject({ available: false, reason: 'historico_insuficiente', sessions: null });
    expect(analyzeTraining([bench('2026-09-01', 60)], 'all', '2026-10-27').comparison).toMatchObject({ available: false, reason: 'periodo_total' });
  });

  it('percentual não é inventado quando o período anterior é zero', () => {
    const r = analyzeTraining([bench('2026-07-01', 60), bench('2026-10-20', 60)], '30d', '2026-10-27');
    expect(r.comparison.sessions).toEqual({ current: 1, previous: 0, diff: 1, pct: null });
  });
});

describe('recordes pessoais', () => {
  it(`maior carga, maior volume numa série e 1RM estimado com data; recorde só depois de ${MIN_PRIOR_SESSIONS_FOR_RECORD} sessões`, () => {
    const list = [bench('2026-09-01', 60), bench('2026-09-08', 65), bench('2026-09-15', 70), bench('2026-09-22', 70, 10), bench('2026-10-20', 75, 3)];
    const h = createTrainingAnalytics(list).history('supino')!;
    const r = h.records;
    expect(r.maxLoad).toMatchObject({ value: 75, reps: 3, date: '2026-10-20' });
    expect(r.maxSetVolume).toMatchObject({ value: 700, date: '2026-09-22' });
    expect(r.bestE1rm!.value).toBeCloseTo(estimate1RM(70, 10), 10);
    expect(r.bestE1rm!.date).toBe('2026-09-22');
    // 65 kg (2ª sessão) não é recorde: só havia 1 sessão antes.
    expect(r.loadRecordHistory.map((m) => [m.date, m.value, m.previous])).toEqual([
      ['2026-09-15', 70, 65],
      ['2026-10-20', 75, 70],
    ]);
  });

  it('empate não renova recorde; recorde absoluto difere do melhor do período', () => {
    const list = [bench('2026-06-01', 60), bench('2026-06-08', 60), bench('2026-06-15', 100), bench('2026-10-20', 100), bench('2026-10-22', 90)];
    const r = analyzeTraining(list, '30d', '2026-10-27');
    const e = r.exercises[0];
    expect(e.records.maxLoad!.date).toBe('2026-06-15');
    expect(e.newLoadRecordInPeriod).toBeNull();
    expect(e.periodBest.maxLoad).toMatchObject({ value: 100, date: '2026-10-20' });
  });

  it('recorde dentro do período só é anunciado se continua sendo o recorde absoluto', () => {
    const list = [bench('2026-09-01', 60), bench('2026-09-08', 60), bench('2026-10-20', 70), bench('2026-10-25', 80)];
    const r = analyzeTraining(list, '7d', '2026-10-27');
    expect(r.exercises[0].newLoadRecordInPeriod).toMatchObject({ value: 80, previous: 70 });
    const first = analyzeTraining([bench('2026-10-25', 80)], '7d', '2026-10-27');
    expect(first.exercises[0].newLoadRecordInPeriod).toBeNull();
    expect(first.exercises[0].records.loadRecordHistory).toEqual([]);
  });

  it('não muda o cálculo histórico: o gráfico antigo segue com a divergência de 1RM documentada', () => {
    const list = [sess('2026-10-20', [{ sets: [[100, 1]] }])];
    expect(exerciseSeries(list, 'supino')[0].best1RM).toBeCloseTo(100 * (1 + 1 / 30), 10);
    expect(createTrainingAnalytics(list).history('supino')!.points[0].e1rm).toBe(100);
  });
});

describe('dados reais imperfeitos', () => {
  it('registros antigos: sem profileId, sem exerciseKey e sem grupo muscular', () => {
    const legacy = sess('2026-10-20', [{ key: '', name: 'Agachamento Livre', group: '', sets: [[80, 5]] }]);
    delete legacy.profileId;
    const r = analyzeTraining([legacy], '30d', '2026-10-27');
    expect(r.exercises[0]).toMatchObject({ key: 'agachamento livre', name: 'Agachamento Livre', muscleGroup: null, volume: 400 });
    expect(r.unclassifiedSets).toBe(1);
  });

  it('rotinas excluídas não afetam a análise (as sessões guardam o próprio exercício)', () => {
    const list = [bench('2026-10-01', 60), sess('2026-10-10', [{ sets: [[62.5, 8]] }], { routineId: 'rotina-apagada', workoutId: 'x' })];
    const r = analyzeTraining(list, '30d', '2026-10-27');
    expect(r.totals.sessions).toBe(2);
    expect(r.exercises).toHaveLength(1);
    expect(r.exercises[0].sessions).toBe(2);
  });

  it('exercícios diferentes em cada sessão e nome renomeado mantêm a identidade pela chave', () => {
    const list = [sess('2026-10-01', [{ key: 'a', name: 'Antigo' }].map((e) => ({ ...e, sets: [[10, 10]] as SetSpec[] }))), sess('2026-10-05', [{ key: 'b', sets: [[20, 10]] }]), sess('2026-10-09', [{ key: 'a', name: 'Novo nome', sets: [[12, 10]] }])];
    const r = analyzeTraining(list, '30d', '2026-10-27');
    expect(r.exercises.map((e) => [e.key, e.name, e.sessions])).toEqual([
      ['a', 'Novo nome', 2],
      ['b', 'B', 1],
    ]);
  });

  it('valores inválidos ficam fora dos cálculos e são contados; nunca há NaN ou Infinity', () => {
    const bad = sess('2026-10-20', [
      {
        sets: [[60, 8], [Number.NaN, 8], [-20, 8], [Number.POSITIVE_INFINITY, 5], [60, Number.NaN], [60, 0], [60, -3], [60, Number.POSITIVE_INFINITY], [60, null]],
      },
    ]);
    const broken = { ...sess('2026-10-21', [{ sets: [[60, 8]] }]), startedAt: Number.NaN };
    const r = analyzeTraining([bad, broken], '30d', '2026-10-27');
    expect(r.quality).toEqual({ completedSessions: 1, ignoredSessions: 1, invalidRepSets: 5, invalidLoadSets: 3, invalidModalitySets: 0 });
    expect(r.totals).toMatchObject({ sets: 4, loadedSets: 1, unloadedSets: 3, volume: 480 });
    assertFinite(r);
    assertFinite(buildInsights(r));
  });

  it('ausência de dados: relatório vazio sem números inventados', () => {
    for (const period of ['7d', '30d', '60d', '90d', 'all'] as const) {
      const r = analyzeTraining([], period, '2026-10-27');
      expect(r.hasData).toBe(false);
      expect(r.covered).toBeNull();
      expect(r.frequency.weeklyAverage).toBeNull();
      expect(r.consistency.variation).toBeNull();
      expect(r.buckets).toEqual([]);
      expect(r.exercises).toEqual([]);
      assertFinite(r);
      expect(buildInsights(r).map((i) => i.id)).toEqual(['dados.sem_treinos']);
    }
  });

  it('um único treino: sem tendência, sem recorde, sem comparação', () => {
    const r = analyzeTraining([bench('2026-10-27', 60)], '30d', '2026-10-27');
    expect(r.hasData).toBe(true);
    expect(r.exercises[0].trend.direction).toBe('insuficiente');
    expect(r.exercises[0].newLoadRecordInPeriod).toBeNull();
    expect(r.comparison.available).toBe(false);
    assertFinite(r);
  });

  it('histórico irregular: regularidade calculada só sobre semanas completas, semanas sem treino contam zero', () => {
    const list = [bench('2026-08-03', 60), bench('2026-08-04', 60), bench('2026-08-05', 60), bench('2026-08-24', 60), bench('2026-09-14', 60), bench('2026-09-15', 60), bench('2026-09-16', 60), bench('2026-09-17', 60)];
    const r = analyzeTraining(list, '90d', '2026-10-27');
    expect(r.covered!.from).toBe('2026-08-03');
    expect(r.consistency.completeWeeks).toBe(12);
    expect(r.consistency.activeCompleteWeeks).toBe(3);
    expect(r.consistency.regularity).toBe('muito_variavel');
  });

  it('não altera as sessões recebidas', () => {
    const list = [bench('2026-10-01', 60), bench('2026-10-10', 65)];
    const before = JSON.stringify(list);
    const a = createTrainingAnalytics(list);
    for (const p of ['7d', '30d', '60d', '90d', 'all'] as const) buildInsights(a.report(p, '2026-10-27'));
    expect(JSON.stringify(list)).toBe(before);
  });
});

describe('motor de insights', () => {
  const progress = () => {
    // 60 dias anteriores + 30 atuais com progressão, frequência estável.
    const list: WorkoutSession[] = [];
    let load = 60;
    for (let d = 0; d < 90; d += 3) {
      const date = new Date(2026, 6, 30 + d);
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      list.push(bench(iso, (load += 0.5)));
    }
    return list;
  };

  it('cada insight tem id, tipo, título, descrição, período, métrica e evidência numérica finita', () => {
    const r = analyzeTraining(progress(), '30d', '2026-10-27');
    const ins = buildInsights(r);
    expect(ins.length).toBeGreaterThan(3);
    for (const i of ins) {
      expect(i.id).toMatch(/^[a-z]+\.[a-z_]+/);
      expect(i.title.length).toBeGreaterThan(5);
      expect(i.description.length).toBeGreaterThan(10);
      expect(i.period).toBe('30d');
      expect(i.range).toEqual(r.range);
      expect(i.metric.length).toBeGreaterThan(3);
      expect(i.evidence.length).toBeGreaterThan(0);
      assertFinite(i.evidence);
    }
    expect(new Set(ins.map((i) => i.id)).size).toBe(ins.length);
  });

  it('evolução positiva rastreável até a tendência calculada', () => {
    const r = analyzeTraining(progress(), '30d', '2026-10-27');
    const i = buildInsights(r).find((x) => x.id === 'carga.tendencia.supino')!;
    expect(i).toMatchObject({ type: 'carga', tone: 'positivo', metric: 'exercises.supino.trend' });
    const t = r.exercises[0].trend;
    expect(i.evidence.find((e) => e.label === 'Variação')!.value).toBe(t.changePct);
    expect(i.confidence).toBe(t.confidence);
  });

  it('mais sessões que no período anterior, recorde e frequência estável', () => {
    const list = [bench('2026-08-29', 50), bench('2026-09-05', 50), bench('2026-10-01', 55), bench('2026-10-08', 55), bench('2026-10-15', 60), bench('2026-10-22', 65)];
    const ins = buildInsights(analyzeTraining(list, '30d', '2026-10-27'));
    const byId = Object.fromEntries(ins.map((i) => [i.id, i]));
    expect(byId['frequencia.comparacao']).toMatchObject({ tone: 'positivo', title: 'Mais sessões que no período anterior' });
    expect(byId['frequencia.comparacao'].evidence.map((e) => e.value)).toEqual([4, 2, 100]);
    expect(byId['recorde.carga.supino']).toMatchObject({ type: 'recorde', title: 'Novo recorde de carga em Supino' });
    expect(byId['recorde.carga.supino'].evidence.map((e) => e.value)).toEqual([65, 60, 8]);
    expect(byId['consistencia.regularidade']).toMatchObject({ title: 'Frequência semanal estável' });
  });

  it('estabilidade, queda e dados insuficientes têm mensagens próprias e neutras', () => {
    const stable = [80, 82.5, 80, 82.5, 80, 82.5].map((l, i) => bench(`2026-10-${String(1 + i * 4).padStart(2, '0')}`, l));
    const drop = [100, 100, 100, 90, 90, 90].map((l, i) => sess(`2026-10-${String(1 + i * 4).padStart(2, '0')}`, [{ key: 'agacho', sets: [[l, 5]] }]));
    const few = [sess('2026-10-25', [{ key: 'rosca', sets: [[20, 10]] }])];
    const ins = buildInsights(analyzeTraining([...stable, ...drop, ...few], '30d', '2026-10-27'));
    expect(ins.find((i) => i.id === 'carga.tendencia.supino')).toMatchObject({ tone: 'neutro', title: 'Desempenho estável em Supino' });
    const q = ins.find((i) => i.id === 'carga.tendencia.agacho')!;
    expect(q).toMatchObject({ tone: 'neutro', title: 'Desempenho registrado menor em Agacho' });
    expect(q.description).toContain('não indica perda de força');
    expect(ins.find((i) => i.id === 'carga.tendencia.insuficiente')!.evidence[0]).toMatchObject({ value: 1, unit: 'exercicios' });
  });

  it('sem diagnósticos, prescrições, alarmismo ou culpa em nenhuma mensagem', () => {
    const scenarios: TrainingReport[] = [
      analyzeTraining(progress(), '30d', '2026-10-27'),
      analyzeTraining(progress(), 'all', '2026-10-27'),
      analyzeTraining([bench('2026-07-01', 100), bench('2026-07-08', 100), bench('2026-07-15', 100), bench('2026-10-01', 70), bench('2026-10-10', 70), bench('2026-10-20', 70), bench('2026-10-24', 70)], '90d', '2026-10-27'),
      analyzeTraining([], '30d', '2026-10-27'),
      analyzeTraining([bench('2026-01-01', 60)], '30d', '2026-10-27'),
    ];
    const FORBIDDEN = /overtraining|sobretreino|lesão|lesao|doença|diagnós|médic|descans(e|ar)\b|precisa (de )?descan|deveria|recomend|aconselh|dieta|caloria|suplement|falhou|fracass|culpa|preguiç|desist|perigo|alarm|risco|urgente|você parou|abandon/i;
    for (const r of scenarios) for (const i of buildInsights(r)) expect(`${i.title} ${i.description}`, i.id).not.toMatch(FORBIDDEN);
  });

  it('determinístico: mesmas sessões, mesmos insights (inclusive a ordem)', () => {
    const a = buildInsights(analyzeTraining(progress(), '60d', '2026-10-27'));
    const b = buildInsights(analyzeTraining([...progress()].reverse(), '60d', '2026-10-27'));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('período sem treinos (mas com histórico) explica em vez de concluir', () => {
    const ins = buildInsights(analyzeTraining([bench('2026-01-10', 60)], '7d', '2026-10-27'));
    expect(ins.map((i) => i.id)).toEqual(['dados.periodo_vazio']);
  });
});

describe('resumo para o assistente (preparado, não usado)', () => {
  it('só agregados: sem IDs, perfil, fotos, datas exatas ou sessões', () => {
    const list = [bench('2026-10-01', 60), bench('2026-10-10', 62.5)].map((s) => ({ ...s, profileId: 'perfil-secreto', notes: 'nota secreta' }));
    const r = analyzeTraining(list, '30d', '2026-10-27');
    const sum = toAnalyticsSummary(r, buildInsights(r));
    const json = JSON.stringify(sum);
    expect(json).not.toMatch(/perfil-secreto|nota secreta|"id"|profileId|routineId|sessionId|exerciseKey|"key"|dataUrl|photo|2026-10-|\d{12,}/);
    expect(sum).toMatchObject({ schema: 'irontrack.analytics-summary.v1', period: '30d', sessions: 2, volumeKg: 2940 });
    assertFinite(sum);
  });
});

describe('desempenho', () => {
  it('anos de histórico: índice e cinco períodos em tempo curto, sem reprocessar a cada período', () => {
    const list: WorkoutSession[] = [];
    const start = new Date(2023, 0, 2).getTime();
    for (let i = 0; i < 4 * 52 * 3; i++) {
      const ts = start + Math.floor(i / 4) * 7 * 86_400_000 + (i % 4) * 2 * 86_400_000 + 3_600_000 * 10;
      list.push(sess(ts, Array.from({ length: 6 }, (_, k) => ({ key: `ex${k}`, group: `G${k % 3}`, sets: [[50 + (i % 10), 8], [50 + (i % 10), 8], [50, 10], [40, 12]] as SetSpec[] }))));
    }
    const t0 = performance.now();
    const a = createTrainingAnalytics(list);
    for (const p of ['7d', '30d', '60d', '90d', 'all'] as const) buildInsights(a.report(p, '2025-12-31'));
    const elapsed = performance.now() - t0;
    expect(a.catalog).toHaveLength(6);
    expect(elapsed).toBeLessThan(2000);
    expect(a.report('all', '2025-12-31').buckets.length).toBeLessThanOrEqual(36);
  });
});
