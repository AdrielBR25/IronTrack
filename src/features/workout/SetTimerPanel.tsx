import { useState } from 'react';
import { History, Pause, Play, RotateCcw, Square, Timer } from 'lucide-react';
import { toast } from 'sonner';
import type { SessionSet } from '@/lib/types';
import {
  canIncludeAway,
  fmtDurationSec,
  fmtStopwatch,
  isRecordableMeasure,
  measuredSeconds,
  setTimerElapsedMs,
  timerBelongsTo,
  type SetTimerState,
  type SetTimerTarget,
} from '@/modules/training';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNow } from '@/hooks/data';
import { cn } from '@/lib/utils';
import { setTimerStore, useSetTimer, type SetTimerStore } from './setTimerStore';

// Cronômetro de execução da série (P11). Independente do descanso: estado próprio (setTimerStore), nunca lê nem
// altera `session.rest`. A duração medida só entra na série por ação da pessoa (Encerrar ou Usar) e nunca
// substitui em silêncio um valor diferente já presente.

/** O valor atual da série pode ser substituído pela medida sem perguntar? */
export function durationConflict(set: Pick<SessionSet, 'durationSec' | 'plannedDurationSec'>, measuredSec: number, timer: Pick<SetTimerState, 'appliedSec'> | null): boolean {
  const cur = set.durationSec;
  return cur != null && cur !== measuredSec && cur !== timer?.appliedSec && cur !== set.plannedDurationSec;
}

