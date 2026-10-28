import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarCheck2, CalendarDays, ChevronRight, Clock, Coffee, Dumbbell, FileUp, Flame, Moon, Play, Sparkles, TrendingDown, TrendingUp, Trophy, Weight } from 'lucide-react';
import { toast } from 'sonner';
import { useActiveRoutine, useActiveSession, useCompletedSessions, useToday } from '@/hooks/data';
import { useCalendarInput, type CalendarData } from '@/hooks/useCalendar';
import { StartChoiceDialog, type StartChoice } from '@/features/calendar/StartChoiceDialog';
import { entryLine } from '@/features/calendar/calendarFormat';
import { nextActivity, primaryEntries, resolveDay, resolveWeek, rotationStatus, type ResolvedDay, type ResolvedEntry } from '@/modules/calendar';
import { useStartWorkout } from '@/features/routines/useStartWorkout';
import { importFichaFile, loadSampleFicha } from '@/features/routines/importFicha';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LogoMark } from '@/components/Logo';
import { InstallBanner } from '@/components/InstallBanner';
import { addDays, fmtDateLong, fmtDateShort, tsToISODate, weekday, weekdayShort } from '@/lib/dates';
import { consistency, exerciseSeries, weekStats, sessionProgress, sessionVolume } from '@/modules/training';
import { cn, fmtDuration, fmtNum } from '@/lib/utils';
import { useUnits } from '@/hooks/useUnits';
import { saveSettings } from '@/db/db';
import type { Routine, WorkoutSession } from '@/lib/types';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Boa noite';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function Onboarding() {
  const [name, setName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  return (
    <Card className="overflow-hidden">
      <div className="bg-gradient-to-br from-primary/25 via-primary/5 to-transparent p-5">
        <LogoMark className="h-12 w-12" />
        <h2 className="mt-4 font-display text-2xl font-bold">Bem-vindo ao IronTrack</h2>
        <p className="mt-1 text-sm text-muted-foreground">Comece importando sua ficha de treino. Tudo fica salvo neste aparelho, sem login.</p>
      </div>
      <CardContent className="space-y-4 pt-4">
        <div className="flex gap-2">
          <Input placeholder="Como quer ser chamado?" value={name} onChange={(e) => setName(e.target.value)} aria-label="Seu nome" />
          <Button variant="secondary" disabled={!name.trim()} onClick={() => void saveSettings({ userName: name.trim() }).then(() => toast.success('Nome salvo'))}>
            Salvar
          </Button>
        </div>
        <div className="grid gap-2">
          <Button size="lg" onClick={() => void loadSampleFicha()} data-testid="load-sample">
            <Sparkles /> Usar ficha ABC de exemplo
          </Button>
          <Button size="lg" variant="outline" onClick={() => fileRef.current?.click()}>
            <FileUp /> Importar ficha (JSON)
          </Button>
          <Button size="lg" variant="ghost" onClick={() => navigate('/treinos')}>
            <Dumbbell /> Montar meus treinos manualmente
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const r = await importFichaFile(f);
            if (r.ok) toast.success(`Ficha "${r.routine.name}" importada`);
            else toast.error('Ficha inválida', { description: r.errors.join('\n'), duration: 10000 });
          }}
        />
      </CardContent>
    </Card>
  );
}

/** Rótulo curto de origem do que é mostrado na Início (o usuário sempre sabe se é plano, sugestão ou previsão). */
function originCaption(e: ResolvedEntry): string {
  if (e.origin === 'plan_exception') return 'Planejamento só de hoje (exceção)';
  if (e.origin === 'plan_recurring') return e.followsRotation ? 'Planejamento semanal · treino pela rotação' : 'Planejamento semanal';
  if (e.origin === 'legacy_override') return 'Reagendado na agenda anterior';
  if (e.origin === 'legacy_rotation') return 'Sugestão da agenda anterior (dias de treino das Configurações)';
  return 'Agenda anterior';
}

