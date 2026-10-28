import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, CalendarCheck2, CalendarClock, Check, ChevronLeft, ChevronRight, Circle, CircleDot, Coffee, Minus, Moon, Pause, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { PlanConflictError, clearPlanException, removePlanEntry, setPlanMarker, updatePlanActivity } from '@/db/planner';
import { useActiveSession, useCurrentProfile, useRoutines, useSettings, useToday } from '@/hooks/data';
import { usePlanEntries, usePlannerSessions, useRotations } from '@/hooks/usePlanner';
import { useGoals } from '@/hooks/useGoals';
import { useStartWorkout } from '@/features/routines/useStartWorkout';
import { ActivityForm, type ActivityFormMode } from '@/features/planner/ActivityForm';
import { ConsistencyCard, WeeklyGoalsCard } from '@/features/planner/WeekSummary';
import { ACTIVITY_TONE, DAY_STATE_SHORT, activityTitle, everyWeekday, fmtDayLong, fmtDayShort, fmtWeekRange } from '@/features/planner/plannerFormat';
import { fmtTime, weekdayShort } from '@/lib/dates';
import { cn, uid } from '@/lib/utils';
import { normIndex, type Routine, type Workout } from '@/modules/training';
import {
  ACTIVITY_STATUS_LABEL,
  DAY_STATE_LABEL,
  buildWeek,
  compareWeeks,
  currentWeekly,
  describeEntry,
  planForDate,
  shiftWeek,
  slotFingerprint,
  weekOf,
  weeklyGoalsForWeek,
  type DayState,
  type DayView,
  type PlanEntry,
  type PlanSlot,
  type PlannedActivity,
} from '@/modules/planner';

// Planejamento semanal (IronTrack 2.0 F01/P13, #/planejamento). Camada de planejamento sobre a rotação: nada aqui
// avança a rotação, conclui sessões, cria treinos fictícios ou altera fichas. Tudo fica no aparelho (nunca vai para a
// IA). Ver docs/PLANEJAMENTO_SEMANAL.md.

const STATE_ICON: Record<DayState, typeof Check> = { concluido: Check, parcial: CircleDot, planejado: Circle, futuro: CalendarClock, sem_plano: Minus };

type EditScope = 'weekly' | 'date';

