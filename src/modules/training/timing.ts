// Tempo do treino com pausas, finalização e retomada (IronTrack 2.0 F01/P20, docs/RETOMADA_TREINOS.md).
// Antes do P20 a duração era só `Date.now() - startedAt` (em andamento) e `durationSec` gravado na finalização.
// Isso continua valendo para todo treino que nunca foi retomado: nenhum registro antigo é reescrito.
// Ao retomar um treino finalizado, a sessão ganha `timing`: a duração efetiva passa a ser a soma dos segmentos ativos,
// e o intervalo em que o treino ficou finalizado nunca entra. Os horários originais de início e de finalização são
// preservados (início em `startedAt`, finalizações anteriores em `timing.finishes`).
// Relógio do aparelho voltando no tempo nunca produz duração negativa: cada trecho é limitado a ≥ 0.
import type { SessionTiming, WorkoutSession } from './types';

/** Limite de segmentos, finalizações e retomadas guardados para auditoria (os mais recentes ficam). */
export const MAX_TIMING_ENTRIES = 50;
/** Maior duração aceita num treino (24 h). Correções manuais acima disso são recusadas. */
export const MAX_SESSION_DURATION_SEC = 24 * 60 * 60;

const posSec = (ms: number) => Math.max(0, ms) / 1000;
const keep = <T>(list: T[]) => list.slice(-MAX_TIMING_ENTRIES);

/** Duração já registrada de um treino concluído (segundos inteiros, ≥ 0). Registros antigos sem `durationSec` usam o horário. */
export function recordedDurationSec(s: Pick<WorkoutSession, 'durationSec' | 'startedAt' | 'finishedAt'>): number {
  if (typeof s.durationSec === 'number' && Number.isFinite(s.durationSec) && s.durationSec >= 0) return Math.round(s.durationSec);
  if (typeof s.finishedAt === 'number' && Number.isFinite(s.finishedAt)) return Math.round(posSec(s.finishedAt - s.startedAt));
  return 0;
}

/**
 * Duração efetiva em segundos (fracionários, ≥ 0).
 * - Concluído (ou descartado): a duração gravada, congelada — o relógio nunca avança.
 * - Em andamento, sem retomada: relógio desde o início (comportamento anterior ao P20).
 * - Em andamento, depois de uma retomada: acumulado + segmento atual.
 */
export function effectiveDurationSec(s: Pick<WorkoutSession, 'status' | 'startedAt' | 'finishedAt' | 'durationSec' | 'timing'>, now: number): number {
  if (s.status !== 'active') return recordedDurationSec(s);
  const t = s.timing;
  if (!t) return posSec(now - s.startedAt);
  return Math.max(0, t.accumulatedSec) + (t.activeSince == null ? 0 : posSec(now - t.activeSince));
}

/** Pode voltar a ficar ativo: só treino concluído. */
export const canResume = (s: Pick<WorkoutSession, 'status'>) => s.status === 'completed';

/**
 * Volta um treino concluído ao estado ativo SEM contar o intervalo desde a finalização: o relógio recomeça do total
 * já acumulado. O horário de finalização sai de `finishedAt` (a sessão está ativa de novo) e fica em `timing.finishes`.
 * O descanso não recomeça e nenhum cronômetro de execução é iniciado.
 */
export function resumeTiming(s: WorkoutSession, now: number): WorkoutSession {
  if (!canResume(s)) return s;
  const accumulated = recordedDurationSec(s);
  const prev = s.timing;
  const firstSegment = typeof s.finishedAt === 'number' ? [{ start: s.startedAt, end: Math.max(s.startedAt, s.finishedAt) }] : [];
  const timing: SessionTiming = {
    accumulatedSec: accumulated,
    activeSince: now,
    segments: prev ? prev.segments : firstSegment,
    finishes: keep([...(prev?.finishes ?? []), ...(typeof s.finishedAt === 'number' ? [s.finishedAt] : [])]),
    resumes: keep([...(prev?.resumes ?? []), now]),
  };
  const { finishedAt: _f, durationSec: _d, ...rest } = s;
  return { ...rest, status: 'active', timing, rest: null };
}

/**
 * Encerra o segmento ativo de um treino retomado e devolve a duração final (segundos inteiros). Treinos nunca
 * retomados não passam por aqui (a finalização antiga é preservada em `finishSession`).
 */
export function closeTiming(t: SessionTiming, now: number): { timing: SessionTiming; durationSec: number } {
  const since = t.activeSince;
  const added = since == null ? 0 : posSec(now - since);
  const accumulatedSec = Math.max(0, t.accumulatedSec) + added;
  const segments = since == null ? t.segments : keep([...t.segments, { start: since, end: Math.max(since, now) }]);
  return { timing: { ...t, accumulatedSec, activeSince: null, segments }, durationSec: Math.round(accumulatedSec) };
}

export type DurationCheck = { ok: true; value: number } | { ok: false; error: string };

/** Valida uma duração corrigida à mão (minutos inteiros na tela; segundos aqui). */
export function checkDuration(sec: unknown): DurationCheck {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return { ok: false, error: 'Informe a duração do treino.' };
  if (sec < 0) return { ok: false, error: 'A duração não pode ser negativa.' };
  if (sec > MAX_SESSION_DURATION_SEC) return { ok: false, error: 'A duração passa de 24 horas.' };
  return { ok: true, value: Math.round(sec) };
}

/** Problemas estruturais em `timing` (verificação de integridade de backups). Vazio = válido ou ausente. */
export function timingIssues(t: unknown): string[] {
  if (t === undefined) return [];
  if (!t || typeof t !== 'object') return ['tempo do treino em formato inválido'];
  const x = t as Partial<SessionTiming>;
  const out: string[] = [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!num(x.accumulatedSec) || (x.accumulatedSec as number) < 0) out.push('duração acumulada inválida');
  if (x.activeSince !== null && !num(x.activeSince)) out.push('início do segmento ativo inválido');
  for (const k of ['segments', 'finishes', 'resumes'] as const) {
    const v = x[k];
    if (!Array.isArray(v)) out.push(`lista "${k}" ausente`);
    else if (v.length > MAX_TIMING_ENTRIES) out.push(`lista "${k}" maior que o limite`);
  }
  if (Array.isArray(x.segments) && x.segments.some((g) => !g || !num(g.start) || !num(g.end) || g.end < g.start)) out.push('segmento ativo inválido');
  return out;
}
