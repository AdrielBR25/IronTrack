import { useEffect, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { goalsLinkedTo, mutateWorkout } from '@/db/library';
import { useSettings } from '@/hooks/data';
import type { ExerciseTemplate } from '@/lib/types';
import { uid } from '@/lib/utils';
import { MODALITY_LABEL } from '@/modules/training';
import { instanceFingerprint, substitutionPreview, type LibraryItem } from '@/modules/exercises';
import { planSummary } from '@/features/workout/modelFormat';
import { useModelCapability } from '@/features/compat/CompatGuard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Confirmação da troca de um exercício da ficha (P17, docs/BIBLIOTECA_EXERCICIOS.md §10). Mostra o atual e o
 * substituto, o que muda de modalidade, os campos que não passam e o impacto em metas e histórico. A troca cria uma
 * instância NOVA (ID novo): o histórico do anterior continua dele e as metas não são redirecionadas.
 */
export function SubstituteDialog({
  routineId,
  workoutId,
  current,
  item,
  onClose,
  onDone,
}: {
  routineId: string;
  workoutId: string;
  current: ExerciseTemplate | null;
  item: LibraryItem | null;
  onClose: () => void;
  onDone: (next: ExerciseTemplate) => void;
}) {
  const settings = useSettings();
  const outdated = useModelCapability().newer;
  const [goals, setGoals] = useState<number | null>(null);
  const [newId, setNewId] = useState(() => uid());
  const [busy, setBusy] = useState(false);
  // P18: impressão digital do exercício quando a prévia abriu; se ele mudar em outra aba até a confirmação, nada é gravado.
  const [expected, setExpected] = useState<string | null>(null);
  useEffect(() => {
    if (!current || !item) return;
    setNewId(uid());
    setExpected(instanceFingerprint(current));
    setGoals(null);
    void goalsLinkedTo(current.id).then(setGoals);
  }, [current?.id, item?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(
    () => (current && item && goals !== null ? substitutionPreview(current, item, { id: newId, muscleGroups: settings.muscleGroups, rest: settings, linkedGoals: goals }) : null),
    [current, item, goals, newId, settings],
  );

  const confirm = async () => {
    if (!preview) return;
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return;
    }
    setBusy(true);
    try {
      await mutateWorkout(routineId, workoutId, { type: 'replace', id: preview.current.id, exercise: preview.next, ...(expected ? { expected } : {}) });
      toast.success(`${preview.current.name} substituído por ${preview.next.name}`);
      onDone(preview.next);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!current && !!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="substitute-dialog">
        <DialogHeader>
          <DialogTitle>Substituir exercício?</DialogTitle>
          <DialogDescription>Confira o que muda antes de confirmar. Nada foi gravado ainda.</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <div className="min-w-0 rounded-xl border p-2">
                <p className="text-xs text-muted-foreground">Atual</p>
                <p className="break-words font-semibold">{preview.current.name}</p>
                <p className="text-xs text-muted-foreground">
                  {preview.current.modality ? MODALITY_LABEL[preview.current.modality] : 'Sem modalidade'} · {planSummary(preview.current)}
                </p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
              <div className="min-w-0 rounded-xl border border-primary/50 p-2">
                <p className="text-xs text-muted-foreground">Substituto</p>
                <p className="break-words font-semibold">{preview.next.name}</p>
                <p className="text-xs text-muted-foreground">
                  {preview.next.modality ? MODALITY_LABEL[preview.next.modality] : 'Sem modalidade'} · {planSummary(preview.next)}
                </p>
              </div>
            </div>
            {preview.modalityNotes.length > 0 && (
              <section aria-label="Modalidade">
                <h3 className="font-semibold">Modalidade</h3>
                <ul className="list-disc pl-5">
                  {preview.modalityNotes.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </section>
            )}
            <p>
              <span className="font-semibold">Mantido:</span> {preview.kept.join(', ')}.
            </p>
            {preview.dropped.length > 0 && (
              <section aria-label="Campos incompatíveis">
                <h3 className="font-semibold">Não passa para o substituto</h3>
                <ul className="list-disc pl-5" data-testid="substitute-dropped">
                  {preview.dropped.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </section>
            )}
            <p className="rounded-xl bg-secondary/60 p-3">{preview.historyNote}</p>
            {preview.goalNote && (
              <p className="rounded-xl border border-warn/40 bg-warn/10 p-3" data-testid="substitute-goals">
                {preview.goalNote}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="lg" disabled={!preview || busy} onClick={() => void confirm()} data-testid="substitute-confirm">
            Substituir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
