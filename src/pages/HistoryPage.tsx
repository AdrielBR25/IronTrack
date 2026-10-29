import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { Clock, History, Layers, Medal, Pencil, Play, Weight } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card } from '@/components/ui/card';
import { useCompletedSessions } from '@/hooks/data';
import { useUnits } from '@/hooks/useUnits';
import { recordedDurationSec, sessionVolume, validSetCount } from '@/modules/training';
import type { WorkoutSession } from '@/lib/types';
import { ResumeDialog } from '@/features/workout/ResumeDialog';
import { Button } from '@/components/ui/button';
import { cn, fmtDuration } from '@/lib/utils';
import { fmtTime } from '@/lib/dates';

export default function HistoryPage() {
  const sessions = useCompletedSessions();
  const { fmtVol } = useUnits();
  const [filter, setFilter] = useState<string>('all');
  const [resuming, setResuming] = useState<WorkoutSession | null>(null);
  const labels = useMemo(() => [...new Set((sessions ?? []).map((s) => s.workoutLabel))].sort(), [sessions]);
  const groups = useMemo(() => {
    const list = [...(sessions ?? [])].reverse().filter((s) => filter === 'all' || s.workoutLabel === filter);
    const map = new Map<string, typeof list>();
    for (const s of list) {
      const k = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(s.startedAt));
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()];
  }, [sessions, filter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Histórico"
        subtitle={sessions ? `${sessions.length} treinos registrados` : ' '}
        action={
          sessions && sessions.length > 0 ? (
            <Link
              to="/desempenho"
              className="flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="history-open-performance"
            >
              <Medal className="h-4 w-4 text-primary" aria-hidden /> Desempenho
            </Link>
          ) : undefined
        }
      />
      {labels.length > 1 && (
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {['all', ...labels].map((l) => (
            <button
              key={l}
              onClick={() => setFilter(l)}
              className={cn('shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium', filter === l ? 'border-primary bg-primary/10' : 'text-muted-foreground')}
            >
              {l === 'all' ? 'Todos' : `Treino ${l}`}
            </button>
          ))}
        </div>
      )}
      {sessions && sessions.length === 0 && (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <History className="h-10 w-10 text-muted-foreground" />
          <p className="font-semibold">Nenhum treino concluído ainda</p>
          <p className="text-sm text-muted-foreground">Seus treinos finalizados aparecem aqui, com séries, cargas e volume.</p>
        </Card>
      )}
      {groups.map(([month, list]) => (
        <section key={month} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{month}</h2>
          {list.map((s) => {
            const d = new Date(s.startedAt);
            return (
              <Card key={s.id} className="flex items-center gap-1 p-1.5 pl-3 transition-colors hover:bg-accent/40">
                <Link to={`/historico/${s.id}`} className="flex min-w-0 flex-1 items-center gap-3 py-1.5" data-testid="history-item">
                  <div className="flex w-10 shrink-0 flex-col items-center">
                    <span className="font-display text-xl font-bold tabular">{d.getDate()}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{new Intl.DateTimeFormat('pt-BR', { weekday: 'short' }).format(d).replace('.', '')}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">
                      <span className="text-primary">Treino {s.workoutLabel}</span> · {s.workoutName}
                    </p>
                    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular">
                      <span>{fmtTime(s.startedAt)}</span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {fmtDuration(recordedDurationSec(s))}
                      </span>
                      <span className="flex items-center gap-1">
                        <Weight className="h-3 w-3" />
                        {fmtVol(sessionVolume(s))}
                      </span>
                      <span className="flex items-center gap-1">
                        <Layers className="h-3 w-3" />
                        {validSetCount(s)} séries
                      </span>
                      {(s.revisions?.length ?? 0) > 0 && <span data-testid="history-edited">editado</span>}
                    </p>
                  </div>
                </Link>
                <Link
                  to={`/historico/${s.id}/editar`}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Editar treino ${s.workoutLabel} de ${fmtTime(s.startedAt)}`}
                  data-testid="history-edit"
                >
                  <Pencil className="h-4 w-4" />
                </Link>
                <Button size="icon" variant="ghost" className="shrink-0" aria-label={`Continuar treino ${s.workoutLabel} de ${fmtTime(s.startedAt)}`} onClick={() => setResuming(s)} data-testid="history-resume">
                  <Play />
                </Button>
              </Card>
            );
          })}
        </section>
      ))}
      {resuming && <ResumeDialog base={resuming} open onOpenChange={(o) => !o && setResuming(null)} />}
    </div>
  );
}
