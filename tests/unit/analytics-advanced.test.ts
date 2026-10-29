// Analytics avançado (IronTrack 2.0 F01/P09): normalização muscular, classificação, 1RM canônico, modalidades
// e qualidade das tendências. Dados fictícios apenas.
import { describe, expect, it } from 'vitest';
import {
  analyzeTraining,
  bodyweightMetrics,
  bodyweightSetKind,
  buildInsights,
  canonicalE1rm,
  canonicalE1rmKg,
  cardioMetrics,
  classifyExercise,
  compareSides,
  compareWithLegacyChart,
  computeTrend,
  createMuscleNormalizer,
  createTrainingAnalytics,
  E1RM_METHOD,
  E1RM_METHOD_ID,
  exerciseAnalyses,
  foldMuscleText,
  fromKg,
  INDICATOR_GUIDE,
  KG_PER_LB as ANALYTICS_KG_PER_LB,
  legacyChartE1rm,
  METERS_PER_MILE,
  muscleDistributionOf,
  normalizeMuscleGroup,
  normalizeSessions,
  sameMethodOnly,
  supportsLoadMetrics,
  timedMetrics,
  toKg,
  toMeters,
  TREND_BASE_THRESHOLD_PCT,
  TREND_LONG_GAP_DAYS,
  TREND_MIN_POINTS,
  TREND_MIN_SPAN_DAYS,
  TREND_NOISE_SE,
  UNAVAILABLE_ANALYSIS_TEXT,
} from '@/modules/analytics';
import { estimate1RM, exerciseSeries, type SessionExercise, type SessionSet, type WorkoutSession } from '@/modules/training';
import { KG_PER_LB } from '@/lib/units';

// ---------------------------------------------------------------------------------------------
// Fixtures (mesmo formato das sessões persistidas)