/** P15: origem do que a Início mostra para hoje, em texto (concluído, planejado, sugestão, descanso ou nada). */
function todaySource(day: ResolvedDay, isDone: boolean, pending: ResolvedEntry | undefined, marker: ResolvedEntry | undefined): string {
  if (isDone) return `Concluído · ${day.plan.sessions.length === 1 ? '1 treino registrado' : `${day.plan.sessions.length} treinos registrados`}`;
  if (pending) return `${pending.origin.startsWith('plan_') ? 'Planejado' : 'Sugestão'} · ${originCaption(pending)}`;
  if (marker) return `${marker.kind === 'rest' ? 'Descanso' : 'Dia livre'} · ${originCaption(marker)}`;
  if (day.legacy?.kind === 'rest') return day.legacy.source === 'override' ? 'Descanso · reagendado na agenda anterior' : 'Descanso · agenda anterior (não é dia de treino)';
  return 'Nada planejado para hoje';
}

const fmtNext = (date: string) => `${weekdayShort(weekday(date))} ${fmtDateShort(date)}`;

/**
 * Hoje na Início (P14): usa a visão unificada (mesma resolução da tela Planejamento). O treino em andamento tem
 * prioridade operacional; nada é iniciado sozinho e previsões nunca aparecem como obrigação.
 */
