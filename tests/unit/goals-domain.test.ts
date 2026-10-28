// Domínio das metas (IronTrack 2.0 F01/P12): validação, unidades, datas, identidade dos exercícios, motor de
// progresso por tipo, estados e conquistas. Dados fictícios (goalFixtures.ts).
import { describe, expect, it } from 'vitest';
import { canonicalE1rmKg, legacyChartE1rm } from '@/modules/analytics';
import { DISTANCE_UNITS, LATERALITIES, LOAD_MODES, MODALITIES } from '@/modules/training';
import {
  GOAL_PERIOD_BY_TYPE,
  GOAL_TYPES,
  GOAL_UNIT_BY_TYPE,
  GoalRuleError,
  applyGoalAction,
  computeGoalProgress,
  deriveAchievements,
  editGoal,
  evaluateGoals,
  exerciseGoalBlocker,
  goalExerciseAvailability,
  goalExerciseKeys,
  goalExerciseMatch,
  goalExerciseOptions,
  goalFieldErrors,
  goalIssues,
  goalsOverview,
  historyReference,
  newGoal,
  optionsForGoalType,
  relatedGoalsForExercise,
  type GoalType,
  type TrainingGoal,
} from '@/modules/goals';
import type { GoalExerciseModality, GoalLoadMode, GoalLaterality, GoalDistanceUnit } from '@/modules/goals';
import { OTHER_PROFILE, ex, fields, goal, goalRoutine, otherRoutine, refOf, ses, set, supino } from './goalFixtures';

const today = '2026-03-20'; // sexta-feira

