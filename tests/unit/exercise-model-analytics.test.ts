// Analytics com os registros do modelo v3 (P10): tempo, cardio, lados e peso corporal ligados aos contratos do
// P09, sem misturar modalidades e sem mudar os números de registros antigos. Dados fictícios.
import { describe, expect, it } from 'vitest';
import { E1RM_METHOD_ID, analyzeTraining, canonicalE1rmKg, createTrainingAnalytics, exerciseAnalyses, normalizeSessions } from '@/modules/analytics';
import type { WorkoutSession } from '@/lib/types';
import { session, snapshot } from './fixtures';
import { DIP, LUNGE, PLANK, PULLUP, RUN, sx } from './modelFixtures';

const DAY = 86_400_000;
const T0 = new Date(2026, 0, 5, 10).getTime();
const at = (i: number) => T0 + i * 4 * DAY;
const today = '2026-03-01';
const w = (id: string, i: number, exercises: WorkoutSession['exercises']) => session(id, { startedAt: at(i), finishedAt: at(i) + 3_600_000, exercises });
const summary = (sessions: WorkoutSession[], key: string) => analyzeTraining(sessions, 'all', today).exercises.find((e) => e.key === key)!;

describe('registros antigos não mudam', () => {
  it('relatório de sessões antigas é idêntico com ou sem treinos do modelo v3 de outros exercícios (exceto totais)', () => {
    const old = snapshot().sessions;
    const a = analyzeTraining(old, 'all', today);
    const b = analyzeTraining([...old, w('t', 1, [sx(PLANK, [{ durationSec: 30 }])])], 'all', today);
    expect(b.exercises.find((e) => e.key === 'supino')).toEqual(a.exercises.find((e) => e.key === 'supino'));
    expect(a.exercises[0].modality).toEqual({ timed: null, cardio: null, sides: null, bodyweight: null });
    expect(a.quality.invalidModalitySets).toBe(0);
  });
});

describe('exercício por tempo (timedMetrics)', () => {
  const sessions = [0, 1, 2, 3, 4].map((i) => w(`p${i}`, i, [sx(PLANK, [{ durationSec: 30 + i * 10 }, { durationSec: 20 }])]));

  it('usa a duração das séries, nunca repetições, e a tendência é de duração', () => {
    const ex = summary(sessions, 'prancha');
    expect(ex.modality.timed).toMatchObject({ available: true, sets: 10, longestSec: 70, totalSec: 30 + 40 + 50 + 60 + 70 + 100 });
    expect(ex.trend.metric).toBe('duracao');
    expect(ex.trend.direction).toBe('positiva');
    expect(ex.reps).toBe(0);
    expect(ex.modalitySets).toBe(10);
    expect(ex.classification.modalities).toContain('timed');
    const by = Object.fromEntries(exerciseAnalyses(ex).map((a) => [a.kind, a.available]));
    expect(by).toMatchObject({ duracao: true, carga: false, cardio: false, lados: false });
  });

  it('séries por tempo contam como séries no total e no grupo muscular; sem duração ficam fora e são contadas', () => {
    const bad = [...sessions, w('px', 6, [sx(PLANK, [{ reps: 45 }])])];
    const r = analyzeTraining(bad, 'all', today);
    expect(r.totals.modalitySets).toBe(10);
    expect(r.totals.sets).toBe(10);
    expect(r.totals.reps).toBe(0);
    expect(r.quality.invalidModalitySets).toBe(1);
    expect(r.quality.invalidRepSets).toBe(0);
  });

  it('dados insuficientes: tendência não é declarada', () => {
    const ex = summary(sessions.slice(0, 2), 'prancha');
    expect(ex.trend.direction).toBe('insuficiente');
  });
});

describe('cardio (cardioMetrics)', () => {
  const sessions = [0, 1, 2, 3].map((i) => w(`c${i}`, i, [sx(RUN, [{ durationSec: 1800, distance: 5000 + i * 500 }])]));

  it('duração, distância, ritmo e tendência de distância; sem misturar com carga', () => {
    const ex = summary([...sessions, w('c4', 4, [sx(RUN, [{ durationSec: 1200 }])])], 'corrida');
    const c = ex.modality.cardio!;
    expect(c).toMatchObject({ available: true, sessions: 5, sessionsWithDuration: 5, sessionsWithDistance: 4, totalDistanceM: 23_000 });
    expect(c.averagePaceSecPerKm).toBeCloseTo((1800 * 4) / 23, 6);
    // Uma métrica só por tendência: a que tem mais sessões (aqui, duração); com empate, distância.
    expect(ex.trend.metric).toBe('duracao');
    expect(summary(sessions, 'corrida').trend.metric).toBe('distancia');
    expect(ex.volume).toBe(0);
    expect(ex.records.maxLoad).toBeNull();
    expect(Object.fromEntries(exerciseAnalyses(ex).map((a) => [a.kind, a.available]))).toMatchObject({ cardio: true, duracao: false, carga: false });
  });

  it('cardio só com duração: ritmo indisponível e tendência de duração', () => {
    const only = [0, 1, 2, 3].map((i) => w(`d${i}`, i, [sx(RUN, [{ durationSec: 1500 + i * 60 }])]));
    const ex = summary(only, 'corrida');
    expect(ex.modality.cardio).toMatchObject({ averagePaceSecPerKm: null, totalDistanceM: null });
    expect(ex.trend.metric).toBe('duracao');
  });
});

