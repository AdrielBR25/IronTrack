// Peças visuais da alimentação (Fase 02): anel de calorias, barras de macronutrientes, cartão de refeição, faixa da
// semana e utilitários de data/formatação. Visual premium escuro com verde-limão (cor primária do tema).
import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Apple, CalendarClock, Check, ChevronLeft, ChevronRight, Coffee, CookingPot, Moon, Sandwich, Soup, UtensilsCrossed, type LucideIcon } from 'lucide-react';
import { FOOD_STATE_LABEL, MEAL_KIND_LABEL, type FoodView, type Macros, type MealKind, type MealView } from '@shared/nutrition/protocol.ts';
import { cn } from '@/lib/utils';

export const KIND_ICON: Record<MealKind, LucideIcon> = { breakfast: Coffee, lunch: Soup, snack: Sandwich, dinner: CookingPot, supper: Moon, custom: UtensilsCrossed };
export const KIND_ORDER: MealKind[] = ['breakfast', 'lunch', 'snack', 'dinner', 'supper', 'custom'];

/** Cores fixas por macronutriente (texto, barra). */
export const MACRO_TONE = {
  protein: { label: 'Proteínas', short: 'P', bar: 'bg-sky-500', text: 'text-sky-500 dark:text-sky-400', fill: '#0ea5e9' },
  carbs: { label: 'Carboidratos', short: 'C', bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', fill: '#f59e0b' },
  fat: { label: 'Gorduras', short: 'G', bar: 'bg-rose-500', text: 'text-rose-500 dark:text-rose-400', fill: '#f43f5e' },
} as const;

const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
export const kcal = (v: number) => nf0.format(Math.round(v));
export const grams = (v: number) => nf1.format(Math.round(v * 10) / 10);
export const qty = (v: number, unit: string) => `${nf1.format(v)} ${unit}`;

// ------------------------------------------------------------------ datas (texto yyyy-mm-dd, sem fuso)

export const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
export const mondayOf = (d: string) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return addDays(d, -((wd + 6) % 7));
};
export const localToday = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dt = (d: string) => new Date(`${d}T12:00:00Z`);
export const dayLabel = (d: string, today: string) => {
  if (d === today) return 'Hoje';
  if (d === addDays(today, -1)) return 'Ontem';
  if (d === addDays(today, 1)) return 'Amanhã';
  return dt(d).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
export const shortDate = (d: string) => dt(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
export const weekdayShort = (d: string) => dt(d).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
export const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

// ------------------------------------------------------------------ anel e barras

/** Anel de calorias: consumido × meta (sem meta: só o número). Passar da meta não fica "vermelho": é informação. */
export function CalorieRing({ value, goal, size = 132 }: { value: number; goal: number | null; size?: number }) {
  const reduce = useReducedMotion();
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  const p = goal ? Math.min(1, value / goal) : 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} data-testid="kcal-ring">
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={10} className="fill-none stroke-secondary" />
        {goal ? (
          <motion.circle cx={size / 2} cy={size / 2} r={r} strokeWidth={10} strokeLinecap="round" className="fill-none stroke-primary drop-shadow-[0_0_8px_hsl(var(--primary)/0.6)]" strokeDasharray={c} initial={reduce ? false : { strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - p) }} transition={{ duration: reduce ? 0 : 0.8, ease: 'easeOut' }} />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="font-display text-3xl font-bold leading-none tabular-nums">{kcal(value)}</span>
        <span className="mt-1 text-[11px] text-muted-foreground">{goal ? `de ${kcal(goal)} kcal` : 'kcal'}</span>
      </div>
    </div>
  );
}

export function MacroBar({ macro, value, goal, compact }: { macro: keyof typeof MACRO_TONE; value: number; goal: number | null; compact?: boolean }) {
  const reduce = useReducedMotion();
  const t = MACRO_TONE[macro];
  const pct = goal ? Math.min(1, value / goal) * 100 : 0;
  return (
    <div className="space-y-1" data-testid={`macro-${macro}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className={cn('font-medium', compact ? 'text-muted-foreground' : '')}>{t.label}</span>
        <span className="tabular-nums text-muted-foreground">
          <span className="font-semibold text-foreground">{grams(value)}</span>
          {goal ? ` / ${goal} g` : ' g'}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label={t.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        {goal ? <motion.div className={cn('h-full rounded-full', t.bar)} initial={reduce ? false : { width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: reduce ? 0 : 0.6, ease: 'easeOut' }} /> : <div className={cn('h-full w-full opacity-25', t.bar)} />}
      </div>
    </div>
  );
}

export function MacroLine({ m, className }: { m: Macros; className?: string }) {
  return (
    <span className={cn('tabular-nums text-xs text-muted-foreground', className)}>
      <span className={MACRO_TONE.protein.text}>P {grams(m.protein)}</span> · <span className={MACRO_TONE.carbs.text}>C {grams(m.carbs)}</span> · <span className={MACRO_TONE.fat.text}>G {grams(m.fat)}</span>
    </span>
  );
}

export function StateChip({ food }: { food: Pick<FoodView, 'state' | 'source'> }) {
  const label = FOOD_STATE_LABEL[food.state];
  if (!label) return null;
  return <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', food.state === 'raw' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : food.state === 'cooked' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground')}>{label}</span>;
}

// ------------------------------------------------------------------ refeição

export function MealCard({ meal, onOpen, onConsume, busy }: { meal: MealView; onOpen: () => void; onConsume?: () => void; busy?: boolean }) {
  const Icon = KIND_ICON[meal.kind];
  const planned = meal.status === 'planned';
  return (
    <div className={cn('flex items-stretch gap-3 rounded-2xl border bg-card p-3 transition-colors', planned && 'border-dashed bg-card/50')} data-testid="meal-card" data-status={meal.status}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-3 text-left active:opacity-70">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', planned ? 'bg-secondary text-muted-foreground' : 'bg-primary/15 text-primary')}>
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium">{meal.title}</span>
            {meal.time && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meal.time}</span>}
            {planned && <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[10px] font-medium text-muted-foreground">planejada</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{meal.items.length ? meal.items.map((i) => i.name.split(',')[0]).join(', ') : 'Sem alimentos ainda'}</span>
          <span className="mt-1 flex items-center gap-2">
            <span className="text-sm font-semibold tabular-nums">{kcal(meal.totals.kcal)} kcal</span>
            <MacroLine m={meal.totals} />
          </span>
        </span>
      </button>
      {planned && onConsume && meal.items.length > 0 && (
        <button type="button" onClick={onConsume} disabled={busy} aria-label={`Marcar ${meal.title} como consumida`} className="flex w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl bg-primary/10 text-[10px] font-semibold text-primary active:scale-95 disabled:opacity-50">
          <Check className="h-5 w-5" strokeWidth={3} />
          Comi
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ faixa da semana (calendário rápido)

export function WeekStrip({ date, today, onPick, marks }: { date: string; today: string; onPick: (d: string) => void; marks?: Record<string, 'logged' | 'planned'> }) {
  const start = mondayOf(date);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);
  return (
    <div className="flex items-center gap-1" data-testid="week-strip">
      <button type="button" aria-label="Semana anterior" onClick={() => onPick(addDays(date, -7))} className="flex h-12 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-accent">
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="grid flex-1 grid-cols-7 gap-1">
        {days.map((d) => {
          const sel = d === date;
          const mark = marks?.[d];
          return (
            <button key={d} type="button" onClick={() => onPick(d)} aria-pressed={sel} aria-label={dayLabel(d, today)} className={cn('flex h-12 flex-col items-center justify-center rounded-xl text-xs transition-colors', sel ? 'bg-primary font-semibold text-primary-foreground' : d === today ? 'bg-secondary font-semibold' : 'text-muted-foreground active:bg-accent')}>
              <span className="text-[10px] uppercase">{weekdayShort(d).slice(0, 3)}</span>
              <span className="tabular-nums">{Number(d.slice(8))}</span>
              <span className={cn('mt-0.5 h-1 w-1 rounded-full', mark === 'logged' ? (sel ? 'bg-primary-foreground' : 'bg-primary') : mark === 'planned' ? 'bg-muted-foreground/60' : 'bg-transparent')} />
            </button>
          );
        })}
      </div>
      <button type="button" aria-label="Próxima semana" onClick={() => onPick(addDays(date, 7))} className="flex h-12 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-accent">
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

export const EmptyIcon = { Apple, CalendarClock };
export const kindLabel = (k: MealKind) => MEAL_KIND_LABEL[k];
