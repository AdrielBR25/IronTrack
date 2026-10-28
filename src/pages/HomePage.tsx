import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useRef, useState } from 'react';
import { CalendarCheck2, CalendarDays, ChevronRight, Clock, Dumbbell, FileUp, Flame, Moon, Play, Sparkles, TrendingDown, TrendingUp, Trophy, Weight } from 'lucide-react';
import { toast } from 'sonner';
import { useActiveRoutine, useActiveSession, useCompletedSessions, useSchedule, useToday } from '@/hooks/data';
import { useStartWorkout } from '@/features/routines/useStartWorkout';
import { importFichaFile, loadSampleFicha } from '@/features/routines/importFicha';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LogoMark } from '@/components/Logo';
import { InstallBanner } from '@/components/InstallBanner';
import { addDays, fmtDateLong, fmtDateShort, startOfWeek, tsToISODate, weekday, weekdayShort } from '@/lib/dates';
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

function TodayCard({ routine }: { routine: Routine }) {
  const { settings } = useActiveRoutine();
  const schedule = useSchedule(routine, settings, 7);
  const active = useActiveSession();
  const start = useStartWorkout();
  const navigate = useNavigate();
  if (!schedule) return <Card className="h-56 animate-pulse" />;

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

  const today = schedule.plan[0];
  const nextWorkoutDay = schedule.plan.find((d) => d.kind === 'workout' && d !== today) ?? schedule.plan.find((d) => d.kind === 'workout');
  const pointerWorkout = routine.workouts[schedule.nextIndex % Math.max(1, routine.workouts.length)];
  const target = today.kind === 'workout' ? routine.workouts.find((w) => w.id === today.workoutId) : pointerWorkout;

  if (!target) {
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

  const isRest = today.kind === 'rest';
  const isDone = today.kind === 'done';
  const sets = target.exercises.reduce((a, e) => a + e.sets + e.warmupSets, 0);
  const estMin = Math.round(target.exercises.reduce((a, e) => a + (e.sets + e.warmupSets) * (45 + e.restSec), 0) / 60);
  const doneWorkout = isDone ? routine.workouts.find((w) => w.id === today.workoutId) : undefined;
  const nextW = nextWorkoutDay ? routine.workouts.find((w) => w.id === nextWorkoutDay.workoutId) : undefined;

  return (
    <Card className="relative overflow-hidden">
      <div className={cn('absolute inset-0 bg-gradient-to-br to-transparent', isRest || isDone ? 'from-secondary/60' : 'from-primary/20')} />
      <CardContent className="relative space-y-4 p-5">
        <div className="flex items-center justify-between">
          <Badge variant={isRest || isDone ? 'secondary' : 'default'}>
            {isDone ? (
              <>
                <CalendarCheck2 /> Concluído hoje
              </>
            ) : isRest ? (
              <>
                <Moon /> Dia de descanso
              </>
            ) : (
              <>
                <Flame /> Treino de hoje
              </>
            )}
          </Badge>
          <span className="text-xs text-muted-foreground">{routine.name}</span>
        </div>
        {isDone ? (
          <div>
            <p className="font-display text-2xl font-bold">Treino {doneWorkout?.label ?? ''} feito ✓</p>
            <p className="text-sm text-muted-foreground">
              Próximo: <strong className="text-foreground">Treino {nextW?.label ?? pointerWorkout?.label}</strong>
              {nextWorkoutDay ? ` · ${weekdayShort(weekday(nextWorkoutDay.date))} ${fmtDateShort(nextWorkoutDay.date)}` : ''}
            </p>
          </div>
        ) : (
          <div>
            <p className="font-display text-4xl font-bold tracking-tight">
              {isRest ? 'Recupere-se' : <>Treino <span className="text-primary">{target.label}</span></>}
            </p>
            <p className="text-muted-foreground">{isRest ? `Próximo na rotação: Treino ${target.label} · ${target.name}` : target.name}</p>
          </div>
        )}
        {!isRest && !isDone && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {target.exercises.slice(0, 6).map((e) => (
                <span key={e.id} className="rounded-full bg-secondary px-2.5 py-1 text-xs">
                  {e.name}
                </span>
              ))}
              {target.exercises.length > 6 && <span className="rounded-full bg-secondary px-2.5 py-1 text-xs">+{target.exercises.length - 6}</span>}
            </div>
            <p className="flex gap-4 text-sm text-muted-foreground tabular">
              <span className="flex items-center gap-1">
                <Dumbbell className="h-4 w-4" /> {target.exercises.length} exercícios · {sets} séries
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-4 w-4" /> ~{estMin} min
              </span>
            </p>
          </>
        )}
        <Button
          size="xl"
          variant={isRest || isDone ? 'secondary' : 'default'}
          className="w-full font-display font-bold"
          onClick={() => void start(routine.id, (isDone ? pointerWorkout : target).id)}
          data-testid="start-workout"
        >
          <Play className="fill-current" /> {isRest || isDone ? `TREINAR MESMO ASSIM (${(isDone ? pointerWorkout : target).label})` : 'INICIAR TREINO'}
        </Button>
      </CardContent>
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

function WeekDots({ sessions, today, trainingDays, since }: { sessions: WorkoutSession[]; today: string; trainingDays: number[]; since: string }) {
  const mon = startOfWeek(today);
  const ws = weekStats(sessions, today);
  return (
    <div className="flex justify-between gap-1">
      {Array.from({ length: 7 }, (_, i) => {
        const d = addDays(mon, i);
        const done = ws.doneDays.has(d);
        const planned = trainingDays.includes(weekday(d));
        const isToday = d === today;
        return (
          <div key={d} className="flex flex-1 flex-col items-center gap-1.5">
            <span className={cn('text-[11px]', isToday ? 'font-bold text-foreground' : 'text-muted-foreground')}>{weekdayShort(weekday(d)).slice(0, 3)}</span>
            <span
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold',
                done ? 'bg-primary text-primary-foreground' : planned ? (d < today && d >= since ? 'border-2 border-destructive/40' : 'border-2 border-dashed border-muted-foreground/40') : 'bg-secondary/40',
                isToday && !done && 'ring-2 ring-primary ring-offset-2 ring-offset-card',
              )}
              aria-label={`${weekdayShort(weekday(d))}: ${done ? 'treinou' : planned ? 'dia de treino' : 'descanso'}`}
            >
              {done ? '✓' : Number(d.slice(8))}
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
          <TodayCard routine={routine} />
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

      {ws && cons && (
        <>
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold">Esta semana</p>
              <p className="text-xs text-muted-foreground">
                Consistência 4 sem.: <strong className={cn(cons.pct >= 80 ? 'text-primary' : cons.pct >= 50 ? 'text-warn' : 'text-foreground')}>{cons.pct}%</strong>
              </p>
            </div>
            <WeekDots sessions={sessions!} today={today} trainingDays={settings.trainingDays} since={since} />
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary" aria-label={`Consistência ${cons.pct}%`}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${cons.pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {cons.planned ? `${cons.done} de ${cons.planned} dias de treino planejados (últimas 4 semanas)` : 'Comece hoje para medir sua consistência'}
            </p>
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat icon={CalendarCheck2} label="Treinos na semana" value={`${ws.count}/${settings.trainingDays.length}`} hint={`Semana passada: ${ws.prevCount}`} accent />
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
