import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarClock, CalendarDays, Check, Coffee, Copy, Download, FileUp, Minus, MoreVertical, Moon, Pencil, Play, Plus, SkipForward, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm';
import { SortableList } from '@/components/SortableList';
import { useActiveSession, useRoutines, useSettings } from '@/hooks/data';
import { useCalendarInput } from '@/hooks/useCalendar';
import { ConflictNotice } from '@/features/calendar/ConflictNotice';
import { CERTAINTY_HINT, ORIGIN_LABEL, entryLine, entryShort } from '@/features/calendar/calendarFormat';
import { DAY_STATUS_LABEL, primaryEntries, resolveRange, rotationStatus, type ResolvedDay } from '@/modules/calendar';
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
import { routineToFicha } from '@/modules/training';
import type { Routine, Workout } from '@/lib/types';
import { cn, downloadJson, uid } from '@/lib/utils';
import { addDays, fmtDateShort, weekday, weekdayShort } from '@/lib/dates';

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

/**
 * Detalhes de um dia da agenda (P14). Deixa explícito qual modelo cada ação altera: o planejamento semanal (na tela
 * Planejamento), a agenda anterior (reagendar/descanso, aqui) ou a rotação (controles do cartão). Nada é migrado.
 */
function AgendaDayDialog({ day, routine, onClose }: { day: ResolvedDay | null; routine: Routine; onClose: () => void }) {
  const navigate = useNavigate();
  const [workoutId, setWorkoutId] = useState('');
  useEffect(() => setWorkoutId(day?.legacy?.workoutId ?? routine.workouts[0]?.id ?? ''), [day, routine]);
  if (!day) return null;
  const legacy = day.legacy;
  const facts = day.entries.filter((e) => e.origin === 'session' || e.origin === 'active_session');
  const primary = primaryEntries(day);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="agenda-day-dialog" data-date={day.date}>
        <DialogHeader>
          <DialogTitle>
            {weekdayShort(weekday(day.date))}, {fmtDateShort(day.date)} {day.isToday && '(hoje)'}
          </DialogTitle>
          <DialogDescription>{DAY_STATUS_LABEL[day.status]}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto">
          <section aria-label="O que vale neste dia" className="space-y-1.5" data-testid="agenda-day-primary">
            {[...facts, ...primary].map((e, i) => (
              <p key={i} className="rounded-xl bg-secondary/50 px-3 py-2 text-sm">
                <span className="block break-words font-medium">{entryLine(e)}</span>
                <span className="block text-xs text-muted-foreground">
                  {ORIGIN_LABEL[e.origin]} · {e.state}
                  {e.followsRotation && CERTAINTY_HINT[e.certainty] ? ` · ${CERTAINTY_HINT[e.certainty]}` : ''}
                </span>
              </p>
            ))}
            {facts.length + primary.length === 0 && <p className="text-sm text-muted-foreground">Nada planejado nem sugerido para este dia.</p>}
          </section>
          <ConflictNotice day={day} planHref={`/planejamento?data=${day.date}`} legacyHref={null} />
          <section aria-label="Planejamento semanal" className="space-y-2 rounded-2xl border p-3">
            <p className="text-sm font-semibold">Planejamento semanal</p>
            <p className="text-xs text-muted-foreground">Altera o planejamento de toda semana ou cria uma exceção só para esta data. Tem prioridade sobre a agenda anterior.</p>
            <Button variant="secondary" className="w-full" onClick={() => navigate(`/planejamento?data=${day.date}`)} data-testid="agenda-edit-plan">
              <CalendarDays /> Editar no planejamento
            </Button>
          </section>
          {legacy && legacy.kind !== 'done' && !day.isPast && (
            <section aria-label="Agenda anterior" className="space-y-2 rounded-2xl border p-3" data-testid="agenda-legacy-edit">
              <p className="text-sm font-semibold">Agenda anterior (reagendar)</p>
              <p className="text-xs text-muted-foreground">
                Altera só a agenda anterior desta rotina (dias de treino das Configurações + reagendamentos). O planejamento semanal não muda. A rotação continua a partir do
                treino que você definir.
              </p>
              {day.plan.source !== 'none' && (
                <p className="rounded-xl bg-warn/10 p-2 text-xs text-warn">Este dia tem planejamento: ele continua valendo, e o reagendamento fica visível como agenda anterior.</p>
              )}
              <Button
                variant="secondary"
                size="lg"
                className="w-full justify-start"
                onClick={async () => {
                  await setDayOverride({ routineId: routine.id, date: day.date, kind: 'rest' });
                  toast.success('Agenda anterior: dia marcado como descanso');
                  onClose();
                }}
              >
                <Moon /> Marcar como descanso
              </Button>
              <Label>Reagendar: treinar neste dia</Label>
              <div className="flex gap-2">
                <NativeSelect value={workoutId} onChange={(e) => setWorkoutId(e.target.value)} aria-label="Treino para reagendar">
                  {routine.workouts.map((w) => (
                    <option key={w.id} value={w.id}>
                      Treino {w.label} · {w.name}
                    </option>
                  ))}
                </NativeSelect>
                <Button
                  onClick={async () => {
                    await setDayOverride({ routineId: routine.id, date: day.date, kind: 'workout', workoutId });
                    toast.success('Agenda anterior: dia reagendado');
                    onClose();
                  }}
                >
                  Definir
                </Button>
              </div>
              {legacy.source === 'override' && (
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={async () => {
                    await clearDayOverride(routine.id, day.date);
                    toast('Dia voltou ao padrão da agenda anterior');
                    onClose();
                  }}
                >
                  <Undo2 /> Voltar ao padrão
                </Button>
              )}
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const AGENDA_DAYS = 14;

function RotationCard({ routine }: { routine: Routine }) {
  const input = useCalendarInput();
  const [selected, setSelected] = useState<string | null>(null);
  const days = useMemo(() => (input ? resolveRange(input, input.today, addDays(input.today, AGENDA_DAYS - 1)) : null), [input]);
  const status = input ? rotationStatus(input, routine.id) : null;
  if (!days || !status || routine.workouts.length === 0) return null;
  const next = status.next;
  const day = days.find((d) => d.date === selected) ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-primary" /> Rotação e agenda
        </CardTitle>
        <CardDescription>
          {routine.workouts.map((w) => w.label).join(' → ')} → … contínua. A agenda é a mesma do Planejamento: o planejamento semanal tem prioridade; sem ele, vale a agenda
          anterior (dias de treino das Configurações + reagendamentos). Toque em um dia para ver detalhes, reagendar ou editar o planejamento.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
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
          <p className="text-xs text-muted-foreground">Estes controles alteram só a rotação (o próximo treino da sequência).</p>
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 no-scrollbar" data-testid="agenda">
          {days.map((d) => {
            const primary = primaryEntries(d);
            const workouts = primary.filter((e) => e.kind === 'workout');
            const first = workouts[0];
            const doneDay = d.plan.sessions.length > 0 && (d.status === 'done' || d.status === 'trained');
            const isPlan = d.origin === 'plan_exception' || d.origin === 'plan_recurring';
            const isOverride = d.origin === 'legacy' && d.legacy?.source === 'override';
            const uncertain = first && (first.certainty === 'forecast' || first.certainty === 'undetermined');
            const what = doneDay
              ? 'treino feito'
              : workouts.length
                ? workouts.map((e) => entryShort(e)).join(' + ')
                : d.status === 'rest'
                  ? 'descanso'
                  : d.status === 'free'
                    ? 'dia livre'
                    : 'nada planejado';
            const origin = isPlan ? (d.origin === 'plan_exception' ? 'exceção do planejamento' : 'planejamento semanal') : isOverride ? 'reagendado na agenda anterior' : d.origin === 'legacy' ? 'agenda anterior' : '';
            return (
              <button
                key={d.date}
                onClick={() => setSelected(d.date)}
                aria-label={`${weekdayShort(weekday(d.date))} ${fmtDateShort(d.date)}: ${what}${origin ? `, ${origin}` : ''}${d.hasWarning ? ', divergência entre agendas' : ''}`}
                data-testid="agenda-day"
                data-date={d.date}
                data-status={d.status}
                data-origin={d.origin}
                data-warning={d.hasWarning ? 'true' : 'false'}
                className={cn(
                  'relative flex w-14 shrink-0 flex-col items-center gap-1 rounded-2xl border py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  d.isToday && 'border-primary',
                  doneDay ? 'bg-primary/15' : d.status === 'rest' || d.status === 'free' ? 'bg-secondary/40' : 'bg-card hover:bg-accent',
                )}
              >
                {d.hasWarning && <AlertTriangle className="absolute right-1 top-1 h-3 w-3 text-warn" aria-hidden />}
                <span className="text-[10px] uppercase text-muted-foreground">{weekdayShort(weekday(d.date))}</span>
                <span className="text-xs tabular text-muted-foreground">{d.date.slice(8)}</span>
                <span className={cn('font-display text-lg font-bold', d.status === 'rest' || d.status === 'free' ? 'text-muted-foreground' : uncertain ? 'text-primary/60' : 'text-primary')}>
                  {doneDay ? (
                    <Check className="h-5 w-5" />
                  ) : d.status === 'rest' ? (
                    <Moon className="h-4 w-4" />
                  ) : d.status === 'free' ? (
                    <Coffee className="h-4 w-4" />
                  ) : first ? (
                    `${first.workoutLabel ?? '?'}${workouts.length > 1 ? '+' : ''}`
                  ) : (
                    <Minus className="h-4 w-4 text-muted-foreground" />
                  )}
                </span>
                {isPlan && <span className="h-1 w-3 rounded-full bg-primary" title="planejamento" aria-hidden />}
                {isOverride && <span className="h-1 w-1 rounded-full bg-warn" title="reagendado" aria-hidden />}
              </button>
            );
          })}
        </div>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-hidden data-testid="agenda-legend">
          <li className="flex items-center gap-1">
            <span className="h-1 w-3 rounded-full bg-primary" /> planejamento
          </li>
          <li className="flex items-center gap-1">
            <span className="h-1 w-1 rounded-full bg-warn" /> reagendado (agenda anterior)
          </li>
          <li className="flex items-center gap-1">
            <span className="font-bold text-primary/60">B</span> previsão da rotação
          </li>
          <li className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-warn" /> divergência
          </li>
        </ul>
        <Link
          to="/planejamento/importar"
          className="flex min-h-11 items-center gap-2 rounded-xl bg-secondary/50 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="treinos-open-import"
        >
          <CalendarDays className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="font-medium">Importar agenda antiga para o planejamento</span>
            <span className="block text-muted-foreground">Opcional, com prévia e confirmação. Reagendar e descanso aqui continuam alterando só a agenda anterior.</span>
          </span>
        </Link>
      </CardContent>
      <AgendaDayDialog day={day} routine={routine} onClose={() => setSelected(null)} />
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
