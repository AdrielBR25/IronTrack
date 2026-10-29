import { ArrowDown, Repeat } from 'lucide-react';
import type { SwapPreview } from '@/modules/training';
import { useUnits } from '@/hooks/useUnits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Prévia da troca de exercício no treino em andamento (P20, docs/BIBLIOTECA_VISUAL.md §substituição): atual → novo,
 * séries feitas (que ficam no atual), cargas registradas, cronômetros em curso e o que não é compatível. Nada é gravado
 * antes de confirmar.
 */
export function SwapPreviewDialog({
  preview,
  setTimerOnThis,
  onCancel,
  onConfirm,
}: {
  preview: SwapPreview | null;
  /** O cronômetro de execução em curso pertence a uma série pendente do exercício atual. */
  setTimerOnThis: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { fmtW } = useUnits();
  const p = preview;
  return (
    <Dialog open={!!p} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent data-testid="swap-preview">
        {p && (
          <>
            <DialogHeader>
              <DialogTitle>Trocar exercício</DialogTitle>
              <DialogDescription>Só neste treino. A ficha não muda.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1 rounded-2xl bg-secondary/60 p-3 text-sm">
              <p className="break-words">
                <span className="text-muted-foreground">Atual:</span> <strong>{p.current.name}</strong>
              </p>
              <ArrowDown className="h-4 w-4 text-muted-foreground" aria-hidden />
              <p className="break-words">
                <span className="text-muted-foreground">Novo:</span> <strong>{p.next.name}</strong> · {p.nextSets} série(s)
              </p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="swap-facts">
              <dt className="text-muted-foreground">Séries feitas</dt>
              <dd data-testid="swap-done">
                {p.doneWork} de {p.plannedWork}
                {p.doneWarmup ? ` (+${p.doneWarmup} aquecimento)` : ''}
              </dd>
              {p.doneLoads.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Cargas registradas</dt>
                  <dd>{p.doneLoads.map((w) => (w == null ? '—' : fmtW(w))).join(' · ')} (ficam no atual)</dd>
                </>
              )}
              <dt className="text-muted-foreground">Pendentes</dt>
              <dd>{p.pendingWork}</dd>
              {(p.restOnThis || setTimerOnThis) && (
                <>
                  <dt className="text-muted-foreground">Cronômetros</dt>
                  <dd data-testid="swap-timers">
                    {[p.restOnThis && 'o descanso em curso continua e passa a apontar para o novo exercício', setTimerOnThis && 'o cronômetro da série pendente do atual é descartado'].filter(Boolean).join('; ')}.
                  </dd>
                </>
              )}
            </dl>
            {p.incompatibilities.length > 0 && (
              <div className="rounded-2xl border border-warn/50 p-3 text-sm" data-testid="swap-incompat">
                <p className="font-semibold text-warn">Registro diferente</p>
                <ul className="list-disc pl-5">
                  {p.incompatibilities.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">Nada é convertido: as séries já feitas continuam como foram registradas.</p>
              </div>
            )}
            <ul className="list-disc space-y-0.5 pl-5 text-sm" data-testid="swap-policy">
              {p.policy.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel}>
                Cancelar
              </Button>
              <Button onClick={onConfirm} data-testid="swap-confirm">
                <Repeat /> Confirmar troca
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
