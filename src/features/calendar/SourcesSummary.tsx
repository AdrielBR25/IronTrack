import { Layers } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { CalendarSummary } from '@/modules/calendar';
import { pct } from '@/features/planner/plannerFormat';

// Números do calendário unificado (IronTrack 2.0 F01/P14). Mesmas definições do planejamento (P13) e sessões contadas
// pelas regras das metas (P12). Sugestões da agenda anterior e divergências aparecem à parte: nunca entram como
// "planejadas".

export function SourcesSummaryCard({ summary: s, title, compact, testId }: { summary: CalendarSummary; title?: string; compact?: boolean; testId?: string }) {
  if (compact) {
    return (
      <p className="flex gap-2 rounded-xl border px-3 py-2 text-xs text-muted-foreground" data-testid={testId}>
        <Layers className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          <span data-testid="sum-suggestions">
            Sugestões da agenda anterior: {s.legacySuggestions} {s.legacySuggestions === 1 ? 'dia' : 'dias'} (não contam como planejadas)
          </span>
          {' · '}
          <span data-testid="sum-conflicts">
            Dias com divergência entre agendas: {s.conflictDays}
          </span>
        </span>
      </p>
    );
  }
  const row = (label: string, value: React.ReactNode, id: string) => (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular" data-testid={id}>
        {value}
      </dd>
    </div>
  );
  return (
    <Card className="p-4" data-testid={testId}>
      <h2 className="mb-3 flex items-center gap-2 font-display font-semibold first-letter:uppercase">
        <Layers className="h-5 w-5 text-primary" /> {title}
      </h2>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm sm:grid-cols-3">
        {row('Sessões concluídas', s.sessionsCompleted, 'sum-sessions')}
        {row('Dias ativos', s.activeDays, 'sum-active-days')}
        {row('Atividades planejadas', `${s.plannedDue} até hoje · ${s.plannedActivities} no período`, 'sum-planned')}
        {row(
          'Realizadas do plano',
          s.plannedDue > 0 ? `${s.realized} de ${s.plannedDue} (${pct(s.realized / s.plannedDue)})` : <span className="font-normal text-muted-foreground">Sem planejamento até hoje</span>,
          'sum-realized',
        )}
        {row('Fora do planejado', s.extraSessions, 'sum-extra')}
        {row('Descanso planejado', `${s.restDaysPlanned} ${s.restDaysPlanned === 1 ? 'dia' : 'dias'}`, 'sum-rest')}
        {row('Sugestões da agenda anterior', `${s.legacySuggestions} ${s.legacySuggestions === 1 ? 'dia' : 'dias'}`, 'sum-suggestions')}
        {row('Dias com divergência', s.conflictDays, 'sum-conflicts')}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Planejadas contam só o que você planejou explicitamente. Sugestões da agenda anterior (dias de treino das Configurações) e previsões da rotação ficam fora dessa
        conta. Sessões: só treinos concluídos, no dia em que aconteceram (horário deste aparelho).
      </p>
    </Card>
  );
}
