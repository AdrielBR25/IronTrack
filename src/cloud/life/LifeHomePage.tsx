// Início no modo conta. Fase 08: responde a três perguntas, nesta ordem — como estou evoluindo (cabeçalho compacto
// com nível, XP e sequência), o que quero fazer agora (ações rápidas) e o que tenho para hoje (um único resumo do dia).
// Depois, um atalho discreto para a IA e o versículo do dia. Resumos extras (alimentação, estudos, sugestões,
// conquistas) só aparecem se a pessoa ligar em "Personalizar". Nada aqui chama a OpenAI: tudo vem de /life/dashboard e
// /planner/today (calculados no servidor, sem IA) e, se a Bíblia estiver no Início, de /bible/home.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BarChart3, BedDouble, CalendarDays, Check, ChevronRight, Dumbbell, Flame, Loader2, Play, Plus, Sparkles, SlidersHorizontal, Target, Trophy, X } from 'lucide-react';
import { CATEGORY_LABEL, normalizeLayout, type HomeCardId, type TodayView } from '@shared/planner/protocol.ts';
import type { DashboardView } from '@shared/life/protocol.ts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useActiveSession } from '@/hooks/data';
import { useAccountPointer } from '../accountPointer';
import { emitReward, lifeApi, useLifeQuery } from './api';
import { HABIT_TEMPLATES, HabitDialog, MissionDetailDialog, MissionDialog, draftFromTemplate, lifeError, toastLifeError, type HabitDraft } from './forms';
import { Bar, HabitRow, MissionRow } from './ui';
import { QUICK_ACTIONS, readQuick } from './catalog';
import { NutritionHomeCard } from '../nutrition/HomeCard';
import { KnowledgeHomeCard } from '../knowledge/HomeCard';
import { BibleHomeCard } from '../bible/HomeCard';
import { plannerApi } from '../planner/api';
import { LayoutDialog, NextMealCard, NextStudyCard, SuggestionsCard } from '../planner/HomeCards';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

const WELCOME_KEY = 'irontrack.life.welcomeDone.v1';
function welcomeDismissed(id: string | undefined): boolean {
  try {
    return (JSON.parse(localStorage.getItem(WELCOME_KEY) ?? '[]') as string[]).includes(id ?? '_');
  } catch {
    return false;
  }
}
function dismissWelcome(id: string | undefined) {
  try {
    const list = JSON.parse(localStorage.getItem(WELCOME_KEY) ?? '[]') as string[];
    localStorage.setItem(WELCOME_KEY, JSON.stringify([...new Set([...list, id ?? '_'])]));
  } catch {
    /* sem armazenamento: volta a aparecer na próxima abertura */
  }
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="text-sm font-semibold text-foreground/90">{children}</h2>
      {action}
    </div>
  );
}

/** Personagem em uma linha: nível, barra de XP, XP de hoje e sequência. Toque abre a Jornada. */
function CharacterStrip({ d }: { d: DashboardView }) {
  const p = d.profile;
  return (
    <Link
      to="/jornada"
      data-testid="life-character"
      className="group flex items-center gap-3 rounded-2xl bg-card px-3 py-2.5 ring-1 ring-border/60 transition hover:ring-primary/30 active:scale-[0.99]"
    >
      <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl bg-primary/15 text-primary">
        <span className="text-[9px] font-semibold uppercase leading-none tracking-wide opacity-80">Nv</span>
        <span className="font-display text-lg font-bold leading-none tabular-nums" data-testid="life-level">
          {p.level.level}
        </span>
      </span>
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="flex items-baseline justify-between gap-2 text-xs">
          <span className="truncate font-semibold text-foreground">{p.title}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {p.level.into}/{p.level.need} XP
          </span>
        </span>
        <Bar value={p.level.progress} className="h-1.5" label="XP do nível" />
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] tabular-nums text-muted-foreground">
        <span className={cn(p.xpToday > 0 && 'font-semibold text-primary')}>+{p.xpToday} hoje</span>
        <span className="flex items-center gap-0.5" title={`Sequência atual: ${p.streak.current} dia(s). Melhor: ${p.streak.best}.`}>
          <Flame className={cn('h-3 w-3', p.streak.current > 0 ? 'text-orange-500' : 'text-muted-foreground/60')} aria-hidden />
          {p.streak.current} {p.streak.current === 1 ? 'dia' : 'dias'}
        </span>
      </span>
    </Link>
  );
}

