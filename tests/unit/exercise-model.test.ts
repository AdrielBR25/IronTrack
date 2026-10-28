// Modelo de exercícios v3 (P10): campos opcionais, validação, regras da sessão e ficha JSON.
import { describe, expect, it } from 'vitest';
import {
  MODEL_LIMITS,
  addSet,
  buildSession,
  carryForwardWeight,
  completeSet,
  exerciseMeasures,
  exerciseModelIssues,
  finishSession,
  fmtDurationSec,
  isCompletedWorkSet,
  isValidWorkingSet,
  parseFicha,
  routineToFicha,
  sessionVolume,
  setCompletionErrors,
  setModelIssues,
  shouldAdvance,
  substituteExercise,
  updateSet,
  validSetCount,
  computeRecords,
  exerciseSeries,
} from '@/modules/training';
import { checkIntegrity } from '@/lib/integrity';
import type { SessionSet } from '@/lib/types';
import { routine, session, snapshot } from './fixtures';
import { DIP, LUNGE, PLANK, PULLUP, RUN, modelRoutine, modelSession, modelSnapshot, sx, tpl } from './modelFixtures';

const set = (p: Partial<SessionSet>): SessionSet => ({ id: 's', type: 'normal', status: 'pending', weight: null, reps: null, ...p });
const errorsOf = (i: ReturnType<typeof exerciseModelIssues>) => i.filter((x) => x.severity === 'error').map((x) => x.field);
const warningsOf = (i: ReturnType<typeof exerciseModelIssues>) => i.filter((x) => x.severity === 'warning').map((x) => x.field);

describe('modelo v3: campos opcionais e compatibilidade', () => {
  it('exercício antigo (sem metadados) continua válido e com o comportamento de antes', () => {
    const old = routine().workouts[0].exercises[0];
    expect(exerciseModelIssues(old)).toEqual([]);
    expect(exerciseMeasures(old)).toEqual({ reps: true, weight: 'externa', assistance: false, duration: false, distance: false, side: false, progression: true });
    // Ausente = não informado: nada vira zero nem é deduzido.
    expect(old).not.toHaveProperty('modality');
  });

  it('aceita todas as modalidades, lateralidades, tipos de carga e unidades válidos', () => {
    for (const modality of ['resistance', 'bodyweight', 'timed', 'cardio'] as const) expect(errorsOf(exerciseModelIssues({ modality }))).toEqual([]);
    for (const laterality of ['bilateral', 'unilateral'] as const) expect(exerciseModelIssues({ laterality })).toEqual([]);
    for (const loadMode of ['externa', 'corporal', 'adicional', 'assistida'] as const) expect(exerciseModelIssues({ loadMode })).toEqual([]);
    for (const distanceUnit of ['m', 'km', 'mi'] as const) expect(exerciseModelIssues({ distanceUnit })).toEqual([]);
    for (const t of [PLANK, RUN, LUNGE, PULLUP, DIP]) expect(exerciseModelIssues(t)).toEqual([]);
  });

  it('recusa valores fora do vocabulário, tipos errados e grupos secundários inválidos', () => {
    expect(errorsOf(exerciseModelIssues({ modality: 'yoga' as never }))).toEqual(['modality']);
    expect(errorsOf(exerciseModelIssues({ laterality: 'esquerdo' as never }))).toEqual(['laterality']);
    expect(errorsOf(exerciseModelIssues({ loadMode: 'elastico' as never }))).toEqual(['loadMode']);
    expect(errorsOf(exerciseModelIssues({ distanceUnit: 'jardas' as never }))).toEqual(['distanceUnit']);
    expect(errorsOf(exerciseModelIssues({ secondaryMuscles: 'Glúteos' as never }))).toEqual(['secondaryMuscles']);
    expect(errorsOf(exerciseModelIssues({ secondaryMuscles: ['a', 'b', 'c', 'd', 'e'] }))).toEqual(['secondaryMuscles']);
    expect(errorsOf(exerciseModelIssues({ secondaryMuscles: [' '] }))).toEqual(['secondaryMuscles']);
    expect(errorsOf(exerciseModelIssues({ targetDurationSec: 0 }))).toEqual(['targetDurationSec']);
    expect(errorsOf(exerciseModelIssues({ targetDistance: -1 }))).toEqual(['targetDistance']);
  });

  it('combinações contraditórias viram aviso explícito (o dado é preservado)', () => {
    expect(warningsOf(exerciseModelIssues({ modality: 'resistance', loadMode: 'assistida' }))).toEqual(['loadMode']);
    expect(warningsOf(exerciseModelIssues({ modality: 'cardio', loadMode: 'externa' }))).toEqual(['loadMode']);
    expect(warningsOf(exerciseModelIssues({ modality: 'cardio', laterality: 'unilateral' }))).toEqual(['laterality']);
    expect(warningsOf(exerciseModelIssues({ modality: 'bodyweight', loadMode: 'adicional' }))).toEqual([]);
  });
});