export function SetTimerPanel({
  target,
  set,
  onPatch,
  onGoTo,
  describe,
  store = setTimerStore,
}: {
  target: SetTimerTarget;
  set: SessionSet;
  onPatch: (p: Partial<SessionSet>) => void;
  /** Vai para a série do cronômetro ativo (quando ele é de outra série). */
  onGoTo?: (t: SetTimerTarget) => void;
  /** Nome curto da série de um cronômetro ("Prancha · Série 2"). */
  describe?: (t: SetTimerTarget) => string;
  store?: SetTimerStore;
}) {
  const { state, persistent } = useSetTimer(store);
  const mine = timerBelongsTo(state, target) ? state : null;
  const other = state && !mine ? state : null;
  const running = mine?.status === 'running';
  const now = useNow(250, running || other?.status === 'running');
  const [conflict, setConflict] = useState<number | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const elapsed = mine ? setTimerElapsedMs(mine, now) : 0;

  const apply = (sec: number, timer: SetTimerState) => {
    if (sec < 1) {
      toast.warning('Menos de 1 segundo: nada foi registrado na série.');
      return;
    }
    if (durationConflict(set, sec, timer)) {
      setConflict(sec);
      return;
    }
    onPatch({ durationSec: sec });
    store.markApplied(target, sec);
    toast.success(`Duração registrada: ${fmtDurationSec(sec)}`);
  };

  const end = () => {
    const st = store.stop(target);
    if (st) apply(measuredSeconds(st.accumulatedMs), st);
  };

  if (other) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-dashed px-3 py-2 text-sm" data-testid="set-timer-other">
        <Timer className="h-5 w-5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1">
          <span className="block font-semibold">Cronômetro em uso em outra série</span>
          <span className="block truncate text-xs text-muted-foreground tabular">
            {describe?.(other) ?? 'Outra série'} · {fmtStopwatch(setTimerElapsedMs(other, now))}
            {other.status === 'paused' ? ' · pausado' : other.status === 'stopped' ? ' · encerrado' : ''}
          </span>
        </p>
        {onGoTo && (
          <Button size="sm" variant="secondary" onClick={() => onGoTo(other)}>
            Ir para a série
          </Button>
        )}
      </div>
    );
  }

  const measuredSec = measuredSeconds(elapsed);
  const applied = mine?.status === 'stopped' && mine.appliedSec === measuredSec && set.durationSec === measuredSec;
  const statusText = !mine ? 'Cronômetro da série' : running ? 'Contando' : mine.status === 'paused' ? 'PAUSADO' : applied ? 'Registrado na série' : 'Encerrado';

  return (
    <section
      aria-label="Cronômetro de execução"
      data-testid="set-timer"
      data-status={mine?.status ?? 'idle'}
      className={cn('rounded-2xl border p-2.5', mine?.status === 'paused' ? 'border-warn bg-warn/10' : running ? 'border-primary/50 bg-primary/5' : 'bg-background/60')}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className={cn('text-[11px] font-semibold uppercase tracking-wider', mine?.status === 'paused' ? 'text-warn' : 'text-muted-foreground')} data-testid="set-timer-status">
            {statusText}
          </p>
          <p role="timer" aria-label={`Tempo medido ${fmtStopwatch(elapsed)}`} className="font-display text-4xl font-bold leading-none tabular" data-testid="set-timer-display">
            {fmtStopwatch(elapsed)}
          </p>
        </div>
        {mine && mine.status !== 'running' && (
          <Button variant="ghost" size="icon" aria-label="Reiniciar cronômetro" onClick={() => setResetOpen(true)} data-testid="set-timer-reset">
            <RotateCcw />
          </Button>
        )}
      </div>

      {mine?.status === 'paused' && canIncludeAway(mine) && (
        <div className="mt-2 rounded-xl bg-background/70 p-2 text-xs" data-testid="set-timer-recovered">
          <p>
            O app foi recarregado ou fechado com o cronômetro rodando. A contagem foi pausada no último tempo confirmado. Tempo fora do app:{' '}
            <strong className="tabular">{fmtStopwatch(mine.awayMs ?? 0)}</strong>.
          </p>
          <Button size="sm" variant="secondary" className="mt-1.5" onClick={() => store.includeAway(target)} data-testid="set-timer-include-away">
            <History /> Somar tempo fora
          </Button>
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        {!mine && (
          <Button
            size="lg"
            variant="secondary"
            className="col-span-2 h-14 text-base"
            data-testid="set-timer-start"
            onClick={() => {
              const r = store.start(target);
              if (!r.ok) toast.warning('Já existe um cronômetro em outra série. Encerre ou reinicie aquele antes.');
            }}
          >
            <Play /> Iniciar cronômetro
          </Button>
        )}
        {running && (
          <Button size="lg" variant="secondary" className="h-14 text-base" onClick={() => store.pause(target)} data-testid="set-timer-pause">
            <Pause /> Pausar
          </Button>
        )}
        {mine?.status === 'paused' && (
          <Button size="lg" className="h-14 text-base" onClick={() => store.resume(target)} data-testid="set-timer-resume">
            <Play /> Continuar
          </Button>
        )}
        {(running || mine?.status === 'paused') && (
          <Button size="lg" variant="outline" className="h-14 text-base" onClick={end} data-testid="set-timer-stop">
            <Square /> Encerrar
          </Button>
        )}
        {mine?.status === 'stopped' && !applied && isRecordableMeasure(elapsed) && (
          <Button size="lg" variant="secondary" className="col-span-2 h-12" onClick={() => apply(measuredSec, mine)} data-testid="set-timer-use">
            Usar {fmtStopwatch(elapsed)} na série
          </Button>
        )}
      </div>
      {!persistent && <p className="mt-1.5 text-[11px] text-warn">Armazenamento local indisponível: o cronômetro funciona, mas não será recuperado se a página recarregar.</p>}

      <Dialog open={conflict !== null} onOpenChange={(o) => !o && setConflict(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Substituir a duração da série?</DialogTitle>
            <DialogDescription>
              A série já tem <strong>{set.durationSec != null ? fmtDurationSec(set.durationSec) : '—'}</strong>. O cronômetro mediu{' '}
              <strong>{conflict != null ? fmtDurationSec(conflict) : ''}</strong>.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => setConflict(null)} data-testid="duration-keep">
              Manter {set.durationSec != null ? fmtDurationSec(set.durationSec) : ''}
            </Button>
            <Button
              data-testid="duration-use-measured"
              onClick={() => {
                if (conflict != null) {
                  onPatch({ durationSec: conflict });
                  store.markApplied(target, conflict);
                }
                setConflict(null);
              }}
            >
              Usar {conflict != null ? fmtDurationSec(conflict) : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reiniciar o cronômetro?"
        description={`A contagem (${fmtStopwatch(elapsed)}) volta a zero. A duração já registrada na série não muda.`}
        confirmLabel="Reiniciar"
        onConfirm={() => store.reset(target)}
      />
    </section>
  );
}

/** Cronômetro de outra série visível junto do descanso (os dois são independentes): pausar/continuar sem trocar de tela. */
export function SetTimerChip({ state, label, onGoTo, store = setTimerStore }: { state: SetTimerState; label: string; onGoTo?: () => void; store?: SetTimerStore }) {
  const now = useNow(250, state.status === 'running');
  const t: SetTimerTarget = { sessionId: state.sessionId, exerciseId: state.exerciseId, setId: state.setId };
  return (
    <div className={cn('flex items-center gap-3 rounded-2xl border bg-card px-3 py-2', state.status === 'paused' && 'border-warn')} data-testid="set-timer-chip" data-status={state.status}>
      <Timer className="h-5 w-5 shrink-0 text-primary" />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onGoTo} disabled={!onGoTo}>
        <span className="block font-display text-xl font-bold leading-tight tabular">{fmtStopwatch(setTimerElapsedMs(state, now))}</span>
        <span className="block truncate text-xs text-muted-foreground">
          Execução{state.status === 'paused' ? ' (PAUSADO)' : state.status === 'stopped' ? ' (encerrado)' : ''} · {label}
        </span>
      </button>
      {state.status === 'running' && (
        <Button size="sm" variant="secondary" onClick={() => store.pause(t)} aria-label="Pausar cronômetro de execução">
          <Pause /> Pausar
        </Button>
      )}
      {state.status === 'paused' && (
        <Button size="sm" onClick={() => store.resume(t)} aria-label="Continuar cronômetro de execução">
          <Play /> Continuar
        </Button>
      )}
    </div>
  );
}