function QuickActions({ ids, onEdit }: { ids: string[]; onEdit: () => void }) {
  const navigate = useNavigate();
  const active = useActiveSession();
  const actions = ids.map((id) => QUICK_ACTIONS.find((a) => a.id === id)).filter((a): a is (typeof QUICK_ACTIONS)[number] => !!a);
  return (
    <section className="space-y-2" aria-labelledby="quick-title">
      <SectionTitle
        action={
          <button type="button" onClick={onEdit} className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
            Editar
          </button>
        }
      >
        <span id="quick-title">O que você quer fazer?</span>
      </SectionTitle>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4" data-testid="home-quick">
        {actions.map((a) => {
          const resume = a.id === 'treinar' && active;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                navigator.vibrate?.(6);
                navigate(resume ? '/treino' : a.to);
              }}
              className="flex min-h-[4.5rem] items-center gap-3 rounded-2xl bg-card px-3.5 py-3 text-left ring-1 ring-border/60 transition hover:ring-primary/40 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary', a.tone)}>
                {resume ? <Play className="h-5 w-5 fill-current" /> : <a.icon className="h-5 w-5" aria-hidden />}
              </span>
              <span className="text-sm font-semibold leading-tight">{resume ? 'Continuar treino' : a.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Primeiro acesso: três caminhos curtos, sem onboarding obrigatório. */
function Welcome({ onGoals, onHabit, onDismiss }: { onGoals: () => void; onHabit: () => void; onDismiss: () => void }) {
  const navigate = useNavigate();
  const paths = [
    {
      label: 'Configurar meus objetivos',
      hint: 'Escolha suas áreas',
      icon: Target,
      onClick: onGoals,
    },
    {
      label: 'Criar meu primeiro hábito',
      hint: 'Um toque por dia já vale XP',
      icon: Plus,
      onClick: onHabit,
    },
    {
      label: 'Pedir ajuda à IA',
      hint: 'Ela monta um plano com você',
      icon: Sparkles,
      onClick: () => navigate(`/assistente?q=${encodeURIComponent('Me ajude a organizar minha rotina: treino, alimentação, estudos e hábitos.')}`),
    },
  ];
  return (
    <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-b from-primary/[0.07] to-card p-4" data-testid="home-welcome">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Fechar boas-vindas"
        className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
      >
        <X className="h-4 w-4" />
      </button>
      <p className="font-display text-lg font-semibold">Vamos organizar sua jornada.</p>
      <p className="mt-0.5 pr-6 text-sm text-muted-foreground">Comece por onde quiser. Dá para mudar tudo depois.</p>
      <div className="mt-3 space-y-2">
        {paths.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={p.onClick}
            className="flex w-full items-center gap-3 rounded-xl bg-background/60 px-3 py-3 text-left ring-1 ring-border/60 transition hover:ring-primary/40 active:scale-[0.99]"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <p.icon className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{p.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{p.hint}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        ))}
      </div>
    </Card>
  );
}

const WORKOUT_TEXT: Record<NonNullable<TodayView['workout']>['status'], string> = {
  planned: 'planejado',
  in_progress: 'em andamento',
  done: 'concluído',
  rest: 'Dia de descanso do treino',
  none: 'Sem treino planejado',
};

function Row({ icon, title, sub, right, to, testId }: { icon: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; to: string; testId?: string }) {
  return (
    <Link to={to} data-testid={testId} className="flex min-h-[3.25rem] items-center gap-3 rounded-xl px-1 py-2 transition hover:bg-accent/50 active:bg-accent">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
      {right}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
    </Link>
  );
}

export default function LifeHomePage() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const active = useActiveSession();
  const account = useAccountPointer();
  const accountId = account?.mode === 'account' ? account.id : undefined;
  const q = useLifeQuery(() => lifeApi.dashboard());
  const d = q.data;
  // Resumo do dia da agenda unificada (uma chamada); se falhar, o resto do Início segue.
  const tq = useLifeQuery(() => plannerApi.today());
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [layoutFocus, setLayoutFocus] = useState<'quick' | 'cards' | 'goals'>('cards');
  const [habitDraft, setHabitDraft] = useState<HabitDraft | null>(null);
  const [missionNew, setMissionNew] = useState(false);
  const [mission, setMission] = useState<DashboardView['missionsToday'][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [quick, setQuick] = useState(() => readQuick(accountId));
  const [welcomeHidden, setWelcomeHidden] = useState(() => welcomeDismissed(accountId));
  const shown = useRef(false);
  useEffect(() => setQuick(readQuick(accountId)), [accountId, layoutOpen]);
  // XP de treinos conciliados ao abrir: avisa uma vez.
  useEffect(() => {
    if (d?.outcome && !shown.current) {
      shown.current = true;
      emitReward(d.outcome);
    }
  }, [d]);

  // Pendentes primeiro (por horário), concluídos no fim. Missões diárias e hábitos do dia juntos.
  const today = useMemo(() => {
    if (!d) return [];
    const missions = d.missionsToday.map((m) => ({
      kind: 'mission' as const,
      m,
      done: m.status === 'completed',
      time: '99',
    }));
    const habits = d.habitsToday.map((h) => ({
      kind: 'habit' as const,
      h,
      done: h.today.completed,
      time: h.preferredTime ?? '99',
    }));
    return [...habits, ...missions].sort((a, b) => Number(a.done) - Number(b.done) || a.time.localeCompare(b.time));
  }, [d]);

  if (!d) {
    return (
      <div className="space-y-4 pt-2" aria-busy={!q.error}>
        {q.error ? (
          <Card className="space-y-3 p-4">
            <p className="text-sm">{lifeError(q.error)}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={q.reload}>
                Tentar de novo
              </Button>
              <Button size="sm" variant="outline" onClick={() => navigate('/treinar')}>
                Ir para o treino
              </Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="h-12 w-52 animate-pulse rounded-xl bg-card" />
            <div className="h-14 animate-pulse rounded-2xl bg-card" />
            <div className="grid grid-cols-2 gap-2.5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[4.5rem] animate-pulse rounded-2xl bg-card" />
              ))}
            </div>
            <div className="h-40 animate-pulse rounded-2xl bg-card" />
          </>
        )}
      </div>
    );
  }

  const p = d.profile;
  const t = tq.data;
  // Conta que nunca salvou o Início (versão 0) usa o padrão enxuto da Fase 08 calculado aqui, sem depender do servidor.
  const layout = t?.layout && t.layout.version > 0 ? t.layout : { cards: normalizeLayout(null), version: t?.layout.version ?? 0 };
  const on = (id: HomeCardId) => layout.cards.some((c) => c.id === id && c.visible);
  const restToday = p.streak.restToday;
  const pending = today.filter((x) => !x.done);
  const doneCount = d.dayProgress.done;
  const total = d.dayProgress.total;
  const allDone = total > 0 && doneCount >= total;
  const isNew = p.totalXp === 0 && d.habitsToday.length === 0 && d.missionsCustom.length === 0 && d.workouts.total === 0;
  const showWelcome = isNew && !welcomeHidden;

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
  const openLayout = (f: 'quick' | 'cards' | 'goals') => {
    setLayoutFocus(f);
    setLayoutOpen(true);
  };

  // "Esta semana": a meta com menos progresso relativo que ainda não foi batida (uma só, para não virar lista).
  const goal = t?.weekGoals.filter((g) => g.target > 0 && g.done < g.target).sort((a, b) => a.done / a.target - b.done / b.target)[0] ?? null;
  // Hábitos já aparecem na lista acima; a próxima atividade mostra o resto da agenda (treino, estudo, refeição…).
  const next = t?.upcoming.find((i) => i.status !== 'done' && i.category !== 'habit' && i.category !== 'mission') ?? null;
  const w = t?.workout;
  const workoutTitle = !w || w.status === 'none' ? WORKOUT_TEXT.none : w.status === 'rest' ? WORKOUT_TEXT.rest : `${w.title ?? 'Treino'} ${WORKOUT_TEXT[w.status]}`;
  const hasWeekRows = (on('workout') && (d.workouts.total > 0 || (w && w.status !== 'none'))) || (on('week_goals') && goal);

  const extras = layout.cards.filter((c) => c.visible && ['nutrition', 'next_meal', 'knowledge', 'next_study', 'suggestions', 'achievements'].includes(c.id));
  const extraNode = (id: HomeCardId): React.ReactNode => {
    switch (id) {
      case 'nutrition':
        return <NutritionHomeCard />;
      case 'next_meal':
        return <NextMealCard t={t} />;
      case 'knowledge':
        return <KnowledgeHomeCard />;
      case 'next_study':
        return <NextStudyCard t={t} />;
      case 'suggestions':
        return <SuggestionsCard t={t} />;
      case 'achievements':
        return d.recentAchievements.length ? (
          <div className="flex gap-2 overflow-x-auto pb-1" data-testid="home-achievements">
            {d.recentAchievements.map((a) => (
              <Link key={a.code} to="/jornada" className="flex min-w-[9.5rem] items-center gap-2 rounded-2xl bg-card px-3 py-2.5 ring-1 ring-border/60">
                <Trophy className="h-4 w-4 shrink-0 text-amber-500" />
                <span className="text-xs font-medium leading-tight">{a.title}</span>
              </Link>
            ))}
          </div>
        ) : null;
      default:
        return null;
    }
  };

  const fade = (i: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 6 },
          animate: { opacity: 1, y: 0 },
          transition: { delay: i * 0.04, duration: 0.22 },
        };

  return (
    <div className="space-y-5 pb-4" data-testid="life-home">
      <header className="flex items-start justify-between gap-3 pt-[calc(env(safe-area-inset-top)+0.25rem)] md:pt-0">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground first-letter:uppercase">{fmtDate(p.today)}</p>
          <h1 className="truncate font-display text-[1.65rem] font-bold leading-tight tracking-tight md:text-3xl">
            {greeting()}
            {d.displayName ? `, ${d.displayName.split(' ')[0]}` : ''}
          </h1>
        </div>
        <div className="flex shrink-0">
          <Button variant="ghost" size="icon" aria-label="Minha Evolução" title="Minha Evolução" onClick={() => navigate('/minha-evolucao')} data-testid="home-evolution" className="text-muted-foreground">
            <BarChart3 />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Personalizar Início" title="Personalizar Início" onClick={() => openLayout('cards')} data-testid="home-customize" className="text-muted-foreground">
            <SlidersHorizontal />
          </Button>
        </div>
      </header>

      {on('character') && (
        <motion.div {...fade(0)}>
          <CharacterStrip d={d} />
        </motion.div>
      )}

      {active && (
        <Button size="lg" className="w-full" onClick={() => navigate('/treino')} data-testid="home-resume-workout">
          <Dumbbell />
          Continuar treino {active.workoutLabel}
        </Button>
      )}

      <AnimatePresence initial={false}>
        {showWelcome && (
          <motion.div key="welcome" initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}>
            <Welcome
              onGoals={() => openLayout('goals')}
              onHabit={() => setHabitDraft(draftFromTemplate({ name: '' }))}
              onDismiss={() => {
                dismissWelcome(accountId);
                setWelcomeHidden(true);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div {...fade(1)}>
        <QuickActions ids={quick} onEdit={() => openLayout('quick')} />
      </motion.div>

      {on('today') && !showWelcome && (
        <motion.section {...fade(2)} className="space-y-2" aria-labelledby="today-title" data-testid="home-today">
          <SectionTitle
            action={
              <Link to="/minha-evolucao" className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="home-evolution-link">
                Ver evolução
              </Link>
            }
          >
            <span id="today-title">Hoje</span>
          </SectionTitle>
          <Card className="p-3">
            {/* Situação do dia em uma linha: progresso real (nada inventado) e o botão de descanso. */}
            <div className="flex items-center gap-3 px-1 pb-1">
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums',
                  allDone || restToday ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground',
                )}
              >
                {allDone ? <Check className="h-4 w-4" strokeWidth={3} /> : restToday ? <BedDouble className="h-4 w-4" /> : total ? `${doneCount}/${total}` : '0'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold" data-testid="home-today-status">
                  {restToday
                    ? 'Dia de descanso'
                    : allDone
                      ? 'Tudo feito por hoje. Bom trabalho!'
                      : total
                        ? `${pending.length} ${pending.length === 1 ? 'pendente' : 'pendentes'} · ${doneCount} ${doneCount === 1 ? 'concluída' : 'concluídas'}`
                        : 'Seu dia está livre'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {restToday ? 'Sequência protegida e missões diárias pausadas.' : total || p.xpToday ? `+${p.xpToday} XP hoje · limite diário ${p.dailyCap} XP` : 'Quer planejar alguma atividade?'}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={restToday ? 'Desmarcar descanso' : 'Marcar hoje como descanso'}
                aria-pressed={restToday}
                disabled={busy}
                onClick={toggleRest}
                title="Dia de descanso"
                className="text-muted-foreground"
              >
                {busy ? <Loader2 className="animate-spin" /> : <BedDouble className={cn(restToday && 'text-primary')} />}
              </Button>
            </div>

            {!restToday && pending.length > 0 && (
              <div className="mt-1 divide-y divide-border/50 border-t border-border/50">
                {pending
                  .slice(0, 3)
                  .map((x) => (x.kind === 'mission' ? <MissionRow key={x.m.id} m={x.m} onOpen={() => setMission(x.m)} /> : <HabitRow key={x.h.id} h={x.h} onError={toastLifeError} />))}
              </div>
            )}
            {!restToday && (pending.length > 3 || (allDone && today.length > 0)) && (
              <Link to="/missoes" className="mt-1 flex items-center justify-center gap-1 rounded-lg py-2 text-xs font-medium text-muted-foreground hover:bg-accent/50">
                {pending.length > 3 ? `Ver todas as ${pending.length} pendentes` : 'Ver o que foi feito'}
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            )}
            {!restToday && total === 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border/50 pt-3">
                <Button variant="secondary" size="sm" onClick={() => (d.habitsToday.length === 0 ? setHabitDraft(draftFromTemplate({ name: '' })) : setMissionNew(true))}>
                  <Plus /> {d.habitsToday.length === 0 ? 'Criar hábito' : 'Criar missão'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => navigate('/semana')}>
                  <CalendarDays /> Planejar semana
                </Button>
              </div>
            )}

            {on('next_activities') && next && (
              <div className="mt-1 border-t border-border/50 pt-1">
                <Row
                  testId="home-upcoming"
                  to={next.link ?? '/semana'}
                  icon={<CalendarDays className="h-[18px] w-[18px]" />}
                  title={`${next.startTime ? `${next.startTime} · ` : ''}${next.title}`}
                  sub={`Próxima atividade · ${CATEGORY_LABEL[next.category]}${next.durationMin ? ` · ${next.durationMin} min` : ''}`}
                />
              </div>
            )}

            {hasWeekRows && (
              <div className="mt-1 border-t border-border/50 pt-2">
                <p className="px-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Esta semana</p>
                {on('workout') && (d.workouts.total > 0 || (w && w.status !== 'none')) && (
                  <Row
                    testId="home-workout"
                    to={w?.status === 'in_progress' ? '/treino' : '/treinar'}
                    icon={<Dumbbell className="h-[18px] w-[18px]" />}
                    title={workoutTitle}
                    sub={
                      d.workouts.last
                        ? `Último: ${d.workouts.last.name ?? 'treino'} em ${new Date(`${d.workouts.last.date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`
                        : 'Nenhum treino concluído ainda'
                    }
                    right={
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
                        {d.workouts.thisWeek}/{d.workouts.weeklyTarget}
                      </span>
                    }
                  />
                )}
                {on('week_goals') && goal && (
                  <Link to={goal.link} className="block space-y-1.5 rounded-xl px-1 py-2 transition hover:bg-accent/50" data-testid="home-week-goals">
                    <span className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate font-medium">{goal.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {goal.done}/{goal.target} {goal.unit}
                      </span>
                    </span>
                    <Bar value={goal.done / goal.target} className="h-1.5" label={goal.title} />
                  </Link>
                )}
              </div>
            )}
          </Card>
        </motion.section>
      )}

      {on('today') && !showWelcome && d.habitsToday.length === 0 && d.missionsCustom.length === 0 && total === 0 && (
        <div className="-mt-2 flex flex-wrap gap-1.5 px-1" aria-label="Sugestões de hábito">
          {HABIT_TEMPLATES.slice(0, 4).map((tp) => (
            <button
              key={tp.name}
              type="button"
              onClick={() => setHabitDraft(draftFromTemplate(tp))}
              className="flex items-center gap-1 rounded-full bg-secondary/70 px-3 py-1.5 text-xs font-medium transition hover:bg-secondary active:scale-95"
            >
              <Plus className="h-3 w-3 text-primary" />
              {tp.name}
            </button>
          ))}
        </div>
      )}

      {on('ai') && (
        <motion.button
          {...fade(3)}
          type="button"
          onClick={() => navigate('/assistente')}
          data-testid="home-ai"
          className="flex w-full items-center gap-3 rounded-2xl bg-gradient-to-r from-primary/[0.10] to-transparent px-4 py-3.5 text-left ring-1 ring-primary/20 transition hover:ring-primary/40 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Sparkles className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Quer ajuda para organizar seu dia?</span>
            <span className="block truncate text-xs text-muted-foreground">Converse com a IA: treinos, rotina, refeições e mais</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
        </motion.button>
      )}

      {/* A Bíblia some sozinha se a pessoa desligar "Mostrar no Início" nas configurações dela. */}
      {on('bible') && <BibleHomeCard />}

      {extras.length > 0 && (
        <section className="space-y-2">
          <SectionTitle>Mais do seu dia</SectionTitle>
          <div className="space-y-2.5">
            {extras.map((c) => {
              const node = extraNode(c.id);
              return node ? <div key={c.id}>{node}</div> : null;
            })}
          </div>
        </section>
      )}

      <HabitDialog open={!!habitDraft} onOpenChange={(o) => !o && setHabitDraft(null)} template={habitDraft} />
      <MissionDialog open={missionNew} onOpenChange={setMissionNew} today={p.today} habits={d.habitsToday} />
      <MissionDetailDialog mission={mission} onOpenChange={(o) => !o && setMission(null)} />
      <LayoutDialog
        open={layoutOpen}
        focus={layoutFocus}
        layout={t ? layout : undefined}
        accountId={accountId}
        weeklyWorkoutTarget={p.weeklyWorkoutTarget}
        onOpenChange={setLayoutOpen}
        onSaved={() => {
          if (layoutFocus === 'goals') {
            dismissWelcome(accountId);
            setWelcomeHidden(true);
          }
        }}
      />
    </div>
  );
}
