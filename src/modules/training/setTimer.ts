import { MODEL_LIMITS } from './exerciseModel';

// Cronômetro de execução da série (IronTrack 2.0 F01/P11, docs/CRONOMETROS_E_CONCORRENCIA.md). Funções puras.
// Independente do descanso (RestState): outro tipo, outro armazenamento, nenhuma função aqui lê ou altera o descanso.
//
// Referência de tempo: relógio de parede (Date.now) gravado no início de cada trecho. O tempo decorrido é sempre
// `acumulado + (agora − início do trecho)`, nunca uma contagem de chamadas de setInterval; o intervalo só redesenha.
// Assim aba em segundo plano, tela bloqueada, timers reduzidos, re-renderização e navigação interna não alteram a
// contagem. Mudanças do relógio do sistema são tratadas em `reconcileClock`; a retomada depois de recarregar ou
// fechar o app, em `recoverSetTimer` (fica pausado: nada continua contando sem a pessoa ver).

export type SetTimerStatus = 'running' | 'paused' | 'stopped';

/** Série à qual o cronômetro pertence. Um cronômetro nunca muda de série. */
export interface SetTimerTarget {
  sessionId: string;
  exerciseId: string;
  setId: string;
}

/** Estado auxiliar e transitório (armazenamento local do navegador; nunca entra em backup nem no banco). */
export interface SetTimerState extends SetTimerTarget {
  v: 1;
  status: SetTimerStatus;
  /** Tempo dos trechos já fechados (ms). */
  accumulatedMs: number;
  /** Início (relógio de parede, ms) do trecho em andamento; null quando pausado ou encerrado. */
  segmentStartedAt: number | null;
  /** Última vez (relógio de parede) em que uma página aberta confirmou a contagem. Base da recuperação. */
  checkpointAt: number;
  /** Depois de recuperar: tempo entre a última confirmação e a recuperação, que NÃO foi somado. */
  awayMs?: number | null;
  /** Segundos que este cronômetro já gravou na série (para não pedir confirmação do próprio valor). */
  appliedSec?: number | null;
  /** Revisão: aumenta a cada ação, para as abas saberem qual estado é o mais novo. */
  rev: number;
}

export const SET_TIMER_LIMITS = {
  /** Mesmo limite da duração de uma série (24 h). */
  maxMs: MODEL_LIMITS.maxDurationSec * 1000,
  /** Tempo fora do app que ainda pode ser somado depois de recuperar (6 h). Acima disso só manualmente. */
  maxAwayMs: 6 * 3600 * 1000,
  /** Diferença entre relógio de parede e relógio monotônico aceita como ruído (ms). */
  clockToleranceMs: 5000,
} as const;

const cap = (ms: number) => Math.min(SET_TIMER_LIMITS.maxMs, Math.max(0, ms));

export function startSetTimer(target: SetTimerTarget, now: number): SetTimerState {
  return { v: 1, ...target, status: 'running', accumulatedMs: 0, segmentStartedAt: now, checkpointAt: now, awayMs: null, appliedSec: null, rev: 1 };
}

/** Tempo medido (ms). Um trecho com relógio "no futuro" (relógio voltou) conta zero, nunca negativo. */
export function setTimerElapsedMs(s: SetTimerState, now: number): number {
  const seg = s.status === 'running' && s.segmentStartedAt !== null ? Math.max(0, now - s.segmentStartedAt) : 0;
  return cap(s.accumulatedMs + seg);
}

export function pauseSetTimer(s: SetTimerState, now: number): SetTimerState {
  if (s.status !== 'running') return s;
  return { ...s, status: 'paused', accumulatedMs: setTimerElapsedMs(s, now), segmentStartedAt: null, checkpointAt: now, rev: s.rev + 1 };
}

export function resumeSetTimer(s: SetTimerState, now: number): SetTimerState {
  if (s.status !== 'paused') return s;
  return { ...s, status: 'running', segmentStartedAt: now, checkpointAt: now, awayMs: null, rev: s.rev + 1 };
}

/** Encerra a contagem. Depois de encerrado só é possível registrar o valor ou reiniciar. */
export function stopSetTimer(s: SetTimerState, now: number): SetTimerState {
  if (s.status === 'stopped') return s;
  return { ...s, status: 'stopped', accumulatedMs: setTimerElapsedMs(s, now), segmentStartedAt: null, checkpointAt: now, awayMs: null, rev: s.rev + 1 };
}

/** Confirmação periódica de uma página aberta (não muda a contagem). */
export function checkpointSetTimer(s: SetTimerState, now: number): SetTimerState {
  if (s.status !== 'running' || now <= s.checkpointAt) return s;
  return { ...s, checkpointAt: now };
}

export function markSetTimerApplied(s: SetTimerState, sec: number): SetTimerState {
  return { ...s, appliedSec: sec, rev: s.rev + 1 };
}

