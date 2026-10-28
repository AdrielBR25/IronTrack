import { useSyncExternalStore } from 'react';
import {
  canIncludeAway,
  checkpointSetTimer,
  includeAwayTime,
  markSetTimerApplied,
  parseSetTimerState,
  pauseSetTimer,
  reconcileClock,
  recoverSetTimer,
  resumeSetTimer,
  startSetTimer,
  stopSetTimer,
  timerBelongsTo,
  type SetTimerState,
  type SetTimerTarget,
} from '@/modules/training';

// Estado do cronômetro de execução compartilhado entre telas e abas (P11, docs/CRONOMETROS_E_CONCORRENCIA.md).
// - Um único cronômetro por vez, preso a uma série (sessão + exercício + série).
// - Guardado em localStorage (`irontrack.setTimer.v1`): sobrevive a navegação e recarga, é visto pelas outras abas
//   (evento `storage`) e não entra no IndexedDB nem em backups. É estado transitório: perdê-lo nunca altera a série.
// - BroadcastChannel só responde "há uma página viva com este cronômetro?" ao recarregar (ver `recover`).
// - Toda ação relê o armazenamento antes de agir, para nunca partir de um estado que outra aba já mudou.

export const SET_TIMER_KEY = 'irontrack.setTimer.v1';
const CHANNEL = 'irontrack-set-timer';

interface ChannelLike {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close?(): void;
}

export interface SetTimerDeps {
  storage: () => Storage | null;
  channel: () => ChannelLike | null;
  now: () => number;
  mono: () => number;
}

export interface SetTimerSnapshot {
  state: SetTimerState | null;
  /** false: o armazenamento local falhou; o cronômetro funciona, mas não será recuperado após recarregar. */
  persistent: boolean;
}

export type StartResult = { ok: true } | { ok: false; current: SetTimerState };

