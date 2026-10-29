import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { PlanConflictError, addPlanActivity, updatePlanActivity } from '@/db/planner';
import { uid } from '@/lib/utils';
import { WEEKDAY_ORDER, type PlanEntry, type PlanSlot } from '@/modules/planner';
import type { Routine } from '@/lib/types';
import { weekdayLong } from '@/lib/dates';
import { everyWeekday, fmtDayLong } from './plannerFormat';

// Formulário de atividade planejada (IronTrack 2.0 F01/P13). Escolha explícita de rotina e treino; nada é sugerido
// automaticamente e nenhuma ficha é alterada. Gravação com conferência de versão (outra aba não é sobrescrita).

export type ActivityFormMode =
  | { kind: 'add'; slot: PlanSlot; expected: string }
  | { kind: 'edit'; entry: PlanEntry; onDate?: string; expected?: string };

const ROTATION = '__rotation__';

export function ActivityForm({
  open,
  onOpenChange,
  mode,
  routines,
  defaultRoutineId,
  today,
  changedElsewhere,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: ActivityFormMode | null;
  routines: Routine[];
  defaultRoutineId: string | null;
  today: string;
  /** A entrada editada mudou ou sumiu em outra aba desde que o formulário abriu. */
  changedElsewhere: boolean;
}) {
  const editing = mode?.kind === 'edit' ? mode.entry : null;
  const [routineId, setRoutineId] = useState('');
  const [workout, setWorkout] = useState(ROTATION);
  const [weekday, setWeekday] = useState(1);
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ID gerado uma vez por abertura: tocar duas vezes em "Salvar" não cria duas atividades.
  const newId = useMemo(() => (open ? uid() : ''), [open]);

  useEffect(() => {
    if (!open || !mode) return;
    setError(null);
    if (mode.kind === 'edit') {
      setRoutineId(mode.entry.routineId ?? '');
      setWorkout(mode.entry.workoutId ?? ROTATION);
      setWeekday(mode.entry.weekday ?? 1);
      setDate(mode.onDate ?? mode.entry.date ?? today);
    } else {
      const first = routines.find((r) => r.id === defaultRoutineId) ?? routines[0];
      setRoutineId(first?.id ?? '');
      setWorkout(ROTATION);
    }
  }, [open, mode, routines, defaultRoutineId, today]);

  const routine = routines.find((r) => r.id === routineId);
  const isWeekly = mode?.kind === 'add' ? mode.slot.scope === 'weekly' : editing?.scope === 'weekly' && !(mode?.kind === 'edit' && mode.onDate);
  const where =
    mode?.kind === 'add'
      ? mode.slot.scope === 'weekly'
        ? `${everyWeekday(mode.slot.weekday)}, a partir de hoje`
        : `só em ${fmtDayLong(mode.slot.date)}`
      : isWeekly
        ? `${everyWeekday(editing?.weekday ?? 1)}, a partir de hoje (semanas anteriores não mudam)`
        : `só em ${fmtDayLong((mode?.kind === 'edit' && (mode.onDate ?? mode.entry.date)) || today)}`;

  async function save() {
    if (!mode || !routine) return;
    setBusy(true);
    setError(null);
    const activity = { routineId: routine.id, workoutId: workout === ROTATION ? null : workout };
    try {
      if (mode.kind === 'add') await addPlanActivity({ id: newId, slot: mode.slot, activity, expected: mode.expected });
      else {
        const move: PlanSlot | undefined = isWeekly
          ? weekday !== mode.entry.weekday
            ? { scope: 'weekly', weekday }
            : undefined
          : date !== (mode.onDate ?? mode.entry.date)
            ? { scope: 'date', date }
            : undefined;
        await updatePlanActivity({ id: mode.entry.id, expectedRevision: mode.entry.revision, onDate: mode.onDate, expected: mode.expected, activity, moveTo: move });
      }
      toast.success(mode.kind === 'add' ? 'Atividade planejada' : 'Planejamento atualizado');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof PlanConflictError ? e.message : 'Não foi possível salvar. Nada foi gravado.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="plan-form">
        <DialogHeader>
          <DialogTitle>{mode?.kind === 'edit' ? 'Alterar atividade' : 'Planejar treino'}</DialogTitle>
          <DialogDescription>Vale {where}. Treinos já registrados e a rotação não mudam.</DialogDescription>
        </DialogHeader>
        {routines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Crie ou importe uma rotina em Treinos para planejar a semana.</p>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="plan-routine">Rotina</Label>
              <NativeSelect id="plan-routine" value={routineId} onChange={(e) => (setRoutineId(e.target.value), setWorkout(ROTATION))} data-testid="plan-routine">
                {routines.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-workout">Treino</Label>
              <NativeSelect id="plan-workout" value={workout} onChange={(e) => setWorkout(e.target.value)} data-testid="plan-workout">
                <option value={ROTATION}>Próximo da rotação (o que estiver na vez)</option>
                {routine?.workouts.map((w) => (
                  <option key={w.id} value={w.id}>
                    Treino {w.label} · {w.name}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">“Próximo da rotação” acompanha a rotação da rotina; um treino específico fica fixo neste dia.</p>
            </div>
            {mode?.kind === 'edit' &&
              (isWeekly ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="plan-weekday">Dia da semana</Label>
                  <NativeSelect id="plan-weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} data-testid="plan-weekday">
                    {WEEKDAY_ORDER.map((d) => (
                      <option key={d} value={d}>
                        {weekdayLong(d)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="plan-date">Data</Label>
                  <Input id="plan-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} data-testid="plan-date" />
                </div>
              ))}
            {changedElsewhere && (
              <p role="alert" className="rounded-xl bg-warn/15 p-3 text-sm text-warn" data-testid="plan-changed-elsewhere">
                Esta atividade foi alterada ou removida em outra aba. Salvar agora não sobrescreve nada: feche e confira a versão atual.
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-xl bg-destructive/15 p-3 text-sm text-destructive" data-testid="plan-form-error">
                {error}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={busy || !routine || (mode?.kind === 'edit' && !isWeekly && (!date || date < today))} data-testid="plan-save">
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
