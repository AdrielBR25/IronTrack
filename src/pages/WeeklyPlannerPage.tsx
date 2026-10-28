import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, ArrowRight, CalendarCheck2, CalendarClock, CalendarPlus, Check, ChevronLeft, ChevronRight, Circle, CircleDot, Coffee, ListChecks, Minus, Moon, Pause, Pencil, Play, Plus, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { PlanConflictError, clearPlanException, removePlanEntry, replacePlanDate, setPlanMarker, updatePlanActivity } from '@/db/planner';
import { useActiveSession, useCurrentProfile, useSettings, useToday } from '@/hooks/data';
import { useCalendarInput, useStoredDecisions } from '@/hooks/useCalendar';
import { useGoals } from '@/hooks/useGoals';
import { useStartWorkout } from '@/features/routines/useStartWorkout';
import { ActivityForm, type ActivityFormMode } from '@/features/planner/ActivityForm';
import { ConsistencyCard, WeeklyGoalsCard } from '@/features/planner/WeekSummary';
import { ConflictNotice } from '@/features/calendar/ConflictNotice';
import { CalendarLegend, MonthGrid, dayAccessibleText } from '@/features/calendar/MonthGrid';
import { ConflictCenter } from '@/features/calendar/ConflictCenter';
import { RememberedDecisions } from '@/features/calendar/RememberedDecisions';
import { CalendarPrefsDialog } from '@/features/calendar/CalendarPrefsDialog';
import { useCalendarPrefs, type CalendarPrefs } from '@/features/calendar/calendarPrefs';
import { StartChoiceDialog, type StartChoice } from '@/features/calendar/StartChoiceDialog';
import { SourcesSummaryCard } from '@/features/calendar/SourcesSummary';
import { CERTAINTY_HINT, STATUS_ICON, entryLine, forecastText } from '@/features/calendar/calendarFormat';
import { ACTIVITY_TONE, DAY_STATE_SHORT, activityTitle, everyWeekday, fmtDayLong, fmtDayShort, fmtWeekRange } from '@/features/planner/plannerFormat';
import { fmtTime, weekdayShort } from '@/lib/dates';
import { cn, uid } from '@/lib/utils';
import { normIndex, type Routine, type Workout } from '@/modules/training';
import { DAY_STATUS_LABEL, conflictCounts, monthOf, nextActivity, resolveMonth, resolveWeek, shiftMonth, type ConflictGroupDay, type ResolvedDay, type ResolvedEntry } from '@/modules/calendar';
import {
  ACTIVITY_STATUS_LABEL,
  DAY_STATE_LABEL,
  buildWeek,
  compareWeeks,
  currentWeekly,
  describeEntry,
  isPlanDate,
  planForDate,
  shiftWeek,
  slotFingerprint,
  weekOf,
  weeklyGoalsForWeek,
  type DayState,
  type PlanEntry,
  type PlanSlot,
  type PlannedActivity,
} from '@/modules/planner';

// Planejamento semanal (IronTrack 2.0 F01/P13, #/planejamento). Camada de planejamento sobre a rotação: nada aqui
// avança a rotação, conclui sessões, cria treinos fictícios ou altera fichas. Tudo fica no aparelho (nunca vai para a
// IA). Ver docs/PLANEJAMENTO_SEMANAL.md.
// P14: a mesma tela é o calendário unificado (semana e mês). Cada dia é resolvido pelo domínio `@/modules/calendar`:
// sessões reais, planejamento (exceção > semanal), agenda anterior como sugestão e rotação como previsão, com avisos
// de divergência. Ver docs/CALENDARIO_UNIFICADO.md.
// P15: central "Revisar divergências", preferências de exibição (só apresentação), visão inicial preferida (links
// `?visao=` e `?data=` têm prioridade), próximo treino em destaque e acesso à importação da agenda antiga. Ver
// docs/CONSOLIDACAO_AGENDAS.md.

const STATE_ICON: Record<DayState, typeof Check> = { concluido: Check, parcial: CircleDot, planejado: Circle, futuro: CalendarClock, sem_plano: Minus };

type EditScope = 'weekly' | 'date';
type CalendarView = 'week' | 'month';

const fmtMonth = (month: string) => new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(+month.slice(0, 4), +month.slice(5, 7) - 1, 1));

