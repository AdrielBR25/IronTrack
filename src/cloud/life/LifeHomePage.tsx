// Início no modo conta (Fase 01): painel de desenvolvimento pessoal. No celular mostra o essencial (personagem, dia,
// próximas atividades) e esconde o resto atrás de "ver mais", sem poluir a tela.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Apple, BedDouble, BookOpen, Check, ChevronDown, ChevronRight, Church, Dumbbell, Flame, History, Loader2, Plus, Sparkles, Trophy } from 'lucide-react';
import type { DashboardView } from '@shared/life/protocol.ts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useActiveSession } from '@/hooks/data';
import { emitReward, lifeApi, useLifeQuery } from './api';
import { HABIT_TEMPLATES, HabitDialog, MissionDetailDialog, draftFromTemplate, lifeError, toastLifeError, type HabitDraft } from './forms';
import { Bar, HabitRow, MissionRow, Ring } from './ui';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

const fmtDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

function Section({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function CharacterCard({ d }: { d: DashboardView }) {
  const p = d.profile;
  return (
    <Link to="/jornada" className="block" data-testid="life-character">
      <Card className="relative overflow-hidden border-primary/25 bg-gradient-to-br from-primary/[0.10] via-card to-card active:scale-[0.99]">
        <CardContent className="flex items-center gap-4 p-4">
          <div className="relative flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_0_30px_-8px_hsl(var(--primary)/0.8)]">
            <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">Nível</span>
            <span className="font-display text-2xl font-bold leading-none tabular-nums" data-testid="life-level">
              {p.level.level}
            </span>
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-display text-base font-semibold">{p.title}</p>
              {p.streak.current > 0 && (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-semibold text-orange-600 dark:text-orange-400" title="Sequência de consistência">
                  <Flame className="h-3.5 w-3.5" />
                  {p.streak.current}
                </span>
              )}
            </div>
            <Bar value={p.level.progress} label="XP do nível" />
            <p className="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>
                {p.level.into}/{p.level.need} XP
              </span>
              <span>Hoje +{p.xpToday}</span>
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </CardContent>
      </Card>
    </Link>
  );
}

function QuickStart({ onPick }: { onPick: (d: HabitDraft) => void }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <p className="font-display font-semibold">Monte seu personagem</p>
          <p className="text-sm text-muted-foreground">Escolha os primeiros hábitos. Cada um cumprido vale XP e faz seus atributos subirem.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {HABIT_TEMPLATES.map((t) => (
            <button key={t.name} type="button" onClick={() => onPick(draftFromTemplate(t))} className="flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-sm active:scale-95">
              <Plus className="h-3.5 w-3.5 text-primary" />
              {t.name}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function LifeHomePage() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const active = useActiveSession();
  const q = useLifeQuery(() => lifeApi.dashboard());
  const d = q.data;
  const [expanded, setExpanded] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);
  const [habitDraft, setHabitDraft] = useState<HabitDraft | null>(null);
  const [mission, setMission] = useState<DashboardView['missionsToday'][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef(false);
  // XP de treinos conciliados ao abrir: avisa uma vez.
  useEffect(() => {
    if (d?.outcome && !shown.current) {
      shown.current = true;
      emitReward(d.outcome);
    }
  }, [d]);

  const today = useMemo(() => {
    if (!d) return [];
    const missions = d.missionsToday.map((m) => ({ kind: 'mission' as const, m }));
    const habits = d.habitsToday.map((h) => ({ kind: 'habit' as const, h }));
    // Pendentes primeiro, por horário; concluídos no fim.
    habits.sort((a, b) => Number(a.h.today.completed) - Number(b.h.today.completed) || (a.h.preferredTime ?? '99').localeCompare(b.h.preferredTime ?? '99'));
    return [...missions, ...habits];
  }, [d]);

  if (!d) {
    return (
      <div className="space-y-3 pt-2">
        {q.error ? (
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm">{lifeError(q.error)}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={q.reload}>
                  Tentar de novo
                </Button>
                <Button size="sm" variant="outline" onClick={() => navigate('/treinar')}>
                  Ir para o treino
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="h-10 w-48 animate-pulse rounded-xl bg-card" />
            <div className="h-24 animate-pulse rounded-2xl bg-card" />
            <div className="h-56 animate-pulse rounded-2xl bg-card" />
          </>
        )}
      </div>
    );
  }

  const p = d.profile;
  const visible = expanded ? today : today.slice(0, 5);
  const restToday = p.streak.restToday;
  const toggleRest = async () => {
    setBusy(true);
    try {
      await lifeApi.setRest(p.today, !restToday);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  const allDone = d.dayProgress.total > 0 && d.dayProgress.done >= d.dayProgress.total;

  return (
    <div className="space-y-5 pb-4" data-testid="life-home">
      <header className="flex items-end justify-between gap-3 pt-[calc(env(safe-area-inset-top)+0.25rem)] md:pt-0">
        <div className="min-w-0">
          <p className="text-sm capitalize text-muted-foreground">{fmtDate(p.today)}</p>
          <h1 className="truncate font-display text-2xl font-bold tracking-tight md:text-3xl">
            {greeting()}
            {d.displayName ? `, ${d.displayName.split(' ')[0]}` : ''}
          </h1>
        </div>
        <Button variant="ghost" size="icon" aria-label="Abrir a IA" onClick={() => navigate('/assistente')}>
          <Sparkles className="text-primary" />
        </Button>
      </header>

      <motion.div initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <CharacterCard d={d} />
      </motion.div>

      {active && (
        <Button size="lg" className="w-full" onClick={() => navigate('/treino')}>
          <Dumbbell />
          Continuar treino {active.workoutLabel}
        </Button>
      )}

      <Section
        title="Missões do dia"
        action={
          <Link to="/missoes" className="text-xs font-medium text-primary">
            Todas
          </Link>
        }
      >
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-4 px-1 pb-2">
              <Ring value={d.dayProgress.total ? d.dayProgress.done / d.dayProgress.total : restToday ? 1 : 0} size={56}>
                {allDone ? <Check className="h-5 w-5 text-primary" strokeWidth={3} /> : <span className="text-sm font-semibold tabular-nums">{d.dayProgress.total ? `${d.dayProgress.done}/${d.dayProgress.total}` : '—'}</span>}
              </Ring>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{restToday ? 'Dia de descanso' : allDone ? 'Dia concluído!' : d.dayProgress.total ? 'Progresso de hoje' : 'Nada previsto para hoje'}</p>
                <p className="text-xs text-muted-foreground">{restToday ? 'Sua sequência fica protegida e as missões diárias, pausadas.' : `${p.xpToday} de ${p.dailyCap} XP possíveis hoje`}</p>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={restToday ? 'Desmarcar descanso' : 'Marcar hoje como descanso'} aria-pressed={restToday} disabled={busy} onClick={toggleRest} title="Dia de descanso">
                {busy ? <Loader2 className="animate-spin" /> : <BedDouble className={cn(restToday && 'text-primary')} />}
              </Button>
            </div>
            {today.length === 0 && !restToday && <p className="px-1 pb-1 text-sm text-muted-foreground">Crie hábitos ou missões para o dia aparecer aqui.</p>}
            <div className="divide-y divide-border/60">
              {visible.map((x) => (x.kind === 'mission' ? <MissionRow key={x.m.id} m={x.m} onOpen={() => setMission(x.m)} /> : <HabitRow key={x.h.id} h={x.h} onError={toastLifeError} />))}
            </div>
            {today.length > 5 && (
              <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 flex w-full items-center justify-center gap-1 py-1.5 text-xs font-medium text-muted-foreground">
                {expanded ? 'Mostrar menos' : `Ver mais ${today.length - 5}`}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
              </button>
            )}
          </CardContent>
        </Card>
      </Section>

      {d.habitsToday.length === 0 && d.missionsCustom.length === 0 && <QuickStart onPick={setHabitDraft} />}

      {d.nextActivities.length > 0 && (
        <Section
          title="Próximas atividades"
          action={
            <Link to="/missoes?aba=rotinas" className="text-xs font-medium text-primary">
              Rotinas
            </Link>
          }
        >
          <Card>
            <CardContent className="divide-y divide-border/60 p-3">
              {d.nextActivities.map((a) => (
                <div key={a.itemId} className="flex items-center gap-3 py-2">
                  <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-primary">{a.startTime ?? '—'}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{a.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.routineName}
                      {a.durationMin ? ` · ${a.durationMin} min` : ''}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Concluir ${a.title}`}
                    onClick={() => lifeApi.checkItem(a.routineId, a.itemId, true).catch(toastLifeError)}
                  >
                    <Check />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </Section>
      )}

      {d.missionsWeek.length > 0 && (
        <Section title="Semana">
          <Card>
            <CardContent className="p-3">
              <div className="divide-y divide-border/60">
                {(weekOpen ? d.missionsWeek : d.missionsWeek.slice(0, 2)).map((m) => (
                  <MissionRow key={m.id} m={m} onOpen={() => setMission(m)} />
                ))}
              </div>
              {d.missionsWeek.length > 2 && (
                <button type="button" onClick={() => setWeekOpen((v) => !v)} className="mt-1 flex w-full items-center justify-center gap-1 py-1.5 text-xs font-medium text-muted-foreground">
                  {weekOpen ? 'Mostrar menos' : `Ver mais ${d.missionsWeek.length - 2}`}
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', weekOpen && 'rotate-180')} />
                </button>
              )}
            </CardContent>
          </Card>
        </Section>
      )}

      {d.missionsCustom.length > 0 && (
        <Section title="Desafios">
          <Card>
            <CardContent className="divide-y divide-border/60 p-3">
              {d.missionsCustom.slice(0, 3).map((m) => (
                <MissionRow key={m.id} m={m} onOpen={() => setMission(m)} />
              ))}
            </CardContent>
          </Card>
        </Section>
      )}

      <Section title="Treinos">
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-500/12 text-rose-500">
                <Dumbbell className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold tabular-nums">
                  {d.workouts.thisWeek}/{d.workouts.weeklyTarget} treinos nesta semana
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {d.workouts.total} no total{d.workouts.last ? ` · último ${d.workouts.last.date.split('-').reverse().slice(0, 2).join('/')}${d.workouts.last.name ? ` (${d.workouts.last.name})` : ''}` : ''}
                </p>
              </div>
            </div>
            <Bar value={d.workouts.weeklyTarget ? d.workouts.thisWeek / d.workouts.weeklyTarget : 0} tone="bg-rose-500" label="Treinos da semana" />
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => navigate('/treinar')}>
                <Dumbbell />
                Treinar
              </Button>
              <Button variant="outline" onClick={() => navigate('/historico')}>
                <History />
                Histórico
              </Button>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="IA central">
        <Card>
          <CardContent className="space-y-3 p-4">
            <button type="button" onClick={() => navigate('/assistente')} className="flex w-full items-center gap-3 rounded-xl border bg-background px-3 py-3 text-left text-sm text-muted-foreground active:scale-[0.99]">
              <Sparkles className="h-4 w-4 text-primary" />
              Pergunte ou peça uma rotina, missão ou hábito…
            </button>
            <div className="flex flex-wrap gap-1.5">
              {['Quais missões ainda faltam hoje?', 'Crie uma rotina matinal para mim', 'Como está minha disciplina nesta semana?'].map((s) => (
                <button key={s} type="button" onClick={() => navigate(`/assistente?q=${encodeURIComponent(s)}`)} className="rounded-full bg-secondary px-3 py-1 text-xs">
                  {s}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </Section>

      {d.recentAchievements.length > 0 && (
        <Section
          title="Conquistas"
          action={
            <Link to="/jornada" className="text-xs font-medium text-primary">
              Ver todas
            </Link>
          }
        >
          <div className="flex gap-2 overflow-x-auto pb-1">
            {d.recentAchievements.map((a) => (
              <div key={a.code} className="flex min-w-[9.5rem] items-center gap-2 rounded-2xl border bg-card px-3 py-2.5">
                <Trophy className="h-4 w-4 shrink-0 text-amber-500" />
                <span className="text-xs font-medium leading-tight">{a.title}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Em breve">
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'nutrition', name: 'Alimentação', icon: Apple },
            { id: 'reading', name: 'Leitura', icon: BookOpen },
            { id: 'bible', name: 'Bíblia', icon: Church },
          ].map((m) => (
            <div key={m.id} className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed bg-card/40 px-2 py-3 text-center" aria-disabled>
              <m.icon className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs font-medium">{m.name}</span>
              <span className="text-[10px] text-muted-foreground">em breve</span>
            </div>
          ))}
        </div>
      </Section>

      <HabitDialog open={!!habitDraft} onOpenChange={(o) => !o && setHabitDraft(null)} template={habitDraft} />
      <MissionDetailDialog mission={mission} onOpenChange={(o) => !o && setMission(null)} />
    </div>
  );
}
