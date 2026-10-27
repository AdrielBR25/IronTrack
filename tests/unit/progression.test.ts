import { describe, expect, it } from 'vitest';
import { suggestProgression } from '@/lib/progression';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import type { SessionSet } from '@/lib/types';

const prefs = DEFAULT_SETTINGS.progression;
const plan = { repMin: 6, repMax: 10, plannedSets: 3, equipment: 'barbell' as const };
const s = (reps: number, extra: Partial<SessionSet> = {}): SessionSet => ({ id: String(Math.random()), type: 'normal', status: 'done', weight: 50, reps, ...extra });

describe('sugestão de progressão', () => {
  it('3×10 em 3×6–10 com RIR adequado → sugere aumento', () => {
    const r = suggestProgression(plan, [s(10, { rir: 2 }), s(10, { rir: 1 }), s(10)], prefs);
    expect(r.kind).toBe('increase');
    expect(r.suggestedWeight).toBe(52.5);
  });
  it('topo da faixa mas RIR 0 → manter', () => {
    expect(suggestProgression(plan, [s(10, { rir: 0 }), s(10), s(10)], prefs).kind).toBe('keep');
  });
  it('RPE 10 → manter', () => {
    expect(suggestProgression(plan, [s(10, { rpe: 10 }), s(10), s(10)], prefs).kind).toBe('keep');
  });
  it('dentro da faixa → manter e buscar +1 rep', () => {
    const r = suggestProgression(plan, [s(10), s(9), s(8)], prefs);
    expect(r.kind).toBe('keep');
    expect(r.suggestedWeight).toBe(50);
  });
  it('séries incompletas → manter', () => {
    expect(suggestProgression(plan, [s(10), s(10)], prefs).kind).toBe('keep');
  });
  it('abaixo do mínimo em duas sessões → sugere reduzir', () => {
    const r = suggestProgression(plan, [s(5), s(5), s(4)], prefs, [s(6), s(5), s(5)]);
    expect(r.kind).toBe('decrease');
    expect(r.suggestedWeight!).toBeLessThan(50);
  });
  it('halteres usam o incremento próprio', () => {
    const r = suggestProgression({ ...plan, equipment: 'dumbbell' }, [s(10), s(10), s(10)], prefs);
    expect(r.suggestedWeight).toBe(52);
  });
  it('sem histórico → nenhuma sugestão', () => {
    expect(suggestProgression(plan, null, prefs).kind).toBe('none');
  });
  it('aquecimento e séries não concluídas são ignorados', () => {
    const r = suggestProgression(plan, [s(10, { type: 'warmup', weight: 20 }), s(10), s(10), s(10), s(3, { status: 'skipped' })], prefs);
    expect(r.kind).toBe('increase');
  });
});
