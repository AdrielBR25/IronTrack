import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, CalendarDays, Check, Copy, Download, FileUp, MoreVertical, Moon, Pencil, Play, Plus, SkipForward, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm';
import { SortableList } from '@/components/SortableList';
import { useActiveSession, useRoutines, useSchedule, useSettings } from '@/hooks/data';
import { useStartWorkout } from '@/features/routines/useStartWorkout';
import { importFichaFile, loadSampleFicha } from '@/features/routines/importFicha';
import {
  addRoutine,
  clearDayOverride,
  cloneWorkout,
  deleteRoutine,
  duplicateRoutine,
  saveRoutine,
  saveRoutineKeepPointer,
  setActiveRoutine,
  setDayOverride,
  setNextWorkout,
  skipNextWorkout,
} from '@/db/repo';
import { routineToFicha, type DayPlan } from '@/modules/training';
import type { Routine, Workout } from '@/lib/types';
import { cn, downloadJson, uid } from '@/lib/utils';
import { fmtDateShort, todayISO, weekday, weekdayShort } from '@/lib/dates';

const LETTERS = 'ABCDEFGHIJ';

function nextLabel(r: Routine) {
  const used = new Set(r.workouts.map((w) => w.label));
  return LETTERS.split('').find((l) => !used.has(l)) ?? String(r.workouts.length + 1);
}

