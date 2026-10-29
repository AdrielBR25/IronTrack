import { useEffect, useMemo, useState } from 'react';
import { Copy, X } from 'lucide-react';
import { toast } from 'sonner';
import { mutateWorkout } from '@/db/library';
import { useSettings } from '@/hooks/data';
import type { Workout } from '@/lib/types';
import { uid } from '@/lib/utils';
import { addManyOp, defaultConfig, describeConfig, instancesForAddMany, libraryKeyOf, plannedSets, type AddManyLine, type LibraryItem } from '@/modules/exercises';
import { useModelCapability } from '@/features/compat/CompatGuard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { WorkoutTarget } from './AddToWorkoutFlow';

/**
 * Confirmação da adição múltipla (P18 §16). As linhas seguem a ordem em que a pessoa marcou os itens; cada uma ganha um
 * ID próprio quando o diálogo abre (repetir a confirmação não duplica). Configuração padrão da modalidade, sem carga.
 * Repetir um exercício só com a ação "Adicionar outra vez". Grava tudo numa operação (`addMany`), tudo ou nada.
 */
export function AddManyDialog({
  items,
  target,
  workout,
  onClose,
  onDone,
}: {
  items: LibraryItem[] | null;
  target: WorkoutTarget | null;
  workout: Workout | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const settings = useSettings();
  const outdated = useModelCapability().newer;
  const [lines, setLines] = useState<AddManyLine[]>([]);
  const [busy, setBusy] = useState(false);
  const open = !!items && !!target;

  useEffect(() => {
    if (items) setLines(items.map((item) => ({ item, id: uid() })));
  }, [items]);

  const inWorkout = useMemo(() => new Set((workout?.exercises ?? []).map(libraryKeyOf).filter(Boolean)), [workout]);
  const exercises = useMemo(() => instancesForAddMany(lines, { muscleGroups: settings.muscleGroups, rest: settings }), [lines, settings]);

  const confirm = async () => {
    if (!target || busy || !exercises.length) return;
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return;
    }
    setBusy(true);
    try {
      const r = await mutateWorkout(target.routineId, target.workoutId, addManyOp(exercises));
      toast.success(r.changed ? `${exercises.length} ${exercises.length === 1 ? 'exercício adicionado' : 'exercícios adicionados'} ao Treino ${workout?.label ?? ''}`.trim() : 'Estes exercícios já tinham sido adicionados.');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="add-many-dialog">
        <DialogHeader>
          <DialogTitle>Adicionar {lines.length} ao Treino {workout?.label}?</DialogTitle>
          <DialogDescription>
            Entram no fim da ficha, nesta ordem, com valores iniciais genéricos e sem carga (ajuste depois). Cada um vira um exercício próprio na ficha. Nada foi gravado ainda.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-1.5" data-testid="add-many-list">
          {lines.map((l, i) => (
            <li key={l.id} className="flex items-center gap-2 rounded-xl border p-2 text-sm">
              <span className="w-5 shrink-0 text-xs font-bold text-muted-foreground tabular">{(workout?.exercises.length ?? 0) + i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block break-words font-semibold">{l.item.name}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  {describeConfig(defaultConfig(l.item, settings), l.item.modality)}
                  {inWorkout.has(l.item.key) && <Badge variant="outline">já na ficha</Badge>}
                  {lines.filter((x) => x.item.key === l.item.key).length > 1 && <Badge variant="warn">repetido</Badge>}
                </span>
              </span>
              <Button size="icon-sm" variant="ghost" aria-label={`Adicionar ${l.item.name} outra vez`} onClick={() => setLines((ls) => [...ls.slice(0, i + 1), { item: l.item, id: uid() }, ...ls.slice(i + 1)])}>
                <Copy />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Tirar ${l.item.name} da seleção`} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}>
                <X />
              </Button>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground" data-testid="add-many-sets">
          Séries planejadas acrescentadas: {plannedSets(exercises)} (estimativa do planejamento, não é volume executado).
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button size="lg" disabled={busy || !exercises.length} onClick={() => void confirm()} data-testid="add-many-confirm">
            Adicionar {exercises.length} à ficha
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
