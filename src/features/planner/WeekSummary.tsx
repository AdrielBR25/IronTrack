import { Link } from 'react-router-dom';
import { Activity, Check, Info, Target } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { fmtDateShort } from '@/lib/dates';
import { GOAL_STATUS_LABEL } from '@/modules/goals';
import type { WeekComparison, WeekConsistency, WeeklyGoalView } from '@/modules/planner';
import { pct, signed } from './plannerFormat';

// Consistência da semana e metas semanais (IronTrack 2.0 F01/P13). Números explicados, sem pontuação de disciplina,
// sem porcentagem quando não há planejamento e sem tratar descanso ou treino extra como falha.

export function ConsistencyCard({ c, cmp, isCurrent }: { c: WeekConsistency; cmp: WeekComparison | null; isCurrent: boolean }) {
  const vs = (n: number) => (cmp ? <span className="ml-1 text-xs font-normal text-muted-foreground">({signed(n)} vs. anterior)</span> : null);
  return (
    <Card className="p-4" data-testid="plan-consistency">
      <h2 className="mb-3 flex items-center gap-2 font-display font-semibold">
        <Activity className="h-5 w-5 text-primary" /> Consistência {isCurrent ? 'desta semana' : 'da semana'}
      </h2>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-sm sm:grid-cols-3">
        <Stat label="Sessões concluídas" testId="cons-sessions">
          {c.sessionsCompleted}
          {vs(cmp?.sessionsDelta ?? 0)}
        </Stat>
        <Stat label="Dias com treino" testId="cons-days">
          {c.daysWithTraining}
          {vs(cmp?.daysDelta ?? 0)}
        </Stat>
        <Stat label="Planejadas" testId="cons-planned">
          {c.plannedDue} até hoje · {c.plannedActivities} na semana
        </Stat>
        <Stat label="Realizadas do plano" testId="cons-realized">
          {c.plannedDue > 0 ? (
            <>
              {c.realized} de {c.plannedDue} ({pct(c.adherence ?? 0)})
            </>
          ) : (
            <span className="font-normal text-muted-foreground">Sem planejamento até hoje</span>
          )}
        </Stat>
        <Stat label="Fora do planejado" testId="cons-extra">
          {c.extraSessions}
        </Stat>
        <Stat label="Descanso planejado" testId="cons-rest">
          {c.restDays} {c.restDays === 1 ? 'dia' : 'dias'}
        </Stat>
      </dl>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer items-center gap-1 font-medium text-foreground/80">
          <Info className="h-3.5 w-3.5" /> Como cada número é calculado
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>Sessões concluídas: treinos finalizados na semana (segunda a domingo, no horário deste aparelho). Em andamento e descartados não contam; repetidos contam uma vez.</li>
          <li>Dias com treino: dias distintos com ao menos uma sessão concluída (duas sessões no mesmo dia = 1 dia).</li>
          <li>Planejadas: treinos do planejamento até hoje e na semana inteira. Descanso e dia livre não entram.</li>
          <li>Realizadas do plano: planejadas até hoje com uma sessão da mesma rotina e do mesmo treino no mesmo dia (ou qualquer treino da rotina, quando o plano segue a rotação). A porcentagem só aparece quando há algo planejado.</li>
          <li>Fora do planejado: sessões sem atividade planejada correspondente. Não são erro; aparecem no dia em que aconteceram.</li>
          <li>A comparação usa a semana anterior completa, com as mesmas regras.</li>
        </ul>
      </details>
    </Card>
  );
}

function Stat({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

export function WeeklyGoalsCard({ views, isFuture }: { views: WeeklyGoalView[]; isFuture: boolean }) {
  return (
    <Card className="p-4" data-testid="plan-goals">
      <h2 className="mb-2 flex items-center gap-2 font-display font-semibold">
        <Target className="h-5 w-5 text-primary" /> Metas semanais
      </h2>
      {views.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma meta de frequência semanal.{' '}
          <Link to="/metas" className="font-medium text-primary underline-offset-4 hover:underline">
            Criar em Metas
          </Link>
        </p>
      ) : (
        <ul className="space-y-3">
          {views.map((v) => {
            const count = v.week?.count ?? 0;
            const frac = Math.min(1, count / v.goal.targetValue);
            const state = v.goal.status !== 'active' ? GOAL_STATUS_LABEL[v.goal.status] : v.week?.met ? 'Cumprida nesta semana' : isFuture ? 'Semana futura' : v.week ? 'Em andamento' : 'Fora da vigência da meta';
            return (
              <li key={v.goal.id} data-testid="plan-goal" className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="min-w-0 break-words font-medium">{v.goal.title}</span>
                  <span className="text-xs text-muted-foreground" data-testid="plan-goal-state">
                    {v.week?.met && <Check className="mr-0.5 inline h-3.5 w-3.5 text-primary" aria-hidden />}
                    {state}
                  </span>
                </div>
                <p className="text-sm tabular" data-testid="plan-goal-progress">
                  {count} de {v.goal.targetValue} {v.goal.targetValue === 1 ? 'sessão' : 'sessões'}
                  {v.week?.partial && !v.week.current ? ' (semana parcial)' : ''}
                </p>
                <div
                  role="progressbar"
                  aria-label={`Progresso da meta ${v.goal.title}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(frac * 100)}
                  aria-valuetext={`${count} de ${v.goal.targetValue} sessões`}
                  className="h-2 overflow-hidden rounded-full bg-secondary"
                >
                  <div className="h-full bg-primary motion-safe:transition-[width]" style={{ width: `${frac * 100}%` }} />
                </div>
                {v.history.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5 text-xs" aria-label="Semanas anteriores">
                    {v.history.map((w) => (
                      <li key={w.week} className="rounded-full bg-secondary px-2 py-0.5 tabular">
                        {fmtDateShort(w.week)}: {w.count}
                        {w.met ? ' ✓ cumprida' : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-foreground">Calculado pelo mesmo motor da tela Metas. Descanso planejado não conta contra a meta.</p>
    </Card>
  );
}