function RoutineDialog({ open, onOpenChange, routine }: { open: boolean; onOpenChange: (o: boolean) => void; routine?: Routine }) {
  const [name, setName] = useState('');
  useEffect(() => setName(routine?.name ?? ''), [routine, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{routine ? 'Renomear rotina' : 'Nova rotina'}</DialogTitle>
          <DialogDescription>{routine ? '' : 'Uma rotina agrupa seus treinos (ex.: A, B e C) e define a sequência da rotação.'}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            if (routine) await saveRoutine({ ...routine, name: name.trim() });
            else {
              const now = Date.now();
              await addRoutine({ id: uid(), name: name.trim(), workouts: [{ id: uid(), label: 'A', name: 'Treino A', exercises: [] }], createdAt: now, updatedAt: now }, true);
              toast.success('Rotina criada e ativada');
            }
            onOpenChange(false);
          }}
        >
          <Input autoFocus placeholder="Ex.: ABC Hipertrofia" value={name} onChange={(e) => setName(e.target.value)} />
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DayDialog({ day, routine, onClose }: { day: DayPlan | null; routine: Routine; onClose: () => void }) {
  const [workoutId, setWorkoutId] = useState('');
  useEffect(() => setWorkoutId(day?.workoutId ?? routine.workouts[0]?.id ?? ''), [day, routine]);
  if (!day) return null;
  const isToday = day.date === todayISO();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {weekdayShort(weekday(day.date))}, {fmtDateShort(day.date)} {isToday && '(hoje)'}
          </DialogTitle>
          <DialogDescription>Ajuste este dia. A rotação continua a partir do treino que você definir.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Button
            variant="secondary"
            size="lg"
            className="w-full justify-start"
            onClick={async () => {
              await setDayOverride({ routineId: routine.id, date: day.date, kind: 'rest' });
              toast.success('Dia marcado como descanso');
              onClose();
            }}
          >
            <Moon /> Marcar como descanso
          </Button>
          <div className="space-y-2 rounded-2xl border p-3">
            <Label>Reagendar: treinar neste dia</Label>
            <div className="flex gap-2">
              <NativeSelect value={workoutId} onChange={(e) => setWorkoutId(e.target.value)}>
                {routine.workouts.map((w) => (
                  <option key={w.id} value={w.id}>
                    Treino {w.label} · {w.name}
                  </option>
                ))}
              </NativeSelect>
              <Button
                onClick={async () => {
                  await setDayOverride({ routineId: routine.id, date: day.date, kind: 'workout', workoutId });
                  toast.success('Dia reagendado');
                  onClose();
                }}
              >
                Definir
              </Button>
            </div>
          </div>
          {day.source === 'override' && (
            <Button
              variant="ghost"
              className="w-full"
              onClick={async () => {
                await clearDayOverride(routine.id, day.date);
                toast('Dia voltou ao padrão');
                onClose();
              }}
            >
              <Undo2 /> Voltar ao padrão
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RotationCard({ routine }: { routine: Routine }) {
  const settings = useSettings();
  const schedule = useSchedule(routine, settings, 14);
  const [day, setDay] = useState<DayPlan | null>(null);
  if (!schedule || routine.workouts.length === 0) return null;
  const next = routine.workouts[schedule.nextIndex % routine.workouts.length];
  const today = todayISO();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-primary" /> Rotação
        </CardTitle>
        <CardDescription>
          {routine.workouts.map((w) => w.label).join(' → ')} → … contínua. Toque em um dia para marcar descanso ou reagendar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Próximo:</span>
          <NativeSelect
            aria-label="Corrigir próximo treino da sequência"
            className="h-10 w-auto min-w-40 flex-1"
            value={next?.id}
            onChange={async (e) => {
              await setNextWorkout(routine, e.target.value);
              toast.success('Sequência corrigida');
            }}
          >
            {routine.workouts.map((w) => (
              <option key={w.id} value={w.id}>
                Treino {w.label} · {w.name}
              </option>
            ))}
          </NativeSelect>
          <Button
            variant="secondary"
            size="sm"
            className="h-10"
            onClick={async () => {
              await skipNextWorkout(routine);
              toast('Treino pulado na sequência');
            }}
          >
            <SkipForward /> Pular
          </Button>
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 no-scrollbar" data-testid="agenda">
          {schedule.plan.map((d) => {
            const w = routine.workouts.find((x) => x.id === d.workoutId);
            const isToday = d.date === today;
            return (
              <button
                key={d.date}
                onClick={() => d.kind !== 'done' && setDay(d)}
                className={cn(
                  'flex w-14 shrink-0 flex-col items-center gap-1 rounded-2xl border py-2 transition-colors',
                  isToday && 'border-primary',
                  d.kind === 'done' ? 'bg-primary/15' : d.kind === 'rest' ? 'bg-secondary/40' : 'bg-card hover:bg-accent',
                )}
              >
                <span className="text-[10px] uppercase text-muted-foreground">{weekdayShort(weekday(d.date))}</span>
                <span className="text-xs tabular text-muted-foreground">{d.date.slice(8)}</span>
                <span className={cn('font-display text-lg font-bold', d.kind === 'rest' ? 'text-muted-foreground' : 'text-primary')}>
                  {d.kind === 'rest' ? <Moon className="h-4 w-4" /> : d.kind === 'done' ? <Check className="h-5 w-5" /> : w?.label}
                </span>
                {d.source === 'override' && <span className="h-1 w-1 rounded-full bg-warn" title="ajustado" />}
              </button>
            );
          })}
        </div>
      </CardContent>
      <DayDialog day={day} routine={routine} onClose={() => setDay(null)} />
    </Card>
  );
}

function WorkoutRow({ routine, workout, handle }: { routine: Routine; workout: Workout; handle: React.ReactNode }) {
  const navigate = useNavigate();
  const start = useStartWorkout();
  const active = useActiveSession();
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const groups = [...new Set(workout.exercises.map((e) => e.muscleGroup))];
  return (
    <Card className="flex items-center gap-2 p-2 pr-3">
      {handle}
      <button className="flex flex-1 items-center gap-3 text-left min-w-0" onClick={() => navigate(`/treinos/${routine.id}/${workout.id}`)}>
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 font-display text-xl font-bold text-primary">{workout.label}</span>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{workout.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {workout.exercises.length} exercícios{groups.length ? ` · ${groups.join(', ')}` : ''}
          </span>
        </span>
      </button>
      <Button size="icon-sm" variant="ghost" aria-label={`Opções do treino ${workout.label}`} onClick={() => setMenu(true)}>
        <MoreVertical />
      </Button>
      <Dialog open={menu} onOpenChange={setMenu}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Treino {workout.label} · {workout.name}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Button size="lg" disabled={!!active || workout.exercises.length === 0} onClick={() => void start(routine.id, workout.id)}>
              <Play /> Iniciar este treino agora
            </Button>
            <Button variant="secondary" size="lg" className="justify-start" onClick={() => navigate(`/treinos/${routine.id}/${workout.id}`)}>
              <Pencil /> Editar exercícios
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="justify-start"
              onClick={async () => {
                const copy = cloneWorkout(workout, nextLabel(routine));
                copy.name = `${workout.name} (cópia)`;
                await saveRoutineKeepPointer({ ...routine, workouts: [...routine.workouts, copy] });
                setMenu(false);
                toast.success(`Treino duplicado como ${copy.label}`);
              }}
            >
              <Copy /> Duplicar treino
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="justify-start text-destructive"
              onClick={() => {
                setMenu(false);
                setConfirm(true);
              }}
            >
              <Trash2 /> Excluir treino
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        destructive
        title={`Excluir o treino ${workout.label}?`}
        description="O histórico de sessões já realizadas é mantido."
        confirmLabel="Excluir"
        onConfirm={async () => {
          await saveRoutineKeepPointer({ ...routine, workouts: routine.workouts.filter((w) => w.id !== workout.id) });
          toast('Treino excluído');
        }}
      />
    </Card>
  );
}

export default function WorkoutsPage() {
  const routines = useRoutines();
  const settings = useSettings();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routineDialog, setRoutineDialog] = useState<{ open: boolean; routine?: Routine }>({ open: false });
  const [routineMenu, setRoutineMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const routine = routines?.find((r) => r.id === (selectedId ?? settings.activeRoutineId)) ?? routines?.[0];
  const isActive = routine && routine.id === (settings.activeRoutineId ?? routines?.[0]?.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Treinos"
        subtitle="Rotinas, rotação e fichas"
        action={
          <div className="flex gap-2">
            <Button variant="outline" size="icon" aria-label="Planejamento semanal" title="Planejamento semanal" onClick={() => navigate('/planejamento')} data-testid="open-planner">
              <CalendarDays />
            </Button>
            <Button variant="outline" size="icon" aria-label="Importar ficha JSON" onClick={() => fileRef.current?.click()}>
              <FileUp />
            </Button>
            <Button size="icon" aria-label="Nova rotina" onClick={() => setRoutineDialog({ open: true })}>
              <Plus />
            </Button>
          </div>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        data-testid="import-ficha-input"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const r = await importFichaFile(f);
          if (r.ok) {
            setSelectedId(r.routine.id);
            toast.success(`Ficha "${r.routine.name}" importada e ativada`);
          } else setImportErrors(r.errors);
        }}
      />

      {routines && routines.length === 0 && (
        <Card className="p-5 text-center">
          <p className="font-semibold">Nenhuma rotina ainda</p>
          <p className="mt-1 text-sm text-muted-foreground">Importe uma ficha JSON, use o exemplo ABC ou crie do zero.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <Button onClick={() => void loadSampleFicha()}>
              <Sparkles /> Ficha de exemplo
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <FileUp /> Importar JSON
            </Button>
            <Button variant="outline" onClick={() => setRoutineDialog({ open: true })}>
              <Plus /> Criar rotina
            </Button>
          </div>
        </Card>
      )}

      {routines && routines.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 no-scrollbar md:mx-0 md:px-0">
          {routines.map((r) => {
            const sel = r.id === routine?.id;
            const act = r.id === (settings.activeRoutineId ?? routines[0].id);
            return (
              <button
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium', sel ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground')}
              >
                {act && <Check className="h-4 w-4 text-primary" />}
                {r.name}
              </button>
            );
          })}
        </div>
      )}

      {routine && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate font-display text-lg font-bold">{routine.name}</h2>
              <p className="text-xs text-muted-foreground">
                {isActive ? <Badge>Rotina ativa</Badge> : 'Rotina inativa'} {routine.description && `· ${routine.description}`}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {!isActive && (
                <Button
                  size="sm"
                  onClick={async () => {
                    await setActiveRoutine(routine.id);
                    toast.success('Rotina ativada');
                  }}
                >
                  Ativar
                </Button>
              )}
              <Button size="icon-sm" variant="outline" aria-label="Opções da rotina" onClick={() => setRoutineMenu(true)}>
                <MoreVertical />
              </Button>
            </div>
          </div>

          {isActive && <RotationCard routine={routine} />}

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-muted-foreground">Treinos da rotina · arraste para mudar a ordem</h3>
            </div>
            <SortableList
              items={routine.workouts}
              onReorder={(ws) => void saveRoutineKeepPointer({ ...routine, workouts: ws })}
              render={(w, handle) => <WorkoutRow routine={routine} workout={w} handle={handle} />}
            />
            <Button
              variant="outline"
              className="w-full border-dashed"
              onClick={async () => {
                const label = nextLabel(routine);
                await saveRoutineKeepPointer({ ...routine, workouts: [...routine.workouts, { id: uid(), label, name: `Treino ${label}`, exercises: [] }] });
              }}
            >
              <Plus /> Adicionar treino
            </Button>
          </section>
        </>
      )}

      {routine && (
        <Dialog open={routineMenu} onOpenChange={setRoutineMenu}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{routine.name}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <Button
                variant="secondary"
                size="lg"
                className="justify-start"
                onClick={() => {
                  downloadJson(`ficha-${routine.name.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}.json`, routineToFicha(routine));
                  setRoutineMenu(false);
                }}
              >
                <Download /> Exportar ficha (JSON)
              </Button>
              <Button
                variant="secondary"
                size="lg"
                className="justify-start"
                onClick={() => {
                  setRoutineMenu(false);
                  setRoutineDialog({ open: true, routine });
                }}
              >
                <Pencil /> Renomear
              </Button>
              <Button
                variant="secondary"
                size="lg"
                className="justify-start"
                onClick={async () => {
                  const c = await duplicateRoutine(routine.id);
                  if (c) setSelectedId(c.id);
                  setRoutineMenu(false);
                  toast.success('Rotina duplicada');
                }}
              >
                <Copy /> Duplicar rotina
              </Button>
              <Button
                variant="secondary"
                size="lg"
                className="justify-start text-destructive"
                onClick={() => {
                  setRoutineMenu(false);
                  setConfirmDelete(true);
                }}
              >
                <Trash2 /> Excluir rotina
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <RoutineDialog open={routineDialog.open} routine={routineDialog.routine} onOpenChange={(o) => setRoutineDialog((s) => ({ ...s, open: o }))} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        destructive
        title="Excluir esta rotina?"
        description="Os treinos e a agenda desta rotina serão removidos. O histórico de sessões realizadas é mantido."
        confirmLabel="Excluir rotina"
        onConfirm={async () => {
          if (routine) await deleteRoutine(routine.id);
          setSelectedId(null);
        }}
      />
      <Dialog open={!!importErrors} onOpenChange={(o) => !o && setImportErrors(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Não foi possível importar a ficha</DialogTitle>
            <DialogDescription>Corrija os pontos abaixo no arquivo JSON e tente novamente. O formato está documentado no repositório (docs/FICHA_JSON.md).</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm" data-testid="import-errors">
            {importErrors?.map((e, i) => (
              <li key={i} className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">
                {e}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