describe('modelo v3: validação das séries', () => {
  it('duração: inteiro positivo e finito, até o limite documentado', () => {
    for (const durationSec of [1, 45, MODEL_LIMITS.maxDurationSec]) expect(setModelIssues({ durationSec })).toEqual([]);
    for (const durationSec of [0, -5, 1.5, NaN, Infinity, MODEL_LIMITS.maxDurationSec + 1, '45' as never])
      expect(setModelIssues({ durationSec }).map((i) => i.field)).toEqual(['durationSec']);
  });

  it('distância: positiva e finita, até 1 000 km', () => {
    expect(setModelIssues({ distance: 0.5 })).toEqual([]);
    for (const distance of [0, -1, NaN, Infinity, MODEL_LIMITS.maxDistanceM + 1]) expect(setModelIssues({ distance }).map((i) => i.field)).toEqual(['distance']);
  });

  it('assistência: finita e não negativa (zero permitido), lado só nos valores permitidos', () => {
    expect(setModelIssues({ assistanceKg: 0 }, { loadMode: 'assistida' })).toEqual([]);
    expect(setModelIssues({ assistanceKg: 20 }, { loadMode: 'assistida' })).toEqual([]);
    for (const assistanceKg of [-1, NaN, Infinity, MODEL_LIMITS.maxAssistanceKg + 1]) expect(setModelIssues({ assistanceKg }).map((i) => i.field)).toEqual(['assistanceKg']);
    expect(setModelIssues({ side: 'direito' }, { laterality: 'unilateral' })).toEqual([]);
    expect(setModelIssues({ side: 'meio' as never }).map((i) => i.field)).toEqual(['side']);
  });

  it('campo ausente ou null não é erro e nunca vira zero', () => {
    expect(setModelIssues({ durationSec: null, distance: undefined, side: null, assistanceKg: null })).toEqual([]);
  });

  it('combinações incompatíveis: carga adicional + assistência, lado em bilateral, assistência sem modo assistido', () => {
    expect(setModelIssues({ weight: 10, assistanceKg: 20 }, { loadMode: 'assistida' }).map((i) => i.severity)).toEqual(['warning']);
    expect(setModelIssues({ side: 'esquerdo' }, { laterality: 'bilateral' }).map((i) => i.field)).toEqual(['side']);
    expect(setModelIssues({ assistanceKg: 10 }, { modality: 'bodyweight', loadMode: 'corporal' }).map((i) => i.field)).toEqual(['assistanceKg']);
  });

  it('conclusão: cada modalidade exige o próprio dado e nada inválido é concluído', () => {
    expect(setCompletionErrors({}, set({ weight: 60, reps: 8 }))).toEqual([]);
    expect(setCompletionErrors({}, set({ weight: 60, reps: null }))).toEqual(['Informe as repetições.']);
    expect(setCompletionErrors(PLANK, set({ durationSec: 45 }))).toEqual([]);
    expect(setCompletionErrors(PLANK, set({ reps: 45 }))).toEqual(['Informe a duração da série.']);
    expect(setCompletionErrors(RUN, set({ distance: 5000 }))).toEqual([]);
    expect(setCompletionErrors(RUN, set({ durationSec: 1800 }))).toEqual([]);
    expect(setCompletionErrors(RUN, set({}))).toEqual(['Informe a duração ou a distância.']);
    expect(setCompletionErrors(RUN, set({ distance: Infinity, durationSec: 60 }))).toHaveLength(1);
    expect(setCompletionErrors(PULLUP, set({ reps: 8, assistanceKg: 20, weight: 5 }))).toContain('Use carga adicional ou assistência, não as duas.');
    expect(setCompletionErrors(LUNGE, set({ reps: 10, weight: 20, side: 'esquerdo' }))).toEqual([]);
    expect(setCompletionErrors(LUNGE, set({ reps: 10, weight: NaN }))).toEqual(['Carga inválida.']);
  });

  it('campos visíveis por modalidade: só o que a modalidade registra', () => {
    expect(exerciseMeasures(PLANK)).toMatchObject({ reps: false, weight: 'none', duration: true, distance: false });
    expect(exerciseMeasures(RUN)).toMatchObject({ reps: false, weight: 'none', duration: true, distance: true, side: false });
    expect(exerciseMeasures(LUNGE)).toMatchObject({ reps: true, weight: 'externa', side: true });
    expect(exerciseMeasures(PULLUP)).toMatchObject({ reps: true, weight: 'none', assistance: true, progression: false });
    expect(exerciseMeasures(DIP)).toMatchObject({ reps: true, weight: 'adicional', progression: false });
    expect(exerciseMeasures({ modality: 'timed', loadMode: 'adicional' })).toMatchObject({ duration: true, weight: 'adicional', reps: false });
  });

  it('formata durações', () => {
    expect([fmtDurationSec(45), fmtDurationSec(90), fmtDurationSec(3725)]).toEqual(['45 s', '1:30', '1:02:05']);
  });
});

