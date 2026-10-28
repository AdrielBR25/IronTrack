// Cronômetro de execução da série (P11): regras puras (iniciar, pausar, continuar, encerrar, reiniciar, segundo
// plano, relógio alterado, recuperação) e o estado compartilhado entre telas e abas (setTimerStore), com relógio,
// armazenamento e canal simulados. Independência do descanso. Dados fictícios.
import { describe, expect, it } from 'vitest';
import {
  SET_TIMER_LIMITS,
  adjustRest,
  canIncludeAway,
  fmtStopwatch,
  includeAwayTime,
  isRecordableMeasure,
  measuredSeconds,
  parseSetTimerState,
  pauseRest,
  pauseSetTimer,
  reconcileClock,
  recoverSetTimer,
  remainingMs,
  resumeSetTimer,
  setTimerElapsedMs,
  startRest,
  startSetTimer,
  stopSetTimer,
} from '@/modules/training';
import { SET_TIMER_KEY, SetTimerStore, type SetTimerDeps } from '@/features/workout/setTimerStore';

const T0 = 1_800_000_000_000;
const A = { sessionId: 's1', exerciseId: 'prancha', setId: 'set-1' };
const B = { sessionId: 's1', exerciseId: 'prancha', setId: 'set-2' };
const C = { sessionId: 's1', exerciseId: 'corrida', setId: 'set-9' };

describe('cronômetro: regras puras', () => {
  it('iniciar, pausar, continuar e encerrar medem só o tempo ativo, pelo relógio (não por chamadas de intervalo)', () => {
    let s = startSetTimer(A, T0);
    expect(setTimerElapsedMs(s, T0 + 12_400)).toBe(12_400);
    s = pauseSetTimer(s, T0 + 20_000);
    expect(s.status).toBe('paused');
    // Pausado: o tempo não anda, por mais que o relógio avance.
    expect(setTimerElapsedMs(s, T0 + 90_000)).toBe(20_000);
    s = resumeSetTimer(s, T0 + 90_000);
    expect(setTimerElapsedMs(s, T0 + 95_500)).toBe(25_500);
    s = stopSetTimer(s, T0 + 100_000);
    expect(s).toMatchObject({ status: 'stopped', accumulatedMs: 30_000, segmentStartedAt: null });
    expect(setTimerElapsedMs(s, T0 + 999_999)).toBe(30_000);
    // Ações fora de ordem não mudam nada.
    expect(pauseSetTimer(s, T0 + 1)).toBe(s);
    expect(resumeSetTimer(s, T0 + 1)).toBe(s);
    expect(stopSetTimer(s, T0 + 1)).toBe(s);
  });

  it('exibição 00:00 / 01:23:45 e gravação arredondada para baixo (o que aparece é o que é gravado)', () => {
    expect(fmtStopwatch(0)).toBe('00:00');
    expect(fmtStopwatch(59_999)).toBe('00:59');
    expect(fmtStopwatch(12 * 60_000 + 5_000)).toBe('12:05');
    expect(fmtStopwatch((3600 + 23 * 60 + 45) * 1000 + 900)).toBe('01:23:45');
    expect(measuredSeconds(52_900)).toBe(52);
    expect(isRecordableMeasure(999)).toBe(false);
    expect(isRecordableMeasure(1000)).toBe(true);
    expect(isRecordableMeasure(SET_TIMER_LIMITS.maxMs)).toBe(true);
    expect(isRecordableMeasure(SET_TIMER_LIMITS.maxMs + 1000)).toBe(false);
    expect(setTimerElapsedMs(startSetTimer(A, T0), T0 + 2 * SET_TIMER_LIMITS.maxMs)).toBe(SET_TIMER_LIMITS.maxMs);
  });

  it('aba em segundo plano / tela bloqueada: o tempo real continua contando (relógio de parede)', () => {
    const s = startSetTimer(A, T0);
    // Página oculta por 5 min: nenhum redesenho aconteceu, mas a medida usa a referência gravada.
    const back = reconcileClock(s, { wallPrev: T0, wallNow: T0 + 300_000, monoPrev: 0, monoNow: 2_000, hidden: true });
    expect(back).toBe(s);
    expect(setTimerElapsedMs(back, T0 + 300_000)).toBe(300_000);
  });

  it('relógio do sistema alterado com a página visível: conta só o tempo monotônico', () => {
    const s = startSetTimer(A, T0);
    // Relógio voltou 1 h enquanto passaram 10 s de verdade.
    const back = reconcileClock(s, { wallPrev: T0 + 20_000, wallNow: T0 + 20_000 - 3_600_000 + 10_000, monoPrev: 20_000, monoNow: 30_000, hidden: false });
    expect(setTimerElapsedMs(back, T0 + 20_000 - 3_600_000 + 10_000)).toBe(30_000);
    // Relógio adiantou 1 h com a página visível: idem.
    const fwd = reconcileClock(s, { wallPrev: T0 + 20_000, wallNow: T0 + 3_630_000, monoPrev: 20_000, monoNow: 30_000, hidden: false });
    expect(setTimerElapsedMs(fwd, T0 + 3_630_000)).toBe(30_000);
    // Pequena diferença (ruído) não mexe.
    expect(reconcileClock(s, { wallPrev: T0, wallNow: T0 + 1_100, monoPrev: 0, monoNow: 1_000, hidden: false })).toBe(s);
    // Trecho com início "no futuro" nunca fica negativo.
    expect(setTimerElapsedMs(s, T0 - 50_000)).toBe(0);
  });

  it('recarregar/fechar: volta PAUSADO no último tempo confirmado; o tempo fora só entra se a pessoa pedir', () => {
    let s = startSetTimer(A, T0);
    s = { ...s, checkpointAt: T0 + 40_000 };
    const r = recoverSetTimer(s, T0 + 160_000);
    expect(r).toMatchObject({ status: 'paused', accumulatedMs: 40_000, awayMs: 120_000 });
    expect(setTimerElapsedMs(r, T0 + 999_000)).toBe(40_000);
    expect(canIncludeAway(r)).toBe(true);
    const inc = includeAwayTime(r);
    expect(inc).toMatchObject({ accumulatedMs: 160_000, awayMs: null });
    expect(canIncludeAway(inc)).toBe(false);
    // Fora por mais de 6 h: não oferece somar (só digitação manual).
    expect(canIncludeAway(recoverSetTimer(s, T0 + 40_000 + SET_TIMER_LIMITS.maxAwayMs + 1))).toBe(false);
    // Pausado ou encerrado não muda ao recuperar.
    const p = pauseSetTimer(startSetTimer(A, T0), T0 + 5_000);
    expect(recoverSetTimer(p, T0 + 99_000)).toBe(p);
  });

  it('estado gravado malformado é ignorado (nunca vira duração)', () => {
    expect(parseSetTimerState(null)).toBeNull();
    expect(parseSetTimerState({ v: 2 })).toBeNull();
    expect(parseSetTimerState({ ...startSetTimer(A, T0), accumulatedMs: -5 })).toBeNull();
    expect(parseSetTimerState({ ...startSetTimer(A, T0), status: 'paused' })).toBeNull(); // pausado com trecho aberto
    expect(parseSetTimerState({ ...startSetTimer(A, T0), setId: '' })).toBeNull();
    expect(parseSetTimerState(JSON.parse(JSON.stringify(startSetTimer(A, T0))))).toEqual(startSetTimer(A, T0));
  });

  it('descanso e execução são independentes: nenhuma função de um altera o outro', () => {
    const rest = startRest(90, T0, { nextLabel: 'Prancha · série 2', exerciseId: 'prancha', setId: 'set-2' });
    const timer = startSetTimer(A, T0);
    const rest2 = adjustRest(pauseRest(rest, T0 + 10_000), 30, T0 + 10_000);
    const timer2 = pauseSetTimer(timer, T0 + 10_000);
    expect(remainingMs(rest2, T0 + 50_000)).toBe(110_000);
    expect(setTimerElapsedMs(timer2, T0 + 50_000)).toBe(10_000);
    expect(Object.keys(timer2)).not.toContain('endsAt');
    expect(Object.keys(rest2)).not.toContain('accumulatedMs');
  });
});

