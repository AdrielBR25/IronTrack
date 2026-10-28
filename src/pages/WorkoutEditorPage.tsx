import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Copy, Eye, Library, MoreHorizontal, Pencil, Plus, Replace, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { mutateWorkout } from '@/db/library';
import { useActiveSession, useRoutine } from '@/hooks/data';
import { useUnits } from '@/hooks/useUnits';
import type { ExerciseTemplate } from '@/lib/types';
import { cn, fmtClock, uid } from '@/lib/utils';
import { MODALITY_LABEL } from '@/modules/training';
import { originLabel, type WorkoutOp } from '@/modules/exercises';
import { planSummary } from '@/features/workout/modelFormat';
import { ExerciseDialog } from '@/features/routines/ExerciseDialog';
import { WorkoutPreviewDialog } from '@/features/library/WorkoutPreviewDialog';
import { useStartWorkout } from '@/features/routines/useStartWorkout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm';
import { SortableList } from '@/components/SortableList';
import { Badge } from '@/components/ui/badge';
import { useModelCapability } from '@/features/compat/CompatGuard';

export default function WorkoutEditorPage() {
  const { routineId, workoutId } = useParams();
  const navigate = useNavigate();
  const routine = useRoutine(routineId);
  const workout = routine?.workouts.find((w) => w.id === workoutId);
  const active = useActiveSession();
  const start = useStartWorkout();
  const [editing, setEditing] = useState<{ open: boolean; ex: ExerciseTemplate | null }>({ open: false, ex: null });
  const [toDelete, setToDelete] = useState<ExerciseTemplate | null>(null);
  const [actionsFor, setActionsFor] = useState<ExerciseTemplate | null>(null);
  const [preview, setPreview] = useState(false);
  const [meta, setMeta] = useState({ label: '', name: '', notes: '' });
  const { fmtW } = useUnits();
  const outdated = useModelCapability().newer;

  useEffect(() => {
    if (workout) setMeta({ label: workout.label, name: workout.name, notes: workout.notes ?? '' });
  }, [workout?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (routine === undefined) return null;
  if (!routine || !workout) {
    return (
      <div className="space-y-3">
        <p>Treino não encontrado (talvez tenha sido excluído em outra aba).</p>
        <Button onClick={() => navigate('/treinos')}>Voltar</Button>
      </div>
    );
  }

  /**
   * P17: cada ação é uma operação aplicada à versão gravada (src/db/library.ts › mutateWorkout), nunca a ficha inteira
   * que esta tela tinha: o que outra aba fez no mesmo treino não se perde. Devolve false se nada foi gravado.
   */
  const apply = async (op: WorkoutOp, ok?: string): Promise<boolean> => {
    // P11: um app desatualizado não regrava fichas que uma versão mais nova já usou (docs/CRONOMETROS_E_CONCORRENCIA.md §7).
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return false;
    }
    try {
      const r = await mutateWorkout(routine.id, workout.id, op);
      if (ok && r.changed) toast.success(ok);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
  const saveMeta = () => void apply({ type: 'meta', label: meta.label, name: meta.name, notes: meta.notes });
  const libraryLink = (extra = '') => `/exercicios?para=${encodeURIComponent(`${routine.id}/${workout.id}`)}${extra}`;
  const sessionHere = active && active.routineId === routine.id && active.workoutId === workout.id;
  const n = workout.exercises.length;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Voltar" onClick={() => navigate('/treinos')}>
          <ArrowLeft />
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{routine.name}</p>
        <Button variant="outline" size="sm" onClick={() => setPreview(true)} data-testid="open-preview">
          <Eye /> Prévia
        </Button>
      </div>

      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-[5rem_1fr] gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="w-label">Rótulo</Label>
            <Input id="w-label" className="text-center font-display text-xl font-bold uppercase" maxLength={4} value={meta.label} onChange={(e) => setMeta({ ...meta, label: e.target.value })} onBlur={saveMeta} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w-name">Nome do treino</Label>
            <Input id="w-name" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} onBlur={saveMeta} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="w-notes">Observações</Label>
          <Textarea id="w-notes" className="min-h-[60px]" value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} onBlur={saveMeta} placeholder="Opcional" />
        </div>
      </Card>

      {sessionHere && (
        <p className="rounded-2xl border border-primary/40 bg-primary/10 p-3 text-sm" role="status">
          Há um treino em andamento desta ficha. Ele usa a cópia feita ao iniciar: as mudanças daqui valem a partir do próximo treino.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {n} {n === 1 ? 'exercício' : 'exercícios'} · use as setas ou arraste <span aria-hidden>⋮⋮</span> para reordenar
        </h2>
        <SortableList
          items={workout.exercises}
          onReorder={(exs) => void apply({ type: 'reorder', order: exs.map((e) => e.id) })}
          render={(ex, handle, i) => {
            const origin = originLabel(ex);
            return (
              <Card className="flex items-center gap-1 p-2 pr-1" data-testid="editor-exercise">
                {handle}
                <button className="min-w-0 flex-1 text-left" onClick={() => setEditing({ open: true, ex })} aria-label={`Editar ${ex.name}: ${planSummary(ex)}`}>
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground tabular">{i + 1}</span>
                    <span className="truncate font-semibold">{ex.name}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge variant="secondary">{ex.muscleGroup}</Badge>
                    <span className="tabular font-semibold text-foreground">{planSummary(ex)}</span>
                    {ex.modality && <Badge variant="outline">{MODALITY_LABEL[ex.modality]}</Badge>}
                    {ex.laterality === 'unilateral' && <Badge variant="outline">unilateral</Badge>}
                    {ex.restSec > 0 && <span className="tabular">{fmtClock(ex.restSec)}</span>}
                    {ex.warmupSets > 0 && <span>+{ex.warmupSets} aquec.</span>}
                    {ex.targetWeight != null && <span className="tabular">{fmtW(ex.targetWeight)}</span>}
                    {ex.modality !== 'cardio' && ex.modality !== 'timed' && (
                      <span className={cn(ex.category === 'compound' ? 'text-primary' : '')}>{ex.category === 'compound' ? 'composto' : 'isolador'}</span>
                    )}
                    {origin && <span className="italic">{origin}</span>}
                  </span>
                </button>
                <Button size="icon-sm" variant="ghost" aria-label={`Mover ${ex.name} para cima`} disabled={i === 0} onClick={() => void apply({ type: 'move', id: ex.id, delta: -1 })}>
                  <ArrowUp />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Mover ${ex.name} para baixo`} disabled={i === n - 1} onClick={() => void apply({ type: 'move', id: ex.id, delta: 1 })}>
                  <ArrowDown />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Mais ações para ${ex.name}`} onClick={() => setActionsFor(ex)} data-testid="exercise-actions">
                  <MoreHorizontal />
                </Button>
              </Card>
            );
          }}
        />
        <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
          <Button size="lg" className="w-full" onClick={() => navigate(libraryLink())} data-testid="add-from-library">
            <Library /> Adicionar da biblioteca
          </Button>
          <Button size="lg" variant="outline" className="w-full border-dashed" onClick={() => setEditing({ open: true, ex: null })} data-testid="add-exercise">
            <Plus /> Criar manualmente
          </Button>
        </div>
      </section>

      <Dialog open={!!actionsFor} onOpenChange={(o) => !o && setActionsFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="break-words">{actionsFor?.name}</DialogTitle>
          </DialogHeader>
          {actionsFor && (
            <div className="grid gap-2" data-testid="exercise-actions-menu">
              <Button variant="secondary" size="lg" className="justify-start" onClick={() => (setEditing({ open: true, ex: actionsFor }), setActionsFor(null))}>
                <Pencil /> Editar configuração
              </Button>
              <Button
                variant="secondary"
                size="lg"
                className="justify-start"
                onClick={() => {
                  const ex = actionsFor;
                  setActionsFor(null);
                  void apply({ type: 'duplicate', id: ex.id, newId: uid() }, 'Exercício duplicado');
                }}
              >
                <Copy /> Duplicar
              </Button>
              <Button variant="secondary" size="lg" className="justify-start" onClick={() => navigate(libraryLink(`&substituir=${encodeURIComponent(actionsFor.id)}`))}>
                <Replace /> Substituir por outro da biblioteca
              </Button>
              <Button variant="ghost" size="lg" className="justify-start text-destructive" onClick={() => (setToDelete(actionsFor), setActionsFor(null))}>
                <Trash2 /> Remover da ficha
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ExerciseDialog
        open={editing.open}
        onOpenChange={(o) => setEditing((s) => ({ ...s, open: o }))}
        initial={editing.ex}
        onSave={(ex) => {
          const exists = workout.exercises.some((e) => e.id === ex.id);
          void apply(exists ? { type: 'update', exercise: ex } : { type: 'add', exercise: ex }, exists ? 'Exercício atualizado' : 'Exercício adicionado');
        }}
      />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        destructive
        title={`Remover ${toDelete?.name}?`}
        description="O histórico desse exercício em treinos anteriores é mantido. Metas ligadas a ele continuam existindo e usando o histórico registrado."
        confirmLabel="Remover"
        onConfirm={() => {
          if (toDelete) void apply({ type: 'remove', id: toDelete.id });
        }}
      />
      <WorkoutPreviewDialog
        open={preview}
        onOpenChange={setPreview}
        workout={workout}
        routineName={routine.name}
        startDisabledReason={active ? 'Já há um treino em andamento: conclua ou descarte antes de iniciar outro.' : null}
        onStart={() => {
          setPreview(false);
          void start(routine.id, workout.id);
        }}
      />
    </div>
  );
}
