// Cartões do painel inicial (Fase 06) que dependem da agenda unificada: treino do dia, próxima refeição, próxima
// sessão de estudo/leitura/Bíblia, próximas atividades, metas da semana e sugestões. Mais o diálogo "Personalizar
// Início" (ordem e visibilidade dos cartões, salvo na conta). Tudo só leitura e rápido: uma chamada (/planner/today).
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { BookOpen, CalendarDays, Check, ChevronRight, Dumbbell, History, Lightbulb, Loader2, Utensils } from 'lucide-react';
import { CATEGORY_LABEL, HOME_CARD_LABEL, HOME_CARDS_HIDDEN_BY_DEFAULT, normalizeLayout, type HomeLayoutView, type TodayView } from '@shared/planner/protocol.ts';
import type { DashboardView } from '@shared/life/protocol.ts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Bar } from '../life/ui';
import { toastLifeError } from '../life/forms';
import { lifeApi } from '../life/api';
import { DEFAULT_QUICK, QUICK_ACTIONS, readQuick, saveQuick } from '../life/catalog';
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

/**
 * Personalizar o Início (Fase 08): três partes num só lugar — objetivos (atalho do primeiro acesso), ações rápidas e
 * cartões. Os cartões ficam salvos na conta (todos os aparelhos; a ordem salva é preservada); as ações rápidas, neste
 * aparelho; a meta semanal de treinos, no perfil do RPG (mesma regra da Jornada).
 */
const AREAS = [
  { id: 'treino', label: 'Treinar com constância', quick: 'treinar', cards: ['workout'] },
  { id: 'alimentacao', label: 'Comer melhor', quick: 'refeicao', cards: ['nutrition'] },
  { id: 'estudos', label: 'Estudar e ler mais', quick: 'foco', cards: ['knowledge'] },
  { id: 'biblia', label: 'Ler a Bíblia', quick: 'biblia', cards: ['bible'] },
  { id: 'habitos', label: 'Criar bons hábitos', quick: 'missoes', cards: ['today'] },
] as const;