describe('modelo v3: sessão de treino', () => {
  const r = modelRoutine();
  const w = r.workouts[0];

  it('copia os metadados para a sessão e monta séries só com os campos da modalidade', () => {
    const s = buildSession(r, w, []);
    const [legacy, plank, run, lunge, pull, dip] = s.exercises;
    expect(legacy).not.toHaveProperty('modality');
    expect(legacy.sets[0]).not.toHaveProperty('durationSec');
    expect(plank).toMatchObject({ modality: 'timed', loadMode: 'corporal', targetDurationSec: 45 });
    // Tempo: sem repetições (repetições nunca viram segundos) e com a duração planejada.
    expect(plank.sets.map((x) => [x.reps, x.weight, x.durationSec, x.plannedDurationSec, x.plannedReps])).toEqual(Array(3).fill([null, null, 45, 45, null]));
    expect(run.sets).toHaveLength(1);
    expect(run.sets[0]).toMatchObject({ reps: null, weight: null, durationSec: 1800, distance: 5000 });
    // Unilateral: uma série por série planejada, sem lado pré-preenchido nem duplicação.
    expect(lunge.sets).toHaveLength(3);
    expect(lunge.sets.every((x) => x.side === undefined)).toBe(true);
    expect(lunge.secondaryMuscles).toEqual(['Glúteos']);
    expect(pull.sets.every((x) => x.weight === null && x.reps === 12)).toBe(true);
    expect(dip.sets.every((x) => x.reps === 12)).toBe(true);
  });

  it('pré-preenche com o último treino do exercício (duração, distância e assistência), nunca o lado', () => {
    const prev = finishSession(buildSession(r, w, []));
    const done = { ...prev, exercises: prev.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, status: 'done' as const })) })) };
    done.exercises[1].sets[0].durationSec = 70;
    done.exercises[2].sets[0].distance = 6000;
    done.exercises[3].sets[0].side = 'esquerdo';
    done.exercises[4].sets[0].assistanceKg = 15;
    const next = buildSession(r, w, [done]);
    expect(next.exercises[1].sets[0].durationSec).toBe(70);
    expect(next.exercises[2].sets[0].distance).toBe(6000);
    expect(next.exercises[3].sets[0].side).toBeUndefined();
    expect(next.exercises[4].sets[0].assistanceKg).toBe(15);
  });

  it('editar, concluir e propagar: só a série editada muda; assistência segue a regra da carga', () => {
    const s0 = buildSession(r, w, []);
    let s = s0;
    const pull = s.exercises[4];
    s = updateSet(s, pull.id, pull.sets[0].id, { assistanceKg: 20, reps: 8 });
    s = carryForwardWeight(completeSet(s, pull.id, pull.sets[0].id), pull.id, pull.sets[0].id);
    expect(s.exercises[4].sets.map((x) => x.assistanceKg)).toEqual([20, 20, 20]);
    expect(s.exercises[4].sets.map((x) => x.weight)).toEqual([null, null, null]);
    const lunge = s.exercises[3];
    s = updateSet(s, lunge.id, lunge.sets[1].id, { side: 'direito' });
    expect(s.exercises[3].sets.map((x) => x.side ?? null)).toEqual([null, 'direito', null]);
    // Outros exercícios da sessão não mudam.
    expect(s.exercises[1]).toEqual(s0.exercises[1]);
    expect(s.exercises[2]).toEqual(s0.exercises[2]);
  });

  it('série extra copia duração/distância, sem repetições em tempo e sem lado', () => {
    let s = buildSession(r, w, []);
    s = addSet(s, s.exercises[1].id);
    expect(s.exercises[1].sets.at(-1)).toMatchObject({ reps: null, durationSec: 45 });
    s = addSet(s, s.exercises[3].id);
    expect(s.exercises[3].sets.at(-1)!.side).toBeUndefined();
  });

  it('substituir um exercício por tempo não inventa repetições', () => {
    const s0 = buildSession(r, w, []);
    const s = substituteExercise(s0, s0.exercises[1].id, 'Prancha lateral', []);
    const ex = s.exercises.find((e) => e.name === 'Prancha lateral')!;
    expect(ex.modality).toBe('timed');
    expect(ex.sets.map((x) => [x.reps, x.weight, x.durationSec])).toEqual(Array(3).fill([null, null, 45]));
    // Exercício com repetições: comportamento antigo (repetições da faixa).
    const t = substituteExercise(s0, s0.exercises[0].id, 'Supino inclinado', []);
    expect(t.exercises[0].sets.every((x) => x.reps === s0.exercises[0].repMax)).toBe(true);
  });

  it('séries por tempo e cardio contam como séries e avançam a rotação; volume e recordes antigos não mudam', () => {
    const only = session('t', { exercises: [sx(PLANK, [{ durationSec: 30 }]), sx(RUN, [{ distance: 3000 }])] });
    expect(validSetCount(only)).toBe(2);
    expect(shouldAdvance(only, 'finish', 0)).toBe(true);
    expect(sessionVolume(only)).toBe(0);
    expect(only.exercises.flatMap((e) => e.sets).every((x) => isCompletedWorkSet(x) && !isValidWorkingSet(x))).toBe(true);
    // Gráfico antigo e recordes antigos: mesmos números com ou sem as sessões do modelo v3 (1RM histórico intacto).
    const old = snapshot().sessions;
    expect(computeRecords([...old, modelSession('m1')]).get('supino')).toEqual(computeRecords(old).get('supino'));
    expect(exerciseSeries([...old, modelSession('m1')], 'supino')).toEqual(exerciseSeries(old, 'supino'));
  });

  it('registros antigos: contagem e rotação idênticas às de antes', () => {
    for (const s of snapshot().sessions) {
      expect(validSetCount(s)).toBe(s.exercises.reduce((a, e) => a + e.sets.filter(isValidWorkingSet).length, 0));
    }
  });
});