describe('modelo e validação', () => {
  it('os vocabulários de modalidade das metas são os mesmos do treinamento', () => {
    const m: readonly GoalExerciseModality[] = MODALITIES;
    const l: readonly GoalLoadMode[] = LOAD_MODES;
    const lat: readonly GoalLaterality[] = LATERALITIES;
    const d: readonly GoalDistanceUnit[] = DISTANCE_UNITS;
    expect([m, l, lat, d].map((x) => x.length)).toEqual([4, 4, 2, 3]);
  });

  it('cada tipo tem unidade e período fixos e explícitos', () => {
    expect(GOAL_TYPES).toHaveLength(7);
    expect(GOAL_UNIT_BY_TYPE).toEqual({ weekly_frequency: 'sessoes_semana', session_count: 'sessoes', max_load: 'kg', reps: 'reps', duration: 's', distance: 'm', e1rm: 'kg' });
    expect(GOAL_PERIOD_BY_TYPE.weekly_frequency).toBe('semanal');
    expect(GOAL_PERIOD_BY_TYPE.session_count).toBe('janela');
    for (const t of ['max_load', 'reps', 'duration', 'distance', 'e1rm'] as GoalType[]) expect(GOAL_PERIOD_BY_TYPE[t]).toBe('recorde');
    const g = goal({ type: 'max_load', exercise: refOf(['sup-A']), targetValue: 80 });
    expect(g).toMatchObject({ unit: 'kg', period: 'recorde', status: 'active', revision: 1, pauses: [] });
    expect(goalIssues(g)).toEqual([]);
  });

  it('valores precisam ser finitos, positivos e na precisão do tipo', () => {
    const err = (over: Parameters<typeof fields>[0]) => goalFieldErrors(fields(over)).targetValue;
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) expect(err({ targetValue: v })).toBeTruthy();
    expect(err({ targetValue: 3.5 })).toMatch(/inteiro/);
    expect(err({ targetValue: 15 })).toMatch(/máximo/);
    expect(err({ type: 'max_load', exercise: refOf(['sup-A']), targetValue: 82.5 })).toBeUndefined();
    expect(err({ type: 'max_load', exercise: refOf(['sup-A']), targetValue: 1001 })).toMatch(/1000 kg/);
    expect(err({ type: 'duration', exercise: refOf(['pr']), targetValue: 90.5 })).toMatch(/inteiro/);
    expect(err({ type: 'distance', exercise: refOf(['cor']), targetValue: 5000.5 })).toBeUndefined();
  });

  it('datas válidas: dia inexistente, prazo antes do início e prazo em meta de janela são recusados', () => {
    expect(goalFieldErrors(fields({ startDate: '2026-02-30' })).startDate).toBeTruthy();
    expect(goalFieldErrors(fields({ startDate: '20/03/2026' })).startDate).toBeTruthy();
    expect(goalFieldErrors(fields({ targetDate: '2026-03-01' })).targetDate).toMatch(/anterior/);
    expect(goalFieldErrors(fields({ targetDate: '2026-04-31' })).targetDate).toBeTruthy();
    expect(goalFieldErrors(fields({ type: 'session_count', targetValue: 12, params: { windowDays: 30 }, targetDate: '2026-04-01' })).targetDate).toBeTruthy();
    expect(goalFieldErrors(fields({ type: 'session_count', targetValue: 12, params: {} })).windowDays).toBeTruthy();
    expect(goalFieldErrors(fields({ type: 'session_count', targetValue: 12, params: { windowDays: 400 } })).windowDays).toMatch(/366/);
  });

  it('metas de exercício exigem exercício identificável; frequência e sessões não aceitam exercício', () => {
    expect(goalFieldErrors(fields({ type: 'max_load', targetValue: 80 })).exercise).toMatch(/Escolha/);
    expect(goalFieldErrors(fields({ type: 'max_load', targetValue: 80, exercise: refOf([]) })).exercise).toMatch(/identificador estável/);
    expect(goalFieldErrors(fields({ type: 'max_load', targetValue: 80, exercise: refOf(['sup-A', 'sup-A']) })).exercise).toMatch(/repetido/);
    expect(goalFieldErrors(fields({ exercise: refOf(['sup-A']) })).exercise).toMatch(/não usa exercício/);
  });

  it('não mistura modalidades: cada tipo só aceita exercícios que registram aquela medida', () => {
    const b = (t: GoalType, id: string) => exerciseGoalBlocker(t, refOf([id]));
    expect(b('max_load', 'sup-A')).toBeNull();
    expect(b('max_load', 'pr')).toMatch(/tempo/);
    expect(b('max_load', 'flex')).toMatch(/carga externa/);
    expect(b('max_load', 'bar')).toBeNull(); // carga adicional
    expect(exerciseGoalBlocker('max_load', refOf(['bar'], { loadMode: 'assistida' }))).toMatch(/assistência/);
    expect(b('e1rm', 'sup-A')).toBeNull();
    expect(b('e1rm', 'bar')).toMatch(/1RM/);
    expect(b('e1rm', 'leg')).toBeNull(); // sem modalidade = musculação
    expect(b('reps', 'cor')).toMatch(/repetições/);
    expect(b('reps', 'flex')).toBeNull();
    expect(b('duration', 'pr')).toBeNull();
    expect(b('duration', 'cor')).toBeNull();
    expect(b('duration', 'sup-A')).toMatch(/tempo ou de cardio/);
    expect(b('distance', 'cor')).toBeNull();
    expect(b('distance', 'pr')).toMatch(/cardio/);
  });

  it('parâmetros só onde se aplicam: lado só em unilaterais, carga mínima só em repetições', () => {
    expect(goalFieldErrors(fields({ type: 'reps', targetValue: 12, exercise: refOf(['sup-A']), params: { side: 'direito' } })).side).toMatch(/unilaterais/);
    expect(goalFieldErrors(fields({ type: 'reps', targetValue: 12, exercise: refOf(['rem']), params: { side: 'direito' } }))).toEqual({});
    expect(goalFieldErrors(fields({ type: 'max_load', targetValue: 40, exercise: refOf(['sup-A']), params: { minLoadKg: 20 } })).params).toMatch(/minLoadKg/);
    expect(goalFieldErrors(fields({ type: 'reps', targetValue: 12, exercise: refOf(['sup-A']), params: { minLoadKg: -1 } })).minLoadKg).toBeTruthy();
    expect(goalFieldErrors(fields({ type: 'duration', targetValue: 60, exercise: refOf(['pr']), params: { side: 'direito' } })).params).toBeTruthy();
  });

  it('registro completo: estado, pausas, unidade incoerente e versão são conferidos', () => {
    const g = goal();
    expect(goalIssues({ ...g, unit: 'kg' }).map((i) => i.field)).toContain('unit');
    expect(goalIssues({ ...g, status: 'paused' }).map((i) => i.field)).toContain('pauses');
    expect(goalIssues({ ...g, pauses: [{ from: '2026-03-05', to: null }] }).map((i) => i.field)).toContain('pauses');
    expect(goalIssues({ ...g, revision: 0 }).map((i) => i.field)).toContain('revision');
    expect(goalIssues({ ...g, id: '' }).map((i) => i.field)).toContain('id');
    expect(goalIssues(null)).toHaveLength(1);
    expect(() => newGoal('x', fields({ targetValue: Number.NaN }), 1)).toThrow(GoalRuleError);
  });
});

