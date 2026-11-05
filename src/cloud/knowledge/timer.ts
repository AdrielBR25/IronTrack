// Cronômetro de leitura/estudo/foco no app (Fase 04, docs/CONHECIMENTO.md §3). Quem guarda e mede é o SERVIDOR: aqui
// só se mostra o tempo, se manda início/pausa/retomada e os sinais de presença.
//
//  - Recarregar a página ou abrir em outro aparelho: o cronômetro vem do servidor (um por conta).
//  - Tela bloqueada / aba em segundo plano: os sinais param; ao voltar, um sinal é enviado na hora. O servidor conta
//    trechos sem presença só até o limite (TIMER_RULES), então nada de "minutos inventados".
//  - Sem conexão: os eventos (pausa, retomada, presença) ficam numa fila no aparelho (localStorage) com o horário do
//    servidor estimado, e são reenviados quando a conexão volta. O servidor limita cada horário ao intervalo válido.
//  - Pomodoro/temporizador: o fim da fase é calculado pelos horários; se o app estava fechado, o foco termina no
//    horário planejado (nunca depois) quando ele volta.
import { useEffect, useSyncExternalStore } from 'react';
import { TIMER_RULES, addSeen, breakPhaseAfter, computeActive, type ActiveBreakdown, type TimerView } from '@shared/knowledge/protocol.ts';
import { ApiClientError } from '../api';
import { playBeep, unlockAudio, vibrate } from '@/lib/alerts';
import { knowledgeApi } from './api';
import { invalidateLife } from '../life/api';

type Ev = { type: 'pause' | 'resume' | 'seen' | 'break'; at: string };
interface Persisted {
  timer: TimerView | null;
  offset: number;
  pending: { id: string; events: Ev[] } | null;
}

const LS = 'irontrack.knowledge.timer.v1';
function readLs(): Persisted {
  try {
    const v = JSON.parse(localStorage.getItem(LS) ?? 'null') as Persisted | null;
    if (v && typeof v === 'object') return { timer: v.timer ?? null, offset: Number(v.offset) || 0, pending: v.pending ?? null };
  } catch {
    /* sem armazenamento: segue só com o servidor */
  }
  return { timer: null, offset: 0, pending: null };
}
function writeLs(p: Persisted): void {
  try {
    if (!p.timer && !p.pending) localStorage.removeItem(LS);
    else localStorage.setItem(LS, JSON.stringify(p));
  } catch {
    /* cota/privado: ignora */
  }
}

export interface TimerState {
  timer: TimerView | null;
  /** Diferença relógio do servidor − aparelho (ms). */
  offset: number;
  loaded: boolean;
  offline: boolean;
  pendingCount: number;
  /** Fase terminou e espera a pessoa (pausa do pomodoro acabou com a tela fechada, temporizador concluído). */
  waiting: 'break_over' | 'countdown_done' | null;
}

