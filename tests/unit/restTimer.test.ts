import { describe, expect, it } from 'vitest';
import { adjustRest, isFinished, pauseRest, progress, remainingMs, resumeRest, startRest } from '@/lib/restTimer';

const meta = { nextLabel: 'Supino · Série 2', exerciseId: 'e', setId: 's' };

describe('cronômetro de descanso por timestamps', () => {
  it('calcula o restante pelo relógio, mesmo após "tela bloqueada"', () => {
    const r = startRest(150, 1_000, meta);
    expect(remainingMs(r, 1_000)).toBe(150_000);
    // nenhum tick durante 100 s (aba em segundo plano): continua correto
    expect(remainingMs(r, 101_000)).toBe(50_000);
    expect(isFinished(r, 151_000)).toBe(true);
    expect(remainingMs(r, 500_000)).toBe(0);
  });
  it('pausa e retoma sem perder tempo', () => {
    let r = startRest(90, 0, meta);
    r = pauseRest(r, 30_000);
    expect(remainingMs(r, 80_000)).toBe(60_000);
    r = resumeRest(r, 80_000);
    expect(remainingMs(r, 90_000)).toBe(50_000);
  });
  it('acrescenta e retira 15/30 s, sem ficar negativo', () => {
    let r = startRest(90, 0, meta);
    r = adjustRest(r, 30, 0);
    expect(remainingMs(r, 0)).toBe(120_000);
    r = adjustRest(r, -15, 0);
    expect(remainingMs(r, 0)).toBe(105_000);
    r = adjustRest(r, -300, 0);
    expect(remainingMs(r, 0)).toBe(0);
    expect(r.durationMs).toBe(0);
  });
  it('ajuste durante pausa', () => {
    let r = pauseRest(startRest(60, 0, meta), 10_000);
    r = adjustRest(r, 15, 99_000);
    expect(remainingMs(r, 200_000)).toBe(65_000);
  });
  it('progresso entre 0 e 1', () => {
    const r = startRest(100, 0, meta);
    expect(progress(r, 0)).toBe(0);
    expect(progress(r, 50_000)).toBeCloseTo(0.5);
    expect(progress(r, 999_000)).toBe(1);
  });
});
