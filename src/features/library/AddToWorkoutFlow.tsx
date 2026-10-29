import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { mutateWorkout } from '@/db/library';
import { useCurrentProfile, useRoutines, useSettings } from '@/hooks/data';
import type { ExerciseTemplate, Routine } from '@/lib/types';
import { uid } from '@/lib/utils';
import { applyConfig, describeConfig, instanceFromItem, previousConfig, type LibraryItem } from '@/modules/exercises';
import { ExerciseDialog } from '@/features/routines/ExerciseDialog';
import { useModelCapability } from '@/features/compat/CompatGuard';
import { Button } from '@/components/ui/button';
import { Label, NativeSelect } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface WorkoutTarget {
  routineId: string;
  workoutId: string;
}

/**
 * Adicionar um item da biblioteca a uma ficha (P17): escolhe a ficha (se ainda não estiver definida) e abre o mesmo
 * formulário do editor, já preenchido. A instância nasce com ID próprio e a origem (`catalogId`/`customExerciseId`).
 * A configuração anterior do mesmo item é oferecida como PONTO DE PARTIDA (sem carga); só vale ao salvar.
 */
export function AddToWorkoutFlow({ item, target, onClose, onAdded }: { item: LibraryItem | null; target: WorkoutTarget | null; onClose: () => void; onAdded?: (t: WorkoutTarget, ex: ExerciseTemplate) => void }) {
  const routines = useRoutines();
  const settings = useSettings();
  const profile = useCurrentProfile();
  const outdated = useModelCapability().newer;
  const [picked, setPicked] = useState<WorkoutTarget | null>(null);
  const [choice, setChoice] = useState<{ routineId: string; workoutId: string }>({ routineId: '', workoutId: '' });
  const [instanceId, setInstanceId] = useState(() => uid());
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    if (!item) return;
    setPicked(target);
    setInstanceId(uid());
    setApplied(false);
    const r = routines?.find((x) => x.id === settings.activeRoutineId) ?? routines?.[0];
    setChoice({ routineId: r?.id ?? '', workoutId: r?.workouts[0]?.id ?? '' });
  }, [item?.key, target?.routineId, target?.workoutId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dest = picked;
  const destRoutine: Routine | undefined = dest ? routines?.find((r) => r.id === dest.routineId) : undefined;
  const destWorkout = destRoutine?.workouts.find((w) => w.id === dest?.workoutId);
  const suggestion = useMemo(() => (item && routines ? previousConfig(item.key, routines, item.modality, profile?.id) : null), [item, routines, profile?.id]);
  const base = useMemo(
    () => (item ? instanceFromItem(item, { id: instanceId, muscleGroups: settings.muscleGroups, rest: settings }) : null),
    [item, instanceId, settings],
  );
  const initial = base && applied && suggestion ? applyConfig(base, suggestion.config) : base;
  const choiceRoutine = routines?.find((r) => r.id === choice.routineId);

  const save = async (ex: ExerciseTemplate) => {
    if (!dest) return;
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return;
    }
    try {
      await mutateWorkout(dest.routineId, dest.workoutId, { type: 'add', exercise: ex });
      toast.success(`${ex.name} adicionado ao Treino ${destWorkout?.label ?? ''}`.trim());
      onAdded?.(dest, ex);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <Dialog open={!!item && !dest} onOpenChange={(o) => !o && onClose()}>
        <DialogContent data-testid="pick-workout">
          <DialogHeader>
            <DialogTitle>Adicionar a qual ficha?</DialogTitle>
            <DialogDescription>{item?.name}</DialogDescription>
          </DialogHeader>
          {routines && routines.length === 0 ? (
            <p className="text-sm text-muted-foreground">Crie uma rotina em Treinos antes de adicionar exercícios.</p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pick-routine">Rotina</Label>
                <NativeSelect
                  id="pick-routine"
                  value={choice.routineId}
                  onChange={(e) => {
                    const r = routines?.find((x) => x.id === e.target.value);
                    setChoice({ routineId: e.target.value, workoutId: r?.workouts[0]?.id ?? '' });
                  }}
                >
                  {(routines ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pick-workout-select">Treino</Label>
                <NativeSelect id="pick-workout-select" value={choice.workoutId} onChange={(e) => setChoice({ ...choice, workoutId: e.target.value })}>
                  {(choiceRoutine?.workouts ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label} · {w.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button size="lg" disabled={!choice.routineId || !choice.workoutId} onClick={() => setPicked({ ...choice })} data-testid="pick-workout-continue">
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ExerciseDialog
        open={!!item && !!dest && !!initial}
        onOpenChange={(o) => !o && onClose()}
        initial={initial}
        resetKey={`${instanceId}:${applied}`}
        title={destWorkout ? `Adicionar ao Treino ${destWorkout.label}` : 'Adicionar à ficha'}
        submitLabel="Adicionar à ficha"
        onSave={(ex) => void save(ex)}
        header={
          item && (
            <div className="space-y-2 text-sm" data-testid="add-config-header">
              <p className="text-muted-foreground">
                {item.kind === 'catalog' ? 'Da biblioteca' : 'Meu exercício'}: <span className="font-medium text-foreground">{item.name}</span>. Valores iniciais genéricos: ajuste à sua realidade (não são
                prescrição).
              </p>
              {suggestion && (
                <div className="rounded-xl border border-dashed p-3" data-testid="config-suggestion">
                  <p className="font-medium">Configuração anterior sugerida</p>
                  <p className="text-muted-foreground">
                    {describeConfig(suggestion.config, item.modality)} · {suggestion.source.routineName}, Treino {suggestion.source.workoutLabel}. A carga não é copiada.
                  </p>
                  {applied ? (
                    <p className="mt-1 text-xs text-primary" role="status">
                      Sugestão aplicada ao formulário. Nada foi salvo ainda: revise e confirme.
                    </p>
                  ) : (
                    <Button variant="secondary" size="sm" className="mt-2" onClick={() => setApplied(true)} data-testid="apply-suggestion">
                      Usar como ponto de partida
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        }
      />
    </>
  );
}