function TodayCard({ routine, input }: { routine: Routine; input: CalendarData | undefined }) {
  const active = useActiveSession();
  const start = useStartWorkout();
  const navigate = useNavigate();
  const [choice, setChoice] = useState<StartChoice | null>(null);
  const view = useMemo(() => {
    if (!input) return null;
    return { day: resolveDay(input, input.today), next: nextActivity(input), rotation: rotationStatus(input, routine.id) };
  }, [input, routine.id]);
  if (!view || active === undefined || !input) return <Card className="h-56 animate-pulse" />;

  if (active) {
    const p = sessionProgress(active);
    return (
      <Card className="relative overflow-hidden border-primary/50">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent" />
        <CardContent className="relative space-y-4 p-5">
          <Badge>Em andamento</Badge>
          <div>
            <p className="font-display text-3xl font-bold">Treino {active.workoutLabel}</p>
            <p className="text-muted-foreground">{active.workoutName}</p>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-primary" style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
          </div>
          <p className="text-sm text-muted-foreground tabular">
            {p.done} de {p.total} séries concluídas
          </p>
          <Button size="xl" className="w-full font-display font-bold" onClick={() => navigate('/treino')} data-testid="continue-workout">
            <Play className="fill-current" /> CONTINUAR TREINO
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (routine.workouts.length === 0) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="font-semibold">Sua rotina ainda não tem treinos.</p>
          <Button className="mt-3" onClick={() => navigate('/treinos')}>
            Adicionar treinos
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { day, next, rotation } = view;
  const pointerWorkout = rotation?.next ?? routine.workouts[0];
  const primary = primaryEntries(day);
  // Primeira atividade de treino ainda pendente hoje (planejada ou sugerida).
  const pending = primary.find((e) => e.kind === 'workout' && !e.sessionId);
  const pendingRoutine = pending ? input.routines.find((r) => r.id === pending.routineId) : undefined;
  const target = pending && pendingRoutine ? pendingRoutine.workouts.find((w) => w.id === pending.workoutId) : undefined;
  const isDone = day.status === 'done' || day.status === 'trained' || (day.plan.sessions.length > 0 && !target);
  const isRest = !isDone && !target && (day.status === 'rest' || day.status === 'free' || day.status === 'empty');
  const doneSessions = day.plan.sessions.map((s) => s.session);
  const marker = primary.find((e) => e.kind !== 'workout');
  const restTitle = day.status === 'free' ? 'Dia livre' : day.status === 'empty' ? 'Nada planejado' : 'Dia de descanso';
  const restCaption = marker ? originCaption(marker) : day.legacy?.source === 'off' ? 'Agenda anterior: não é dia de treino' : 'Sem planejamento para hoje';
  const startTarget = target ?? pointerWorkout;
  const targetRoutineId = target && pendingRoutine ? pendingRoutine.id : routine.id;
  const sets = startTarget.exercises.reduce((a, e) => a + e.sets + e.warmupSets, 0);
  const estMin = Math.round(startTarget.exercises.reduce((a, e) => a + (e.sets + e.warmupSets) * (45 + e.restSec), 0) / 60);
  const warnings = day.conflicts.filter((c) => c.severity === 'warning');

  const onStart = () => {
    if (target && pendingRoutine && pending?.origin.startsWith('plan_') && !pending.followsRotation) {
      const rotNext = rotationStatus(input, pendingRoutine.id)?.next;
      if (rotNext && rotNext.id !== target.id) return setChoice({ routine: pendingRoutine, planned: target, next: rotNext });
    }
    void start(targetRoutineId, startTarget.id);
  };

  return (
    <Card className="relative overflow-hidden" data-testid="home-today" data-status={day.status} data-origin={day.origin}>
      <div className={cn('absolute inset-0 bg-gradient-to-br to-transparent', isRest || isDone ? 'from-secondary/60' : 'from-primary/20')} />
      <CardContent className="relative space-y-4 p-5">
        <div className="flex items-center justify-between gap-2">
          <Badge variant={isRest || isDone ? 'secondary' : 'default'}>
            {isDone ? (
              <>
                <CalendarCheck2 /> Concluído hoje
              </>
            ) : isRest ? (
              <>
                {day.status === 'free' ? <Coffee /> : <Moon />} {restTitle}
              </>
            ) : (
              <>
                <Flame /> {pending?.origin.startsWith('plan_') ? 'Planejado para hoje' : 'Treino de hoje'}
              </>
            )}
          </Badge>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{target && pendingRoutine ? pendingRoutine.name : routine.name}</span>
        </div>
        {warnings.length > 0 && (
          <Link
            to={`/planejamento?data=${day.date}`}
            className="flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="home-conflict"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            <span className="min-w-0 break-words">
              {warnings[0].message} <span className="font-medium text-primary">Ver no planejamento</span>
            </span>
          </Link>
        )}
        {isDone ? (
          <div>
            <p className="font-display text-2xl font-bold" data-testid="home-done">
              {doneSessions.map((s) => `Treino ${s.workoutLabel}`).join(' + ')} feito ✓
            </p>
            {day.plan.activities.length > day.plan.activities.filter((a) => a.sessionId).length && <p className="text-sm text-muted-foreground">Ainda há atividade planejada para hoje.</p>}
          </div>
        ) : isRest ? (
          <div>
            <p className="font-display text-4xl font-bold tracking-tight">{day.status === 'empty' ? 'Dia livre' : 'Recupere-se'}</p>
            <p className="text-sm text-muted-foreground">{restCaption}</p>
          </div>
        ) : (
          <div>
            <p className="font-display text-4xl font-bold tracking-tight">
              Treino <span className="text-primary">{startTarget.label}</span>
            </p>
            <p className="text-muted-foreground">{startTarget.name}</p>
            {pending && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="home-today-origin">
                {originCaption(pending)}
              </p>
            )}
          </div>
        )}
        {!isRest && !isDone && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {startTarget.exercises.slice(0, 6).map((e) => (
                <span key={e.id} className="rounded-full bg-secondary px-2.5 py-1 text-xs">
                  {e.name}
                </span>
              ))}
              {startTarget.exercises.length > 6 && <span className="rounded-full bg-secondary px-2.5 py-1 text-xs">+{startTarget.exercises.length - 6}</span>}
            </div>
            <p className="flex gap-4 text-sm text-muted-foreground tabular">
              <span className="flex items-center gap-1">
                <Dumbbell className="h-4 w-4" /> {startTarget.exercises.length} exercícios · {sets} séries
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-4 w-4" /> ~{estMin} min
              </span>
            </p>
          </>
        )}
        <dl className="grid gap-1 rounded-xl bg-secondary/40 p-3 text-xs" data-testid="home-calendar-info">
          <div className="flex flex-wrap justify-between gap-x-2">
            <dt className="text-muted-foreground">Hoje</dt>
            <dd className="min-w-0 break-words text-right" data-testid="home-today-source">
              {todaySource(day, isDone, pending, marker)}
              {day.legacyAgrees ? <span className="block text-muted-foreground">A agenda anterior indica o mesmo.</span> : null}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-2">
            <dt className="text-muted-foreground">Rotação</dt>
            <dd data-testid="home-rotation">
              Próximo: <strong>Treino {pointerWorkout.label}</strong> · {routine.workouts.map((w) => w.label).join(' → ')}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-2">
            <dt className="text-muted-foreground">Próxima atividade</dt>
            <dd className="min-w-0 break-words text-right" data-testid="home-next">
              {next ? (
                <>
                  <strong>{entryLine(next.entry)}</strong> · {fmtNext(next.day.date)}
                  <span className="block text-muted-foreground">
                    {next.entry.origin.startsWith('plan_') ? (next.entry.followsRotation && next.entry.certainty === 'forecast' ? 'Planejada · previsão baseada na rotação atual' : 'Planejada') : next.entry.certainty === 'forecast' ? 'Sugestão da agenda anterior · previsão baseada na rotação atual' : next.entry.certainty === 'undetermined' ? 'Sugestão da agenda anterior · treino a definir pela rotação' : 'Sugestão da agenda anterior'}
                  </span>
                </>
              ) : (
                'Nada planejado nos próximos dias'
              )}
            </dd>
          </div>
        </dl>
        <Button
          size="xl"
          variant={isRest || isDone ? 'secondary' : 'default'}
          className="w-full font-display font-bold"
          onClick={() => (isRest || isDone ? void start(routine.id, pointerWorkout.id) : onStart())}
          data-testid="start-workout"
        >
          <Play className="fill-current" /> {isRest || isDone ? `TREINAR MESMO ASSIM (${pointerWorkout.label})` : 'INICIAR TREINO'}
        </Button>
      </CardContent>
      <StartChoiceDialog choice={choice} onClose={() => setChoice(null)} onStart={(r, w) => void start(r, w)} />
    </Card>
  );
}