describe('estados e edição', () => {
  it('pausar, retomar, arquivar e restaurar; repetir uma ação não muda nada', () => {
    const g = goal();
    const p = applyGoalAction(g, 'pause', '2026-03-10', 2);
    expect(p).toMatchObject({ changed: true, goal: { status: 'paused', revision: 2, pauses: [{ from: '2026-03-10', to: null }] } });
    expect(applyGoalAction(p.goal, 'pause', '2026-03-11', 3).changed).toBe(false);
    const r = applyGoalAction(p.goal, 'resume', '2026-03-12', 3).goal;
    expect(r).toMatchObject({ status: 'active', pauses: [{ from: '2026-03-10', to: '2026-03-12' }] });
    const a = applyGoalAction(applyGoalAction(r, 'pause', '2026-03-13', 4).goal, 'archive', '2026-03-14', 5).goal;
    expect(a).toMatchObject({ status: 'archived', pauses: [{ to: '2026-03-12' }, { from: '2026-03-13', to: '2026-03-14' }] });
    expect(goalIssues(a)).toEqual([]);
    expect(applyGoalAction(a, 'archive', '2026-03-15', 6).changed).toBe(false);
    expect(() => applyGoalAction(a, 'pause', '2026-03-15', 6)).toThrow(/arquivada/);
    expect(applyGoalAction(a, 'unarchive', '2026-03-15', 6).goal.status).toBe('active');
  });

  it('editar preserva tipo, exercício e ID, avança a versão e mantém a linha do tempo coerente', () => {
    const g = goal({ type: 'max_load', exercise: refOf(['sup-A']), targetValue: 80 });
    const e = editGoal(g, { title: 'Supino 85', targetValue: 85, params: {}, startDate: g.startDate, targetDate: '2026-06-30' }, 5);
    expect(e).toMatchObject({ id: g.id, type: 'max_load', exercise: g.exercise, targetValue: 85, revision: 2, updatedAt: 5 });
    const paused = applyGoalAction(g, 'pause', '2026-03-05', 2).goal;
    expect(() => editGoal(paused, { title: 'x', targetValue: 80, params: {}, startDate: '2026-03-10', targetDate: null }, 3)).toThrow(/pausa/);
    expect(() => editGoal(g, { title: '', targetValue: 80, params: {}, startDate: g.startDate, targetDate: null }, 3)).toThrow(GoalRuleError);
  });
});

describe('identidade dos exercícios', () => {
  it('opções: o mesmo exercício em vários treinos da rotina vira uma opção; rotinas diferentes nunca se juntam', () => {
    const opts = goalExerciseOptions([goalRoutine(), otherRoutine()]);
    const supinos = opts.filter((o) => o.ref.name === 'Supino reto');
    expect(supinos.map((o) => o.ref.templateIds)).toEqual([['sup-A', 'sup-B'], ['sup-X']]);
    expect(supinos[0].workoutLabels).toEqual(['A', 'B']);
    expect(optionsForGoalType(opts, 'distance').map((o) => o.ref.name)).toEqual(['Corrida']);
    expect(optionsForGoalType(opts, 'duration').map((o) => o.ref.name).sort()).toEqual(['Corrida', 'Prancha']);
  });

  it('associação pelo ID da ficha: mesmo nome com outro ID, exercício substituído e sessão sem ID não contam', () => {
    const ref = refOf(['sup-A', 'sup-B']);
    expect(goalExerciseMatch(ref, supino('sup-A', []))).toBe('match');
    expect(goalExerciseMatch(ref, supino('sup-X', []))).toBeNull(); // mesmo nome, outro exercício
    expect(goalExerciseMatch(ref, ex(undefined, 'Supino reto', []))).toBeNull(); // histórico sem identificador
    expect(goalExerciseMatch(ref, supino('sup-A', [], { substitutedFrom: 'Supino reto', name: 'Crucifixo' }))).toBe('substituted');
    expect(goalExerciseMatch(ref, supino('sup-A', [], { modality: 'timed' }))).toBe('incompatible');
    // Renomeado na ficha: o ID continua o mesmo, então continua contando.
    expect(goalExerciseMatch(ref, supino('sup-A', [], { name: 'Supino com barra', exerciseKey: 'supino-com-barra' }))).toBe('match');
  });

  it('situação nas fichas: disponível, renomeado, parcial, modalidade alterada e removido', () => {
    const r = goalRoutine();
    const ref = refOf(['sup-A', 'sup-B']);
    expect(goalExerciseAvailability(ref, [r]).state).toBe('disponivel');
    const renamed = structuredClone(r);
    renamed.workouts[0].exercises[0].name = 'Supino com barra';
    renamed.workouts[1].exercises[0].name = 'Supino com barra';
    expect(goalExerciseAvailability(ref, [renamed])).toMatchObject({ state: 'renomeado', currentName: 'Supino com barra' });
    const partial = structuredClone(r);
    partial.workouts[1].exercises.shift();
    expect(goalExerciseAvailability(ref, [partial])).toMatchObject({ state: 'parcial', missing: 1 });
    const changed = structuredClone(r);
    changed.workouts[0].exercises[0].modality = 'timed';
    expect(goalExerciseAvailability(ref, [changed]).state).toBe('modalidade_alterada');
    expect(goalExerciseAvailability(ref, [otherRoutine()])).toMatchObject({ state: 'removido', currentName: null });
  });
});