export default function WeeklyPlannerPage() {
  const today = useToday();
  const entries = usePlanEntries();
  const sessions = usePlannerSessions();
  const routines = useRoutines();
  const rotations = useRotations();
  const goals = useGoals();
  const active = useActiveSession();
  const profile = useCurrentProfile();
  const settings = useSettings();
  const start = useStartWorkout();
  const navigate = useNavigate();

  const [monday, setMonday] = useState(() => weekOf(today));
  const [selected, setSelected] = useState(today);
  const [scope, setScope] = useState<EditScope>('weekly');
  const [form, setForm] = useState<ActivityFormMode | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; description: string; label: string; run: () => Promise<unknown> } | null>(null);
  const [startChoice, setStartChoice] = useState<{ routine: Routine; planned: Workout; next: Workout } | null>(null);
  const [activeBlock, setActiveBlock] = useState(false);

  const isCurrentWeek = monday === weekOf(today);
  const week = useMemo(
    () => (entries && sessions && routines ? buildWeek({ entries, sessions, routines, week: monday, today, profileId: profile?.id }) : null),
    [entries, sessions, routines, monday, today, profile?.id],
  );
  const prevWeek = useMemo(
    () => (entries && sessions && routines ? buildWeek({ entries, sessions, routines, week: shiftWeek(monday, -1), today, profileId: profile?.id }) : null),
    [entries, sessions, routines, monday, today, profile?.id],
  );
  const goalViews = useMemo(() => (goals && sessions ? weeklyGoalsForWeek(goals, sessions, monday, today) : []), [goals, sessions, monday, today]);

  const day = week?.days.find((d) => d.date === selected) ?? week?.days[0] ?? null;

  // Escopo de edição padrão: a exceção do dia, se houver; senão o modelo semanal.
  useEffect(() => {
    if (day) setScope(day.source === 'exception' ? 'date' : 'weekly');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day?.date]);

  const goWeek = (m: string) => {
    setMonday(m);
    setSelected(m === weekOf(today) ? today : m);
  };

  const rotationNext = (routineId: string | null): Workout | null => {
    const r = routines?.find((x) => x.id === routineId);
    if (!r || !r.workouts.length) return null;
    const rot = rotations?.find((x) => x.routineId === r.id);
    return r.workouts[normIndex(rot?.nextIndex ?? 0, r.workouts.length)] ?? null;
  };

  // ---------- Início de treino (reusa o fluxo existente: startSession + tela de treino) ----------
  function startActivity(a: PlannedActivity) {
    if (active) {
      setActiveBlock(true);
      return;
    }
    const routine = routines?.find((r) => r.id === a.entry.routineId);
    if (!routine || a.availability !== 'ok') return;
    const next = rotationNext(routine.id);
    const planned = a.followsRotation ? next : routine.workouts.find((w) => w.id === a.entry.workoutId);
    if (!planned) return;
    if (next && next.id !== planned.id) {
      setStartChoice({ routine, planned, next });
      return;
    }
    void start(routine.id, planned.id);
  }

  // ---------- Edição ----------
  const slotOf = (d: DayView, s: EditScope): PlanSlot => (s === 'weekly' ? { scope: 'weekly', weekday: d.weekday } : { scope: 'date', date: d.date });
  const fp = (slot: PlanSlot) => slotFingerprint(entries ?? [], slot, today);

  async function guarded(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof PlanConflictError ? e.message : 'Não foi possível alterar o planejamento. Nada foi gravado.');
    }
  }

  const editable = !!day && !day.isPast;
  const editList: PlanEntry[] = !day || !entries ? [] : scope === 'weekly' ? currentWeekly(entries, day.weekday, today) : planForDate(entries, day.date).entries;
  const dayLabel = day ? everyWeekday(day.weekday) : '';

  function askMarker(kind: 'rest' | 'free') {
    if (!day) return;
    const slot = slotOf(day, scope);
    const expected = fp(slot);
    const what = kind === 'rest' ? 'descanso' : 'dia livre';
    const where = scope === 'weekly' ? `${dayLabel}, a partir de hoje` : `só em ${fmtDayLong(day.date)}`;
    const hasWorkouts = editList.some((e) => e.kind === 'workout');
    const run = () => setPlanMarker({ id: uid(), slot, kind, expected });
    if (!hasWorkouts) return void guarded(run, `Marcado como ${what}`);
    setConfirm({
      title: `Marcar ${what}?`,
      description: `Os treinos planejados (${where}) saem do planejamento. Treinos já registrados, fichas e rotação não mudam.`,
      label: `Marcar ${what}`,
      run: () => guarded(run, `Marcado como ${what}`),
    });
  }

  function askRemove(e: PlanEntry) {
    if (!day) return;
    const onDate = scope === 'date' ? day.date : undefined;
    const expected = onDate ? fp({ scope: 'date', date: onDate }) : undefined;
    const title = describeEntry(e, routines ?? []);
    const name = e.kind === 'workout' ? activityTitle(title) : e.kind === 'rest' ? 'Descanso' : 'Dia livre';
    setConfirm({
      title: 'Remover do planejamento?',
      description:
        scope === 'weekly'
          ? `“${name}” sai de ${dayLabel} a partir de hoje. Semanas anteriores continuam mostrando o que estava planejado. Treinos registrados não mudam.`
          : `“${name}” sai só de ${fmtDayLong(day.date)}. O planejamento semanal continua igual.`,
      label: 'Remover',
      run: () => guarded(() => removePlanEntry({ id: e.id, expectedRevision: e.revision, onDate, expected }), 'Removido do planejamento'),
    });
  }

  const liveEditing = form?.kind === 'edit' && entries ? (entries.find((x) => x.id === form.entry.id) ?? null) : undefined;
  const changedElsewhere = form?.kind === 'edit' && !form.onDate && liveEditing !== undefined && (liveEditing === null || liveEditing.revision !== form.entry.revision);

  const header = (
    <>
      <Link to="/treinos" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Treinos
      </Link>
      <PageHeader title="Planejamento" subtitle="Sua semana: o que você planejou e o que realizou" />
    </>
  );

  if (!week || !day || !routines) return <div className="space-y-4">{header}<div className="h-40 animate-pulse rounded-2xl bg-card" /></div>;

  const cmp = prevWeek ? compareWeeks(week.consistency, prevWeek.consistency) : null;

  return (
    <div className="space-y-4" data-testid="planner-page">
      {header}

      {/* Navegação semanal */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Semana anterior" onClick={() => goWeek(shiftWeek(monday, -1))} data-testid="week-prev">
          <ChevronLeft />
        </Button>
        <p className="min-w-0 flex-1 text-center font-display font-semibold tabular" aria-live="polite" data-testid="week-range">
          {fmtWeekRange(week.days[0].date, week.days[6].date)}
          {isCurrentWeek && <span className="block text-xs font-normal text-muted-foreground">Semana atual</span>}
        </p>
        <Button variant="outline" size="icon" aria-label="Próxima semana" onClick={() => goWeek(shiftWeek(monday, 1))} data-testid="week-next">
          <ChevronRight />
        </Button>
      </div>
      {!isCurrentWeek && (
        <Button variant="secondary" size="sm" className="w-full" onClick={() => goWeek(weekOf(today))} data-testid="week-today">
          <CalendarCheck2 /> Voltar para hoje
        </Button>
      )}

      <WeekStrip days={week.days} selected={day.date} onSelect={setSelected} routines={routines} />
      <StripLegend />

      {/* Dia selecionado */}
      <Card className="space-y-4 p-4" data-testid="plan-day" data-date={day.date} data-state={day.state}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold first-letter:uppercase">{fmtDayLong(day.date)}</h2>
            <p className="text-xs text-muted-foreground" data-testid="plan-day-source">
              {day.source === 'exception' ? 'Planejamento só deste dia (exceção)' : day.source === 'recurring' ? `Planejamento de ${dayLabel}` : 'Nada planejado para este dia'}
              {day.isToday ? ' · hoje' : ''}
            </p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium" data-testid="plan-day-state">
            {(() => {
              const I = STATE_ICON[day.state];
              return <I className="h-3.5 w-3.5" aria-hidden />;
            })()}
            {DAY_STATE_LABEL[day.state]}
          </span>
        </div>

        {day.markerConflict && (
          <p className="rounded-xl bg-warn/15 p-3 text-sm text-warn">Este dia tem descanso e treinos ao mesmo tempo (ex.: depois de mesclar um backup). Os treinos valem; ajuste o dia abaixo.</p>
        )}

        <section aria-label="Planejado">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Planejado</h3>
          {day.activities.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="plan-day-empty">
              {day.marker === 'rest' ? <Moon className="h-4 w-4" /> : day.marker === 'free' ? <Coffee className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
              {day.marker === 'rest' ? 'Descanso planejado' : day.marker === 'free' ? 'Dia livre' : 'Sem atividade planejada'}
            </p>
          ) : (
            <ul className="space-y-2">
              {day.activities.map((a) => {
                const next = a.followsRotation ? rotationNext(a.entry.routineId) : null;
                const canStart = day.isToday && a.status === 'pendente' && a.availability === 'ok';
                const rotNext = !a.followsRotation && canStart ? rotationNext(a.entry.routineId) : null;
                return (
                  <li key={a.entry.id} className="rounded-xl border p-3" data-testid="plan-activity" data-status={a.status}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-words font-medium" data-testid="plan-activity-title">
                        {activityTitle(a, next)}
                      </span>
                      <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', ACTIVITY_TONE[a.status])} data-testid="plan-activity-status">
                        {a.status === 'realizada' && <Check className="h-3 w-3" aria-hidden />}
                        {ACTIVITY_STATUS_LABEL[a.status]}
                      </span>
                    </div>
                    {a.availability === 'ok' && a.routineName && !a.followsRotation && <p className="text-xs text-muted-foreground">{a.routineName}</p>}
                    {a.availability !== 'ok' && (
                      <p className="mt-1 text-xs text-warn">{a.availability === 'routine_missing' ? 'A rotina deste planejamento foi excluída. Remova ou troque a atividade.' : 'O treino foi removido da rotina. Escolha outro treino.'}</p>
                    )}
                    {rotNext && a.entry.workoutId !== rotNext.id && (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid="plan-rotation-note">
                        A rotação indica Treino {rotNext.label} como próximo. Você escolhe qual iniciar.
                      </p>
                    )}
                    {a.sessionId && (
                      <Link to={`/historico/${a.sessionId}`} className="mt-1 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline">
                        Ver registro
                      </Link>
                    )}
                    {canStart && (
                      <Button className="mt-2 w-full" onClick={() => startActivity(a)} data-testid="plan-start">
                        <Play className="fill-current" /> Iniciar este treino
                      </Button>
                    )}
                    {day.isToday && a.status === 'em_andamento' && (
                      <Button variant="secondary" className="mt-2 w-full" onClick={() => navigate('/treino')}>
                        <Play /> Continuar treino em andamento
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {(day.sessions.length > 0 || day.active) && (
          <section aria-label="Registrado neste dia">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Registrado neste dia</h3>
            <ul className="space-y-1.5 text-sm">
              {day.sessions.map(({ session: s, entryId }) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-2" data-testid="plan-session" data-extra={entryId ? 'false' : 'true'}>
                  <Link to={`/historico/${s.id}`} className="min-w-0 break-words hover:underline">
                    Treino {s.workoutLabel} · {s.workoutName}
                  </Link>
                  <span className="text-xs text-muted-foreground tabular">
                    {fmtTime(s.startedAt)} · {entryId ? 'do planejado' : 'fora do planejado'}
                  </span>
                </li>
              ))}
              {day.active && (
                <li className="flex flex-wrap items-center justify-between gap-x-2" data-testid="plan-session-active">
                  <span>
                    Treino {day.active.workoutLabel} · {day.active.workoutName}
                  </span>
                  <span className="text-xs text-muted-foreground">em andamento (não conta como concluído)</span>
                </li>
              )}
            </ul>
          </section>
        )}

        {/* Ajustes (só hoje e dias futuros) */}
        {editable ? (
          <section aria-label="Ajustar planejamento" className="space-y-3 border-t pt-3" data-testid="plan-edit">
            <Segmented<EditScope>
              aria-label="O que alterar"
              size="sm"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'weekly', label: <span data-testid="scope-weekly">Toda {weekdayShort(day.weekday).toLowerCase()}.</span> },
                { value: 'date', label: <span data-testid="scope-date">Só em {fmtDayShort(day.date)}</span> },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {scope === 'weekly'
                ? `Alterações valem para ${dayLabel} de hoje em diante; semanas anteriores não mudam.`
                : 'Alterações valem só nesta data e têm prioridade sobre o planejamento semanal.'}
            </p>
            {editList.length > 0 && (
              <ul className="space-y-1.5">
                {editList.map((e) => {
                  const d = describeEntry(e, routines);
                  const label = e.kind === 'workout' ? activityTitle(d, d.followsRotation ? rotationNext(e.routineId) : null) : e.kind === 'rest' ? 'Descanso' : 'Dia livre';
                  return (
                    <li key={e.id} className="flex items-center gap-1 rounded-xl bg-secondary/50 py-1 pl-3 pr-1" data-testid="plan-edit-item">
                      <span className="min-w-0 flex-1 break-words text-sm">
                        {label}
                        {e.scope === 'weekly' && !e.enabled && <span className="ml-1 text-xs text-muted-foreground">(pausada)</span>}
                      </span>
                      {e.kind === 'workout' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Alterar ${label}`}
                          onClick={() => {
                            setForm({ kind: 'edit', entry: e, onDate: scope === 'date' ? day.date : undefined, expected: scope === 'date' ? fp({ scope: 'date', date: day.date }) : undefined });
                            setFormOpen(true);
                          }}
                          data-testid="plan-item-edit"
                        >
                          <Pencil />
                        </Button>
                      )}
                      {e.kind === 'workout' && scope === 'weekly' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={e.enabled ? `Pausar ${label}` : `Retomar ${label}`}
                          onClick={() => void guarded(() => updatePlanActivity({ id: e.id, expectedRevision: e.revision, enabled: !e.enabled }), e.enabled ? 'Atividade pausada' : 'Atividade retomada')}
                          data-testid="plan-item-pause"
                        >
                          {e.enabled ? <Pause /> : <Play />}
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" aria-label={`Remover ${label}`} onClick={() => askRemove(e)} data-testid="plan-item-remove">
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Button
                className="col-span-2 sm:col-span-1"
                onClick={() => {
                  const slot = slotOf(day, scope);
                  setForm({ kind: 'add', slot, expected: fp(slot) });
                  setFormOpen(true);
                }}
                data-testid="plan-add"
              >
                <Plus /> Treino
              </Button>
              <Button variant="secondary" onClick={() => askMarker('rest')} data-testid="plan-rest">
                <Moon /> Descanso
              </Button>
              <Button variant="secondary" onClick={() => askMarker('free')} data-testid="plan-free">
                <Coffee /> Dia livre
              </Button>
              {scope === 'date' && day.source === 'exception' && (
                <Button
                  variant="outline"
                  className="col-span-2 sm:col-span-1"
                  onClick={() =>
                    setConfirm({
                      title: 'Voltar ao planejamento semanal?',
                      description: `As alterações feitas só para ${fmtDayLong(day.date)} são desfeitas e o dia volta a seguir o planejamento de ${dayLabel}.`,
                      label: 'Voltar ao semanal',
                      run: () => guarded(() => clearPlanException({ date: day.date, expected: fp({ scope: 'date', date: day.date }) }), 'Dia voltou ao planejamento semanal'),
                    })
                  }
                  data-testid="plan-clear-exception"
                >
                  <RotateCcw /> Voltar ao semanal
                </Button>
              )}
            </div>
          </section>
        ) : (
          <p className="border-t pt-3 text-xs text-muted-foreground">Dias passados não são alterados. Para mudar as próximas semanas, selecione hoje ou um dia futuro.</p>
        )}
      </Card>

      <div className="grid gap-4">
        <ConsistencyCard c={week.consistency} cmp={cmp} isCurrent={isCurrentWeek} />
        <WeeklyGoalsCard views={goalViews} isFuture={monday > weekOf(today)} />
      </div>

      <p className="text-xs text-muted-foreground">
        O planejamento fica só neste aparelho (e nos backups). Ele não avança a rotação, não conclui treinos, não altera fichas e não é enviado ao assistente de IA.
        {settings.activeRoutineId ? '' : ' Nenhuma rotina ativa: escolha uma em Treinos.'}
      </p>

      <ActivityForm
        open={formOpen}
        onOpenChange={setFormOpen}
        mode={form}
        routines={routines}
        defaultRoutineId={settings.activeRoutineId}
        today={today}
        changedElsewhere={changedElsewhere}
      />

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.description}
        confirmLabel={confirm?.label}
        destructive={confirm?.label === 'Remover'}
        onConfirm={async () => void (await confirm?.run())}
      />

      <Dialog open={!!startChoice} onOpenChange={(o) => !o && setStartChoice(null)}>
        <DialogContent data-testid="plan-start-choice">
          <DialogHeader>
            <DialogTitle>Qual treino iniciar?</DialogTitle>
            <DialogDescription>
              O planejado para hoje é o Treino {startChoice?.planned.label}, mas a rotação indica o Treino {startChoice?.next.label}. Nada é alterado até você escolher. Ao concluir,
              a rotação segue a regra de sempre (continua a partir do treino realizado), igual a iniciar pela tela Treinos.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:flex-col sm:items-stretch">
            <Button
              onClick={() => {
                const c = startChoice!;
                setStartChoice(null);
                void start(c.routine.id, c.planned.id);
              }}
              data-testid="start-planned"
            >
              Iniciar Treino {startChoice?.planned.label} (planejado)
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const c = startChoice!;
                setStartChoice(null);
                void start(c.routine.id, c.next.id);
              }}
              data-testid="start-rotation"
            >
              Iniciar Treino {startChoice?.next.label} (rotação)
            </Button>
            <Button variant="ghost" onClick={() => setStartChoice(null)}>
              Cancelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={activeBlock} onOpenChange={setActiveBlock}>
        <DialogContent data-testid="plan-active-block">
          <DialogHeader>
            <DialogTitle>Já existe um treino em andamento</DialogTitle>
            <DialogDescription>
              O Treino {active?.workoutLabel} está em andamento. Conclua ou descarte esse treino antes de iniciar outro; nenhum treino novo foi criado.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setActiveBlock(false)}>
              Fechar
            </Button>
            <Button onClick={() => navigate('/treino')}>
              <Play /> Continuar treino
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Faixa da semana: 7 dias compactos no celular, colunas com as atividades no computador. Setas do teclado navegam. */
function WeekStrip({ days, selected, onSelect, routines }: { days: DayView[]; selected: string; onSelect: (d: string) => void; routines: Routine[] }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? 6 : null;
    if (to === null || to < 0 || to > 6) return;
    e.preventDefault();
    onSelect(days[to].date);
    refs.current[to]?.focus();
  };
  return (
    <ol className="grid grid-cols-7 gap-1 md:gap-2" aria-label="Dias da semana" data-testid="week-strip">
      {days.map((d, i) => {
        const Icon = d.marker === 'rest' && d.state !== 'futuro' ? Moon : STATE_ICON[d.state];
        const isSel = d.date === selected;
        const summary = d.activities.length ? `${d.activities.length} ${d.activities.length === 1 ? 'atividade planejada' : 'atividades planejadas'}` : d.marker === 'rest' ? 'descanso' : d.marker === 'free' ? 'dia livre' : 'nada planejado';
        const done = d.sessions.length ? `, ${d.sessions.length} ${d.sessions.length === 1 ? 'treino registrado' : 'treinos registrados'}` : '';
        return (
          <li key={d.date} className="min-w-0">
            <button
              ref={(el) => (refs.current[i] = el)}
              type="button"
              onClick={() => onSelect(d.date)}
              onKeyDown={(e) => onKey(e, i)}
              tabIndex={isSel ? 0 : -1}
              aria-pressed={isSel}
              aria-current={d.isToday ? 'date' : undefined}
              aria-label={`${fmtDayLong(d.date)}: ${DAY_STATE_LABEL[d.state]}, ${summary}${done}`}
              data-testid="week-day"
              data-date={d.date}
              data-state={d.state}
              className={cn(
                'flex h-full min-h-[4.5rem] w-full flex-col items-center gap-0.5 rounded-xl border px-0.5 py-1.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:items-stretch md:px-2 md:text-left',
                isSel ? 'border-primary bg-primary/10' : 'bg-card hover:bg-accent',
                d.isToday && !isSel && 'border-primary/50',
              )}
            >
              <span className="text-[11px] font-medium uppercase text-muted-foreground">{weekdayShort(d.weekday)}</span>
              <span className={cn('font-display text-lg font-bold leading-none tabular', d.isToday && 'text-primary')}>{Number(d.date.slice(8))}</span>
              <span className="mt-0.5 flex max-w-full items-center gap-0.5 text-xs leading-tight text-muted-foreground">
                <Icon className="h-3.5 w-3.5 shrink-0 md:h-3 md:w-3" aria-hidden />
                <span className="hidden truncate md:inline">{d.marker === 'rest' && d.activities.length === 0 && d.state !== 'futuro' ? 'Desc.' : DAY_STATE_SHORT[d.state]}</span>
              </span>
              <ul className="mt-1 hidden space-y-0.5 text-xs md:block" aria-hidden>
                {d.activities.slice(0, 3).map((a) => (
                  <li key={a.entry.id} className={cn('truncate', a.sessionId && 'text-primary')}>
                    {a.sessionId ? '✓ ' : ''}
                    {a.followsRotation ? (routines.find((r) => r.id === a.entry.routineId)?.name ?? '—') : a.workoutLabel ? `Treino ${a.workoutLabel}` : '—'}
                  </li>
                ))}
                {d.activities.length === 0 && d.marker && <li className="truncate text-muted-foreground">{d.marker === 'rest' ? 'Descanso' : 'Livre'}</li>}
                {d.sessions.filter((s) => !s.entryId).length > 0 && <li className="truncate text-muted-foreground">+{d.sessions.filter((s) => !s.entryId).length} extra</li>}
              </ul>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Legenda dos ícones da faixa no celular (lá os dias mostram só o ícone; o texto está no rótulo acessível e no dia selecionado). */
function StripLegend() {
  const items: [typeof Check, string][] = [
    [Check, 'concluído'],
    [CircleDot, 'parcial'],
    [Circle, 'planejado'],
    [Moon, 'descanso'],
    [CalendarClock, 'futuro'],
    [Minus, 'sem plano'],
  ];
  return (
    <ul className="-mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground md:hidden" aria-hidden data-testid="strip-legend">
      {items.map(([I, t]) => (
        <li key={t} className="flex items-center gap-1">
          <I className="h-3 w-3" /> {t}
        </li>
      ))}
    </ul>
  );
}
