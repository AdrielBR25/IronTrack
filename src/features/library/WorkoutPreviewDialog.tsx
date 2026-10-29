import { Play } from 'lucide-react';
import type { Workout } from '@/lib/types';
import { fmtClock } from '@/lib/utils';
import { MODALITY_LABEL } from '@/modules/training';
import { planSummary } from '@/features/workout/modelFormat';
import { useUnits } from '@/hooks/useUnits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Prévia da ficha (P17): o que está PLANEJADO, em ordem, antes de salvar ou iniciar. Não mostra nada executado:
 * séries, cargas e tempos realizados ficam no treino e no histórico.
 */
export function WorkoutPreviewDialog({
  open,
  onOpenChange,
  workout,
  routineName,
  onStart,
  startDisabledReason,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workout: Workout;
  routineName?: string;
  onStart?: () => void;
  /** Motivo para não oferecer o início (ex.: já há um treino em andamento). */
  startDisabledReason?: string | null;
}) {
  const { fmtW } = useUnits();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="workout-preview">
        <DialogHeader>
          <DialogTitle>
            Treino {workout.label} · {workout.name}
          </DialogTitle>
          <DialogDescription>
            {routineName ? `${routineName} · ` : ''}
            {workout.exercises.length} {workout.exercises.length === 1 ? 'exercício' : 'exercícios'}. Parâmetros planejados: o que você executar fica registrado no treino.
          </DialogDescription>
        </DialogHeader>
        {workout.notes && <p className="rounded-xl bg-secondary/60 p-3 text-sm">{workout.notes}</p>}
        {workout.exercises.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum exercício nesta ficha ainda.</p>
        ) : (
          <ol className="space-y-2" aria-label="Exercícios planejados">
            {workout.exercises.map((ex, i) => (
              <li key={ex.id} className="rounded-2xl border p-3" data-testid="preview-exercise">
                <p className="flex items-start gap-2 font-semibold">
                  <span className="tabular text-muted-foreground">{i + 1}.</span>
                  <span className="min-w-0 break-words">{ex.name}</span>
                </p>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-muted-foreground">Modalidade</dt>
                  <dd>{ex.modality ? MODALITY_LABEL[ex.modality] : 'Não definida (carga × repetições)'}</dd>
                  <dt className="text-muted-foreground">Planejado</dt>
                  <dd className="tabular font-medium">{planSummary(ex)}</dd>
                  {ex.restSec > 0 && (
                    <>
                      <dt className="text-muted-foreground">Descanso</dt>
                      <dd className="tabular">{fmtClock(ex.restSec)}</dd>
                    </>
                  )}
                  {ex.warmupSets > 0 && ex.modality !== 'cardio' && ex.modality !== 'timed' && (
                    <>
                      <dt className="text-muted-foreground">Aquecimento</dt>
                      <dd>{ex.warmupSets} série(s)</dd>
                    </>
                  )}
                  {ex.targetWeight != null && ex.modality !== 'cardio' && (
                    <>
                      <dt className="text-muted-foreground">Carga planejada</dt>
                      <dd className="tabular">{fmtW(ex.targetWeight)}</dd>
                    </>
                  )}
                  {ex.notes && (
                    <>
                      <dt className="text-muted-foreground">Observações</dt>
                      <dd className="break-words">{ex.notes}</dd>
                    </>
                  )}
                </dl>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Badge variant="secondary">{ex.muscleGroup}</Badge>
                  {ex.laterality === 'unilateral' && <Badge variant="outline">unilateral · lado registrado por série</Badge>}
                </div>
              </li>
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
          {onStart && (
            <Button size="lg" disabled={!!startDisabledReason || workout.exercises.length === 0} onClick={onStart} data-testid="preview-start">
              <Play /> Iniciar treino
            </Button>
          )}
        </DialogFooter>
        {startDisabledReason && <p className="text-xs text-muted-foreground">{startDisabledReason}</p>}
      </DialogContent>
    </Dialog>
  );
}
