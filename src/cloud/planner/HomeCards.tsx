// Cartões do painel inicial (Fase 06) que dependem da agenda unificada: treino do dia, próxima refeição, próxima
// sessão de estudo/leitura/Bíblia, próximas atividades, metas da semana e sugestões. Mais o diálogo "Personalizar
// Início" (ordem e visibilidade dos cartões, salvo na conta). Tudo só leitura e rápido: uma chamada (/planner/today).
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, BookOpen, CalendarDays, ChevronRight, Dumbbell, History, Lightbulb, Loader2, Utensils } from 'lucide-react';
import { CATEGORY_LABEL, HOME_CARD_LABEL, type HomeLayoutView, type TodayView } from '@shared/planner/protocol.ts';
import type { DashboardView } from '@shared/life/protocol.ts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Bar } from '../life/ui';
import { toastLifeError } from '../life/forms';
import { plannerApi } from './api';
import { CATEGORY_COLOR, StatusBadge } from './WeekPage';

const WORKOUT_TEXT: Record<NonNullable<TodayView['workout']>['status'], string> = { planned: 'Planejado para hoje', in_progress: 'Em andamento', done: 'Concluído hoje', rest: 'Dia de descanso', none: 'Nenhum treino planejado hoje' };

export function WorkoutCard({ t, w }: { t: TodayView | undefined; w: DashboardView['workouts'] }) {
  const navigate = useNavigate();
  const s = t?.workout;
  return (
    <Card data-testid="home-workout">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-500/12 text-rose-500">
            <Dumbbell className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{s?.title && s.status !== 'rest' ? s.title : WORKOUT_TEXT[s?.status ?? 'none']}</p>
            <p className="truncate text-xs text-muted-foreground tabular-nums">
              {s && s.title && s.status !== 'rest' ? `${WORKOUT_TEXT[s.status]} · ` : ''}
              {w.thisWeek}/{w.weeklyTarget} na semana
            </p>
          </div>
        </div>
        <Bar value={w.weeklyTarget ? w.thisWeek / w.weeklyTarget : 0} tone="bg-rose-500" label="Treinos da semana" />
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => navigate(s?.status === 'in_progress' ? '/treino' : '/treinar')}>
            <Dumbbell />
            {s?.status === 'in_progress' ? 'Continuar' : 'Treinar'}
          </Button>
          <Button variant="outline" onClick={() => navigate('/historico')}>
            <History />
            Histórico
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MiniRow({ icon, title, sub, to, testId }: { icon: React.ReactNode; title: string; sub: string; to: string; testId: string }) {
  return (
    <Link to={to} className="block" data-testid={testId}>
      <Card className="active:scale-[0.99]">
        <CardContent className="flex items-center gap-3 p-3.5">
          {icon}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{title}</p>
            <p className="truncate text-xs text-muted-foreground">{sub}</p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </CardContent>
      </Card>
    </Link>
  );
}

export function NextMealCard({ t }: { t: TodayView | undefined }) {
  const m = t?.nextMeal;
  return (
    <MiniRow
      testId="home-next-meal"
      to={m?.link ?? '/alimentacao/planejar'}
      icon={<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-500"><Utensils className="h-5 w-5" /></span>}
      title={m ? `${m.time ? `${m.time} · ` : ''}${m.title}` : 'Nenhuma refeição planejada'}
      sub={m ? `Próxima refeição planejada${m.kcal ? ` · ~${m.kcal} kcal (catálogo)` : ''}` : 'Planeje no planejamento alimentar'}
    />
  );
}

export function NextStudyCard({ t }: { t: TodayView | undefined }) {
  const s = t?.nextStudy;
  return (
    <MiniRow
      testId="home-next-study"
      to={s?.link ?? '/conhecimento'}
      icon={<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/12 text-sky-500"><BookOpen className="h-5 w-5" /></span>}
      title={s ? `${s.time ? `${s.time} · ` : ''}${s.title}` : 'Nenhuma leitura ou estudo previsto hoje'}
      sub={s ? `${CATEGORY_LABEL[s.category]}${s.status === 'in_progress' ? ' · em andamento' : ''}` : 'Crie uma meta diária ou uma atividade na Minha Semana'}
    />
  );
}

export function UpcomingCard({ t }: { t: TodayView | undefined }) {
  if (!t?.upcoming.length) return null;
  return (
    <Card data-testid="home-upcoming">
      <CardContent className="divide-y divide-border/60 p-3">
        {t.upcoming.map((i) => (
          <Link key={i.key} to={i.link ?? '/semana'} className="flex items-center gap-3 py-2">
            <span className="w-11 shrink-0 text-sm font-semibold tabular-nums text-primary">{i.startTime ?? '—'}</span>
            <span className={cn('h-7 w-1 shrink-0 rounded-full', CATEGORY_COLOR[i.category])} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{i.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{CATEGORY_LABEL[i.category]}{i.durationMin ? ` · ${i.durationMin} min` : ''}</span>
            </span>
            {i.status === 'in_progress' && <StatusBadge s={i.status} />}
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

export function WeekGoalsCard({ t }: { t: TodayView | undefined }) {
  if (!t?.weekGoals.length) return null;
  return (
    <Card data-testid="home-week-goals">
      <CardContent className="space-y-3 p-4">
        {t.weekGoals.map((g, i) => (
          <Link key={i} to={g.link} className="block space-y-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium">{g.title}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {g.done}/{g.target} {g.unit}
              </span>
            </div>
            <Bar value={g.target ? g.done / g.target : 0} label={g.title} />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

export function SuggestionsCard({ t }: { t: TodayView | undefined }) {
  if (!t?.suggestions.length) return null;
  return (
    <div className="space-y-1.5" data-testid="home-suggestions">
      {t.suggestions.map((s, i) => {
        const body = (
          <span className="flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> {s.text}
          </span>
        );
        return s.link ? (
          <Link key={i} to={s.link} className="block">
            {body}
          </Link>
        ) : (
          <div key={i}>{body}</div>
        );
      })}
    </div>
  );
}

export function WeekLink() {
  return (
    <Link to="/semana" className="flex items-center gap-1 text-xs font-medium text-primary">
      <CalendarDays className="h-3.5 w-3.5" /> Minha Semana
    </Link>
  );
}

/** Personalizar o Início: mostrar/ocultar e reordenar cartões (salvo na conta, vale em todos os aparelhos). */
export function LayoutDialog({ open, layout, onOpenChange }: { open: boolean; layout: HomeLayoutView | undefined; onOpenChange: (o: boolean) => void }) {
  const [cards, setCards] = useState(layout?.cards ?? []);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && layout) setCards(layout.cards);
  }, [open, layout]);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= cards.length) return;
    const next = [...cards];
    [next[i], next[j]] = [next[j], next[i]];
    setCards(next);
  };
  const save = async () => {
    setBusy(true);
    try {
      await plannerApi.saveLayout(cards, layout?.version ?? 0);
      toast.success('Início personalizado.');
      onOpenChange(false);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="home-layout-dialog">
        <DialogHeader>
          <DialogTitle>Personalizar Início</DialogTitle>
          <DialogDescription>Escolha os cartões e a ordem. Vale para todos os seus aparelhos.</DialogDescription>
        </DialogHeader>
        <ul className="max-h-[55vh] divide-y divide-border/60 overflow-y-auto">
          {cards.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2 py-2">
              <Switch checked={c.visible} onCheckedChange={(v) => setCards(cards.map((x) => (x.id === c.id ? { ...x, visible: v } : x)))} aria-label={`Mostrar ${HOME_CARD_LABEL[c.id]}`} />
              <span className={cn('min-w-0 flex-1 truncate text-sm', !c.visible && 'text-muted-foreground')}>{HOME_CARD_LABEL[c.id]}</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Subir ${HOME_CARD_LABEL[c.id]}`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={`Descer ${HOME_CARD_LABEL[c.id]}`} disabled={i === cards.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown />
              </Button>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button className="w-full" disabled={busy} onClick={() => void save()} data-testid="home-layout-save">
            {busy && <Loader2 className="animate-spin" />} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