let state: TimerState = (() => {
  const p = readLs();
  return { timer: p.timer, offset: p.offset, loaded: false, offline: false, pendingCount: p.pending?.events.length ?? 0, waiting: null };
})();
let pending = readLs().pending;
const listeners = new Set<() => void>();
const set = (patch: Partial<TimerState>) => {
  state = { ...state, ...patch };
  writeLs({ timer: state.timer, offset: state.offset, pending });
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const serverNow = () => Date.now() + state.offset;
const isoNow = (ms = serverNow()) => new Date(ms).toISOString();
const isNetwork = (e: unknown) => e instanceof ApiClientError && (e.code === 'network' || e.code === 'timeout' || e.code === 'api_unavailable');

function adopt(timer: TimerView | null, srvNow?: number): void {
  const offset = srvNow ? srvNow - Date.now() : state.offset;
  if (pending && (!timer || pending.id !== timer.id)) pending = null;
  set({ timer, offset, loaded: true, offline: false, pendingCount: pending?.events.length ?? 0 });
}

/** Aplica um evento na cópia local (mesmas regras do servidor, para a tela responder na hora). */
function applyLocal(t: TimerView, ev: Ev): TimerView {
  const at = Date.parse(ev.at);
  const x: TimerView = { ...t, segments: t.segments.map((s) => ({ ...s })), seen: addSeen(t.seen, at) };
  const open = x.segments[x.segments.length - 1];
  const close = () => {
    if (open && open.e === null) open.e = Math.max(open.s, x.phaseEndsAt ? Math.min(at, x.phaseEndsAt) : at);
  };
  if (ev.type === 'pause' && x.phase !== 'paused') {
    if (x.phase === 'focus') close();
    x.phase = 'paused';
    x.phaseStartedAt = at;
    x.phaseEndsAt = null;
  } else if (ev.type === 'break' && x.phase === 'focus' && x.pomodoro) {
    close();
    x.focusDone += 1;
    const b = breakPhaseAfter(x.focusDone, x.pomodoro);
    x.phase = b.phase;
    x.phaseStartedAt = open?.e ?? at;
    x.phaseEndsAt = x.phaseStartedAt + b.ms;
  } else if (ev.type === 'resume' && x.phase !== 'focus') {
    x.segments.push({ s: at, e: null });
    x.phase = 'focus';
    x.phaseStartedAt = at;
    const before = computeActive(x.segments.slice(0, -1), x.seen, at).activeSec * 1000;
    x.phaseEndsAt = x.mode === 'pomodoro' && x.pomodoro ? at + x.pomodoro.focusMin * 60_000 : x.mode === 'countdown' && x.plannedSec ? at + Math.max(0, x.plannedSec * 1000 - before) : null;
  }
  return x;
}

async function flush(): Promise<void> {
  if (!pending || !state.timer || !pending.events.length) return;
  const batch = pending;
  try {
    const r = await knowledgeApi.timerEvents(batch.id, batch.events.slice(0, 200));
    if (pending === batch) pending = batch.events.length > 200 ? { id: batch.id, events: batch.events.slice(200) } : null;
    adopt(r.timer, r.serverNow);
  } catch (e) {
    if (isNetwork(e)) set({ offline: true });
    else if (e instanceof ApiClientError && e.code === 'knowledge_timer_missing') {
      pending = null;
      adopt(null);
    } else throw e;
  }
}

async function send(...events: Ev['type'][]): Promise<void> {
  const t = state.timer;
  if (!t) return;
  const evs = events.map((type) => ({ type, at: isoNow() }));
  let local = t;
  for (const ev of evs) local = applyLocal(local, ev);
  pending = { id: t.id, events: [...(pending?.id === t.id ? pending.events : []), ...evs] };
  set({ timer: local, pendingCount: pending.events.length, waiting: null });
  await flush();
}

let heartbeat: ReturnType<typeof setInterval> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let users = 0;

/** Transições automáticas: fim do foco do pomodoro/temporizador e fim da pausa. */
function autoStep(): void {
  const t = state.timer;
  if (!t || !t.phaseEndsAt) return;
  const now = serverNow();
  if (now < t.phaseEndsAt) return;
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  if (t.phase === 'focus' && t.mode === 'pomodoro') {
    const at = t.phaseEndsAt;
    pending = { id: t.id, events: [...(pending?.id === t.id ? pending.events : []), { type: 'break', at: isoNow(at) }] };
    set({ timer: applyLocal(t, { type: 'break', at: isoNow(at) }) });
    alertEnd(t.sound, 'Foco concluído! Hora da pausa.');
    void flush();
  } else if (t.phase === 'focus' && t.mode === 'countdown') {
    const at = t.phaseEndsAt;
    pending = { id: t.id, events: [...(pending?.id === t.id ? pending.events : []), { type: 'pause', at: isoNow(at) }] };
    set({ timer: applyLocal(t, { type: 'pause', at: isoNow(at) }), waiting: 'countdown_done' });
    alertEnd(t.sound, 'Tempo concluído!');
    void flush();
  } else if ((t.phase === 'short_break' || t.phase === 'long_break') && state.waiting !== 'break_over') {
    alertEnd(t.sound, 'Pausa terminou.');
    if (t.pomodoro?.autoContinue && visible && now - t.phaseEndsAt < 60_000) void send('resume');
    else set({ waiting: 'break_over' });
  }
}

function alertEnd(sound: boolean, _msg: string): void {
  if (sound) playBeep();
  vibrate([200, 100, 200]);
}

function onVisible(): void {
  if (document.visibilityState !== 'visible' || !state.timer) return;
  void reload().then(() => {
    if (state.timer && state.timer.phase === 'focus') void send('seen');
  });
}
const onOnline = () => void flush().then(() => reload());

function startEngine(): void {
  if (users++ > 0) return;
  heartbeat = setInterval(() => {
    if (state.timer && state.timer.phase === 'focus' && document.visibilityState === 'visible') void send('seen');
    else if (pending) void flush();
  }, TIMER_RULES.heartbeatSec * 1000);
  ticker = setInterval(autoStep, 1000);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  void reload();
}
function stopEngine(): void {
  if (--users > 0) return;
  if (heartbeat) clearInterval(heartbeat);
  if (ticker) clearInterval(ticker);
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('online', onOnline);
}

export async function reload(): Promise<void> {
  try {
    if (pending) await flush();
    const r = await knowledgeApi.timer();
    adopt(r.timer, r.serverNow);
    autoStep();
  } catch (e) {
    if (isNetwork(e)) set({ offline: true, loaded: true });
    else set({ loaded: true });
  }
}

export const timerActions = {
  async start(cfg: Record<string, unknown>): Promise<TimerView> {
    unlockAudio();
    const r = await knowledgeApi.startTimer(cfg);
    adopt(r.timer, r.serverNow);
    invalidateLife();
    return r.timer;
  },
  pause: () => send('pause'),
  resume: () => {
    unlockAudio();
    return send('resume');
  },
  skipBreak: () => send('resume'),
  async finish(f: Record<string, unknown>) {
    const t = state.timer;
    if (!t) throw new Error('sem cronômetro');
    await flush();
    if (pending) throw new ApiClientError('network', 0, 'Sem conexão. A sessão continua guardada neste aparelho; tente encerrar de novo quando a conexão voltar.');
    const at = t.phase === 'focus' ? isoNow() : isoNow(t.phaseStartedAt);
    const r = await knowledgeApi.finishTimer(t.id, { at, ...f });
    pending = null;
    set({ timer: null, waiting: null, pendingCount: 0 });
    return r;
  },
  async discard() {
    const t = state.timer;
    if (!t) return;
    try {
      await knowledgeApi.discardTimer(t.id);
    } catch (e) {
      if (!(e instanceof ApiClientError && e.code === 'knowledge_timer_missing')) throw e;
    }
    pending = null;
    set({ timer: null, waiting: null, pendingCount: 0 });
  },
};

/** Tempo que conta AGORA (prévia; quem decide é o servidor ao encerrar). A tela aberta conta como presença. */
export function liveActive(t: TimerView, now: number, visible = true): ActiveBreakdown {
  const seen = visible && t.phase === 'focus' ? addSeen(t.seen, now) : t.seen;
  return computeActive(t.segments, seen, now, {
    unattendedMaxMs: Math.max(TIMER_RULES.unattendedMaxSec * 1000, t.mode === 'pomodoro' && t.pomodoro ? t.pomodoro.focusMin * 60_000 : t.mode === 'countdown' && t.plannedSec ? t.plannedSec * 1000 : 0),
    segmentMaxMs: t.mode === 'pomodoro' && t.pomodoro ? t.pomodoro.focusMin * 60_000 : null,
    totalMaxMs: t.mode === 'countdown' && t.plannedSec ? t.plannedSec * 1000 : null,
  });
}

/** Estado do cronômetro + motor (sinais, transições). Vários componentes podem usar ao mesmo tempo. */
export function useKnowledgeTimer(): TimerState {
  useEffect(() => {
    startEngine();
    return stopEngine;
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}

/** Relógio que atualiza a cada segundo (só enquanto montado). */
export function useNow(active = true): number {
  return useSyncExternalStore(
    (l) => {
      if (!active) return () => undefined;
      const i = setInterval(l, 1000);
      return () => clearInterval(i);
    },
    () => Math.floor(serverNow() / 1000) * 1000,
  );
}

export const fmtClock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};
