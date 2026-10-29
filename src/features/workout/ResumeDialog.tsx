import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { conflictMessage, resumeCompletedSession } from '@/db/sessionEdits';
import { recordedDurationSec } from '@/modules/training';
import type { WorkoutSession } from '@/lib/types';
import { fmtClock } from '@/lib/utils';
import { fmtTime } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Confirmação de "Continuar treino" (P20, docs/RETOMADA_TREINOS.md): mostra o tempo acumulado e deixa claro que o
 * intervalo em que o treino ficou finalizado não conta. A gravação confere, na mesma transação, que o treino não mudou
 * e que não há outro treino em andamento (um cronômetro só, em todas as abas).
 */
export function ResumeDialog({
  base,
  draft = null,
  open,
  onOpenChange,
  onConflict,
}: {
  base: WorkoutSession;
  /** Correções feitas na edição antes de continuar (gravadas junto). */
  draft?: WorkoutSession | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConflict?: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const acc = recordedDurationSec(draft ?? base);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="resume-dialog">
        <DialogHeader>
          <DialogTitle>Continuar este treino?</DialogTitle>
          <DialogDescription>
            O treino volta a ficar em andamento e o cronômetro continua de <strong data-testid="resume-accumulated">{fmtClock(acc)}</strong>.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            O tempo em que ele ficou finalizado{base.finishedAt ? ` (desde ${fmtTime(base.finishedAt)})` : ''} não é contado.
          </li>
          <li>As séries já registradas continuam como estão; você pode acrescentar séries e exercícios.</li>
          <li>Ao concluir de novo, a rotação não avança outra vez.</li>
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={busy}
            data-testid="resume-confirm"
            onClick={async () => {
              setBusy(true);
              try {
                const r = await resumeCompletedSession(base, draft);
                if (r.status === 'resumed' || r.status === 'already-active') {
                  if (r.status === 'already-active') toast('Este treino já estava em andamento em outra aba.');
                  navigate('/treino');
                  return;
                }
                onOpenChange(false);
                if (r.status === 'other-active') toast.error(`Já há um treino em andamento (Treino ${r.other.workoutLabel}). Finalize ou descarte antes de continuar este.`);
                else if (r.status === 'invalid') toast.error(r.issues.map((i) => i.message).join(' '));
                else onConflict ? onConflict(conflictMessage(r.reason)) : toast.error(conflictMessage(r.reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Play /> Continuar treino
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