/**
 * Recuperação depois de recarregar ou reabrir sem nenhuma outra página mantendo a contagem: o cronômetro volta
 * PAUSADO com o tempo confirmado até `checkpointAt`. O tempo fora do app fica em `awayMs` e só entra na medida se a
 * pessoa pedir (`includeAwayTime`). Nunca conclui a série, nunca grava duração, nunca reinicia sozinho.
 */
export function recoverSetTimer(s: SetTimerState, now: number): SetTimerState {
  if (s.status !== 'running') return s;
  const confirmed = setTimerElapsedMs(s, Math.max(s.checkpointAt, s.segmentStartedAt ?? s.checkpointAt));
  return { ...s, status: 'paused', accumulatedMs: confirmed, segmentStartedAt: null, awayMs: Math.max(0, now - s.checkpointAt), checkpointAt: now, rev: s.rev + 1 };
}

/** O tempo fora do app pode ser somado? (pausado depois de recuperar, positivo e até 6 h). */
export function canIncludeAway(s: SetTimerState): boolean {
  return s.status === 'paused' && !!s.awayMs && s.awayMs > 0 && s.awayMs <= SET_TIMER_LIMITS.maxAwayMs;
}

export function includeAwayTime(s: SetTimerState): SetTimerState {
  if (!canIncludeAway(s)) return s;
  return { ...s, accumulatedMs: cap(s.accumulatedMs + (s.awayMs ?? 0)), awayMs: null, rev: s.rev + 1 };
}

export interface ClockObservation {
  wallPrev: number;
  wallNow: number;
  /** performance.now() nas mesmas leituras (monotônico, não muda com o relógio do sistema). */
  monoPrev: number;
  monoNow: number;
  /** A página ficou oculta (ou suspensa) entre as leituras. */
  hidden: boolean;
}

/**
 * Corrige mudanças do relógio do sistema percebidas com a página aberta. Compara o avanço do relógio de parede
 * com o do relógio monotônico:
 * - relógio voltou (diferença < −tolerância): conta só o tempo monotônico do intervalo;
 * - relógio avançou com a página visível: idem (ajuste manual ou sincronização de rede);
 * - avançou com a página oculta: mantém o relógio de parede, porque o monotônico pode parar durante a suspensão
 *   do aparelho e o tempo de tela bloqueada é tempo real de exercício.
 */
export function reconcileClock(s: SetTimerState, o: ClockObservation): SetTimerState {
  if (s.status !== 'running' || s.segmentStartedAt === null) return s;
  const drift = o.wallNow - o.wallPrev - (o.monoNow - o.monoPrev);
  if (Math.abs(drift) <= SET_TIMER_LIMITS.clockToleranceMs) return s;
  if (drift > 0 && o.hidden) return s;
  const atPrev = setTimerElapsedMs(s, o.wallPrev);
  return { ...s, accumulatedMs: cap(atPrev + Math.max(0, o.monoNow - o.monoPrev)), segmentStartedAt: o.wallNow, checkpointAt: o.wallNow, rev: s.rev + 1 };
}

/** Segundos gravados na série: o que a tela mostra (arredondado para baixo), como um cronômetro comum. */
export function measuredSeconds(ms: number): number {
  return Math.floor(Math.max(0, ms) / 1000);
}

/** A medida pode ser gravada como duração da série (1 s a 24 h). */
export function isRecordableMeasure(ms: number): boolean {
  const s = measuredSeconds(ms);
  return s >= 1 && s <= MODEL_LIMITS.maxDurationSec;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "00:42", "12:05", "01:23:45". */
export function fmtStopwatch(ms: number): string {
  const total = measuredSeconds(ms);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function timerBelongsTo(s: SetTimerState | null | undefined, t: SetTimerTarget): boolean {
  return !!s && s.sessionId === t.sessionId && s.exerciseId === t.exerciseId && s.setId === t.setId;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Lê o estado gravado. Qualquer coisa malformada vira null (o cronômetro some; a série não é tocada). */
export function parseSetTimerState(raw: unknown): SetTimerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !str(r.sessionId) || !str(r.exerciseId) || !str(r.setId)) return null;
  if (r.status !== 'running' && r.status !== 'paused' && r.status !== 'stopped') return null;
  if (!num(r.accumulatedMs) || r.accumulatedMs < 0 || !num(r.checkpointAt) || !num(r.rev)) return null;
  if (r.status === 'running' ? !num(r.segmentStartedAt) : r.segmentStartedAt !== null) return null;
  return {
    v: 1,
    sessionId: r.sessionId,
    exerciseId: r.exerciseId,
    setId: r.setId,
    status: r.status,
    accumulatedMs: cap(r.accumulatedMs),
    segmentStartedAt: r.status === 'running' ? (r.segmentStartedAt as number) : null,
    checkpointAt: r.checkpointAt,
    awayMs: num(r.awayMs) && r.awayMs > 0 ? r.awayMs : null,
    appliedSec: num(r.appliedSec) ? r.appliedSec : null,
    rev: r.rev,
  };
}