describe('frequência semanal', () => {
  const g = goal({ type: 'weekly_frequency', targetValue: 3, startDate: '2026-03-04' }); // quarta
  const week1 = ['2026-03-04', '2026-03-05', '2026-03-07'];
  const week2 = ['2026-03-09', '2026-03-12'];
  const week3 = ['2026-03-16', '2026-03-17'];

  it('conta sessões concluídas por semana local (segunda a domingo), separa semana atual, anteriores e vigência', () => {
    const sessions = [...week1, ...week2, ...week3].map((d, i) => ses(`s${i}`, d));
    sessions.push(ses('antes', '2026-03-02')); // antes do início
    const p = computeGoalProgress(g, sessions, today);
    expect(p.weekly!.weeks.map((w) => [w.week, w.count, w.met, w.partial, w.current])).toEqual([
      ['2026-03-02', 3, true, true, false],
      ['2026-03-09', 2, false, false, false],
      ['2026-03-16', 2, false, true, true],
    ]);
    expect(p.current).toBe(2);
    expect(p.fraction).toBeCloseTo(2 / 3);
    expect(p.achieved).toBe(false);
    expect(p.displayState).toBe('ativa');
    expect(p.weekly!.weeksEvaluated).toBe(1);
    expect(p.weekly!.firstMet?.metOn).toBe('2026-03-07');
  });

  it('não conta treino em andamento, descartado, repetido (mesmo ID ou mesmo início e treino) nem de outro perfil', () => {
    const base = ses('a', '2026-03-16');
    const sessions = [
      base,
      { ...base }, // mesmo ID duas vezes
      ses('b', '2026-03-16', [], { startedAt: base.startedAt }), // mesmo início e mesmo treino
      ses('c', '2026-03-17', [], { status: 'active' }),
      ses('d', '2026-03-18', [], { status: 'discarded' }),
      ses('e', '2026-03-18', [], { profileId: OTHER_PROFILE }),
      ses('f', '2026-03-19'),
    ];
    const p = computeGoalProgress(g, sessions, today);
    expect(p.current).toBe(2);
    expect(p.quality.duplicateSessions).toBe(2);
  });

  it('semana sem treino aparece como zero, sem diagnóstico; pausa marca a semana; atingir na semana atual', () => {
    const paused = { ...g, pauses: [{ from: '2026-03-10', to: '2026-03-11' }] };
    const sessions = ['2026-03-16', '2026-03-17', '2026-03-19'].map((d, i) => ses(`x${i}`, d));
    const p = computeGoalProgress(paused, sessions, today);
    const w2 = p.weekly!.weeks[1];
    expect(w2).toMatchObject({ count: 0, met: false, paused: true });
    expect(p.weekly!.weeksEvaluated).toBe(0); // a única semana completa teve pausa
    expect(p.achieved).toBe(true);
    expect(p.achievedAt).toBe('2026-03-19');
    expect(p.displayState).toBe('ativa'); // recorrente: segue ativa, com "cumprida nesta semana"
  });

  it('prazo encerra a avaliação e não vira fracasso; meta futura ainda não começou', () => {
    const ended = { ...g, targetDate: '2026-03-10' };
    const p = computeGoalProgress(ended, [ses('a', '2026-03-16')], today);
    expect(p.weekly!.weeks.map((w) => w.week)).toEqual(['2026-03-02', '2026-03-09']);
    expect(p.displayState).toBe('prazo_encerrado');
    expect(p.achieved).toBe(false);
    const future = computeGoalProgress({ ...g, startDate: '2026-04-01' }, [ses('a', '2026-03-16')], today);
    expect(future).toMatchObject({ notStarted: true, displayState: 'nao_iniciada', current: null, fraction: 0 });
  });
});

