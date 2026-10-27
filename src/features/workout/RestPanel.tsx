import { AnimatePresence, motion } from 'framer-motion';
import { BellOff, ChevronDown, ChevronUp, Pause, Play, SkipForward } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RestState } from '@/lib/types';
import { isPaused, progress, remainingMs } from '@/modules/training';
import { cn, fmtClock } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useNow } from '@/hooks/data';

function Ring({ value, size, stroke, children, done }: { value: number; size: number; stroke: number; children: React.ReactNode; done?: boolean }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="hsl(var(--secondary))" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={done ? 'hsl(var(--primary))' : 'hsl(var(--primary))'}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value)}
          style={{ transition: 'stroke-dashoffset 0.25s linear', filter: 'drop-shadow(0 0 8px hsl(var(--primary) / 0.5))' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

export function RestPanel({
  rest,
  onAdjust,
  onPause,
  onResume,
  onSkip,
  alertsMissing,
}: {
  rest: RestState;
  onAdjust: (deltaSec: number) => void;
  onPause: () => void;
  onResume: () => void;
  onSkip: () => void;
  /** Avisos indisponíveis (sem som/vibração/notificação): reforça o aviso visual. */
  alertsMissing: boolean;
}) {
  const now = useNow(200);
  const [minimized, setMinimized] = useState(false);
  const rem = remainingMs(rest, now);
  const finished = rem <= 0;
  const paused = isPaused(rest);

  useEffect(() => {
    if (finished) setMinimized(false);
  }, [finished]);

  // Ao terminar, mostra o aviso por alguns segundos e libera a próxima série.
  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(onSkip, 8000);
    return () => clearTimeout(t);
  }, [finished, onSkip]);

  if (minimized && !finished) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="flex w-full items-center gap-3 rounded-2xl border border-primary/30 bg-card px-4 py-2.5"
        aria-label="Expandir descanso"
      >
        <span className="font-display text-2xl font-bold tabular text-primary">{fmtClock(rem / 1000)}</span>
        <span className="flex-1 truncate text-left text-sm text-muted-foreground">Descanso{paused ? ' (pausado)' : ''} · {rest.nextLabel}</span>
        <ChevronUp className="h-5 w-5 text-muted-foreground" />
      </button>
    );
  }

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn('relative overflow-hidden rounded-3xl border bg-card p-3.5', finished && 'border-primary')}
      aria-live="polite"
      data-testid="rest-panel"
    >
      <AnimatePresence>
        {finished && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.15, 0.35, 0.15] }}
            transition={{ duration: 1.2, repeat: Infinity }}
            className="pointer-events-none absolute inset-0 bg-primary"
          />
        )}
      </AnimatePresence>
      <div className="relative flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{finished ? 'Descanso terminado' : paused ? 'Descanso pausado' : 'Descansando'}</p>
        {!finished && (
          <button className="rounded-full p-1.5 text-muted-foreground hover:bg-accent" onClick={() => setMinimized(true)} aria-label="Minimizar descanso">
            <ChevronDown className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="relative mt-1 flex items-center gap-4">
        <Ring value={finished ? 1 : progress(rest, now)} size={128} stroke={9} done={finished}>
          <span className={cn('font-display text-4xl font-bold tabular', finished && 'text-primary')} data-testid="rest-remaining">
            {finished ? '0:00' : fmtClock(rem / 1000)}
          </span>
          <span className="text-xs text-muted-foreground">de {fmtClock(rest.durationMs / 1000)}</span>
        </Ring>
        <div className="grid flex-1 grid-cols-2 gap-2">
          <Button variant="secondary" className="h-12 px-0 text-base" onClick={() => onAdjust(-30)} disabled={finished}>
            −30
          </Button>
          <Button variant="secondary" className="h-12 px-0 text-base" onClick={() => onAdjust(30)}>
            +30
          </Button>
          <Button variant="secondary" className="h-12 px-0 text-base" onClick={() => onAdjust(-15)} disabled={finished}>
            −15
          </Button>
          <Button variant="secondary" className="h-12 px-0 text-base" onClick={() => onAdjust(15)}>
            +15
          </Button>
        </div>
      </div>

      <div className="relative mt-2 rounded-2xl bg-background/60 px-3 py-1.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Próxima</p>
        <p className="truncate font-semibold">{rest.nextLabel}</p>
      </div>

      {finished && alertsMissing && (
        <p className="relative mt-2 flex items-center gap-1.5 text-xs text-warn">
          <BellOff className="h-3.5 w-3.5" /> Som/vibração indisponíveis: fique de olho neste aviso.
        </p>
      )}

      <div className="relative mt-3 grid grid-cols-2 gap-2">
        {!finished &&
          (paused ? (
            <Button variant="outline" size="lg" onClick={onResume}>
              <Play /> Continuar
            </Button>
          ) : (
            <Button variant="outline" size="lg" onClick={onPause}>
              <Pause /> Pausar
            </Button>
          ))}
        <Button size="lg" className={cn(finished && 'col-span-2')} onClick={onSkip} data-testid="rest-skip">
          <SkipForward /> {finished ? 'Próxima série' : 'Pular'}
        </Button>
      </div>
    </motion.section>
  );
}
