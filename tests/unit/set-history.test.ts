// Preenchimento série a série pelo último treino, comparação com a mesma série e séries em partes
// (docs/SERIES_POR_PARTES.md). Dados fictícios.
import { describe, expect, it } from 'vitest';
import {
  allowsSegments,
  buildSession,
  carryForwardWeight,
  completeSet,
  computeRecords,
  exerciseSeries,
  historyFor,
  previousSameSet,
  sessionPRs,
  setCompletionErrors,
  setParts,
  setVolume,
  totalSetReps,
  updateSet,
  type SessionSet,
  type WorkoutSession,
} from '@/modules/training';
import { exercisePoint, normalizeSessions } from '@/modules/analytics';
import { classifySets, metricsOf } from '@/modules/performance';
import { parseBackup } from '@/lib/backup';
import { setSummary } from '@/features/workout/modelFormat';
import { exerciseKey } from '@/lib/utils';
import { backupOf, routine, session, snapshot } from './fixtures';

const r = routine('r1');
const w = r.workouts[0];
const tpl = w.exercises[0];
const key = exerciseKey(tpl.name);

const done = (id: string, weight: number, reps: number, over: Partial<SessionSet> = {}): SessionSet => ({ id, type: 'normal', status: 'done', weight, reps, completedAt: 1, ...over });

function previous(sets: SessionSet[], startedAt = 1_700_000_000_000): WorkoutSession {
  const base = session(`prev-${startedAt}`, { startedAt });
  return { ...base, exercises: [{ ...base.exercises[0], id: 'px', exerciseKey: key, name: tpl.name, plannedSets: sets.length, sets }] };
}

const last = previous([done('a', 35, 10), done('b', 45, 8), done('c', 50, 6)]);
const fmtW = (kg: number | null | undefined, unit = true) => (kg == null ? '—' : `${kg}${unit ? ' kg' : ''}`);

describe('preenchimento pela mesma série do último treino', () => {
  it('cada série recebe carga e repetições da mesma série (não da primeira nem da mais pesada)', () => {
    const s = buildSession(r, w, [last]);
    const sets = s.exercises[0].sets;
    expect(sets.map((x) => [x.weight, x.reps])).toEqual([
      [35, 10],
      [45, 8],
      [50, 6],
    ]);
    // O plano de cada série também é a mesma série (antes era a carga mais pesada para todas).
    expect(sets.map((x) => x.plannedWeight)).toEqual([35, 45, 50]);
  });

  it('com carga planejada na ficha, o plano continua sendo a ficha', () => {
    const r2 = routine('r1');
    r2.workouts[0].exercises[0].targetWeight = 40;
    const s = buildSession(r2, r2.workouts[0], [last]);
    expect(s.exercises[0].sets.map((x) => x.plannedWeight)).toEqual([40, 40, 40]);
    expect(s.exercises[0].sets.map((x) => x.weight)).toEqual([35, 45, 50]);
  });

  it('concluir a série 1 não sobrescreve as séries seguintes que têm referência no último treino', () => {
    let s = buildSession(r, w, [last]);
    const ex = s.exercises[0];
    s = updateSet(s, ex.id, ex.sets[0].id, { weight: 37.5, edited: true });
    s = carryForwardWeight(completeSet(s, ex.id, ex.sets[0].id), ex.id, ex.sets[0].id, historyFor(key, [last], 1)[0].sets);
    expect(s.exercises[0].sets.map((x) => x.weight)).toEqual([37.5, 45, 50]);
  });

  it('séries sem referência (primeiro treino ou séries a mais) continuam seguindo a carga concluída', () => {
    let s = buildSession(r, w, []);
    const ex = s.exercises[0];
    s = updateSet(s, ex.id, ex.sets[0].id, { weight: 40 });
    s = carryForwardWeight(completeSet(s, ex.id, ex.sets[0].id), ex.id, ex.sets[0].id, undefined);
    expect(s.exercises[0].sets.map((x) => x.weight)).toEqual([40, 40, 40]);

    // Último treino com só 1 série: a série 1 tem referência, as 2 e 3 seguem a carga.
    const short = previous([done('a', 30, 10)]);
    let t = buildSession(r, w, [short]);
    const ex2 = t.exercises[0];
    t = updateSet(t, ex2.id, ex2.sets[0].id, { weight: 32.5 });
    t = carryForwardWeight(completeSet(t, ex2.id, ex2.sets[0].id), ex2.id, ex2.sets[0].id, short.exercises[0].sets);
    expect(t.exercises[0].sets.map((x) => x.weight)).toEqual([32.5, 32.5, 32.5]);
  });

  it('previousSameSet corresponde pela posição dentro do mesmo tipo', () => {
    const s = buildSession(r, w, [last]);
    const ex = s.exercises[0];
    expect(ex.sets.map((x) => previousSameSet(ex, x, last.exercises[0].sets)?.weight)).toEqual([35, 45, 50]);
    expect(previousSameSet(ex, ex.sets[0], [])).toBeUndefined();
    const drop: SessionSet = { id: 'd', type: 'drop', status: 'pending', weight: 30, reps: 8 };
    expect(previousSameSet({ sets: [...ex.sets, drop] }, drop, last.exercises[0].sets)).toBeUndefined();
  });

  it('35 kg na série 1 contra 35 kg na série 1 do último treino: diferença zero (não −15 kg)', () => {
    const s = buildSession(r, w, [last]);
    const ex = s.exercises[0];
    const ref = previousSameSet(ex, ex.sets[0], last.exercises[0].sets)!;
    expect((ex.sets[0].weight ?? 0) - (ref.weight ?? 0)).toBe(0);
  });
});