describe('quantidade de sessões', () => {
  const g = goal({ type: 'session_count', targetValue: 3, params: { windowDays: 10 }, startDate: '2026-03-01' });

  it('conta só a janela e registra a data da sessão que completou a meta', () => {
    const sessions = ['2026-02-28', '2026-03-01', '2026-03-04', '2026-03-08', '2026-03-12'].map((d, i) => ses(`s${i}`, d));
    const p = computeGoalProgress(g, sessions, today);
    expect(p.window).toEqual({ from: '2026-03-01', to: '2026-03-10', count: 3 });
    expect(p).toMatchObject({ achieved: true, achievedAt: '2026-03-08', displayState: 'atingida', fraction: 1 });
  });

  it('janela encerrada sem atingir: "prazo encerrado", nunca "fracassada"', () => {
    const p = computeGoalProgress(g, [ses('a', '2026-03-02')], today);
    expect(p).toMatchObject({ achieved: false, deadlinePassed: true, displayState: 'prazo_encerrado', current: 1 });
  });
});

describe('metas por exercício', () => {
  const load = goal({ type: 'max_load', targetValue: 80, exercise: refOf(['sup-A', 'sup-B']), startDate: '2026-03-02' });

  it('carga: maior carga válida desde o início; antes do início é só referência; evidência na primeira sessão que atinge', () => {
    const sessions = [
      ses('old', '2026-02-20', [supino('sup-A', [set(85, 3)])]),
      ses('a', '2026-03-03', [supino('sup-A', [set(75, 5), set(77.5, 3)])]),
      ses('b', '2026-03-10', [supino('sup-B', [set(80, 2)])]),
      ses('c', '2026-03-17', [supino('sup-A', [set(82.5, 1)])]),
    ];
    const p = computeGoalProgress(load, sessions, today);
    expect(p.baseline).toMatchObject({ value: 85, date: '2026-02-20' });
    expect(p.current).toBe(82.5);
    expect(p.evidence).toMatchObject({ sessionId: 'b', value: 80, reps: 2, date: '2026-03-10' });
    expect(p.displayState).toBe('atingida');
    expect(p.personalRecord).toBe(false); // 80 não supera os 85 de antes
  });

  it('não inventa conquista anterior ao início: marca atingida antes do início não conta', () => {
    const p = computeGoalProgress(load, [ses('old', '2026-02-20', [supino('sup-A', [set(90, 3)])])], today);
    expect(p).toMatchObject({ achieved: false, hasData: false, current: null, fraction: 0, displayState: 'ativa' });
    expect(p.baseline?.value).toBe(90);
  });

  it('ignora aquecimento, séries pendentes ou puladas, assistência, outro exercício com o mesmo nome e substituições', () => {
    const sessions = [
      ses('a', '2026-03-03', [
        supino('sup-A', [set(100, 5, { type: 'warmup' }), set(95, 5, { status: 'pending' }), set(90, 5, { status: 'skipped' }), set(70, 8)]),
        supino('sup-X', [set(120, 5)]),
        supino('sup-B', [set(110, 5)], { substitutedFrom: 'Supino reto', name: 'Crucifixo' }),
      ]),
    ];
    const p = computeGoalProgress(load, sessions, today);
    expect(p.current).toBe(70);
    expect(p.quality).toMatchObject({ matchedSessions: 1, substitutedSessions: 1 });
  });

  it('carga em lb convertida para kg atinge a meta com tolerância de arredondamento', () => {
    const lbToKg = Math.round(176.37 * 0.45359237 * 1000) / 1000; // 80,000 kg digitados como 176,37 lb
    const p = computeGoalProgress(load, [ses('a', '2026-03-05', [supino('sup-A', [set(lbToKg, 1)])])], today);
    expect(p.achieved).toBe(true);
  });

  it('repetições: melhor série comparável, com carga mínima opcional; assistência não se compara', () => {
    const reps = goal({ type: 'reps', targetValue: 12, exercise: refOf(['sup-A']), params: { minLoadKg: 60 }, startDate: '2026-03-02' });
    const sessions = [ses('a', '2026-03-03', [supino('sup-A', [set(40, 15), set(60, 10), set(62.5, 12)])])];
    const p = computeGoalProgress(reps, sessions, today);
    expect(p.evidence).toMatchObject({ value: 12, load: 62.5 });
    const free = computeGoalProgress({ ...reps, params: {} }, sessions, today);
    expect(free.current).toBe(15);
    const bw = goal({ type: 'reps', targetValue: 20, exercise: refOf(['flex']), startDate: '2026-03-02' });
    const flex = (sets: ReturnType<typeof set>[]) => ex('flex', 'Flexão', sets, { modality: 'bodyweight', loadMode: 'corporal', equipment: 'bodyweight' });
    const pb = computeGoalProgress(bw, [ses('b', '2026-03-04', [flex([set(null, 18), set(null, 25, { assistanceKg: 20 })])])], today);
    expect(pb.current).toBe(18);
  });

  it('unilateral: lado explícito ou qualquer lado, com o lado na evidência', () => {
    const rem = (sets: ReturnType<typeof set>[]) => ex('rem', 'Remada unilateral', sets, { modality: 'resistance', laterality: 'unilateral', equipment: 'dumbbell' });
    const sessions = [ses('a', '2026-03-03', [rem([set(30, 10, { side: 'direito' }), set(26, 10, { side: 'esquerdo' })])])];
    const any = goal({ type: 'max_load', targetValue: 30, exercise: refOf(['rem']), startDate: '2026-03-02' });
    expect(computeGoalProgress(any, sessions, today).evidence).toMatchObject({ value: 30, side: 'direito' });
    const left = goal({ type: 'max_load', targetValue: 30, exercise: refOf(['rem']), params: { side: 'esquerdo' }, startDate: '2026-03-02' });
    expect(computeGoalProgress(left, sessions, today)).toMatchObject({ current: 26, achieved: false });
  });

  it('duração: maior série do exercício por tempo; cardio soma a sessão; repetições nunca viram segundos', () => {
    const plank = goal({ type: 'duration', targetValue: 90, exercise: refOf(['pr']), startDate: '2026-03-02' });
    const pr = (sets: ReturnType<typeof set>[], over = {}) => ex('pr', 'Prancha', sets, { modality: 'timed', loadMode: 'corporal', equipment: 'bodyweight', ...over });
    const sessions = [
      ses('a', '2026-03-03', [pr([set(null, null, { durationSec: 60 }), set(null, null, { durationSec: 75 }), set(null, null, { durationSec: 0 })])]),
      ses('b', '2026-03-05', [pr([set(null, 120)], { modality: undefined })]), // registro sem modalidade: 120 reps não são 120 s
    ];
    const p = computeGoalProgress(plank, sessions, today);
    expect(p.current).toBe(75);
    expect(p.quality.incompatibleSessions).toBe(1);
    const run = goal({ type: 'duration', targetValue: 1800, exercise: refOf(['cor']), startDate: '2026-03-02' });
    const cor = ex('cor', 'Corrida', [set(null, null, { durationSec: 1000, distance: 2500 }), set(null, null, { durationSec: 900, distance: 2600 })], { modality: 'cardio', distanceUnit: 'km', equipment: 'other' });
    expect(computeGoalProgress(run, [ses('c', '2026-03-06', [cor])], today)).toMatchObject({ current: 1900, achieved: true });
  });

  it('distância: maior distância numa sessão, em metros, só em cardio', () => {
    const dist = goal({ type: 'distance', targetValue: 5000, exercise: refOf(['cor']), startDate: '2026-03-02' });
    const cor = (m: number[]) => ex('cor', 'Corrida', m.map((x) => set(null, null, { distance: x })), { modality: 'cardio', distanceUnit: 'km', equipment: 'other' });
    const p = computeGoalProgress(dist, [ses('a', '2026-03-03', [cor([3000])]), ses('b', '2026-03-10', [cor([2500, 2500])])], today);
    expect(p).toMatchObject({ current: 5000, achieved: true, achievedAt: '2026-03-10' });
  });

  it('1RM: método canônico (1 a 12 repetições, 1 repetição = carga); séries longas não entram; fórmula antiga não é usada', () => {
    const rm = goal({ type: 'e1rm', targetValue: 100, exercise: refOf(['sup-A']), startDate: '2026-03-02' });
    const sessions = [ses('a', '2026-03-03', [supino('sup-A', [set(80, 8), set(60, 20), set(95, 1)])])];
    const p = computeGoalProgress(rm, sessions, today);
    expect(p.current).toBeCloseTo(canonicalE1rmKg(80, 8)!);
    expect(p.current).toBeCloseTo(80 * (1 + 8 / 30));
    const single = computeGoalProgress(rm, [ses('b', '2026-03-03', [supino('sup-A', [set(95, 1)])])], today);
    expect(single.current).toBe(95);
    expect(single.current).not.toBeCloseTo(legacyChartE1rm(95, 1));
  });

  it('dados insuficientes não são fracasso: sem registros, progresso zero e nenhum NaN/Infinity', () => {
    const goals: TrainingGoal[] = [
      load,
      goal({ type: 'e1rm', targetValue: 100, exercise: refOf(['sup-A']) }),
      goal({ type: 'duration', targetValue: 90, exercise: refOf(['pr']) }),
      goal({ type: 'distance', targetValue: 5000, exercise: refOf(['cor']) }),
      goal({ type: 'reps', targetValue: 12, exercise: refOf(['flex']) }),
      goal({ type: 'weekly_frequency', targetValue: 4 }),
      goal({ type: 'session_count', targetValue: 12, params: { windowDays: 30 } }),
    ];
    for (const g of goals) {
      const p = computeGoalProgress(g, [], today);
      expect(Number.isFinite(p.fraction), g.type).toBe(true);
      expect(p.fraction).toBe(0);
      expect(p.achieved).toBe(false);
      expect(JSON.stringify(p)).not.toMatch(/NaN|Infinity/);
      expect(['ativa', 'prazo_encerrado']).toContain(p.displayState);
    }
  });

  it('exercício excluído das fichas: a meta continua calculada pelos treinos registrados', () => {
    const p = computeGoalProgress(load, [ses('a', '2026-03-03', [supino('sup-A', [set(81, 3)])])], today);
    expect(goalExerciseAvailability(load.exercise!, [otherRoutine()]).state).toBe('removido');
    expect(p.achieved).toBe(true);
  });

  it('estados exibidos: pausada e arquivada prevalecem; atingida tem evidência; prazo vencido; atingida depois do prazo', () => {
    const sessions = [ses('a', '2026-03-12', [supino('sup-A', [set(80, 1)])])];
    const paused = applyGoalAction(load, 'pause', '2026-03-15', 2).goal;
    expect(computeGoalProgress(paused, sessions, today).displayState).toBe('pausada');
    const archived = applyGoalAction(load, 'archive', '2026-03-15', 2).goal;
    expect(computeGoalProgress(archived, sessions, today).displayState).toBe('arquivada');
    const late = computeGoalProgress({ ...load, targetDate: '2026-03-10' }, sessions, today);
    expect(late).toMatchObject({ achieved: true, achievedAfterDeadline: true, displayState: 'atingida' });
    const expired = computeGoalProgress({ ...load, targetDate: '2026-03-10' }, [], today);
    expect(expired.displayState).toBe('prazo_encerrado');
  });

  it('o cálculo não altera as sessões recebidas e é reproduzível', () => {
    const sessions = [ses('a', '2026-03-03', [supino('sup-A', [set(80, 3)])])];
    const frozen = structuredClone(sessions);
    Object.freeze(sessions);
    const a = computeGoalProgress(load, sessions, today);
    const b = computeGoalProgress(load, sessions, today);
    expect(a).toEqual(b);
    expect(sessions).toEqual(frozen);
  });
});