describe('ficha JSON com campos de modalidade', () => {
  const ficha = (ex: Record<string, unknown>, versao = 2) =>
    JSON.stringify({ formato: 'irontrack.ficha', versao, nome: 'F', treinos: [{ rotulo: 'A', nome: 'A', exercicios: [{ nome: 'X', grupo: 'Peito', series: 3, repeticoes: '8-12', ...ex }] }] });
  const rest = { restCompoundSec: 120, restIsolationSec: 90 };

  it('fichas antigas (v1, sem campos novos) continuam idênticas: nada é inventado', () => {
    const r = parseFicha(ficha({}, 1), rest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.workouts[0].exercises[0];
    for (const k of ['modality', 'laterality', 'loadMode', 'secondaryMuscles', 'distanceUnit', 'targetDurationSec', 'targetDistance']) expect(e).not.toHaveProperty(k);
  });

  it('lê os campos novos só quando escritos explicitamente, com unidade explícita', () => {
    const r = parseFicha(ficha({ modalidade: 'cardio', unidade_distancia: 'km', distancia: 5, duracao: 1800 }), rest);
    expect(r.ok && r.value.workouts[0].exercises[0]).toMatchObject({ modality: 'cardio', distanceUnit: 'km', targetDistance: 5000, targetDurationSec: 1800 });
    const u = parseFicha(ficha({ modalidade: 'musculacao', lateralidade: 'unilateral', grupos_secundarios: ['Glúteos'] }), rest);
    expect(u.ok && u.value.workouts[0].exercises[0]).toMatchObject({ modality: 'resistance', laterality: 'unilateral', secondaryMuscles: ['Glúteos'] });
  });

  it('não interpreta números ambíguos como duração ou distância e valida valores', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ duracao: 45 }, /duracao só vale/],
      [{ modalidade: 'cardio', distancia: 5 }, /unidade_distancia/],
      [{ modalidade: 'tempo', duracao: 0 }, /maior que zero/],
      [{ modalidade: 'tempo', duracao: 12.5 }, /inteiro/],
      [{ modalidade: 'cardio', unidade_distancia: 'km', distancia: 5000 }, /1 000 km/],
      [{ modalidade: 'yoga' }, /modalidade deve ser/],
      [{ modalidade: 'musculacao', tipo_carga: 'assistida' }, /não combina/],
      [{ grupos_secundarios: ['a', 'b', 'c', 'd', 'e'] }, /no máximo 4/],
    ];
    for (const [ex, msg] of cases) {
      const r = parseFicha(ficha(ex), rest);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors.join('\n')).toMatch(msg);
    }
  });

  it('exporta e reimporta sem perder campos; sem campos novos continua v1', () => {
    const r = modelRoutine();
    const f = routineToFicha(r);
    expect(f.versao).toBe(2);
    const back = parseFicha(JSON.stringify(f), rest);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const strip = (e: object) => Object.fromEntries(Object.entries(e).filter(([k]) => ['modality', 'laterality', 'loadMode', 'secondaryMuscles', 'distanceUnit', 'targetDurationSec', 'targetDistance'].includes(k)));
    expect(back.value.workouts[0].exercises.map(strip)).toEqual(r.workouts[0].exercises.map(strip));
    expect(routineToFicha(routine()).versao).toBe(1);
  });

  it('versão de ficha futura é recusada com mensagem clara', () => {
    const r = parseFicha(ficha({}, 3), rest);
    expect(!r.ok && r.errors.join()).toMatch(/versão não suportada/);
  });
});

