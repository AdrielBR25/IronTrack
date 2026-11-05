// Alimentação (Fase 02): o dia em uma tela. Resumo de calorias e macros contra a meta, água, refeições consumidas e
// planejadas, registro em poucos toques (repetir, refeições salvas), calendário da semana e atalho para a IA.
// Planejadas aparecem separadas e não entram no consumo até a pessoa tocar em "Comi".
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { BarChart3, CalendarRange, Search, ChevronRight, Copy, Droplet, Minus, Plus, Repeat2, Settings2, Sparkles, Target, UtensilsCrossed } from 'lucide-react';
import { MEAL_KIND_LABEL, NUTRITION_REWARD, type MealKind, type MealView } from '@shared/nutrition/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { emitReward, useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { nutritionApi } from './api';
import { MealEditor, type MealEditorTarget } from './MealEditor';
import { CalorieRing, KIND_ICON, KIND_ORDER, MacroBar, MealCard, WeekStrip, addDays, dayLabel, kcal, localToday, mondayOf, nowHHMM } from './ui';

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function NutritionPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [date, setDate] = useState(params.get('dia') ?? localToday());
  const q = useLifeQuery(() => nutritionApi.day(date), [date]);
  const d = q.data?.day;
  const today = d?.today ?? localToday();
  const week = mondayOf(date);
  const summaries = useLifeQuery(() => nutritionApi.days(week, addDays(week, 6)), [week]);
  const quick = useLifeQuery(() => nutritionApi.quick().then((r) => r.quick));
  const [editor, setEditor] = useState<MealEditorTarget | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = useRef(false);

  useEffect(() => {
    if (q.data?.outcome && !shown.current) {
      shown.current = true;
      emitReward(q.data.outcome);
    }
  }, [q.data]);
  useEffect(() => {
    if (params.get('registrar') && d) {
      setEditor({ date: d.date });
      params.delete('registrar');
      setParams(params, { replace: true });
    }
  }, [params, d, setParams]);

  const pick = (x: string) => {
    setDate(x);
    setParams(x === today ? {} : { dia: x }, { replace: true });
  };
  const marks = useMemo(() => Object.fromEntries((summaries.data?.days ?? []).map((s) => [s.date, s.consumedMeals > 0 ? ('logged' as const) : ('planned' as const)])), [summaries.data]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(null);
    }
  };

  if (!d) {
    return (
      <div className="space-y-3">
        <PageHeader title="Alimentação" />
        {q.error ? (
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm">{lifeError(q.error)}</p>
              <Button size="sm" onClick={q.reload}>
                Tentar de novo
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="h-64 animate-pulse rounded-3xl bg-card" />
        )}
      </div>
    );
  }

  const g = d.goals;
  const consumed = d.meals.filter((m) => m.status === 'consumed');
  const planned = d.meals.filter((m) => m.status === 'planned');
  const isFuture = d.date > today;
  const remaining = g?.kcal ? g.kcal - d.consumed.kcal : null;
  const consume = (m: MealView) => act(`c${m.id}`, () => nutritionApi.consume(m.id, m.version, d.date === today ? nowHHMM() : m.time), `${m.title} marcada como consumida.`);
  // "Repetir": última refeição consumida de cada tipo, que ainda não foi registrada no dia.
  const repeat = KIND_ORDER.map((k) => quick.data?.lastByKind[k]).filter((m): m is MealView => !!m && m.date !== d.date && !consumed.some((c) => c.kind === m.kind)).slice(0, 3);

  return (
    <div className="space-y-4 pb-24" data-testid="nutrition-page">
      <PageHeader
        title="Alimentação"
        subtitle={dayLabel(d.date, today)}
        action={
          <Link to="/alimentacao/metas" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Metas nutricionais">
            <Settings2 className="h-5 w-5" />
          </Link>
        }
      />
      <WeekStrip date={d.date} today={today} onPick={pick} marks={marks} />

      <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/[0.08] via-card to-card" data-testid="day-summary">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-center gap-5">
            <CalorieRing value={d.consumed.kcal} goal={g?.kcal ?? null} />
            <div className="min-w-0 flex-1 space-y-2.5">
              <MacroBar macro="protein" value={d.consumed.protein} goal={g?.protein ?? null} />
              <MacroBar macro="carbs" value={d.consumed.carbs} goal={g?.carbs ?? null} />
              <MacroBar macro="fat" value={d.consumed.fat} goal={g?.fat ?? null} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {remaining != null && !isFuture && <span className="tabular-nums">{remaining >= 0 ? `${kcal(remaining)} kcal até a meta` : `${kcal(-remaining)} kcal acima da meta`}</span>}
            {d.hasPlan && <span className="tabular-nums">Planejado: {kcal(d.planTotal.kcal)} kcal</span>}
            <span className="tabular-nums">Fibras {Math.round(d.consumed.fiber)} g</span>
            {!g && (
              <Link to="/alimentacao/metas" className="font-medium text-primary">
                Definir metas
              </Link>
            )}
          </div>
          {d.diary.rewardAllowed && (
            <p className={cn('text-xs', d.diary.rewarded ? 'text-primary' : 'text-muted-foreground')} data-testid="diary-status">
              {d.diary.rewarded ? `Diário do dia registrado ✓` : `Registre ${Math.max(0, NUTRITION_REWARD.minMeals - d.diary.consumedMeals)} refeição(ões) para completar o diário (+${NUTRITION_REWARD.diaryDay} XP)`}
            </p>
          )}
        </CardContent>
      </Card>

      {!isFuture && <Water date={d.date} ml={d.water.ml} goal={d.water.goalMl} />}

      {repeat.length > 0 && !isFuture && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" aria-label="Repetir refeição">
          {repeat.map((m) => {
            const Icon = KIND_ICON[m.kind];
            return (
              <button key={m.id} type="button" disabled={!!busy} onClick={() => act(`r${m.id}`, () => nutritionApi.duplicate(m.id, { date: d.date, status: 'consumed' }), `${MEAL_KIND_LABEL[m.kind]} repetido.`)} className="flex shrink-0 items-center gap-2 rounded-2xl border bg-card px-3 py-2 text-left active:scale-[0.98]">
                <Repeat2 className="h-4 w-4 text-primary" />
                <span>
                  <span className="flex items-center gap-1 text-xs font-medium">
                    <Icon className="h-3 w-3" />
                    Repetir {MEAL_KIND_LABEL[m.kind].toLowerCase()}
                  </span>
                  <span className="block text-[11px] tabular-nums text-muted-foreground">{kcal(m.totals.kcal)} kcal · {dayLabel(m.date, today).toLowerCase()}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <Section
        title={isFuture ? 'Planejamento do dia' : 'Refeições'}
        action={
          <button type="button" onClick={() => setCopyOpen(true)} className="flex items-center gap-1 text-xs font-medium text-primary">
            <Copy className="h-3.5 w-3.5" />
            Copiar dia
          </button>
        }
      >
        {consumed.length === 0 && planned.length === 0 && (
          <Card>
            <CardContent className="space-y-3 p-5 text-center">
              <UtensilsCrossed className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{isFuture ? 'Nada planejado para este dia.' : 'Nenhuma refeição registrada neste dia.'}</p>
            </CardContent>
          </Card>
        )}
        <div className="space-y-2">
          {consumed.map((m) => (
            <MealCard key={m.id} meal={m} onOpen={() => setEditor({ date: d.date, meal: m })} />
          ))}
        </div>
        {planned.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="px-1 text-[11px] font-medium text-muted-foreground">Planejadas · não contam no consumo até você marcar</p>
            {planned.map((m) => (
              <MealCard key={m.id} meal={m} busy={busy === `c${m.id}`} onOpen={() => setEditor({ date: d.date, meal: m })} onConsume={d.date <= today ? () => consume(m) : undefined} />
            ))}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 pt-1">
          {(['breakfast', 'lunch', 'dinner'] as MealKind[]).map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <button key={k} type="button" onClick={() => setEditor({ date: d.date, kind: k, time: g?.mealTimes[k] ?? null })} className="flex flex-col items-center gap-1 rounded-2xl border border-dashed bg-card/40 py-3 text-xs text-muted-foreground active:scale-[0.98]">
                <Icon className="h-4 w-4" />+ {MEAL_KIND_LABEL[k]}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="IA central">
        <Card>
          <CardContent className="space-y-3 p-4">
            <button type="button" onClick={() => navigate(`/assistente?q=${encodeURIComponent('O que eu comi hoje?')}`)} className="flex w-full items-center gap-3 rounded-xl border bg-background px-3 py-3 text-left text-sm text-muted-foreground active:scale-[0.99]">
              <Sparkles className="h-4 w-4 text-primary" />
              Pergunte sobre sua alimentação…
            </button>
            <div className="flex flex-wrap gap-1.5">
              {['Quanto de proteína consumi esta semana?', 'Monte uma alimentação para amanhã com o que costumo comer', 'Olhando meus treinos e minha alimentação, o que posso melhorar?'].map((s) => (
                <button key={s} type="button" onClick={() => navigate(`/assistente?q=${encodeURIComponent(s)}`)} className="rounded-full bg-secondary px-3 py-1 text-left text-xs">
                  {s}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </Section>

      <Card className="divide-y divide-border/60">
        {[
          { to: '/alimentacao/planejar', label: 'Planejamento da semana', hint: 'Planeje sem registrar como consumido', icon: CalendarRange },
          { to: '/alimentacao/analise', label: 'Histórico e gráficos', hint: 'Calorias, proteínas, médias e frequência', icon: BarChart3 },
          { to: '/alimentacao/metas', label: 'Metas nutricionais', hint: 'Calorias, macros, água e horários', icon: Target },
          { to: '/alimentacao/alimentos', label: 'Alimentos', hint: 'Catálogo TACO e alimentos do rótulo', icon: Search },
        ].map((i) => (
          <Link key={i.to} to={i.to} className="flex items-center gap-3 px-4 py-3 active:bg-accent">
            <i.icon className="h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{i.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{i.hint}</span>
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        ))}
      </Card>

      <button
        type="button"
        onClick={() => setEditor({ date: d.date })}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] right-4 z-30 flex h-14 items-center gap-2 rounded-full bg-primary px-5 font-semibold text-primary-foreground shadow-[0_8px_30px_-6px_hsl(var(--primary)/0.7)] active:scale-95 md:bottom-8"
        data-testid="quick-log"
      >
        <Plus className="h-5 w-5" strokeWidth={3} />
        {isFuture ? 'Planejar' : 'Registrar'}
      </button>

      <MealEditor target={editor} today={today} onClose={() => setEditor(null)} />
      <CopyDayDialog open={copyOpen} onClose={() => setCopyOpen(false)} date={d.date} today={today} hasMeals={d.meals.length > 0} />
    </div>
  );
}

function Water({ date, ml, goal }: { date: string; ml: number; goal: number | null }) {
  const [busy, setBusy] = useState(false);
  const set = async (v: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await nutritionApi.water(date, Math.max(0, Math.min(10000, v)));
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const pct = goal ? Math.min(1, ml / goal) : 0;
  return (
    <Card data-testid="water">
      <CardContent className="flex items-center gap-3 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/15 text-sky-500">
          <Droplet className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium tabular-nums">
            {(ml / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} L{goal ? <span className="text-muted-foreground"> / {(goal / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} L</span> : null}
          </p>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${goal ? pct * 100 : ml > 0 ? 100 : 0}%`, opacity: goal ? 1 : 0.35 }} />
          </div>
        </div>
        <button type="button" aria-label="Menos 250 ml" disabled={busy || ml <= 0} onClick={() => set(ml - 250)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary disabled:opacity-30">
          <Minus className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Mais 250 ml" disabled={busy} onClick={() => set(ml + 250)} className="flex h-9 items-center gap-1 rounded-lg bg-sky-500/15 px-2.5 text-xs font-semibold text-sky-600 dark:text-sky-400">
          <Plus className="h-4 w-4" />
          250 ml
        </button>
      </CardContent>
    </Card>
  );
}

export function CopyDayDialog({ open, onClose, date, today, hasMeals }: { open: boolean; onClose: () => void; date: string; today: string; hasMeals: boolean }) {
  const [mode, setMode] = useState<'from' | 'to'>(hasMeals ? 'to' : 'from');
  const [other, setOther] = useState(hasMeals ? addDays(date, 1) : addDays(date, -1));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setMode(hasMeals ? 'to' : 'from');
      setOther(hasMeals ? addDays(date, 1) : addDays(date, -1));
    }
  }, [open, hasMeals, date]);
  const from = mode === 'to' ? date : other;
  const to = mode === 'to' ? other : date;
  const status = to > today ? 'planned' : 'consumed';
  const go = async () => {
    setBusy(true);
    try {
      const r = await nutritionApi.copyDay(from, [to], status);
      toast.success(`${r.ids?.length ?? 0} refeição(ões) copiada(s) ${status === 'planned' ? 'como planejadas' : ''}.`);
      onClose();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copiar refeições</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Button variant={mode === 'from' ? 'default' : 'outline'} size="sm" className="flex-1" onClick={() => setMode('from')}>
            Trazer de outro dia
          </Button>
          <Button variant={mode === 'to' ? 'default' : 'outline'} size="sm" className="flex-1" disabled={!hasMeals} onClick={() => setMode('to')}>
            Levar para outro dia
          </Button>
        </div>
        <label className="space-y-1.5 text-sm">
          <span className="text-muted-foreground">{mode === 'from' ? 'Copiar do dia' : 'Para o dia'}</span>
          <Input type="date" value={other} onChange={(e) => setOther(e.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">{status === 'planned' ? 'O destino é no futuro: as refeições entram como planejadas e não contam como consumo.' : 'As refeições entram como consumidas no destino. Você pode corrigir quantidades depois.'}</p>
        <DialogFooter>
          <Button onClick={go} disabled={busy || !other || other === date}>
            Copiar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
