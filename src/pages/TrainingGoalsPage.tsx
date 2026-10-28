import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Award, CalendarClock, ChevronDown, Plus, Target } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Empty } from '@/components/charts';
import { deleteGoal, GoalConflictError, setGoalStatus } from '@/db/goals';
import { useCompletedSessions, useCurrentProfile, useRoutines, useToday } from '@/hooks/data';
import { useGoals } from '@/hooks/useGoals';
import { useUnits } from '@/hooks/useUnits';
import { fmtDateShort } from '@/lib/dates';
import { GoalCard } from '@/features/goals/GoalCard';
import { GoalForm } from '@/features/goals/GoalForm';
import { fmtGoalValue } from '@/features/goals/goalFormat';
import { GOAL_ACTION_LABEL, GoalRuleError, goalExerciseAvailability, goalsOverview, type GoalAction, type GoalEvaluation, type TrainingGoal } from '@/modules/goals';

// Metas de treinamento (IronTrack 2.0 F01/P12, #/metas). Tudo é calculado no aparelho a partir dos treinos
// concluídos (src/modules/goals); nada é enviado nem passa por IA. Ver docs/METAS_TREINAMENTO.md.

export default function TrainingGoalsPage() {
  const goals = useGoals();
  const sessions = useCompletedSessions();
  const routines = useRoutines();
  const profile = useCurrentProfile();
  const today = useToday();
  const { unit } = useUnits();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TrainingGoal | null>(null);
  const [deleting, setDeleting] = useState<TrainingGoal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const overview = useMemo(() => (goals && sessions ? goalsOverview(goals, sessions, today) : null), [goals, sessions, today]);

  const header = (
    <>
      <Link to="/evolucao" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="goals-back">
        <ArrowLeft className="h-4 w-4" /> Evolução
      </Link>
      <PageHeader
        title="Metas"
        subtitle="Objetivos pessoais acompanhados com os seus registros, no aparelho"
        action={
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            data-testid="new-goal"
          >
            <Plus /> Nova meta
          </Button>
        }
      />
    </>
  );

  async function act(goal: TrainingGoal, action: GoalAction) {
    setBusy(goal.id);
    try {
      await setGoalStatus(goal.id, action);
      toast.success(`${GOAL_ACTION_LABEL[action]}: ${goal.title}`);
    } catch (e) {
      toast.error(e instanceof GoalConflictError || e instanceof GoalRuleError ? e.message : 'Não foi possível alterar a meta. Nada foi gravado.');
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete(goal: TrainingGoal) {
    try {
      const r = await deleteGoal(goal.id, goal.revision);
      toast.success(r === 'deleted' ? 'Meta excluída' : 'A meta já tinha sido excluída em outra aba');
    } catch (e) {
      toast.error(e instanceof GoalConflictError ? 'A meta foi alterada em outra aba e não foi excluída. Confira a versão atual.' : 'Não foi possível excluir a meta.');
    }
  }

  const card = (e: GoalEvaluation) => (
    <GoalCard
      key={e.goal.id}
      evaluation={e}
      availability={e.goal.exercise && routines ? goalExerciseAvailability(e.goal.exercise, routines) : null}
      weightUnit={unit}
      busy={busy === e.goal.id}
      onEdit={() => {
        setEditing(e.goal);
        setFormOpen(true);
      }}
      onAction={(a) => void act(e.goal, a)}
      onDelete={() => setDeleting(e.goal)}
    />
  );

  const live = editing ? (goals ? (goals.find((g) => g.id === editing.id) ?? null) : undefined) : undefined;

  return (
    <div className="space-y-4" data-testid="goals-page">
      {header}
      {!overview ? null : overview.evaluations.length === 0 ? (
        <Empty text="Nenhuma meta ainda. Crie uma meta para acompanhar frequência, sessões, carga, repetições, duração, distância ou 1RM estimado." />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2" data-testid="goals-summary">
            <Summary label="Em andamento" value={overview.inProgress.length} />
            <Summary label="Atingidas" value={overview.counts.achieved} />
            <Summary label="Arquivadas" value={overview.counts.archived} />
          </dl>

          {overview.upcomingDeadlines.length > 0 && (
            <Card className="p-4" data-testid="goals-deadlines">
              <h2 className="mb-2 flex items-center gap-2 font-display font-semibold">
                <CalendarClock className="h-5 w-5 text-primary" /> Próximos prazos
              </h2>
              <ul className="space-y-1 text-sm">
                {overview.upcomingDeadlines.slice(0, 3).map((e) => (
                  <li key={e.goal.id} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate">{e.goal.title}</span>
                    <span className="shrink-0 tabular text-muted-foreground">{fmtDateShort(e.progress.deadline!)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {overview.achievements.length > 0 && (
            <Card className="p-4" data-testid="achievements">
              <h2 className="mb-2 flex items-center gap-2 font-display font-semibold">
                <Award className="h-5 w-5 text-primary" /> Conquistas
              </h2>
              <ul className="space-y-1.5 text-sm">
                {overview.achievements.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-x-2" data-testid="achievement" data-kind={a.kind}>
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{a.title}</span> <span className="text-muted-foreground">· {a.goalTitle}</span>
                    </span>
                    <span className="shrink-0 tabular text-xs text-muted-foreground">{fmtDateShort(a.date)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">Calculadas a partir dos seus registros neste aparelho. Sem pontuação e sem comparação com outras pessoas.</p>
            </Card>
          )}

          <Section title="Em andamento" testId="goals-in-progress" items={overview.inProgress} render={card} empty="Nenhuma meta em andamento." />
          {overview.achieved.length > 0 && <Section title="Atingidas" testId="goals-achieved" items={overview.achieved} render={card} />}
          {overview.archived.length > 0 && (
            <section data-testid="goals-archived">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-xl px-1 py-2 text-left font-display font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                data-testid="toggle-archived"
              >
                Arquivadas ({overview.archived.length})
                <ChevronDown className={`h-5 w-5 transition-transform ${showArchived ? 'rotate-180' : ''}`} />
              </button>
              {showArchived && <div className="mt-2 space-y-3">{overview.archived.map(card)}</div>}
            </section>
          )}
        </>
      )}
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Target className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Metas ficam só neste aparelho (e nos backups). Não são enviadas ao assistente de IA e não alteram fichas nem treinos.
      </p>

      {routines && sessions && (
        <GoalForm open={formOpen} onOpenChange={setFormOpen} editing={editing} live={live} routines={routines} sessions={sessions} profileId={profile?.id} />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Excluir meta?"
        description={
          deleting ? (
            <>
              A meta “{deleting.title}” ({fmtGoalValue(deleting, deleting.targetValue, unit)}) será excluída deste aparelho. Treinos e fichas não mudam. Para só tirar da lista, use “Arquivar”.
            </>
          ) : undefined
        }
        confirmLabel="Excluir"
        destructive
        onConfirm={() => (deleting ? confirmDelete(deleting) : undefined)}
      />
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <Card className="min-w-0 p-3">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-xl font-bold tabular">{value}</dd>
    </Card>
  );
}

function Section({ title, items, render, testId, empty }: { title: string; items: GoalEvaluation[]; render: (e: GoalEvaluation) => React.ReactNode; testId: string; empty?: string }) {
  return (
    <section data-testid={testId} className="space-y-3">
      <h2 className="font-display font-semibold">{title}</h2>
      {items.length ? items.map(render) : empty ? <p className="text-sm text-muted-foreground">{empty}</p> : null}
    </section>
  );
}
