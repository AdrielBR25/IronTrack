// Peças compartilhadas das telas do Conhecimento: aviso da sessão em andamento e seção com título.
import { Link } from 'react-router-dom';
import { ChevronRight, Timer } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { fmtClock, liveActive, useKnowledgeTimer, useNow } from './timer';

export function ActiveTimerBanner() {
  const { timer } = useKnowledgeTimer();
  const now = useNow(!!timer);
  if (!timer) return null;
  const a = liveActive(timer, now);
  const label = timer.stale ? 'Sessão interrompida' : timer.phase === 'paused' ? 'Pausada' : timer.phase === 'focus' ? 'Em andamento' : 'Pausa do pomodoro';
  return (
    <Link to="/conhecimento/foco" className="flex items-center gap-3 rounded-2xl border border-primary/40 bg-primary/10 p-3" data-testid="knowledge-timer-banner">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Timer className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{timer.title}</span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
      <span className="font-display text-xl font-bold tabular-nums">{fmtClock(a.activeSec)}</span>
    </Link>
  );
}

export function Section({ title, to, children, action }: { title: string; to?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {action}
        {to && (
          <Link to={to} className="flex items-center text-xs text-primary">
            Ver tudo
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <Card>
        <CardContent className="divide-y divide-border/60 px-4 py-1">{children}</CardContent>
      </Card>
    </section>
  );
}
