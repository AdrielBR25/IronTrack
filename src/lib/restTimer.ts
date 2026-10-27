import type { RestState } from './types';

// Cronômetro baseado em timestamps reais: o tempo restante é sempre calculado
// a partir de endsAt - agora, então bloquear a tela ou trocar de app não
// desincroniza a contagem. setInterval/rAF servem apenas para redesenhar.

export function startRest(
  durationSec: number,
  now: number,
  meta: Pick<RestState, 'nextLabel' | 'exerciseId' | 'setId'>,
): RestState {
  const durationMs = Math.max(0, Math.round(durationSec * 1000));
  return { ...meta, durationMs, endsAt: now + durationMs, pausedRemainingMs: null, notified: false };
}

export function remainingMs(r: RestState, now: number): number {
  if (r.pausedRemainingMs !== null) return Math.max(0, r.pausedRemainingMs);
  return Math.max(0, r.endsAt - now);
}

export function isPaused(r: RestState): boolean {
  return r.pausedRemainingMs !== null;
}

export function isFinished(r: RestState, now: number): boolean {
  return remainingMs(r, now) <= 0;
}

export function progress(r: RestState, now: number): number {
  if (r.durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - remainingMs(r, now) / r.durationMs));
}

export function pauseRest(r: RestState, now: number): RestState {
  if (isPaused(r)) return r;
  return { ...r, pausedRemainingMs: Math.max(0, r.endsAt - now) };
}

export function resumeRest(r: RestState, now: number): RestState {
  if (!isPaused(r)) return r;
  return { ...r, endsAt: now + (r.pausedRemainingMs ?? 0), pausedRemainingMs: null };
}

/** Acrescenta (ou retira, se negativo) segundos. Nunca fica abaixo de zero. */
export function adjustRest(r: RestState, deltaSec: number, now: number): RestState {
  const delta = deltaSec * 1000;
  const rem = remainingMs(r, now);
  const newRem = Math.max(0, rem + delta);
  const applied = newRem - rem;
  const durationMs = Math.max(0, r.durationMs + applied);
  if (isPaused(r)) return { ...r, durationMs, pausedRemainingMs: newRem };
  return { ...r, durationMs, endsAt: now + newRem, notified: newRem > 0 ? false : r.notified };
}