describe('integridade com campos de modalidade', () => {
  it('dados válidos do modelo v3 não geram problemas', () => {
    const rep = checkIntegrity(modelSnapshot());
    expect(rep.issues.filter((i) => i.code === 'INVALID_MODALITY_FIELD' || i.code === 'MODALITY_CONTRADICTION')).toEqual([]);
  });

  it('valor inválido é erro (bloqueia restauração); contradição é aviso (preservada)', () => {
    const d = modelSnapshot();
    d.routines[0].workouts[0].exercises[1] = tpl('x', { modality: 'pilates' as never });
    const bad = d.sessions.at(-1)!;
    bad.exercises[0].sets[0].durationSec = -3;
    bad.exercises[2].sets[0].side = 'meio' as never;
    const contra = d.sessions.at(-2)!;
    contra.exercises[3].sets[0].weight = 10; // carga adicional + assistência
    const rep = checkIntegrity(d);
    expect(rep.ok).toBe(false);
    const by = (code: string) => rep.issues.filter((i) => i.code === code).map((i) => [i.collection, i.id, i.severity]);
    expect(by('INVALID_MODALITY_FIELD')).toEqual([
      ['routines', 'r1', 'error'],
      ['sessions', bad.id, 'error'],
    ]);
    expect(by('MODALITY_CONTRADICTION')).toEqual([['sessions', contra.id, 'warning']]);
    expect(rep.issues.find((i) => i.code === 'INVALID_MODALITY_FIELD' && i.collection === 'sessions')!.message).toMatch(/2 campo\(s\)/);
  });
});