export default function WeeklyPlannerPage() {
  const today = useToday();
  const input = useCalendarInput();
  const entries = input?.entries;
  const sessions = input?.sessions;
  const routines = input?.routines;
  const rotations = input?.rotations;
  const goals = useGoals();
  const active = useActiveSession();
  const settings = useSettings();
  const start = useStartWorkout();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialDate = isPlanDate(params.get('data')) ? params.get('data')! : today;
  const profile = useCurrentProfile();
  const [prefs, setPrefs] = useCalendarPrefs(profile?.id);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefsPersisted, setPrefsPersisted] = useState(true);
  const updatePrefs = (patch: Partial<CalendarPrefs>) => setPrefsPersisted(setPrefs(patch));
  const [centerOpen, setCenterOpen] = useState(params.get('revisar') === '1' || params.get('decisoes') === '1');
  const [reviewOpen, setReviewOpen] = useState(params.get('decisoes') === '1');
  const stored = useStoredDecisions();
  const [legacyChoice, setLegacyChoice] = useState<{ date: string; choice: NonNullable<ConflictGroupDay['legacyChoice']> } | null>(null);

  // Link explícito (`?visao=mes`/`?visao=semana`) > escolha feita nesta tela > preferência de visão inicial.
  const linkView: CalendarView | null = params.get('visao') === 'mes' ? 'month' : params.get('visao') === 'semana' ? 'week' : null;
  const [chosenView, setView] = useState<CalendarView | null>(linkView);
  const view: CalendarView = chosenView ?? prefs.defaultView;
  const [monday, setMonday] = useState(() => weekOf(initialDate));
  const [month, setMonth] = useState(() => monthOf(initialDate));
  const [selected, setSelected] = useState(initialDate);
  const editRef = useRef<HTMLElement>(null);
  const [scope, setScope] = useState<EditScope>('weekly');
  const [form, setForm] = useState<ActivityFormMode | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; description: string; label: string; run: () => Promise<unknown> } | null>(null);
  const [startChoice, setStartChoice] = useState<StartChoice | null>(null);
  const [activeBlock, setActiveBlock] = useState(false);

  const isCurrentWeek = monday === weekOf(today);
  // Visão unificada (só leitura, sob demanda): a semana exibida e, na visão mensal, o mês.
  const cal = useMemo(() => (input ? resolveWeek(input, monday) : null), [input, monday]);
  const week = useMemo(() => (cal ? { days: cal.days.map((d) => d.plan), consistency: cal.consistency } : null), [cal]);
  const monthCal = useMemo(() => (input && view === 'month' ? resolveMonth(input, month) : null), [input, view, month]);
  const prevWeek = useMemo(
    () => (input ? buildWeek({ entries: input.entries, sessions: input.sessions, routines: input.routines, week: shiftWeek(monday, -1), today: input.today, profileId: input.profileId }) : null),
    [input, monday],
  );
  const goalViews = useMemo(() => (goals && sessions ? weeklyGoalsForWeek(goals, sessions, monday, today) : []), [goals, sessions, monday, today]);
  const next = useMemo(() => (input ? nextActivity(input) : null), [input]);
  const centerDays = view === 'month' && monthCal ? monthCal.weeks.flatMap((w) => w.days).filter((d) => d.inMonth) : (cal?.days ?? []);
  const counts = conflictCounts(centerDays);

  const rday: ResolvedDay | null = cal?.days.find((d) => d.date === selected) ?? cal?.days[0] ?? null;
  const day = rday?.plan ?? null;

  // Escopo de edição padrão: a exceção do dia, se houver; senão o modelo semanal.
  useEffect(() => {
    if (day) setScope(day.source === 'exception' ? 'date' : 'weekly');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day?.date]);

  const goWeek = (m: string) => {
    const sel = m === weekOf(today) ? today : m;
    setMonday(m);
    setSelected(sel);
    setMonth(monthOf(sel));
  };
  const selectDate = (d: string) => {
    setSelected(d);
    setMonday(weekOf(d));
    if (view === 'month' && monthOf(d) !== month) setMonth(monthOf(d));
  };
  const goMonth = (m: string) => {
    setMonth(m);
    const sel = m === monthOf(today) ? today : `${m}-01`;
    setSelected(sel);
    setMonday(weekOf(sel));
  };
  // Links explícitos também valem com a tela já aberta (HashRouter não remonta a página ao mudar só a busca).
  const linkDate = isPlanDate(params.get('data')) ? params.get('data')! : null;
  const firstLink = useRef(true);
  useEffect(() => {
    if (firstLink.current) {
      firstLink.current = false;
      return;
    }
    if (linkView) setView(linkView);
    if (linkDate) {
      setSelected(linkDate);
      setMonday(weekOf(linkDate));
      setMonth(monthOf(linkDate));
    }
    if (params.get('revisar') === '1' || params.get('decisoes') === '1') setCenterOpen(true);
    if (params.get('decisoes') === '1') setReviewOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkView, linkDate, params.get('revisar'), params.get('decisoes')]);

  const changeView = (v: CalendarView) => {
    setView(v);
    if (v === 'month') setMonth(monthOf(selected));
    else setMonday(weekOf(selected));
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
  const slotOf = (d: { weekday: number; date: string }, s: EditScope): PlanSlot => (s === 'weekly' ? { scope: 'weekly', weekday: d.weekday } : { scope: 'date', date: d.date });
  const fp = (slot: PlanSlot) => slotFingerprint(entries ?? [], slot, today);

  async function guarded(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(e instanceof PlanConflictError ? e.message : 'Não foi possível alterar o planejamento. Nada foi gravado.');
    }
  }

  function useLegacyForDay() {
    if (!legacyChoice || !entries) return;
    const { date, choice } = legacyChoice;
    const expected = slotFingerprint(entries, { scope: 'date', date }, today);
    return guarded(
      () => replacePlanDate({ id: uid(), date, kind: choice.kind, activity: choice.kind === 'workout' ? { routineId: choice.routineId, workoutId: choice.workoutId } : undefined, expected }),
      `Planejamento de ${fmtDayShort(date)} alterado (só neste dia)`,
    );
  }
  const openDay = (date: string, edit = false) => {
    selectDate(date);
    if (edit) setTimeout(() => editRef.current?.scrollIntoView({ block: 'start' }), 0);
  };

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

  if (!week || !day || !rday || !routines || !cal) return <div className="space-y-4">{header}<div className="h-40 animate-pulse rounded-2xl bg-card" /></div>;

  const cmp = prevWeek ? compareWeeks(week.consistency, prevWeek.consistency) : null;

  return (
    <div className="space-y-4" data-testid="planner-page">
      {header}

      <Segmented<CalendarView>
        aria-label="Visão do calendário"
        value={view}
        onChange={changeView}
        options={[
          { value: 'week', label: <span data-testid="view-week">Semana</span> },
          { value: 'month', label: <span data-testid="view-month">Mês</span> },
        ]}
      />

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" data-testid="planner-toolbar">
        <Button
          variant={counts.warningDays ? 'default' : 'outline'}
          className="col-span-2 h-auto min-h-11 whitespace-normal py-2 sm:col-span-1"
          aria-expanded={centerOpen}
          onClick={() => setCenterOpen((v) => !v)}
          data-testid="open-conflict-center"
          data-warnings={counts.warningDays}
        >
          {counts.warningDays ? <AlertTriangle /> : <ListChecks />}
          Revisar divergências
          <span className="rounded-full bg-background/20 px-1.5 text-xs tabular" aria-label={`${counts.warningDays} com aviso, ${counts.infoDays} só com observações`}>
            {counts.warningDays}
            {prefs.showInfo && counts.infoDays ? ` + ${counts.infoDays}` : ''}
          </span>
        </Button>
        <Button variant="outline" className="h-auto min-h-11 whitespace-normal py-2" onClick={() => setPrefsOpen(true)} data-testid="open-calendar-prefs">
          <SlidersHorizontal /> Exibição
        </Button>
        <Button variant="outline" className="h-auto min-h-11 whitespace-normal py-2" asChild>
          <Link to="/planejamento/importar" data-testid="open-import">
            <CalendarPlus /> Importar agenda antiga
          </Link>
        </Button>
      </div>

      {centerOpen && (
        <ConflictCenter
          days={centerDays}
          rangeLabel={view === 'month' ? `Divergências de ${fmtMonth(month)}` : `Divergências da semana ${week ? fmtWeekRange(week.days[0].date, week.days[6].date) : ''}`}
          showInfo={prefs.showInfo}
          onShowInfo={(v) => updatePrefs({ showInfo: v })}
          onOpenDay={(d) => openDay(d)}
          onEditDay={(d) => openDay(d, true)}
          onUseLegacy={(date, choice) => setLegacyChoice({ date, choice })}
          onReviewDecisions={() => setReviewOpen((v) => !v)}
          reviewOpen={reviewOpen}
        />
      )}
      {centerOpen && reviewOpen && input && <RememberedDecisions input={input} invalidCount={stored?.invalidIds.length ?? 0} onOpenDay={(d) => openDay(d)} />}

      {view === 'week' ? (
        <>
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

      {isCurrentWeek && <NextBanner next={next} prefs={prefs} onOpen={(d) => openDay(d)} />}
      <WeekStrip days={cal.days} selected={day.date} onSelect={selectDate} routines={routines} prefs={prefs} nextDate={next?.day.date ?? null} />
      <StripLegend prefs={prefs} />
        </>
      ) : (
        monthCal && (
          <section aria-label="Calendário do mês" className="space-y-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" aria-label="Mês anterior" onClick={() => goMonth(shiftMonth(month, -1))} data-testid="month-prev">
                <ChevronLeft />
              </Button>
              <p className="min-w-0 flex-1 text-center font-display font-semibold first-letter:uppercase" aria-live="polite" data-testid="month-label">
                {fmtMonth(month)}
              </p>
              <Button variant="outline" size="icon" aria-label="Próximo mês" onClick={() => goMonth(shiftMonth(month, 1))} data-testid="month-next">
                <ChevronRight />
              </Button>
            </div>
            {(month !== monthOf(today) || selected !== today) && (
              <Button variant="secondary" size="sm" className="w-full" onClick={() => goMonth(monthOf(today))} data-testid="month-today">
                <CalendarCheck2 /> Voltar para hoje
              </Button>
            )}
            <MonthGrid month={monthCal} selected={selected} onSelect={selectDate} prefs={prefs} />
            <CalendarLegend prefs={prefs} />
            <p className="rounded-xl bg-secondary/50 px-3 py-2 text-xs" aria-live="polite" data-testid="month-day-summary">
              {rday ? dayAccessibleText(rday, prefs) : ''}
              {rday && primaryLine(rday, prefs) ? ` · ${primaryLine(rday, prefs)}` : ''}
            </p>
          </section>
        )
      )}

      {/* Dia selecionado */}
      <Card className="space-y-4 p-4" data-testid="plan-day" data-date={day.date} data-state={day.state} data-status={rday.status} data-origin={rday.origin}>
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
          {rday.status !== 'planned' && rday.status !== 'empty' && DAY_STATUS_LABEL[rday.status] !== DAY_STATE_LABEL[day.state] && (
            <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium" data-testid="plan-day-status">
              {(() => {
                const I = STATUS_ICON[rday.status];
                return <I className="h-3.5 w-3.5" aria-hidden />;
              })()}
              {DAY_STATUS_LABEL[rday.status]}
            </span>
          )}
        </div>

        {day.markerConflict && (
          <p className="rounded-xl bg-warn/15 p-3 text-sm text-warn">Este dia tem descanso e treinos ao mesmo tempo (ex.: depois de mesclar um backup). Os treinos valem; ajuste o dia abaixo.</p>
        )}

        <ConflictNotice
          day={rday}
          onEditPlan={editable ? () => editRef.current?.scrollIntoView({ block: 'start' }) : undefined}
          legacyHref="/treinos"
          showInfo={prefs.showInfo}
        />

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
                const forecast = rday.forecasts[a.entry.id];
                const canStart = day.isToday && a.status === 'pendente' && a.availability === 'ok';
                const rotNext = !a.followsRotation && canStart ? rotationNext(a.entry.routineId) : null;
                return (
                  <li key={a.entry.id} className="rounded-xl border p-3" data-testid="plan-activity" data-status={a.status}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-words font-medium" data-testid="plan-activity-title">
                        {a.followsRotation && a.availability === 'ok' ? `${a.routineName} · ${prefs.showForecasts || forecast?.certainty === 'fact' ? forecastText(forecast) : 'pela rotação'}` : activityTitle(a, null)}
                      </span>
                      <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', ACTIVITY_TONE[a.status])} data-testid="plan-activity-status">
                        {a.status === 'realizada' && <Check className="h-3 w-3" aria-hidden />}
                        {ACTIVITY_STATUS_LABEL[a.status]}
                      </span>
                    </div>
                    {a.availability === 'ok' && a.routineName && !a.followsRotation && <p className="text-xs text-muted-foreground">{a.routineName}</p>}
                    {a.followsRotation && a.availability === 'ok' && prefs.showForecasts && forecast && CERTAINTY_HINT[forecast.certainty] && (
                      <p className="mt-1 text-xs text-muted-foreground" data-testid="plan-forecast-note" data-certainty={forecast.certainty}>
                        {CERTAINTY_HINT[forecast.certainty]}
                      </p>
                    )}
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

        <LegacySection day={rday} show={prefs.showLegacy} onShow={() => updatePrefs({ showLegacy: true })} />

        {/* Ajustes (só hoje e dias futuros) */}
        {editable ? (
          <section ref={editRef} aria-label="Ajustar planejamento" className="scroll-mt-4 space-y-3 border-t pt-3" data-testid="plan-edit">
            <p className="text-xs font-medium text-foreground/80" data-testid="plan-edit-model">
              Estes ajustes alteram só o planejamento semanal (ou uma exceção desta data). A agenda anterior e a rotação não mudam: elas ficam em Treinos.
            </p>
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
        {view === 'month' && monthCal ? (
          <SourcesSummaryCard summary={monthCal.summary} title={`Resumo de ${fmtMonth(month)}`} testId="month-summary" />
        ) : (
          <>
            <ConsistencyCard c={week.consistency} cmp={cmp} isCurrent={isCurrentWeek} />
            <SourcesSummaryCard summary={cal.summary} compact testId="week-sources" />
          </>
        )}
        {prefs.showGoals ? (
          <WeeklyGoalsCard views={goalViews} isFuture={monday > weekOf(today)} />
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="goals-hidden">
            Metas da semana ocultas pelas preferências de exibição (as metas não mudam).{' '}
            <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => updatePrefs({ showGoals: true })}>
              Mostrar
            </button>
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        O planejamento fica só neste aparelho (e nos backups). Ele não avança a rotação, não conclui treinos, não altera fichas e não é enviado ao assistente de IA. O
        calendário combina, só para exibir, o planejamento, a agenda anterior e a rotação; nenhum deles é alterado sem você pedir.
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

      <CalendarPrefsDialog open={prefsOpen} onOpenChange={setPrefsOpen} prefs={prefs} onChange={updatePrefs} persisted={prefsPersisted} />

      <ConfirmDialog
        open={!!legacyChoice}
        onOpenChange={(o) => !o && setLegacyChoice(null)}
        title="Usar a agenda antiga só neste dia?"
        description={
          legacyChoice
            ? `Alteração de planejamento (não é só exibição): ${fmtDayLong(legacyChoice.date)} passa a ter só: ${legacyChoice.choice.kind === 'rest' ? 'descanso' : legacyChoice.choice.label} (exceção do planejamento). O planejamento semanal, a agenda antiga, a rotação e os treinos registrados não mudam.`
            : undefined
        }
        confirmLabel="Usar só neste dia"
        onConfirm={async () => void (await useLegacyForDay())}
      />

      <StartChoiceDialog choice={startChoice} onClose={() => setStartChoice(null)} onStart={(r, w) => void start(r, w)} />

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
function WeekStrip({ days: resolved, selected, onSelect, routines, prefs, nextDate }: { days: ResolvedDay[]; selected: string; onSelect: (d: string) => void; routines: Routine[]; prefs: CalendarPrefs; nextDate: string | null }) {
  const days = resolved.map((r) => r.plan);
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
        const shownState = !prefs.showSessions && (d.state === 'concluido' || d.state === 'parcial') ? 'planejado' : d.state;
        const Icon = d.marker === 'rest' && d.state !== 'futuro' ? Moon : STATE_ICON[shownState];
        const isSel = d.date === selected;
        const summary = d.activities.length ? `${d.activities.length} ${d.activities.length === 1 ? 'atividade planejada' : 'atividades planejadas'}` : d.marker === 'rest' ? 'descanso' : d.marker === 'free' ? 'dia livre' : 'nada planejado';
        const done = d.sessions.length ? `, ${d.sessions.length} ${d.sessions.length === 1 ? 'treino registrado' : 'treinos registrados'}` : '';
        const r = resolved[i];
        const showLegacy = prefs.showLegacy && r.origin === 'legacy' && r.legacy?.kind === 'workout';
        const legacyNote = showLegacy ? ', sugestão da agenda anterior' : '';
        const warn = r.hasWarning ? ', divergência entre agendas' : '';
        const isNext = d.date === nextDate;
        const today = d.isToday ? ', hoje' : '';
        const nextNote = isNext ? ', próximo treino' : '';
        const done2 = prefs.showSessions ? done : '';
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
              aria-label={`${fmtDayLong(d.date)}${today}: ${DAY_STATE_LABEL[d.state]}, ${summary}${done2}${legacyNote}${nextNote}${warn}`}
              data-testid="week-day"
              data-date={d.date}
              data-state={d.state}
              data-status={r.status}
              data-warning={r.hasWarning ? 'true' : 'false'}
              className={cn(
                'relative flex h-full min-h-[4.5rem] w-full flex-col items-center gap-0.5 rounded-xl border px-0.5 py-1.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:items-stretch md:px-2 md:text-left',
                isSel ? 'border-primary bg-primary/10' : 'bg-card hover:bg-accent',
                d.isToday && !isSel && 'border-primary/60 border-2',
                isNext && !isSel && !d.isToday && 'border-primary/40 border-dashed',
              )}
            >
              {r.hasWarning && <AlertTriangle className="absolute right-0.5 top-0.5 h-3 w-3 text-warn" aria-hidden />}
              <span className={cn('text-[11px] font-medium uppercase', d.isToday ? 'text-primary' : 'text-muted-foreground')}>{d.isToday ? 'Hoje' : weekdayShort(d.weekday)}</span>
              <span className={cn('font-display text-lg font-bold leading-none tabular', d.isToday && 'text-primary')}>{Number(d.date.slice(8))}</span>
              <span className="mt-0.5 flex max-w-full items-center gap-0.5 text-xs leading-tight text-muted-foreground">
                <Icon className="h-3.5 w-3.5 shrink-0 md:h-3 md:w-3" aria-hidden />
                <span className="hidden truncate md:inline">{d.marker === 'rest' && d.activities.length === 0 && d.state !== 'futuro' ? 'Desc.' : DAY_STATE_SHORT[shownState]}</span>
              </span>
              <ul className="mt-1 hidden space-y-0.5 text-xs md:block" aria-hidden>
                {d.activities.slice(0, 3).map((a) => {
                  const f = r.forecasts[a.entry.id];
                  const label = a.followsRotation
                    ? prefs.showForecasts && f?.workoutLabel
                      ? `Treino ${f.workoutLabel}${f.certainty === 'forecast' ? ' (prev.)' : ''}`
                      : (routines.find((x) => x.id === a.entry.routineId)?.name ?? '—')
                    : a.workoutLabel
                      ? `Treino ${a.workoutLabel}`
                      : '—';
                  return (
                    <li key={a.entry.id} className={cn('truncate', a.sessionId && prefs.showSessions && 'text-primary')}>
                      {a.sessionId && prefs.showSessions ? '✓ ' : ''}
                      {label}
                    </li>
                  );
                })}
                {d.activities.length === 0 && d.marker && <li className="truncate text-muted-foreground">{d.marker === 'rest' ? 'Descanso' : 'Livre'}</li>}
                {showLegacy && r.legacy && (
                  <li className="truncate italic text-muted-foreground">Sug. {r.legacy.workoutLabel && prefs.showForecasts ? `Treino ${r.legacy.workoutLabel}` : 'treino'}</li>
                )}
                {prefs.showSessions && d.sessions.filter((s) => !s.entryId).length > 0 && <li className="truncate text-muted-foreground">+{d.sessions.filter((s) => !s.entryId).length} extra</li>}
                {isNext && <li className="truncate font-medium text-primary">Próximo</li>}
              </ul>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Legenda dos ícones da faixa no celular (lá os dias mostram só o ícone; o texto está no rótulo acessível e no dia selecionado). */
function StripLegend({ prefs }: { prefs: CalendarPrefs }) {
  const items: [typeof Check, string][] = [
    ...(prefs.showSessions ? ([[Check, 'concluído'], [CircleDot, 'parcial']] as [typeof Check, string][]) : []),
    [Circle, 'planejado'],
    [Moon, 'descanso'],
    [CalendarClock, 'futuro'],
    [AlertTriangle, 'divergência'],
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

/** Agenda anterior do dia: visível sempre, dizendo se define o dia (sem planejamento) ou não (planejamento tem prioridade). */
function LegacySection({ day, show, onShow }: { day: ResolvedDay; show: boolean; onShow: () => void }) {
  const e = day.entries.find((x) => x.origin.startsWith('legacy'));
  if (!e || day.isPast) return null;
  const defines = day.origin === 'legacy';
  // P15: depois de importar, a agenda anterior costuma dizer o mesmo que o planejamento: mostra uma vez só.
  if (day.legacyAgrees && !day.hasWarning)
    return (
      <p className="flex items-center gap-2 rounded-xl bg-secondary/40 px-3 py-2 text-xs text-muted-foreground" data-testid="plan-legacy" data-defines="false" data-agrees="true">
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> A agenda anterior indica o mesmo que o planejamento neste dia.
      </p>
    );
  if (!show && !day.hasWarning)
    return (
      <p className="rounded-xl bg-secondary/40 px-3 py-2 text-xs text-muted-foreground" data-testid="plan-legacy-hidden">
        Sugestão da agenda anterior oculta pelas preferências de exibição.{' '}
        <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={onShow}>
          Mostrar
        </button>
      </p>
    );
  return (
    <section aria-label="Agenda anterior" className="rounded-xl bg-secondary/40 p-3 text-sm" data-testid="plan-legacy" data-defines={defines ? 'true' : 'false'}>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Agenda anterior</h3>
      <p className="break-words" data-testid="plan-legacy-text">
        {entryLine(e)} · <span className="text-muted-foreground">{e.state}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {defines
          ? 'Sem planejamento para este dia: vale a sugestão da agenda anterior (dias de treino das Configurações e reagendamentos da tela Treinos). Ela não conta como atividade planejada.'
          : 'O planejamento tem prioridade neste dia. A agenda anterior continua guardada, sem alteração.'}
        {e.certainty === 'forecast' ? ' O treino indicado é previsão baseada na rotação atual.' : ''}
        {e.certainty === 'undetermined' ? ' Treino a definir pela rotação.' : ''}
      </p>
      <Link to="/treinos" className="mt-1 inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-4 hover:underline" data-testid="plan-legacy-link">
        Consultar a agenda anterior em Treinos
      </Link>
    </section>
  );
}

/** Linha curta do que define o dia (para o resumo do dia selecionado no mês), respeitando as preferências. */
function primaryLine(day: ResolvedDay, prefs: CalendarPrefs): string {
  const list = day.entries.filter((e) => !e.shadowed && e.origin !== 'active_session' && (prefs.showSessions || e.origin !== 'session') && (prefs.showLegacy || !e.origin.startsWith('legacy')));
  return list
    .map((e: ResolvedEntry) => (e.followsRotation && !prefs.showForecasts && e.origin !== 'session' ? `${e.routineName ?? 'Rotina'}: pela rotação` : entryLine(e)))
    .join(' + ');
}

/** Próximo treino (planejado ou sugerido) em destaque na semana atual. Previsão sempre identificada. */
function NextBanner({ next, prefs, onOpen }: { next: ReturnType<typeof nextActivity>; prefs: CalendarPrefs; onOpen: (date: string) => void }) {
  if (!next || (!prefs.showLegacy && !next.entry.origin.startsWith('plan_'))) return null;
  const isPlan = next.entry.origin.startsWith('plan_');
  const what = next.entry.followsRotation && !prefs.showForecasts ? `${next.entry.routineName ?? 'Rotina'} (pela rotação)` : entryLine(next.entry);
  return (
    <button
      type="button"
      onClick={() => onOpen(next.day.date)}
      className="flex min-h-11 w-full items-center gap-2 rounded-xl border bg-card px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="planner-next"
      data-date={next.day.date}
    >
      <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 break-words">
        <span className="text-muted-foreground">Próximo treino: </span>
        <strong>{what}</strong> · {fmtDayShort(next.day.date)}
        <span className="block text-xs text-muted-foreground">{isPlan ? 'Planejado' : 'Sugestão da agenda anterior (não conta como planejado)'}</span>
      </span>
    </button>
  );
}