type SetSpec = [weight: number | null, reps: number | null];
let seq = 0;
const at = (iso: string) => {
  const [y, mo, d] = iso.split('-').map(Number);
  return new Date(y, mo - 1, d, 10).getTime();
};
function ex(key: string, group: string, sets: SetSpec[], equipment: SessionExercise['equipment'] = 'barbell', name = key): SessionExercise {
  return {
    id: `x${++seq}`,
    exerciseKey: key,
    name,
    muscleGroup: group,
    category: 'compound',
    equipment,
    repMin: 6,
    repMax: 10,
    restSec: 90,
    plannedSets: sets.length,
    sets: sets.map(([weight, reps]): SessionSet => ({ id: `s${++seq}`, type: 'normal', status: 'done', weight, reps })),
  };
}
function sess(date: string, exercises: SessionExercise[]): WorkoutSession {
  const startedAt = at(date);
  return { id: `w${++seq}`, routineId: 'r', workoutId: 'A', workoutLabel: 'A', workoutName: 'Treino A', status: 'completed', startedAt, finishedAt: startedAt + 3_600_000, exercises, updatedAt: startedAt };
}
const deepClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const days = (start: string, n: number, step: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(at(start) + i * step * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

// ---------------------------------------------------------------------------------------------

describe('normalização de grupos musculares', () => {
  it('acentos, maiúsculas e espaços extras', () => {
    expect(foldMuscleText('  QUADRÍCEPS  ')).toBe('quadriceps');
    expect(foldMuscleText('Posterior   de coxa')).toBe('posterior de coxa');
    for (const raw of ['Bíceps', 'biceps', 'BICEPS', '  bíceps ']) expect(normalizeMuscleGroup(raw)).toMatchObject({ id: 'biceps', label: 'Bíceps', match: 'canonico' });
    for (const raw of ['Tríceps', 'triceps']) expect(normalizeMuscleGroup(raw).label).toBe('Tríceps');
  });

  it('sinônimos do Prompt 09 e os grupos padrão do app', () => {
    const cases: [string, string][] = [
      ['Peito', 'Peitoral'], ['peitoral', 'Peitoral'],
      ['Costas', 'Costas'], ['dorsal', 'Costas'], ['Dorsais', 'Costas'],
      ['Ombro', 'Ombros'], ['ombros', 'Ombros'], ['Deltoides', 'Ombros'],
      ['Quadriceps', 'Quadríceps'],
      ['Posterior', 'Posteriores de coxa'], ['Posteriores de coxa', 'Posteriores de coxa'], ['Posterior de coxa', 'Posteriores de coxa'],
      ['Panturrilha', 'Panturrilhas'], ['panturrilhas', 'Panturrilhas'],
      ['Abdômen', 'Abdômen'], ['abdomen', 'Abdômen'], ['Abdominal', 'Abdômen'],
      ['Antebraço', 'Antebraço'], ['Glúteos', 'Glúteos'], ['Trapézio', 'Trapézio'],
    ];
    for (const [raw, label] of cases) expect(normalizeMuscleGroup(raw).label, raw).toBe(label);
  });

  it('desconhecido fica como está (sem forçar um grupo) e variações só de caixa se juntam', () => {
    const a = normalizeMuscleGroup('  Serrátil ');
    expect(a).toMatchObject({ id: null, match: 'nao_reconhecido', label: 'Serrátil', original: '  Serrátil ' });
    expect(normalizeMuscleGroup('SERRATIL').key).toBe(a.key);
    // A chave de um texto livre nunca colide com um id canônico.
    expect(a.key).not.toBe('costas');
  });

  it('ambíguos e vários grupos no mesmo texto não são atribuídos', () => {
    for (const raw of ['Pernas', 'perna', 'Braços', 'Core', 'Corpo inteiro', 'Peito e tríceps', 'Costas/Bíceps', 'Ombro, trapézio', 'Quadríceps + glúteos'])
      expect(normalizeMuscleGroup(raw), raw).toMatchObject({ id: null, match: 'ambiguo' });
    expect(normalizeMuscleGroup('')).toMatchObject({ key: null, match: 'vazio' });
    expect(normalizeMuscleGroup(null).match).toBe('vazio');
    expect(normalizeMuscleGroup(undefined as unknown as string).match).toBe('vazio');
  });

  it('preserva o nome original no banco e no relatório (P08 continua com o texto exato)', () => {
    const list = [sess('2026-10-20', [ex('supino', 'Peito', [[60, 8]]), ex('crucifixo', ' peitoral ', [[14, 12]]), ex('afundo', 'Pernas', [[20, 10]]), ex('x', '', [[10, 10]])])];
    const before = deepClone(list);
    const r = analyzeTraining(list, '30d', '2026-10-27');
    expect(list).toEqual(before);
    expect(r.muscleGroups.map((g) => g.group).sort()).toEqual(['Peito', 'Pernas', 'peitoral']);
    expect(r.muscleDistribution.groups).toEqual([{ key: 'peitoral', group: 'Peitoral', sets: 2, originals: ['Peito', 'peitoral'] }]);
    expect(r.muscleDistribution.ambiguous.map((g) => g.group)).toEqual(['Pernas']);
    expect(r.muscleDistribution.emptySets).toBe(1);
    const supino = r.exercises.find((e) => e.key === 'supino')!;
    expect(supino.muscleGroup).toBe('Peito');
    expect(supino.muscle.label).toBe('Peitoral');
  });

  it('cada série conta uma vez, no grupo principal (sem duplicar volume em músculos auxiliares)', () => {
    const s = normalizeSessions([sess('2026-10-20', [ex('supino', 'Peito', [[60, 8], [60, 8], [60, 8]])])]).sessions;
    const d = muscleDistributionOf(s);
    expect(d.groups.reduce((a, g) => a + g.sets, 0)).toBe(3);
  });

  it('normalizador memoizado devolve o mesmo resultado', () => {
    const n = createMuscleNormalizer();
    expect(n('Peito')).toBe(n('Peito'));
    expect(n('Peito')).toEqual(normalizeMuscleGroup('Peito'));
  });
});

describe('classificação de exercícios', () => {
  it('carga externa: equipamento de carga com séries carregadas', () => {
    const c = classifyExercise({ equipment: 'barbell', hasLoadedSets: true, hasUnloadedSets: false });
    expect(c).toMatchObject({ modalities: ['resistance_weighted'], load: 'externa', laterality: 'desconhecida', source: 'dados_existentes' });
    expect(supportsLoadMetrics(c)).toBe(true);
  });

  it('peso corporal sem carga e com carga adicional (assistência nunca é deduzida)', () => {
    const only = classifyExercise({ equipment: 'bodyweight', hasLoadedSets: false, hasUnloadedSets: true });
    expect(only).toMatchObject({ modalities: ['bodyweight'], load: 'corporal' });
    const added = classifyExercise({ equipment: 'bodyweight', hasLoadedSets: true, hasUnloadedSets: true });
    expect(added).toMatchObject({ modalities: ['bodyweight'], load: 'corporal_com_adicional' });
    expect(supportsLoadMetrics(added)).toBe(false);
  });

  it('assistência e unilateral só por atributo explícito (contrato futuro), combináveis com carga', () => {
    const assisted = classifyExercise({ equipment: 'machine', hasLoadedSets: true, hasUnloadedSets: false, explicit: { loadMode: 'assistida' } });
    expect(assisted).toMatchObject({ load: 'corporal_assistida', modalities: ['bodyweight'], source: 'explicito' });
    expect(assisted.measures.externalLoad).toBe(false);
    const uni = classifyExercise({ equipment: 'dumbbell', hasLoadedSets: true, hasUnloadedSets: false, explicit: { laterality: 'unilateral' } });
    expect(uni.modalities).toEqual(['resistance_weighted', 'unilateral']);
    // Halteres sozinhos não dizem que o exercício é unilateral.
    expect(classifyExercise({ equipment: 'dumbbell', hasLoadedSets: true, hasUnloadedSets: false }).laterality).toBe('desconhecida');
  });

  it('temporizado e cardio explícitos; sem dados de tempo, a medida continua indisponível (dados incompatíveis)', () => {
    const timed = classifyExercise({ equipment: 'bodyweight', hasLoadedSets: false, hasUnloadedSets: true, explicit: { modality: 'timed' } });
    expect(timed.modalities).toContain('timed');
    expect(timed.measures.duration).toBe(false);
    const cardio = classifyExercise({ equipment: 'other', hasLoadedSets: false, hasUnloadedSets: false, hasDuration: true, hasDistance: true, explicit: { modality: 'cardio' } });
    expect(cardio.modalities).toEqual(['cardio']);
    expect(cardio.measures).toMatchObject({ duration: true, distance: true });
  });

  it('sem modalidade nem carga: desconhecido; o nome nunca é usado', () => {
    const c = classifyExercise({ equipment: 'machine', hasLoadedSets: false, hasUnloadedSets: true });
    expect(c).toMatchObject({ modalities: ['unknown'], load: 'desconhecida', source: 'desconhecido' });
    expect(classifyExercise({ equipment: null, hasLoadedSets: false, hasUnloadedSets: false }).modalities).toEqual(['unknown']);
    // "Prancha" registrada com repetições: continua repetições, nada vira segundos.
    const r = analyzeTraining([sess('2026-10-20', [ex('prancha', 'Abdômen', [[null, 45]], 'bodyweight', 'Prancha')])], '30d', '2026-10-27');
    const p = r.exercises[0];
    expect(p.classification.modalities).toEqual(['bodyweight']);
    expect(p.classification.measures.duration).toBe(false);
    expect(p.reps).toBe(45);
  });

  it('determinística: mesma entrada, mesma classificação', () => {
    const input = { equipment: 'cable', hasLoadedSets: true, hasUnloadedSets: true } as const;
    expect(classifyExercise(input)).toEqual(classifyExercise(input));
  });

  it('análises por tipo: só as sustentadas pelos dados ficam disponíveis', () => {
    const r = analyzeTraining(
      [sess('2026-10-20', [ex('supino', 'Peito', [[60, 8]]), ex('barra', 'Costas', [[null, 8]], 'bodyweight'), ex('paralela', 'Tríceps', [[10, 8]], 'bodyweight')])],
      '30d',
      '2026-10-27',
    );
    const by = (k: string) => Object.fromEntries(exerciseAnalyses(r.exercises.find((e) => e.key === k)!).map((a) => [a.kind, a.available]));
    expect(by('supino')).toEqual({ carga: true, repeticoes: true, duracao: false, cardio: false, lados: false });
    expect(by('barra')).toEqual({ carga: false, repeticoes: true, carga_adicional: false, duracao: false, cardio: false, lados: false });
    expect(by('paralela')).toMatchObject({ carga: false, carga_adicional: true });
    expect(UNAVAILABLE_ANALYSIS_TEXT).toBe('Este exercício ainda não possui dados suficientes para esse tipo de análise.');
  });
});

describe('peso corporal', () => {
  it('sem volume fictício: só a carga adicional registrada entra no volume (P08), sem 1RM no exercício', () => {
    const list = days('2026-09-01', 6, 7).map((d, i) => sess(d, [ex('barra', 'Costas', [[null, 6 + i], [5 + i, 5]], 'bodyweight')]));
    const r = analyzeTraining(list, '60d', '2026-10-10');
    const b = r.exercises[0];
    expect(b.volume).toBe(list.reduce((a, _s, i) => a + (5 + i) * 5, 0));
    expect(b.classification.load).toBe('corporal_com_adicional');
    // Tendência só em repetições sem carga (condições comparáveis), nunca 1RM da carga adicional.
    expect(b.trend.metric).toBe('reps');
    expect(b.trend.direction).toBe('positiva');
  });

  it('tipos de série: só corporal, carga adicional, assistência, incompatível', () => {
    expect(bodyweightSetKind({ reps: 8, load: null })).toBe('somente_corporal');
    expect(bodyweightSetKind({ reps: 8, load: 10 })).toBe('com_carga_adicional');
    expect(bodyweightSetKind({ reps: 8, load: null, assistanceKg: 20 })).toBe('com_assistencia');
    expect(bodyweightSetKind({ reps: 8, load: 10, assistanceKg: 20 })).toBe('incompativel');
    const m = bodyweightMetrics([
      { reps: 10, load: null },
      { reps: 6, load: 10 },
      { reps: 7, load: 10 },
      { reps: 8, load: null, assistanceKg: 30 },
      { reps: 9, load: null, assistanceKg: 20 },
      { reps: 5, load: 5, assistanceKg: 5 },
      { reps: 0, load: null },
    ]);
    expect(m).toEqual({
      sets: 5,
      reps: 40,
      bySetKind: { somente_corporal: 1, com_carga_adicional: 2, com_assistencia: 2, incompativel: 1 },
      bestRepsBodyOnly: 10,
      bestAddedLoad: { load: 10, reps: 7 },
      bestAssisted: { assistanceKg: 20, reps: 9 },
      volumeKg: null,
    });
  });
});

describe('exercícios por tempo (contrato, dados fictícios)', () => {
  it('maior duração, total, frequência e tendência de duração', () => {
    const list = days('2026-09-01', 6, 5).map((date, i) => ({ date, durationsSec: [30 + i * 10, 25 + i * 10] }));
    const m = timedMetrics(list);
    expect(m).toMatchObject({ available: true, sessions: 6, sets: 12, invalidSets: 0, longestSec: 80 });
    expect(m.totalSec).toBe(list.reduce((a, s) => a + s.durationsSec[0] + s.durationsSec[1], 0));
    expect(m.trend).toMatchObject({ metric: 'duracao', direction: 'positiva' });
  });

  it('sem duração confiável: indisponível, sem zeros; repetições nunca viram segundos', () => {
    const m = timedMetrics([{ date: '2026-10-01', durationsSec: [null, undefined, 0, -5, Number.NaN] }]);
    expect(m).toMatchObject({ available: false, reason: 'sem_duracao', longestSec: null, totalSec: null, invalidSets: 5 });
    expect(m.trend.direction).toBe('insuficiente');
  });
});

describe('unilaterais (contrato, dados fictícios)', () => {
  it('compara lados registrados sem duplicar séries nem volume', () => {
    const c = compareSides([
      { side: 'direito', reps: 10, load: 12 },
      { side: 'esquerdo', reps: 8, load: 12 },
      { side: 'direito', reps: 9, load: 14 },
      { side: 'ambos', reps: 12, load: 10 },
      { side: null, reps: 10, load: 12 },
    ]);
    expect(c.available).toBe(true);
    expect(c.direito).toEqual({ sets: 2, reps: 19, volume: 10 * 12 + 9 * 14, topLoad: 14, bestReps: 10 });
    expect(c.esquerdo).toEqual({ sets: 1, reps: 8, volume: 96, topLoad: 12, bestReps: 8 });
    expect(c.ambos.sets).toBe(1);
    expect(c.desconhecido.sets).toBe(1);
    const total = c.direito.sets + c.esquerdo.sets + c.ambos.sets + c.desconhecido.sets;
    expect(total).toBe(5);
    expect(c.differences!.reps.diff).toBe(11);
    expect(c.differences!.topLoad!.diff).toBe(2);
  });

  it('sem lado registrado (dados atuais) ou com um lado só: análise indisponível', () => {
    expect(compareSides([{ side: undefined, reps: 10, load: 20 }])).toMatchObject({ available: false, reason: 'sem_lado', differences: null });
    expect(compareSides([{ side: 'esquerdo', reps: 10, load: 20 }])).toMatchObject({ available: false, reason: 'um_lado_so' });
  });
});

describe('cardio (contrato, dados fictícios)', () => {
  it('conversões de unidade e ritmo/velocidade só com os dois campos', () => {
    expect(toMeters(5, 'km')).toBe(5000);
    expect(toMeters(800, 'm')).toBe(800);
    expect(toMeters(1, 'mi')).toBe(METERS_PER_MILE);
    const m = cardioMetrics(
      [
        { date: '2026-10-01', durationSec: 1500, distance: { value: 5, unit: 'km' } },
        { date: '2026-10-03', durationSec: 1200, distance: { value: 4000, unit: 'm' } },
        { date: '2026-10-05', durationSec: 600 },
        { date: '2026-10-07', distance: { value: 2, unit: 'km' } },
        { date: '2026-10-09', durationSec: 0, distance: { value: -1, unit: 'km' } },
      ],
      14,
    );
    expect(m.sessions).toBe(4);
    expect(m.points[0]).toMatchObject({ distanceM: 5000, paceSecPerKm: 300, speedKmh: 12 });
    expect(m.points[1].paceSecPerKm).toBe(300);
    expect(m.points[2]).toMatchObject({ paceSecPerKm: null, speedKmh: null, distanceM: null });
    expect(m).toMatchObject({ totalDurationSec: 3300, sessionsWithDuration: 3, totalDistanceM: 11000, sessionsWithDistance: 3, averagePaceSecPerKm: 300, averageSpeedKmh: 12, weeklyFrequency: 2 });
    expect(Object.keys(m)).not.toContain('calories');
  });

  it('sem dados de cardio: indisponível; frequência semanal não calculada em menos de 7 dias', () => {
    expect(cardioMetrics([])).toMatchObject({ available: false, reason: 'sem_dados_de_cardio', totalDurationSec: null, averagePaceSecPerKm: null });
    expect(cardioMetrics([{ date: '2026-10-01', durationSec: 600 }], 3).weeklyFrequency).toBeNull();
  });
});

describe('1RM canônico', () => {
  it('uma repetição: a própria carga; 2 a 12: Epley; método identificado', () => {
    expect(canonicalE1rm(100, 1)).toEqual({ ok: true, valueKg: 100, method: E1RM_METHOD_ID, kind: 'direta', loadKg: 100, reps: 1 });
    for (let reps = 2; reps <= 12; reps++) {
      const r = canonicalE1rm(80, reps);
      expect(r.ok && r.valueKg).toBe(80 * (1 + reps / 30));
      expect(r.ok && r.kind).toBe('estimada');
      // Igual à fórmula dos recordes (estimate1RM) dentro do intervalo.
      expect(canonicalE1rmKg(80, reps)).toBe(estimate1RM(80, reps));
    }
    expect(E1RM_METHOD).toMatchObject({ id: 'epley-1a12-v1', minReps: 1, maxReps: 12, unit: 'kg' });
  });

  it('acima do limite não extrapola; cargas e repetições inválidas são recusadas com motivo', () => {
    expect(canonicalE1rm(60, 13)).toEqual({ ok: false, method: E1RM_METHOD_ID, reason: 'acima_do_intervalo' });
    for (const load of [0, -20, Number.NaN, Number.POSITIVE_INFINITY, null, '80']) expect(canonicalE1rm(load, 5)).toMatchObject({ ok: false, reason: 'carga_invalida' });
    for (const reps of [0, -1, 2.5, Number.NaN, null, '5']) expect(canonicalE1rm(80, reps)).toMatchObject({ ok: false, reason: 'repeticoes_invalidas' });
    expect(canonicalE1rmKg(0, 5)).toBeNull();
  });

  it('conversão kg/lb exata e precisão interna sem arredondar', () => {
    expect(ANALYTICS_KG_PER_LB).toBe(KG_PER_LB);
    expect(toKg(225, 'lb')).toBe(225 * 0.45359237);
    expect(fromKg(toKg(225, 'lb'), 'lb')).toBeCloseTo(225, 10);
    const r = canonicalE1rm(225, 5, 'lb');
    expect(r.ok && r.valueKg).toBe(225 * 0.45359237 * (1 + 5 / 30));
    // 72,5 × (1 + 7/30) = 89,41666…: nenhum arredondamento no valor interno.
    expect(canonicalE1rmKg(72.5, 7)).toBe(72.5 * (1 + 7 / 30));
    expect(Number.isInteger((canonicalE1rmKg(72.5, 7)! * 1000))).toBe(false);
  });

  it('compatibilidade do gráfico antigo: o adaptador reproduz exerciseSeries e a diferença é documentada', () => {
    const list = [sess('2026-10-01', [ex('supino', 'Peito', [[100, 1]])]), sess('2026-10-03', [ex('supino', 'Peito', [[100, 10]])]), sess('2026-10-05', [ex('supino', 'Peito', [[50, 15]])])];
    const legacy = exerciseSeries(list, 'supino').map((p) => p.best1RM);
    expect(legacy).toEqual([legacyChartE1rm(100, 1), legacyChartE1rm(100, 10), legacyChartE1rm(50, 15)]);
    const one = compareWithLegacyChart(100, 1);
    expect(one.canonicalKg).toBe(100);
    expect(one.diffPct).toBeCloseTo(100 / 30, 10); // ≈ 3,33% a mais no gráfico antigo
    expect(compareWithLegacyChart(100, 10).diffKg).toBe(0);
    expect(compareWithLegacyChart(50, 15)).toMatchObject({ canonicalKg: null, reason: 'acima_do_intervalo', legacyChartKg: 75 });
    // O motor novo usa o canônico: 1RM de 1 rep é a carga; 15 reps não geram 1RM.
    const an = createTrainingAnalytics(list).history('supino')!;
    expect(an.points.map((p) => p.e1rm)).toEqual([100, estimate1RM(100, 10), null]);
  });

  it('não mistura métodos numa mesma série de estimativas', () => {
    const items = [{ method: E1RM_METHOD_ID, v: 1 }, { method: 'legado-grafico', v: 2 }, { method: E1RM_METHOD_ID, v: 3 }];
    expect(sameMethodOnly(items).map((i) => i.v)).toEqual([1, 3]);
    const r = analyzeTraining([sess('2026-10-20', [ex('supino', 'Peito', [[60, 8]])])], '30d', '2026-10-27');
    expect(r.exercises[0].e1rmMethod).toBe(E1RM_METHOD_ID);
  });
});

describe('qualidade das tendências (caracterização dos limiares do P08)', () => {
  const obs = (values: number[], step = 4, start = '2026-08-03') => days(start, values.length, step).map((date, i) => ({ date, value: values[i] }));

  it('limiares inalterados', () => {
    expect({ TREND_MIN_POINTS, TREND_MIN_SPAN_DAYS, TREND_NOISE_SE, TREND_LONG_GAP_DAYS }).toEqual({ TREND_MIN_POINTS: 4, TREND_MIN_SPAN_DAYS: 14, TREND_NOISE_SE: 2, TREND_LONG_GAP_DAYS: 28 });
    expect(TREND_BASE_THRESHOLD_PCT).toEqual({ e1rm: 2.5, carga_13: 2.5, reps: 5, duracao: 5, distancia: 5 });
  });

  it('amostras pequenas e dados insuficientes', () => {
    expect(computeTrend(obs([100, 120, 140]), 'e1rm')).toMatchObject({ direction: 'insuficiente', reason: 'poucas_sessoes' });
    expect(computeTrend(obs([100, 110, 120, 130], 2), 'e1rm')).toMatchObject({ direction: 'insuficiente', reason: 'intervalo_curto' });
    expect(computeTrend([], 'duracao')).toMatchObject({ direction: 'insuficiente', reason: 'sem_metrica' });
  });

  it('série estável e série ruidosa sem direção', () => {
    expect(computeTrend(obs([100, 100.5, 99.5, 100, 100.5, 99.8, 100.2, 100]), 'e1rm').direction).toBe('estavel');
    // Oscilação grande sem direção: o limiar sobe com o ruído e não declara evolução.
    const noisy = computeTrend(obs([80, 120, 85, 115, 90, 118, 82, 121]), 'e1rm');
    expect(noisy.direction).toBe('estavel');
    expect(noisy.thresholdPct!).toBeGreaterThan(TREND_BASE_THRESHOLD_PCT.e1rm);
  });

  it('evolução consistente e queda consistente', () => {
    expect(computeTrend(obs([100, 102, 104, 106, 108, 110, 112, 114]), 'e1rm')).toMatchObject({ direction: 'positiva', confidence: 'alta' });
    expect(computeTrend(obs([114, 112, 110, 108, 106, 104, 102, 100]), 'e1rm').direction).toBe('queda');
  });

  it('intervalos irregulares: pausa longa é sinalizada e reduz a confiança, sem contar dias sem treino', () => {
    const dates = ['2026-06-01', '2026-06-05', '2026-06-09', '2026-08-20', '2026-08-24', '2026-08-28'];
    const t = computeTrend(dates.map((date, i) => ({ date, value: [100, 101, 102, 96, 97, 98][i] })), 'e1rm');
    expect(t.longGap).toBe(true);
    expect(t.maxGapDays).toBeGreaterThan(TREND_LONG_GAP_DAYS);
    expect(t.confidence).toBe('baixa');
    expect(t.points).toBe(6); // só as sessões realizadas
    expect(computeTrend(obs([100, 102, 104, 106]), 'e1rm').longGap).toBe(false);
  });

  it('queda após pausa: o insight cita a pausa e não fala em perda de força como fato', () => {
    const dates = ['2026-06-01', '2026-06-05', '2026-06-09', '2026-06-13', '2026-08-20', '2026-08-24', '2026-08-28', '2026-09-01'];
    const loads = [100, 100, 100, 100, 85, 85, 85, 85];
    const r = analyzeTraining(dates.map((d, i) => sess(d, [ex('supino', 'Peito', [[loads[i], 5]])])), 'all', '2026-09-02');
    const i = buildInsights(r).find((x) => x.id === 'carga.tendencia.supino')!;
    expect(i.description).toContain('pausa');
    expect(i.description).toContain('não indica perda de força');
  });

  it('não compara modalidades: duração e carga ficam em métricas separadas', () => {
    const timed = timedMetrics(days('2026-09-01', 4, 5).map((date) => ({ date, durationsSec: [60] })));
    expect(timed.trend.metric).toBe('duracao');
    const r = analyzeTraining(days('2026-09-01', 4, 5).map((d) => sess(d, [ex('supino', 'Peito', [[60, 8]])])), '60d', '2026-10-01');
    expect(r.exercises[0].trend.metric).toBe('e1rm');
  });
});

describe('explicações dos indicadores', () => {
  it('cada indicador explica o que mede, como é calculado, quando comparar e limitações', () => {
    expect(INDICATOR_GUIDE.length).toBeGreaterThanOrEqual(8);
    for (const g of INDICATOR_GUIDE) for (const k of ['measures', 'calculation', 'comparable', 'limitations'] as const) expect(g[k].length, `${g.id}.${k}`).toBeGreaterThan(10);
    const e1rm = INDICATOR_GUIDE.find((g) => g.id === 'e1rm')!;
    expect(e1rm.calculation).toContain(E1RM_METHOD.name);
    const forbidden = /diagn[oó]stic(?!o\.)|overtraining|les[aã]o|prescrev|deve treinar|desequil[ií]brio/i;
    for (const g of INDICATOR_GUIDE) expect(`${g.measures} ${g.calculation} ${g.comparable}`).not.toMatch(forbidden);
  });
});

describe('desempenho e imutabilidade', () => {
  it('índice com histórico longo continua rápido e não altera a entrada', () => {
    const groups = ['Peito', 'peitoral', 'Costas', 'Dorsal', 'Pernas', 'Ombros'];
    const list: WorkoutSession[] = [];
    for (let i = 0; i < 600; i++) {
      const d = new Date(at('2024-01-01') + i * 2 * 86_400_000);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      list.push(sess(iso, groups.map((g, k) => ex(`ex${k}`, g, [[50 + (i % 7), 8], [50, 10], [null, 12]], k === 5 ? 'bodyweight' : 'barbell'))));
    }
    const before = deepClone(list);
    const t0 = performance.now();
    const a = createTrainingAnalytics(list);
    for (const p of ['7d', '30d', '60d', '90d', 'all'] as const) a.report(p, '2027-04-01');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(list).toEqual(before);
  });
});
