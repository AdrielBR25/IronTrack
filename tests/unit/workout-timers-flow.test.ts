// Do treino ao histórico e às análises (P11): a duração medida pelo cronômetro, a distância digitada em milhas,
// o lado escolhido pelo atalho e a carga adicional/assistência chegam ao histórico e ao analytics com as mesmas
// regras do P10. O 1RM histórico e os limiares de tendência não mudam. Banco fake-indexeddb, dados fictícios.
import { beforeEach, describe, expect, it } from 'vitest';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addRoutine, completeSession, completedSessions, saveSessionGuarded, startSession } from '@/db/repo';
import { analyzeTraining } from '@/modules/analytics';
import {
  completeSet,
  estimate1RM,
  historyFor,
  measuredSeconds,
  oppositeSide,
  paceSecPerUnit,
  pauseSetTimer,
  resumeSetTimer,
  setCompletionErrors,
  setTimerElapsedMs,
  startSetTimer,
  stopSetTimer,
  toMetersFrom,
  fromMetersTo,
  updateSet,
  type SetTimerState,
} from '@/modules/training';
import type { WorkoutSession } from '@/lib/types';
import { modelRoutine } from './modelFixtures';

let n = 0;
beforeEach(async () => {
  setDb(new IronTrackDB(`flow-${++n}`));
  await db.open();
});

const T = 1_800_000_000_000;
const exOf = (s: WorkoutSession, id: string) => s.exercises.find((e) => e.templateId === id)!;

async function runWorkout(startAt: number, plankSec: number, runMiles: number): Promise<WorkoutSession> {
  const r = (await db.routines.toCollection().first())!;
  let s = await startSession(r.id, r.workouts[0].id);
  s = { ...s, startedAt: startAt };
  const base = s;
  const plank = exOf(s, 'prancha');
  // Cronômetro: inicia, pausa 30 s, continua e encerra.
  let t: SetTimerState = startSetTimer({ sessionId: s.id, exerciseId: plank.id, setId: plank.sets[0].id }, startAt);
  t = pauseSetTimer(t, startAt + 20_000);
  t = resumeSetTimer(t, startAt + 50_000);
  t = stopSetTimer(t, startAt + 50_000 + (plankSec - 20) * 1000 + 700);
  const measured = measuredSeconds(setTimerElapsedMs(t, startAt + 999_999));
  expect(measured).toBe(plankSec);
  s = completeSet(updateSet(s, plank.id, plank.sets[0].id, { durationSec: measured }), plank.id, plank.sets[0].id, startAt + 60_000);
  // Cardio: distância digitada em milhas, gravada em metros.
  const run = exOf(s, 'corrida');
  s = updateSet(s, run.id, run.sets[0].id, { durationSec: 1500, distance: toMetersFrom(runMiles, 'mi') });
  expect(setCompletionErrors(run, exOf(s, 'corrida').sets[0])).toEqual([]);
  s = completeSet(s, run.id, run.sets[0].id);
  // Unilateral: direito, depois o atalho escolhe o oposto.
  const lunge = exOf(s, 'afundo');
  s = completeSet(updateSet(s, lunge.id, lunge.sets[0].id, { side: 'direito', weight: 20, reps: 10 }), lunge.id, lunge.sets[0].id);
  s = completeSet(updateSet(s, lunge.id, lunge.sets[1].id, { side: oppositeSide('direito')!, weight: 20, reps: 8 }), lunge.id, lunge.sets[1].id);
  // Assistência e carga adicional.
  const pull = exOf(s, 'barra');
  s = completeSet(updateSet(s, pull.id, pull.sets[0].id, { assistanceKg: 20, reps: 6 }), pull.id, pull.sets[0].id);
  const dip = exOf(s, 'paralelas');
  s = completeSet(updateSet(s, dip.id, dip.sets[0].id, { weight: 10, reps: 8 }), dip.id, dip.sets[0].id);
  const saved = await saveSessionGuarded(base, s);
  return completeSession(saved.session!, undefined, startAt + 3_600_000);
}

describe('fluxo completo até o histórico e o analytics', () => {
  it('duração medida, distância em milhas, lados, assistência e carga adicional aparecem corretamente', async () => {
    await addRoutine(modelRoutine());
    for (let i = 0; i < 4; i++) await runWorkout(T + i * 3 * 86_400_000, 40 + i * 5, 3 + i * 0.1);
    const done = await completedSessions();
    expect(done).toHaveLength(4);

    // Histórico: duração e distância gravadas em segundos e metros.
    const h = historyFor(exOf(done[0], 'prancha').exerciseKey, done, 5);
    expect(h.map((x) => x.sets[0].durationSec)).toEqual([55, 50, 45, 40]);
    const runSet = historyFor(exOf(done[0], 'corrida').exerciseKey, done, 1)[0].sets[0];
    expect(fromMetersTo(runSet.distance!, 'mi')).toBeCloseTo(3.3, 6);
    expect(paceSecPerUnit(runSet.durationSec, runSet.distance, 'km')).toBeCloseTo(1500 / (toMetersFrom(3.3, 'mi') / 1000), 6);

    const today = new Date(T + 20 * 86_400_000).toISOString().slice(0, 10);
    const report = analyzeTraining(done, 'all', today);
    const keyOf = (id: string) => done[0].exercises.find((e) => e.templateId === id)!.exerciseKey;
    const ex = (id: string) => report.exercises.find((e) => e.key === keyOf(id))!;
    expect(ex('prancha').modality.timed).toMatchObject({ available: true, longestSec: 55 });
    expect(ex('prancha').trend.metric).toBe('duracao');
    expect(ex('corrida').modality.cardio).toMatchObject({ available: true, sessionsWithDistance: 4 });
    expect(ex('corrida').modality.cardio!.totalDistanceM).toBeCloseTo(toMetersFrom(3, 'mi') + toMetersFrom(3.1, 'mi') + toMetersFrom(3.2, 'mi') + toMetersFrom(3.3, 'mi'), 2);
    expect(ex('afundo').modality.sides).toMatchObject({ available: true });
    expect([ex('afundo').modality.sides!.direito.sets, ex('afundo').modality.sides!.esquerdo.sets, ex('afundo').modality.sides!.desconhecido.sets]).toEqual([4, 4, 0]);
    expect(ex('barra').modality.bodyweight).toMatchObject({ bestAssisted: { assistanceKg: 20, reps: 6 }, volumeKg: null });
    expect(ex('paralelas').modality.bodyweight).toMatchObject({ bestAddedLoad: { load: 10, reps: 8 } });
    expect(report.quality.invalidModalitySets).toBe(0);
  });

  it('1RM histórico (estimate1RM) continua com a mesma fórmula', () => {
    expect(estimate1RM(100, 1)).toBe(100);
    expect(estimate1RM(100, 10)).toBeCloseTo(100 * (1 + 10 / 30), 6);
  });
});