// ---------- Estado compartilhado (setTimerStore) ----------

class MemStorage {
  map = new Map<string, string>();
  fail = false;
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.fail) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string) {
    if (this.fail) throw new DOMException('quota', 'QuotaExceededError');
    this.map.delete(k);
  }
}

/** Canal entre "abas" do mesmo teste (cada store tem o seu ponto; a mensagem não volta para quem enviou). */
function bus() {
  const members = new Set<{ onmessage: ((e: { data: unknown }) => void) | null }>();
  return () => {
    const me = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(data: unknown) {
        for (const m of members) if (m !== me) queueMicrotask(() => m.onmessage?.({ data }));
      },
      close() {
        members.delete(me);
      },
    };
    members.add(me);
    return me;
  };
}

function env() {
  const clock = { wall: T0, mono: 0 };
  const storage = new MemStorage();
  const channel = bus();
  const deps = (): SetTimerDeps => ({ storage: () => storage as unknown as Storage, channel, now: () => clock.wall, mono: () => clock.mono });
  const advance = (ms: number) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  return { clock, storage, deps, advance, store: () => new SetTimerStore(deps()) };
}

describe('cronômetro: estado compartilhado (telas, recarga, abas)', () => {
  it('um cronômetro por vez: iniciar de novo na mesma série não cria outro; em outra série é recusado', () => {
    const e = env();
    const s = e.store();
    expect(s.start(A)).toEqual({ ok: true });
    e.advance(5_000);
    expect(s.start(A)).toEqual({ ok: true });
    expect(setTimerElapsedMs(s.get().state!, e.clock.wall)).toBe(5_000);
    const r = s.start(B);
    expect(r.ok).toBe(false);
    expect(s.get().state).toMatchObject({ setId: 'set-1' });
    // Ações dirigidas a outra série não afetam este cronômetro.
    expect(s.pause(C)).toBeNull();
    expect(s.get().state!.status).toBe('running');
  });

  it('reiniciar zera e permite iniciar de novo; o estado fica só no armazenamento local', () => {
    const e = env();
    const s = e.store();
    s.start(A);
    e.advance(8_000);
    s.stop(A);
    expect(JSON.parse(e.storage.getItem(SET_TIMER_KEY)!)).toMatchObject({ status: 'stopped', accumulatedMs: 8_000 });
    s.reset(A);
    expect(s.get().state).toBeNull();
    expect(e.storage.getItem(SET_TIMER_KEY)).toBeNull();
    expect(s.start(B)).toEqual({ ok: true });
  });

  it('navegação interna: o estado não depende do componente (nova leitura continua a mesma contagem)', () => {
    const e = env();
    const s = e.store();
    s.start(A);
    e.advance(30_000);
    // Mesmo armazenamento lido de novo (tela desmontada e montada): continua rodando, sem recomeçar.
    const again = e.store();
    expect(again.get().state!.status).toBe('running');
    expect(setTimerElapsedMs(again.get().state!, e.clock.wall)).toBe(30_000);
  });

  it('recarregar sem outra aba viva: volta pausado no tempo confirmado; não conclui nem grava nada', async () => {
    const e = env();
    const s = e.store();
    s.start(A);
    e.advance(10_000);
    s.tick(false); // confirmação aos 10 s
    e.advance(500);
    s.markHidden(); // página fechando (pagehide)
    s.close();
    // Página antiga some; 2 min depois abre de novo.
    e.advance(120_000);
    const reloaded = e.store();
    await reloaded.recover(5);
    const st = reloaded.get().state!;
    expect(st.status).toBe('paused');
    expect(st.accumulatedMs).toBe(10_500);
    expect(st.awayMs).toBe(120_000);
    // Recuperar duas vezes não muda nada.
    await reloaded.recover(5);
    expect(reloaded.get().state).toEqual(st);
  });

  it('duas abas: a segunda vê o mesmo cronômetro rodando (a primeira responde ao chamado) e as ações valem para as duas', async () => {
    const e = env();
    const tab1 = e.store();
    tab1.start(A);
    e.advance(4_000);
    const tab2 = e.store();
    await tab2.recover(20);
    expect(tab2.get().state!.status).toBe('running');
    // Pausa na aba 2; a aba 1 relê o armazenamento antes de agir e não "despausa" por estar desatualizada.
    tab2.pause(A);
    await Promise.resolve();
    tab1.sync();
    expect(tab1.get().state!.status).toBe('paused');
    expect(tab1.pause(A)!.status).toBe('paused');
    // A aba 1 tenta iniciar outra série: recusado, porque a aba 2 tem o cronômetro de A.
    expect(tab1.start(B).ok).toBe(false);
    // Encerrar em uma aba encerra para as duas.
    tab1.resume(A);
    e.advance(1_000);
    tab2.stop(A);
    tab1.sync();
    expect(tab1.get().state).toMatchObject({ status: 'stopped', accumulatedMs: 5_000 });
  });

  it('relógio do sistema alterado com a página visível: a batida periódica corrige', () => {
    const e = env();
    const s = e.store();
    s.start(A);
    e.advance(10_000);
    s.tick(false);
    // Relógio volta 1 h; 1 s real.
    e.clock.wall -= 3_600_000;
    e.advance(1_000);
    s.tick(false);
    expect(setTimerElapsedMs(s.get().state!, e.clock.wall)).toBe(11_000);
  });

  it('falha de persistência: continua funcionando em memória e avisa; nada lança erro', () => {
    const e = env();
    e.storage.fail = true;
    const s = e.store();
    expect(() => s.start(A)).not.toThrow();
    expect(s.get()).toMatchObject({ persistent: false, state: { status: 'running' } });
    e.advance(3_000);
    s.pause(A);
    expect(s.get().state!.accumulatedMs).toBe(3_000);
    s.reset(A);
    expect(s.get().state).toBeNull();
  });

  it('descarta o cronômetro de uma série que deixou de estar pendente', () => {
    const e = env();
    const s = e.store();
    s.start(A);
    s.discardWhere((t) => t.setId === 'outra');
    expect(s.get().state).not.toBeNull();
    s.discardWhere((t) => t.setId === 'set-1');
    expect(s.get().state).toBeNull();
  });
});
