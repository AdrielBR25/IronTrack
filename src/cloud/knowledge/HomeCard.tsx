// Cartão "Conhecimento" do Início (Fase 04): leitura/estudo de hoje, sessão em andamento e atalho para começar.
import { Link } from 'react-router-dom';
import { Brain, ChevronRight, Play } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useLifeQuery } from '../life/api';
import { Bar } from '../life/ui';
import { knowledgeApi } from './api';
import { ActiveTimerBanner } from './parts';
import { fmtMin } from './ui';

export function KnowledgeHomeCard() {
  const q = useLifeQuery(() => knowledgeApi.dashboard());
  const d = q.data;
  const goal = d?.goals.find((g) => g.period === 'daily' && g.current.scheduledToday);
  return (
    <Card data-testid="home-knowledge">
      <CardContent className="space-y-3 p-4">
        <Link to="/conhecimento" className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Brain className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Conhecimento</span>
            <span className="block text-xs tabular-nums text-muted-foreground">
              {!d ? 'Carregando…' : d.sessionsToday === 0 ? (d.reading[0] ? `Lendo: ${d.reading[0].title}` : 'Nenhuma sessão hoje') : `${fmtMin(d.readingMin)} de leitura · ${fmtMin(d.studyMin + d.focusMin)} de estudo`}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
        {goal && (
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span className="truncate">{goal.title}</span>
              <span className="tabular-nums">
                {goal.current.progress}/{goal.target}
              </span>
            </div>
            <Bar value={goal.current.progress / goal.target} className="h-1.5" label={goal.title} />
          </div>
        )}
        {d?.timer ? (
          <ActiveTimerBanner />
        ) : (
          <Link to="/conhecimento/foco" className="flex items-center justify-center gap-1 rounded-xl bg-secondary py-2 text-xs font-semibold active:scale-[0.99]">
            <Play className="h-3.5 w-3.5" />
            Iniciar sessão
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
