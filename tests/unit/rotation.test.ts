import { describe, expect, it } from 'vitest';
import { completionPct, indexAfter, projectSchedule, shouldAdvance, skipIndex } from '@/lib/rotation';
import type { DayOverride, WorkoutSession } from '@/lib/types';

const order = ['A', 'B', 'C'];
const MON = '2026-11-02'; // segunda-feira

function labels(nextIndex: number, days: number, overrides = new Map<string, DayOverride>(), done = new Map<string, string>()) {
  return projectSchedule({ order, nextIndex, trainingDays: [1, 2, 3, 4, 5], overrides, doneByDate: done, start: MON, days }).map((d) =>
    d.kind === 'workout' || d.kind === 'done' ? d.workoutId : '-',
  );
}

describe('rotação ABC contínua', () => {
  it('segue o exemplo de 3 semanas, sem reiniciar na segunda', () => {
    const r = labels(0, 21);
    expect(r.slice(0, 7).join('')).toBe('ABCAB--');
    expect(r.slice(7, 14).join('')).toBe('CABCA--');
    expect(r.slice(14, 21).join('')).toBe('BCABC--');
  });

  it('dia de descanso marcado não consome treino', () => {
    const ov = new Map<string, DayOverride>([['2026-11-03', { routineId: 'r', date: '2026-11-03', kind: 'rest' }]]);
    expect(labels(0, 7, ov).join('')).toBe('A-BCA--');
  });

  it('reagendar treino para sábado continua a sequência a partir dele', () => {
    const ov = new Map<string, DayOverride>([['2026-11-07', { routineId: 'r', date: '2026-11-07', kind: 'workout', workoutId: 'C' }]]);
    expect(labels(0, 10, ov).join('')).toBe('ABCABC-ABC');
  });

  it('dia concluído aparece como feito e não consome o ponteiro', () => {
    const done = new Map([[MON, 'A']]);
    // após concluir A o ponteiro já foi para B (índice 1)
    expect(labels(1, 5, undefined, done).join('')).toBe('ABCAB');
  });

  it('conclusão avança a partir do treino realizado; pular avança um', () => {
    expect(indexAfter(order, 'A', 0)).toBe(1);
    expect(indexAfter(order, 'C', 0)).toBe(0);
    expect(indexAfter(order, 'B', 2)).toBe(2);
    expect(indexAfter(order, 'X', 2)).toBe(2);
    expect(skipIndex(order, 2)).toBe(0);
  });

  it('abrir o app não avança: projetar duas vezes dá o mesmo resultado', () => {
    expect(labels(1, 5)).toEqual(labels(1, 5));
  });
});

function session(doneNormal: number, planned: number): WorkoutSession {
  return {
    id: 's', routineId: 'r', workoutId: 'A', workoutLabel: 'A', workoutName: 'A', status: 'active', startedAt: 0, updatedAt: 0,
    exercises: [{
      id: 'e', exerciseKey: 'x', name: 'x', muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', repMin: 6, repMax: 10, restSec: 90, plannedSets: planned,
      sets: Array.from({ length: planned }, (_, i) => ({ id: String(i), type: 'normal' as const, status: i < doneNormal ? ('done' as const) : ('pending' as const), weight: 50, reps: 8 })),
    }],
  };
}

describe('política de avanço', () => {
  it('finish: avança com qualquer série válida; não avança sem séries', () => {
    expect(shouldAdvance(session(1, 3), 'finish', 60)).toBe(true);
    expect(shouldAdvance(session(0, 3), 'finish', 60)).toBe(false);
  });
  it('threshold: exige % mínimo', () => {
    expect(completionPct(session(1, 3))).toBe(33);
    expect(shouldAdvance(session(1, 3), 'threshold', 60)).toBe(false);
    expect(shouldAdvance(session(2, 3), 'threshold', 60)).toBe(true);
  });
});
