// Peças visuais do RPG (Fase 01): ícones, barras de XP, atributos, linhas de hábito e de missão, e o retorno discreto
// de recompensas (ganho de XP, subida de nível, missão concluída, conquista). Movimento reduzido respeitado.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Apple,
  Award,
  Book,
  BookOpen,
  Brain,
  Check,
  Church,
  Clock,
  Droplet,
  Dumbbell,
  Flame,
  Footprints,
  GraduationCap,
  Heart,
  HeartPulse,
  Leaf,
  List,
  Minus,
  Moon,
  Music,
  PenLine,
  Plus,
  Sparkle,
  Sun,
  Target,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import { ATTRIBUTE_LABEL, UNIT_LABEL, type Attribute, type HabitView, type IconName, type MissionView, type RewardOutcome } from '@shared/life/protocol.ts';
import { cn } from '@/lib/utils';
import { getSyncEngine } from '../syncEngine';
import { emitReward, invalidateLife, lifeApi, onReward } from './api';

export const ICON: Record<IconName, LucideIcon> = {
  check: Check,
  droplet: Droplet,
  book: Book,
  'book-open': BookOpen,
  graduation: GraduationCap,
  dumbbell: Dumbbell,
  moon: Moon,
  sun: Sun,
  heart: Heart,
  brain: Brain,
  apple: Apple,
  list: List,
  clock: Clock,
  flame: Flame,
  pen: PenLine,
  church: Church,
  footprints: Footprints,
  music: Music,
  leaf: Leaf,
  target: Target,
};

export const ATTR_ICON: Record<Attribute, LucideIcon> = { strength: Dumbbell, knowledge: Brain, discipline: Target, health: HeartPulse, spirituality: Sparkle };
/** Cores fixas por atributo (texto, fundo suave, barra). */
export const ATTR_TONE: Record<Attribute, { text: string; soft: string; bar: string }> = {
  strength: { text: 'text-rose-500 dark:text-rose-400', soft: 'bg-rose-500/12', bar: 'bg-rose-500' },
  knowledge: { text: 'text-sky-600 dark:text-sky-400', soft: 'bg-sky-500/12', bar: 'bg-sky-500' },
  discipline: { text: 'text-violet-600 dark:text-violet-400', soft: 'bg-violet-500/12', bar: 'bg-violet-500' },
  health: { text: 'text-emerald-600 dark:text-emerald-400', soft: 'bg-emerald-500/12', bar: 'bg-emerald-500' },
  spirituality: { text: 'text-amber-600 dark:text-amber-400', soft: 'bg-amber-500/12', bar: 'bg-amber-500' },
};

export function AttrChip({ attribute, className }: { attribute: Attribute; className?: string }) {
  const Icon = ATTR_ICON[attribute];
  const t = ATTR_TONE[attribute];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', t.soft, t.text, className)}>
      <Icon className="h-3 w-3" />
      {ATTRIBUTE_LABEL[attribute]}
    </span>
  );
}

export function Bar({ value, className, tone = 'bg-primary', label }: { value: number; className?: string; tone?: string; label?: string }) {
  const reduce = useReducedMotion();
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-secondary', className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label}>
      <motion.div className={cn('h-full rounded-full', tone)} initial={reduce ? false : { width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: reduce ? 0 : 0.6, ease: 'easeOut' }} />
    </div>
  );
}