describe('conquistas e visão geral', () => {
  const s = [
    ses('w1', '2026-03-02', [supino('sup-A', [set(70, 5)])]),
    ses('w2', '2026-03-03', [supino('sup-A', [set(80, 3)])]),
    ses('w3', '2026-03-05', [supino('sup-B', [set(85, 2)])]),
  ];

  it('derivadas de evidências reais, em ordem, sem pontuação; nada antes do início', () => {
    const goals = [
      goal({ type: 'max_load', title: 'Supino 80', targetValue: 80, exercise: refOf(['sup-A', 'sup-B']), startDate: '2026-03-02' }),
      goal({ type: 'weekly_frequency', title: '3 por semana', targetValue: 3, startDate: '2026-03-02' }),
      goal({ type: 'session_count', title: '2 em 7 dias', targetValue: 2, params: { windowDays: 7 }, startDate: '2026-03-02' }),
      goal({ type: 'max_load', title: 'Supino 100', targetValue: 100, exercise: refOf(['sup-A', 'sup-B']), startDate: '2026-03-02' }),
      goal({ type: 'max_load', title: 'Futura', targetValue: 50, exercise: refOf(['sup-A']), startDate: '2026-03-10' }),
    ];
    const a = deriveAchievements(evaluateGoals(goals, s, today));
    const byKind = Object.fromEntries(a.map((x) => [x.id, x]));
    expect(byKind.primeira_meta.date).toBe('2026-03-03');
    expect(['2 em 7 dias', 'Supino 80']).toContain(byKind.primeira_meta.goalTitle);
    expect(byKind.tres_metas).toMatchObject({ date: '2026-03-05', goalTitle: '3 por semana' });
    expect(byKind.frequencia_semanal.date).toBe('2026-03-05');
    expect(byKind[`recorde_meta:${goals[0].id}`]).toMatchObject({ date: '2026-03-03', goalTitle: 'Supino 80' });
    expect(a.some((x) => x.goalTitle === 'Futura' || x.goalTitle === 'Supino 100')).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/pontos|ranking|score/i);
  });

  it('visão geral separa em andamento, atingidas, arquivadas e próximos prazos', () => {
    const g1 = goal({ type: 'max_load', title: 'A', targetValue: 80, exercise: refOf(['sup-A']), startDate: '2026-03-02' });
    const g2 = goal({ type: 'max_load', title: 'B', targetValue: 100, exercise: refOf(['sup-A']), startDate: '2026-03-02', targetDate: '2026-04-30' });
    const g3 = goal({ type: 'max_load', title: 'C', targetValue: 100, exercise: refOf(['sup-A']), startDate: '2026-03-02', targetDate: '2026-03-25' });
    const g4 = applyGoalAction(goal({ type: 'weekly_frequency', title: 'D', targetValue: 2 }), 'archive', today, 9).goal;
    const o = goalsOverview([g1, g2, g3, g4], s, today);
    expect(o.achieved.map((e) => e.goal.title)).toEqual(['A']);
    expect(o.inProgress.map((e) => e.goal.title).sort()).toEqual(['B', 'C']);
    expect(o.archived.map((e) => e.goal.title)).toEqual(['D']);
    expect(o.upcomingDeadlines.map((e) => e.goal.title)).toEqual(['C', 'B']);
    expect(o.counts).toEqual({ active: 3, paused: 0, achieved: 1, archived: 1 });
  });

  it('referência do histórico para o formulário: melhor marca real e semanas recentes (sem sugerir valores)', () => {
    const best = historyReference({ type: 'max_load', exercise: refOf(['sup-A', 'sup-B']), params: {} }, s, today).best;
    expect(best).toMatchObject({ value: 85, sessionId: 'w3' });
    expect(historyReference({ type: 'max_load', exercise: refOf(['pr']), params: {} }, s, today).best).toBeNull();
    const weeks = historyReference({ type: 'weekly_frequency', exercise: null, params: {} }, s, today).recentWeeks;
    expect(weeks).toEqual([
      { week: '2026-02-16', count: 0 },
      { week: '2026-02-23', count: 0 },
      { week: '2026-03-02', count: 3 },
      { week: '2026-03-09', count: 0 },
    ]);
  });

  it('integração com analytics: metas ligadas ao exercício pelo ID da ficha, nunca pelo nome', () => {
    const g = goal({ type: 'max_load', targetValue: 80, exercise: refOf(['sup-A']), startDate: '2026-03-02' });
    const sessions = [ses('a', '2026-03-03', [supino('sup-A', [set(70, 5)])]), ses('b', '2026-03-04', [supino('sup-X', [set(70, 5)], { exerciseKey: 'supino-halteres' })])];
    expect([...goalExerciseKeys(g, sessions)]).toEqual(['supino-reto']);
    const evals = evaluateGoals([g], sessions, today);
    expect(relatedGoalsForExercise(evals, sessions, 'supino-reto')).toHaveLength(1);
    expect(relatedGoalsForExercise(evals, sessions, 'supino-halteres')).toHaveLength(0);
    expect(goalExerciseKeys(goal({ type: 'max_load', targetValue: 80, exercise: refOf(['sup-B']) }), sessions).size).toBe(0);
  });
});