const defaultDeps: SetTimerDeps = {
  storage: () => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  },
  channel: () => {
    try {
      return typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(CHANNEL) as unknown as ChannelLike);
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  mono: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

export class SetTimerStore {
  private snap: SetTimerSnapshot = { state: null, persistent: true };
  private listeners = new Set<() => void>();
  private chan: ChannelLike | null;
  private pongs = 0;
  private recovered = false;
  private lastWall: number;
  private lastMono: number;
  private hiddenSinceLastTick = false;

  constructor(private deps: SetTimerDeps = defaultDeps) {
    this.snap = { state: this.read(), persistent: true };
    this.lastWall = deps.now();
    this.lastMono = deps.mono();
    this.chan = deps.channel();
    if (this.chan) this.chan.onmessage = (ev) => this.onMessage(ev.data);
  }

  get = (): SetTimerSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private read(): SetTimerState | null {
    try {
      const raw = this.deps.storage()?.getItem(SET_TIMER_KEY);
      return raw ? parseSetTimerState(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private set(state: SetTimerState | null, persistent = this.snap.persistent) {
    if (JSON.stringify(state) === JSON.stringify(this.snap.state) && persistent === this.snap.persistent) return;
    this.snap = { state, persistent };
    for (const l of this.listeners) l();
  }

  /** Estado mais recente: o gravado (outra aba pode ter mudado) ou, sem armazenamento, o da memória. */
  private fresh(): SetTimerState | null {
    if (!this.snap.persistent) return this.snap.state;
    const s = this.deps.storage();
    if (!s) return this.snap.state;
    const stored = this.read();
    if (JSON.stringify(stored) !== JSON.stringify(this.snap.state)) this.set(stored);
    return stored;
  }

  private commit(next: SetTimerState | null) {
    let persistent = true;
    try {
      const s = this.deps.storage();
      if (!s) persistent = false;
      else if (next) s.setItem(SET_TIMER_KEY, JSON.stringify(next));
      else s.removeItem(SET_TIMER_KEY);
    } catch {
      persistent = false;
    }
    this.set(next, persistent);
    try {
      this.chan?.postMessage({ type: 'changed' });
    } catch {
      /* canal fechado */
    }
  }

  /** Encerra o canal (página fechando; usado nos testes para simular uma aba que deixou de existir). */
  close() {
    this.chan?.close?.();
    this.chan = null;
  }

  /** Relê o armazenamento (evento `storage` de outra aba ou mensagem do canal). */
  sync = () => {
    if (this.snap.persistent) this.set(this.read());
  };

  private onMessage(data: unknown) {
    const t = (data as { type?: string } | null)?.type;
    if (t === 'ping') {
      if (this.snap.state?.status === 'running') this.chan?.postMessage({ type: 'pong' });
    } else if (t === 'pong') this.pongs++;
    else if (t === 'changed') this.sync();
  }

  /** Inicia o cronômetro da série. Se já existe um cronômetro de OUTRA série, não faz nada e o devolve. */
  start(target: SetTimerTarget): StartResult {
    const cur = this.fresh();
    if (cur && !timerBelongsTo(cur, target)) return { ok: false, current: cur };
    if (cur) return { ok: true };
    this.commit(startSetTimer(target, this.deps.now()));
    return { ok: true };
  }

  private act(target: SetTimerTarget, fn: (s: SetTimerState) => SetTimerState) {
    const cur = this.fresh();
    if (!cur || !timerBelongsTo(cur, target)) return null;
    const next = fn(cur);
    if (next !== cur) this.commit(next);
    return next;
  }

  pause = (t: SetTimerTarget) => this.act(t, (s) => pauseSetTimer(s, this.deps.now()));
  resume = (t: SetTimerTarget) => this.act(t, (s) => resumeSetTimer(s, this.deps.now()));
  stop = (t: SetTimerTarget) => this.act(t, (s) => stopSetTimer(s, this.deps.now()));
  includeAway = (t: SetTimerTarget) => this.act(t, (s) => (canIncludeAway(s) ? includeAwayTime(s) : s));
  markApplied = (t: SetTimerTarget, sec: number) => this.act(t, (s) => markSetTimerApplied(s, sec));

  /** Zera (reinício confirmado) ou descarta o cronômetro desta série. A série não é alterada. */
  reset(target: SetTimerTarget) {
    const cur = this.fresh();
    if (cur && timerBelongsTo(cur, target)) this.commit(null);
  }

  /** Descarta o cronômetro se ele pertencer a uma série que não está mais pendente (ou a outro treino). */
  discardWhere(pred: (s: SetTimerState) => boolean) {
    const cur = this.fresh();
    if (cur && pred(cur)) this.commit(null);
  }

  /**
   * Batida periódica de uma página aberta: corrige mudanças do relógio do sistema e confirma a contagem
   * (`checkpointAt`, base da recuperação). Só grava quando algo muda.
   */
  tick(hidden: boolean) {
    const wall = this.deps.now();
    const mono = this.deps.mono();
    const obs = { wallPrev: this.lastWall, wallNow: wall, monoPrev: this.lastMono, monoNow: mono, hidden: hidden || this.hiddenSinceLastTick };
    this.lastWall = wall;
    this.lastMono = mono;
    this.hiddenSinceLastTick = hidden;
    const cur = this.fresh();
    if (!cur || cur.status !== 'running') return;
    let next = reconcileClock(cur, obs);
    if (!hidden) next = checkpointSetTimer(next, wall);
    if (next !== cur) this.commit(next);
  }

  /** A página vai para segundo plano ou fecha: registra a última confirmação. */
  markHidden() {
    this.hiddenSinceLastTick = true;
    const cur = this.fresh();
    if (cur?.status === 'running') {
      const next = checkpointSetTimer(cur, this.deps.now());
      if (next !== cur) this.commit(next);
    }
  }

  /**
   * Uma vez por carregamento da página. Se o cronômetro gravado está rodando, pergunta às outras abas se alguma
   * página viva o mantém. Sem resposta, a página anterior foi recarregada ou fechada: o cronômetro volta PAUSADO
   * com o tempo confirmado (política em docs/CRONOMETROS_E_CONCORRENCIA.md §3).
   */
  async recover(waitMs = 400): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    const cur = this.fresh();
    if (cur?.status !== 'running') return;
    this.pongs = 0;
    if (this.chan) {
      try {
        this.chan.postMessage({ type: 'ping' });
      } catch {
        /* sem canal: trata como sem resposta */
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (this.pongs > 0) return;
    const latest = this.fresh();
    if (latest?.status === 'running') this.commit(recoverSetTimer(latest, this.deps.now()));
  }
}

export const setTimerStore = new SetTimerStore();

export function useSetTimer(store: SetTimerStore = setTimerStore): SetTimerSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