/** Anel de progresso (dia). */
export function Ring({ value, size = 64, children }: { value: number; size?: number; children?: React.ReactNode }) {
  const reduce = useReducedMotion();
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={6} className="fill-none stroke-secondary" />
        <motion.circle cx={size / 2} cy={size / 2} r={r} strokeWidth={6} strokeLinecap="round" className="fill-none stroke-primary" strokeDasharray={c} initial={reduce ? false : { strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v) }} transition={{ duration: reduce ? 0 : 0.8, ease: 'easeOut' }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

const goalText = (h: HabitView) => (h.goalKind === 'check' ? 'Concluir' : `${h.today.amount}/${h.goalTarget} ${h.goalUnit ?? (h.goalKind === 'duration' ? 'min' : '')}`.trim());

/** Linha de hábito com registro rápido: toque para concluir; quantidade/duração com − e +. */
export function HabitRow({ h, onError }: { h: HabitView; onError: (e: unknown) => void }) {
  const Icon = ICON[h.icon] ?? Check;
  const [busy, setBusy] = useState(false);
  const step = h.goalKind === 'duration' ? (h.goalTarget >= 30 ? 10 : 5) : 1;
  const log = async (amount: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await lifeApi.logHabit(h.id, Math.max(0, amount));
      navigator.vibrate?.(8);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const done = h.today.completed;
  return (
    <div className={cn('flex items-center gap-3 rounded-xl px-1 py-2', busy && 'opacity-60')}>
      <button
        type="button"
        onClick={() => log(done ? 0 : h.goalTarget)}
        aria-pressed={done}
        aria-label={done ? `Desmarcar ${h.name}` : `Concluir ${h.name}`}
        className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition-colors', done ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:border-primary/60')}
      >
        {done ? <Check className="h-5 w-5" strokeWidth={3} /> : <Icon className="h-[18px] w-[18px]" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm font-medium', done && 'text-muted-foreground line-through decoration-1')}>{h.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {goalText(h)}
          {h.preferredTime ? ` · ${h.preferredTime}` : ''}
          {h.frequency === 'weekly' ? ` · ${h.week.completions}/${h.timesPerWeek} na semana` : ''}
          {h.streak > 1 ? ` · ${h.streak} seguidos` : ''}
        </p>
      </div>
      {h.goalKind !== 'check' && !done && (
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Diminuir" disabled={h.today.amount <= 0} onClick={() => log(h.today.amount - step)} className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground disabled:opacity-30">
            <Minus className="h-4 w-4" />
          </button>
          <button type="button" aria-label="Aumentar" onClick={() => log(h.today.amount + step)} className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}
      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">+{h.xp}</span>
    </div>
  );
}

const STATUS_LABEL: Record<MissionView['status'], string> = { active: '', completed: 'Concluída', expired: 'Expirada', paused: 'Pausada', cancelled: 'Cancelada' };

export function MissionRow({ m, onOpen }: { m: MissionView; onOpen?: () => void }) {
  const done = m.status === 'completed';
  const unit = m.unit === 'check' ? '' : ` ${UNIT_LABEL[m.unit]}`;
  const Comp = onOpen ? 'button' : 'div';
  return (
    <Comp {...(onOpen ? { type: 'button' as const, onClick: onOpen } : {})} className={cn('flex w-full items-center gap-3 rounded-xl px-1 py-2 text-left', onOpen && 'active:opacity-70', (m.status === 'paused' || m.status === 'expired') && 'opacity-60')}>
      <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', done ? 'bg-primary text-primary-foreground' : cn(ATTR_TONE[m.attribute].soft, ATTR_TONE[m.attribute].text))}>{done ? <Check className="h-5 w-5" strokeWidth={3} /> : <Trophy className="h-[18px] w-[18px]" />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn('truncate text-sm font-medium', done && 'text-muted-foreground')}>{m.title}</span>
          {STATUS_LABEL[m.status] && !done && <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">{STATUS_LABEL[m.status]}</span>}
        </span>
        <span className="mt-1 flex items-center gap-2">
          <Bar value={m.progress / m.target} className="h-1.5" tone={done ? 'bg-primary' : ATTR_TONE[m.attribute].bar} label={m.title} />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {Math.min(m.progress, m.target)}/{m.target}
            {unit}
          </span>
        </span>
      </span>
      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">+{m.xp}</span>
    </Comp>
  );
}

// ------------------------------------------------------------------ retorno de recompensas

interface Fx {
  id: number;
  kind: 'xp' | 'level' | 'mission' | 'achievement';
  text: string;
}

/**
 * Avisos discretos no topo: "+15 XP", "Missão concluída", "Conquista", "Nível 5". No máximo 3 por vez, somem
 * sozinhos; com movimento reduzido, aparecem sem deslocamento.
 */
export function RewardFx() {
  const reduce = useReducedMotion();
  const [items, setItems] = useState<Fx[]>([]);
  const seq = useRef(0);
  useEffect(
    () =>
      onReward((o: RewardOutcome) => {
        const next: Fx[] = [];
        if (o.levelUp) next.push({ id: ++seq.current, kind: 'level', text: `Nível ${o.levelUp.to}!` });
        for (const a of o.achievements) next.push({ id: ++seq.current, kind: 'achievement', text: a.title });
        for (const m of o.missionsCompleted.slice(0, 2)) next.push({ id: ++seq.current, kind: 'mission', text: m.title });
        if (o.xpGained > 0) next.push({ id: ++seq.current, kind: 'xp', text: `+${o.xpGained} XP` });
        const shown = next.slice(0, 3);
        setItems((cur) => [...cur, ...shown].slice(-3));
        for (const f of shown) setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== f.id)), f.kind === 'level' ? 3200 : 2200);
      }),
    [],
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[60] flex flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence>
        {items.map((f) => (
          <motion.div
            key={f.id}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.96 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.1 : 0.25 }}
            className={cn(
              'flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur-xl',
              f.kind === 'level' ? 'border-primary/50 bg-primary text-primary-foreground' : 'bg-card/95',
            )}
          >
            {f.kind === 'xp' && <Sparkle className="h-4 w-4 text-primary" />}
            {f.kind === 'level' && <Trophy className="h-4 w-4" />}
            {f.kind === 'mission' && <Check className="h-4 w-4 text-primary" />}
            {f.kind === 'achievement' && <Award className="h-4 w-4 text-amber-500" />}
            <span>
              {f.kind === 'mission' ? 'Missão concluída: ' : f.kind === 'achievement' ? 'Conquista: ' : ''}
              {f.text}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Depois de cada sincronização (ex.: treino concluído enviado), concilia os treinos com o RPG: o XP do treino aparece
 * sem precisar abrir o Início. No máximo uma vez a cada 20 s.
 */
export function LifeSyncWatcher() {
  const last = useRef<number | null>(null);
  const at = useRef(0);
  useEffect(() => {
    const engine = getSyncEngine();
    if (!engine) return;
    const run = () => {
      const s = engine.getStatus();
      if (!s.lastSyncAt || s.lastSyncAt === last.current || s.state !== 'synced') return;
      last.current = s.lastSyncAt;
      if (Date.now() - at.current < 20_000) return;
      at.current = Date.now();
      lifeApi
        .reconcile()
        .then((r) => {
          if (!r.outcome.xpGained && !r.outcome.xpReverted) return;
          emitReward(r.outcome);
          invalidateLife();
        })
        .catch(() => {});
    };
    return engine.subscribe(run);
  }, []);
  return null;
}