describe('unilateral (compareSides)', () => {
  it('compara direito e esquerdo sem duplicar séries; séries sem lado ficam à parte', () => {
    const s = [w('u1', 0, [sx(LUNGE, [{ side: 'direito', weight: 20, reps: 10 }, { side: 'esquerdo', weight: 20, reps: 8 }, { weight: 20, reps: 9 }])])];
    const ex = summary(s, 'afundo');
    const sides = ex.modality.sides!;
    expect(sides.available).toBe(true);
    expect([sides.direito.sets, sides.esquerdo.sets, sides.desconhecido.sets]).toEqual([1, 1, 1]);
    expect(sides.differences!.reps).toEqual({ diff: 2, pct: 20 });
    expect(ex.sets).toBe(3);
    // Carga externa unilateral mantém 1RM canônico e volume (cada série uma vez).
    expect(ex.e1rmMethod).toBe(E1RM_METHOD_ID);
    expect(ex.periodBest.bestE1rm!.value).toBeCloseTo(canonicalE1rmKg(20, 10)!, 6);
    expect(ex.volume).toBe(20 * 27);
  });

  it('só um lado registrado: sem comparação', () => {
    const ex = summary([w('u2', 0, [sx(LUNGE, [{ side: 'direito', weight: 20, reps: 10 }])])], 'afundo');
    expect(ex.modality.sides).toMatchObject({ available: false, reason: 'um_lado_so' });
  });
});

describe('peso corporal (bodyweightMetrics)', () => {
  it('assistência e carga adicional ficam separadas; sem volume em kg nem 1RM', () => {
    const s = [
      w('b1', 0, [sx(PULLUP, [{ assistanceKg: 30, reps: 8 }, { assistanceKg: 20, reps: 6 }]), sx(DIP, [{ weight: 10, reps: 8 }, { weight: null, reps: 12 }])]),
    ];
    const pull = summary(s, 'barra');
    expect(pull.modality.bodyweight).toMatchObject({ bestAssisted: { assistanceKg: 20, reps: 6 }, bestRepsBodyOnly: null, volumeKg: null });
    // Repetições assistidas não entram como "repetições só com o corpo".
    expect(pull.periodBest.maxUnloadedReps).toBeNull();
    expect(pull.classification.load).toBe('corporal_assistida');
    const dip = summary(s, 'paralelas');
    expect(dip.modality.bodyweight).toMatchObject({ bestAddedLoad: { load: 10, reps: 8 }, bestRepsBodyOnly: 12 });
    expect(Object.fromEntries(exerciseAnalyses(dip).map((a) => [a.kind, a.available]))).toMatchObject({ carga: false, carga_adicional: true });
  });

  it('carga adicional + assistência na mesma série é incompatível e fica fora', () => {
    const ex = summary([w('b2', 0, [sx(PULLUP, [{ assistanceKg: 20, weight: 5, reps: 6 }])])], 'barra');
    expect(ex.modality.bodyweight!.bySetKind.incompativel).toBe(1);
    expect(ex.modality.bodyweight!.sets).toBe(0);
  });
});

describe('classificação e tendências', () => {
  it('a classificação explícita mais recente vale; o histórico antigo do mesmo exercício não é reinterpretado', () => {
    const old = { ...sx(PLANK, [{ reps: 40 }]) };
    for (const k of ['modality', 'loadMode', 'targetDurationSec'] as const) delete old[k];
    const s = [w('o1', 0, [old]), w('o2', 1, [sx(PLANK, [{ durationSec: 40 }])])];
    const a = createTrainingAnalytics(s);
    const h = a.history('prancha')!;
    expect(h.classification.source).toBe('explicito');
    expect(h.points.map((p) => [p.reps, p.bestDurationSec])).toEqual([
      [40, null],
      [0, 40],
    ]);
    // A tendência do exercício por tempo usa só duração: as 40 repetições antigas não viram 40 segundos.
    const ex = a.report('all', today).exercises[0];
    expect(ex.modality.timed!.sets).toBe(1);
  });

  it('normalização ignora valores fora do vocabulário (sem inventar lado ou modalidade)', () => {
    const x = sx(LUNGE, [{ side: 'meio' as never, weight: 10, reps: 5 }]);
    x.modality = 'yoga' as never;
    const { sessions } = normalizeSessions([w('n1', 0, [x])]);
    const ex = sessions[0].exercises[0];
    expect(ex.explicit).toEqual({ laterality: 'unilateral' });
    expect(ex.sets[0]).toEqual({ reps: 5, load: 10 });
  });
});