function Stat({ icon: Icon, label, value, hint, accent }: { icon: typeof Clock; label: string; value: React.ReactNode; hint?: React.ReactNode; accent?: boolean }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className={cn('h-4 w-4', accent && 'text-primary')} /> {label}
      </div>
      <p className="mt-2 font-display text-2xl font-bold tabular">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** Semana na Início (P14): mesma resolução do Planejamento. Planejado, sugestão e descanso com texto acessível. */
function WeekDots({ days }: { days: ResolvedDay[] }) {
  return (
    <div className="flex justify-between gap-1" data-testid="home-week">
      {days.map((d) => {
        const done = d.plan.sessions.length > 0;
        const planned = d.status === 'planned' || d.status === 'partial' || d.status === 'not_recorded' || d.status === 'in_progress';
        const suggested = d.status === 'suggested' || (d.isPast && !done && d.origin === 'none' && d.legacy?.kind === 'workout');
        const label = done ? 'treinou' : planned ? (d.status === 'not_recorded' ? 'planejado, sem registro' : 'treino planejado') : suggested ? 'sugestão da agenda anterior' : d.status === 'rest' ? 'descanso' : d.status === 'free' ? 'dia livre' : 'nada planejado';
        return (
          <div key={d.date} className="flex flex-1 flex-col items-center gap-1.5">
            <span className={cn('text-[11px]', d.isToday ? 'font-bold text-foreground' : 'text-muted-foreground')}>{weekdayShort(d.weekday).slice(0, 3)}</span>
            <span
              className={cn(
                'relative flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold',
                done ? 'bg-primary text-primary-foreground' : planned ? 'border-2 border-primary/60' : suggested ? 'border-2 border-dashed border-muted-foreground/40' : 'bg-secondary/40',
                d.isToday && !done && 'ring-2 ring-primary ring-offset-2 ring-offset-card',
              )}
              aria-label={`${weekdayShort(d.weekday)}: ${label}${d.hasWarning ? ', divergência entre agendas' : ''}`}
              data-testid="home-week-day"
              data-status={d.status}
            >
              {done ? '✓' : Number(d.date.slice(8))}
              {d.hasWarning && <AlertTriangle className="absolute -right-1 -top-1 h-3 w-3 text-warn" aria-hidden />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RecentEvolution({ sessions }: { sessions: WorkoutSession[] }) {
  const { fmtW } = useUnits();
  const last = [...sessions].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!last) return null;
  const items = last.exercises
    .map((e) => {
      const series = exerciseSeries(sessions, e.exerciseKey);
      if (series.length < 2) return null;
      const a = series[series.length - 2];
      const b = series[series.length - 1];
      return { name: e.name, from: a.maxWeight, to: b.maxWeight, repsFrom: a.bestReps, repsTo: b.bestReps };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 4);
  if (!items.length) return <p className="text-sm text-muted-foreground">Complete o mesmo treino mais uma vez para ver a evolução das cargas.</p>;
  return (
    <ul className="divide-y">
      {items.map((it) => {
        const diff = it.to - it.from;
        const repDiff = it.repsTo - it.repsFrom;
        return (
          <li key={it.name} className="flex items-center gap-3 py-2.5">
            <span className="flex-1 truncate text-sm">{it.name}</span>
            <span className="text-sm tabular text-muted-foreground">{fmtW(it.to)}</span>
            <Badge variant={diff > 0 || (diff === 0 && repDiff > 0) ? 'default' : diff < 0 ? 'warn' : 'secondary'} className="w-20 justify-center tabular">
              {diff > 0 ? <TrendingUp /> : diff < 0 ? <TrendingDown /> : null}
              {diff !== 0 ? `${diff > 0 ? '+' : ''}${fmtW(diff, false)}` : repDiff !== 0 ? `${repDiff > 0 ? '+' : ''}${repDiff} rep` : '='}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

export default function HomePage() {
  const { routine, settings } = useActiveRoutine();
  const sessions = useCompletedSessions();
  const today = useToday();
  const { fmtVol } = useUnits();

  const ws = sessions ? weekStats(sessions, today) : null;
  const firstSession = sessions?.[0] ? tsToISODate(sessions[0].startedAt) : today;
  const since = routine ? [firstSession, tsToISODate(routine.createdAt)].sort()[0] : firstSession;
  const cons = sessions ? consistency(sessions, today, settings.trainingDays, since) : null;
  const last = sessions?.length ? sessions[sessions.length - 1] : null;
  const volDiff = ws && ws.prevVolume > 0 ? Math.round(((ws.volume - ws.prevVolume) / ws.prevVolume) * 100) : null;
  // Semana pela visão unificada (P14): os mesmos dias e números da tela Planejamento.
  const input = useCalendarInput();
  const cal = useMemo(() => (input ? resolveWeek(input, input.today) : null), [input]);
  const prevCal = useMemo(() => (input ? resolveWeek(input, addDays(input.today, -7)) : null), [input]);
  const hasPlan = !!cal && cal.summary.plannedActivities > 0;
  const planPct = cal && cal.summary.plannedDue > 0 ? Math.round((cal.summary.realized / cal.summary.plannedDue) * 100) : 0;

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <LogoMark className="h-10 w-10 md:hidden" />
        <div className="min-w-0">
          <h1 className="truncate font-display text-2xl font-bold tracking-tight md:text-3xl">
            {greeting()}
            {settings.userName ? `, ${settings.userName}` : ''}!
          </h1>
          <p className="text-sm text-muted-foreground">{fmtDateLong(new Date()).replace(/^./, (c) => c.toUpperCase())}</p>
        </div>
      </header>

      <InstallBanner />

      {routine === undefined ? (
        <Card className="h-56 animate-pulse" />
      ) : routine === null ? (
        <Onboarding />
      ) : (
        <motion.div initial={{ scale: 0.98, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          <TodayCard routine={routine} input={input} />
          <Link
            to="/planejamento"
            data-testid="home-open-planner"
            className="mt-3 flex items-center gap-3 rounded-2xl border p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CalendarDays className="h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 text-sm">
              <span className="block font-semibold">Planejamento da semana</span>
              <span className="block text-muted-foreground">Organize os dias e veja o que já fez</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        </motion.div>
      )}

      {ws && cons && cal && prevCal && (
        <>
          <Card className="p-4" data-testid="home-week-card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">Esta semana</p>
              {hasPlan ? (
                <p className="text-xs text-muted-foreground" data-testid="home-week-plan">
                  Do plano: <strong className="text-foreground">{cal.summary.realized} de {cal.summary.plannedDue}</strong> até hoje
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Consistência 4 sem.: <strong className={cn(cons.pct >= 80 ? 'text-primary' : cons.pct >= 50 ? 'text-warn' : 'text-foreground')}>{cons.pct}%</strong>
                </p>
              )}
            </div>
            <WeekDots days={cal.days} />
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary" aria-label={hasPlan ? `Realizadas do plano ${planPct}%` : `Consistência ${cons.pct}%`}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${hasPlan ? planPct : cons.pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground" data-testid="home-week-text">
              {hasPlan
                ? `${cal.summary.realized} de ${cal.summary.plannedDue} atividades planejadas realizadas até hoje (planejamento semanal).${cal.summary.legacySuggestions ? ` ${cal.summary.legacySuggestions} ${cal.summary.legacySuggestions === 1 ? 'sugestão' : 'sugestões'} da agenda anterior fora dessa conta.` : ''}`
                : cons.planned
                  ? `${cons.done} de ${cons.planned} dias de treino da agenda anterior (dias de treino das Configurações, últimas 4 semanas)`
                  : 'Comece hoje para medir sua consistência'}
            </p>
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              icon={CalendarCheck2}
              label="Treinos na semana"
              value={`${cal.summary.sessionsCompleted}/${hasPlan ? cal.summary.plannedActivities : settings.trainingDays.length}`}
              hint={`${hasPlan ? 'de atividades planejadas' : 'de dias de treino (Configurações)'} · semana passada: ${prevCal.summary.sessionsCompleted}`}
              accent
            />
            <Stat icon={Clock} label="Tempo treinado" value={fmtDuration(ws.durationSec)} hint="nesta semana" />
            <Stat
              icon={Weight}
              label="Volume semanal"
              value={fmtVol(ws.volume)}
              hint={volDiff === null ? 'carga × repetições' : `${volDiff >= 0 ? '+' : ''}${fmtNum(volDiff, 0)}% vs semana passada`}
            />
            <Stat icon={Trophy} label="Total de treinos" value={String(sessions!.length)} hint={sessions!.length ? `${fmtDuration(sessions!.reduce((a, s) => a + (s.durationSec ?? 0), 0))} no total` : 'Comece hoje!'} />
          </div>
        </>
      )}

      {last && (
        <Link to={`/historico/${last.id}`} className="block">
          <Card className="flex items-center gap-4 p-4 transition-colors hover:bg-accent/40">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 font-display text-xl font-bold text-primary">{last.workoutLabel}</span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Último treino · {fmtDateShort(last.startedAt)}</p>
              <p className="truncate font-semibold">{last.workoutName}</p>
              <p className="text-xs text-muted-foreground tabular">
                {fmtDuration(last.durationSec ?? 0)} · {fmtVol(sessionVolume(last))}
              </p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </Card>
        </Link>
      )}

      {sessions && sessions.length > 0 && (
        <Card className="p-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-semibold">Evolução recente</p>
            <Link to="/evolucao" className="text-xs font-medium text-primary">
              Ver gráficos
            </Link>
          </div>
          <RecentEvolution sessions={sessions} />
        </Card>
      )}
    </div>
  );
}