export function LayoutDialog({
  open,
  layout,
  onOpenChange,
  focus = 'cards',
  accountId,
  weeklyWorkoutTarget = null,
  onSaved,
}: {
  open: boolean;
  layout: HomeLayoutView | undefined;
  onOpenChange: (o: boolean) => void;
  focus?: 'quick' | 'cards' | 'goals';
  accountId?: string;
  weeklyWorkoutTarget?: number | null;
  onSaved?: () => void;
}) {
  const [cards, setCards] = useState(layout?.cards ?? normalizeLayout(null));
  const [quick, setQuick] = useState<string[]>(() => readQuick(accountId));
  const [areas, setAreas] = useState<string[]>([]);
  const [target, setTarget] = useState<number | null>(weeklyWorkoutTarget);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCards(layout?.cards ?? normalizeLayout(null));
    setQuick(readQuick(accountId));
    setAreas([]);
    setTarget(weeklyWorkoutTarget);
  }, [open, layout, accountId, weeklyWorkoutTarget]);
  const toggleQuick = (id: string) => {
    if (quick.includes(id)) setQuick(quick.filter((x) => x !== id));
    else if (quick.length < 4) setQuick([...quick, id]);
  };
  const toggleArea = (id: string) => {
    const next = areas.includes(id) ? areas.filter((x) => x !== id) : [...areas, id];
    setAreas(next);
    // Ações rápidas: as das áreas escolhidas primeiro, completadas pelo padrão.
    const picked = AREAS.filter((a) => next.includes(a.id)).map((a) => a.quick as string);
    setQuick([...new Set([...picked, ...DEFAULT_QUICK])].slice(0, 4));
    // Cartões: liga os resumos das áreas escolhidas (nunca desliga nada sozinho).
    const want = new Set(AREAS.filter((a) => next.includes(a.id)).flatMap((a) => a.cards as readonly string[]));
    setCards((cur) => cur.map((c) => (want.has(c.id) ? { ...c, visible: true } : c)));
  };
  const save = async () => {
    setBusy(true);
    try {
      const changed = JSON.stringify(cards) !== JSON.stringify(layout?.cards ?? normalizeLayout(null));
      if (changed) await plannerApi.saveLayout(cards, layout?.version ?? 0);
      if (quick.length === 4) saveQuick(accountId, quick);
      if (focus === 'goals' && target !== weeklyWorkoutTarget) await lifeApi.patchProfile({ weeklyWorkoutTarget: target });
      toast.success(focus === 'goals' ? 'Pronto! Seu Início foi ajustado aos seus objetivos.' : 'Início personalizado.');
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  const chip = (on: boolean) =>
    cn('flex min-h-[2.75rem] items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium ring-1 transition active:scale-[0.98]', on ? 'bg-primary/12 text-foreground ring-primary/60' : 'bg-secondary/50 text-muted-foreground ring-transparent hover:text-foreground');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="home-layout-dialog">
        <DialogHeader>
          <DialogTitle>{focus === 'goals' ? 'Seus objetivos' : 'Personalizar Início'}</DialogTitle>
          <DialogDescription>{focus === 'goals' ? 'Escolha o que importa agora. O Início se ajusta; dá para mudar depois.' : 'O padrão já mostra o essencial. Ajuste se quiser.'}</DialogDescription>
        </DialogHeader>

        {focus === 'goals' && (
          <section className="space-y-2" aria-label="Objetivos">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {AREAS.map((a) => (
                <button key={a.id} type="button" aria-pressed={areas.includes(a.id)} onClick={() => toggleArea(a.id)} className={chip(areas.includes(a.id))}>
                  <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-md border', areas.includes(a.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                    {areas.includes(a.id) && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                  </span>
                  {a.label}
                </button>
              ))}
            </div>
            {areas.includes('treino') && (
              <label className="flex items-center justify-between gap-3 rounded-xl bg-secondary/40 px-3 py-2 text-sm">
                Treinos por semana
                <select value={target ?? ''} onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : null)} className="h-9 rounded-lg border bg-background px-2 text-sm" aria-label="Meta semanal de treinos">
                  <option value="">Automática</option>
                  {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                    <option key={n} value={n}>
                      {n}× semana
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
        )}

        <section className="space-y-2" aria-labelledby="layout-quick">
          <h3 id="layout-quick" className="text-xs font-medium text-muted-foreground">
            Ações rápidas · escolha 4 ({quick.length}/4)
          </h3>
          <div className="grid grid-cols-2 gap-2" data-testid="layout-quick">
            {QUICK_ACTIONS.map((a) => {
              const on = quick.includes(a.id);
              return (
                <button key={a.id} type="button" aria-pressed={on} disabled={!on && quick.length >= 4} onClick={() => toggleQuick(a.id)} className={cn(chip(on), 'disabled:opacity-40')}>
                  <a.icon className={cn('h-4 w-4 shrink-0', on ? 'text-primary' : '')} aria-hidden />
                  <span className="truncate">{a.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        {focus !== 'goals' && (
          <section className="space-y-1" aria-labelledby="layout-cards">
            <div className="flex items-center justify-between">
              <h3 id="layout-cards" className="text-xs font-medium text-muted-foreground">
                O que aparece no Início
              </h3>
              <button type="button" className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setCards(cards.map((c) => ({ ...c, visible: !HOME_CARDS_HIDDEN_BY_DEFAULT.includes(c.id) })))}>
                Restaurar padrão
              </button>
            </div>
            <ul className="divide-y divide-border/50">
              {cards.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2">
                  <span className={cn('min-w-0 flex-1 truncate text-sm', !c.visible && 'text-muted-foreground')}>{HOME_CARD_LABEL[c.id]}</span>
                  <Switch checked={c.visible} onCheckedChange={(v) => setCards(cards.map((x) => (x.id === c.id ? { ...x, visible: v } : x)))} aria-label={`Mostrar ${HOME_CARD_LABEL[c.id]}`} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <DialogFooter>
          <Button className="w-full" disabled={busy || quick.length !== 4} onClick={() => void save()} data-testid="home-layout-save">
            {busy && <Loader2 className="animate-spin" />} {quick.length !== 4 ? `Escolha mais ${4 - quick.length} ação(ões)` : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
