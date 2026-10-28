import { Link } from 'react-router-dom';
import { Target } from 'lucide-react';
import type { WeightUnit } from '@/lib/types';
import type { GoalEvaluation } from '@/modules/goals';
import { DISPLAY_STATE_LABEL, fmtGoalValue } from './goalFormat';

// Metas ligadas a um indicador da página de desempenho (IronTrack 2.0 F01/P12). O progresso vem do motor de metas,
// que usa os mesmos contratos do analytics: nada é recalculado aqui.

export function RelatedGoals({ items, weightUnit, title = 'Metas deste exercício', testId = 'related-goals' }: { items: GoalEvaluation[]; weightUnit: WeightUnit; title?: string; testId?: string }) {
  if (!items.length) return null;
  return (
    <div className="mt-3 rounded-xl border p-3" data-testid={testId}>
      <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        <Target className="h-4 w-4 text-primary" aria-hidden /> {title}
      </p>
      <ul className="space-y-1 text-sm">
        {items.map(({ goal, progress: p }) => (
          <li key={goal.id} className="flex flex-wrap justify-between gap-x-2">
            <span className="min-w-0 break-words">{goal.title}</span>
            <span className="shrink-0 tabular text-xs text-muted-foreground">
              {goal.type === 'weekly_frequency'
                ? `${p.current ?? 0} de ${goal.targetValue} nesta semana`
                : `${p.current === null ? 'sem registros' : fmtGoalValue(goal, p.current, weightUnit)} de ${fmtGoalValue(goal, goal.targetValue, weightUnit)}`}{' '}
              · {DISPLAY_STATE_LABEL[p.displayState]}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Quando o gráfico mostra a medida da meta, a linha tracejada marca o objetivo. A meta considera só o exercício escolhido na ficha. <Link to="/metas" className="text-primary underline-offset-2 hover:underline">Ver metas</Link>
      </p>
    </div>
  );
}