describe('série em partes (várias cargas na mesma série)', () => {
  const seg = done('s', 35, 8, { segments: [{ weight: 40, reps: 4 }] });

  it('volume soma as partes; a série conta uma vez', () => {
    expect(setVolume(seg)).toBe(35 * 8 + 40 * 4);
    expect(setParts(seg)).toEqual([
      { weight: 35, reps: 8 },
      { weight: 40, reps: 4 },
    ]);
    expect(totalSetReps(seg)).toBe(12);
    // Série sem partes: igual a antes.
    expect(setVolume(done('x', 60, 8))).toBe(480);
  });

  it('recordes e 1RM consideram cada parte', () => {
    const s = previous([seg]);
    const rec = computeRecords([s]).get(key)!;
    expect(rec.maxWeight).toBe(40);
    expect(rec.maxWeightReps).toBe(4);
    expect(rec.bestSessionVolume).toBe(440);
    const series = exerciseSeries([s], key);
    expect(series[0].maxWeight).toBe(40);
    expect(series[0].totalReps).toBe(12);
    const older = previous([done('o', 38, 8)], 1_600_000_000_000);
    expect(sessionPRs(s, [older])).toEqual([tpl.name]);
  });

  it('análises (P08/P09) e desempenho (P19) somam as partes sem aumentar a contagem de séries', () => {
    const h = normalizeSessions([previous([seg, done('t', 35, 10)])]);
    const ex = h.sessions[0].exercises[0];
    const p = exercisePoint(h.sessions[0], ex);
    expect(p.sets).toBe(2);
    expect(p.loadedSets).toBe(2);
    expect(p.volume).toBe(440 + 350);
    expect(p.topLoad).toBe(40);
    expect(p.reps).toBe(22);
    expect(p.bestSetVolume).toBe(440);

    const m = metricsOf('carga', classifySets('carga', [seg, done('t', 35, 10)]));
    expect(m.workSets).toBe(2);
    expect(m.volumeKg).toBe(790);
    expect(m.topLoadKg).toBe(40);
    expect(m.totalReps).toBe(22);
  });

  it('validação: cada parte precisa de repetições; só em exercícios de carga × repetições', () => {
    const ex = { modality: 'resistance' as const };
    expect(setCompletionErrors(ex, seg)).toEqual([]);
    expect(setCompletionErrors(ex, { ...seg, segments: [{ weight: 40, reps: null }] })).toContain('Informe as repetições de cada parte.');
    expect(setCompletionErrors(ex, { ...seg, segments: [{ weight: -5, reps: 4 }] })).toContain('Carga inválida numa parte.');
    expect(allowsSegments({})).toBe(true);
    expect(allowsSegments({ modality: 'timed' })).toBe(false);
    expect(allowsSegments({ modality: 'cardio' })).toBe(false);
    expect(allowsSegments({ modality: 'bodyweight', loadMode: 'corporal' })).toBe(false);
    expect(allowsSegments({ modality: 'bodyweight', loadMode: 'adicional' })).toBe(true);
  });

  it('a mesma série do próximo treino vem preenchida com as mesmas partes', () => {
    const prev = previous([done('a', 35, 10), done('b', 35, 8, { segments: [{ weight: 40, reps: 4 }] }), done('c', 50, 6)]);
    const s = buildSession(r, w, [prev]);
    expect(s.exercises[0].sets.map((x) => x.segments)).toEqual([undefined, [{ weight: 40, reps: 4 }], undefined]);
  });

  it('resumo em texto mostra as partes', () => {
    expect(setSummary(seg, fmtW)).toBe('35×8 + 40×4');
    expect(setSummary(done('x', 60, 8), fmtW)).toBe('60×8');
  });

  it('backup preserva as partes (exportar → importar)', () => {
    const s = previous([seg]);
    const file = backupOf(snapshot({ sessions: [s] }));
    const r2 = parseBackup(JSON.stringify(file));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.data.sessions[0].exercises[0].sets[0].segments).toEqual([{ weight: 40, reps: 4 }]);
  });
});
