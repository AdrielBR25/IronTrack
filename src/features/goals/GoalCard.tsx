import { Archive, ArchiveRestore, CalendarClock, CheckCircle2, Clock, Pause, Pencil, Play, Target, Trash2, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fmtDateShort } from '@/lib/dates';
import { cn } from '@/lib/utils';
import type { WeightUnit } from '@/lib/types';
import { GOAL_TYPE_LABEL, type ExerciseAvailability, type GoalAction, type GoalDisplayState, type GoalEvaluation } from '@/modules/goals';
import { DISPLAY_STATE_LABEL, fmtEvidence, fmtGoalNumber, fmtGoalValue } from './goalFormat';

// Cartão de uma meta (IronTrack 2.0 F01/P12). O estado aparece em texto e ícone (nunca só pela cor) e a barra de
// progresso tem valor acessível ("3 de 4 sessões"). Sem mensagens de culpa: prazo vencido só informa que acabou.

const STATE_ICON: Record<GoalDisplayState, LucideIcon> = {
  ativa: Target,
  atingida: CheckCircle2,
  pausada: Pause,
  arquivada: Archive,
  prazo_encerrado: Clock,
  nao_iniciada: CalendarClock,
};

const STATE_VARIANT: Record<GoalDisplayState, 'default' | 'secondary' | 'outline'> = {
  ativa: 'secondary',
  atingida: 'default',
  pausada: 'outline',
  arquivada: 'outline',
  prazo_encerrado: 'outline',
  nao_iniciada: 'outline',
};

const AVAILABILITY_TEXT: Partial<Record<ExerciseAvailability['state'], (a: ExerciseAvailability) => string>> = {
  removido: () => 'O exercício não está mais em nenhuma ficha. A meta foi preservada e continua usando os treinos já registrados.',
  renomeado: (a) => `Na ficha, o exercício agora se chama “${a.currentName}”. A meta continua ligada a ele.`,
  parcial: (a) => `${a.missing === 1 ? 'Uma ocorrência' : `${a.missing} ocorrências`} do exercício saiu das fichas; os treinos já registrados continuam contando.`,
  modalidade_alterada: () => 'A classificação do exercício mudou na ficha. Treinos registrados com outra modalidade não entram nesta meta.',
};

export function GoalCard({
  evaluation,
  availability,
  weightUnit,
  onEdit,
  onAction,
  onDelete,
  busy,
}: {
  evaluation: GoalEvaluation;
  availability: ExerciseAvailability | null;
  weightUnit: WeightUnit;
  onEdit: () => void;
  onAction: (a: GoalAction) => void;
  onDelete: () => void;
  busy?: boolean;
}) {
  const { goal, progress: p } = evaluation;
  const Icon = STATE_ICON[p.displayState];
  const pct = Math.round(p.fraction * 100);
  const weekly = p.weekly;
  const targetText = fmtGoalValue(goal, goal.targetValue, weightUnit);
  const currentText = fmtGoalNumber(goal, p.current, weightUnit);
  const valueText =
    goal.type === 'weekly_frequency'
      ? `${p.current ?? 0} de ${goal.targetValue} sessões nesta semana`
      : goal.type === 'session_count'
        ? `${p.current ?? 0} de ${goal.targetValue} sessões`
        : p.current === null
          ? `sem registros; objetivo ${targetText}`
          : `${fmtGoalValue(goal, p.current, weightUnit)} de ${targetText}`;
  const status = goal.status;
  return (
    <Card className="min-w-0 p-4" data-testid="goal-card" data-goal-id={goal.id} data-state={p.displayState}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words font-semibold leading-snug" data-testid="goal-title-text">
            {goal.title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {GOAL_TYPE_LABEL[goal.type]}
            {goal.exercise && <> · <span className="break-words">{availability?.currentName ?? goal.exercise.name}</span></>}
          </p>
        </div>
        <Badge variant={STATE_VARIANT[p.displayState]} className="shrink-0 gap-1" data-testid="goal-state">
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {DISPLAY_STATE_LABEL[p.displayState]}
        </Badge>
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 truncate tabular" data-testid="goal-current">
            <span className="font-display text-lg font-bold">{currentText}</span>
            {goal.type === 'weekly_frequency' || goal.type === 'session_count' ? <span className="text-muted-foreground"> / {goal.targetValue}</span> : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground" data-testid="goal-target-text">
            Objetivo: {targetText}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={`Progresso de ${goal.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={valueText}
          className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-secondary"
        >
          <div className={cn('h-full rounded-full', p.achieved ? 'bg-primary' : 'bg-primary/70')} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground tabular" data-testid="goal-progress-text">
          {pct}% · {valueText}
        </p>
      </div>

      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {p.achieved && p.evidence && (
          <p className="text-foreground" data-testid="goal-evidence">
            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden />
            Atingida: {fmtEvidence(goal, p.evidence, weightUnit)}
            {p.personalRecord && ' · recorde pessoal'}
            {p.achievedAfterDeadline && ' · depois do prazo'}
          </p>
        )}
        {weekly?.currentWeek?.met && goal.status === 'active' && (
          <p className="text-foreground" data-testid="goal-week-met">
            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden />
            Cumprida nesta semana{weekly.currentWeek.metOn ? ` (em ${fmtDateShort(weekly.currentWeek.metOn)})` : ''}.
          </p>
        )}
        {weekly && weekly.weeksEvaluated > 0 && (
          <p data-testid="goal-weeks-summary">
            Semanas completas cumpridas: {weekly.weeks.filter((w) => w.met && !w.partial && !w.paused && !w.current).length} de {weekly.weeksEvaluated}.
          </p>
        )}
        {weekly && weekly.weeks.length > 1 && (
          <ol className="flex flex-wrap gap-1" aria-label="Semanas anteriores" data-testid="goal-weeks">
            {weekly.weeks
              .filter((w) => !w.current)
              .slice(-6)
              .map((w) => (
                <li key={w.week} className={cn('rounded-md border px-1.5 py-0.5 tabular', w.met && 'border-primary/50 text-foreground')}>
                  {fmtDateShort(w.week)}: {w.count}
                  {w.met ? ' ✓' : ''}
                  {w.paused ? ' (pausa)' : w.partial ? ' (parcial)' : ''}
                </li>
              ))}
          </ol>
        )}
        {!p.hasData && !p.notStarted && goal.period !== 'semanal' && (
          <p data-testid="goal-no-data">
            {goal.period === 'janela' ? 'Nenhuma sessão concluída na janela até agora.' : 'Ainda não há dados suficientes: nenhum registro válido deste exercício desde o início da meta.'}
          </p>
        )}
        {p.baseline && <p data-testid="goal-baseline">Antes do início: melhor {fmtEvidence(goal, p.baseline, weightUnit)}.</p>}
        {p.quality.incompatibleSessions > 0 && (
          <p>
            {p.quality.incompatibleSessions === 1 ? '1 treino' : `${p.quality.incompatibleSessions} treinos`} com o exercício registrado em outra modalidade não {p.quality.incompatibleSessions === 1 ? 'entra' : 'entram'}.
          </p>
        )}
        {p.quality.substitutedSessions > 0 && (
          <p>
            {p.quality.substitutedSessions === 1 ? '1 treino' : `${p.quality.substitutedSessions} treinos`} em que o exercício foi substituído não {p.quality.substitutedSessions === 1 ? 'conta' : 'contam'}.
          </p>
        )}
        {availability && AVAILABILITY_TEXT[availability.state] && <p data-testid="goal-availability">{AVAILABILITY_TEXT[availability.state]!(availability)}</p>}
        <p>
          {p.notStarted ? `Começa em ${fmtDateShort(goal.startDate)}` : `Desde ${fmtDateShort(goal.startDate)}`}
          {p.deadline && (p.window ? ` · janela até ${fmtDateShort(p.deadline)}` : ` · prazo ${fmtDateShort(p.deadline)}`)}
          {p.displayState === 'prazo_encerrado' && ' · o prazo terminou; a meta continua aqui e pode ser editada ou arquivada.'}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`Ações de ${goal.title}`}>
        <Button size="sm" variant="secondary" onClick={onEdit} disabled={busy} data-testid="goal-edit">
          <Pencil /> Editar
        </Button>
        {status === 'active' && (
          <Button size="sm" variant="secondary" onClick={() => onAction('pause')} disabled={busy} data-testid="goal-pause">
            <Pause /> Pausar
          </Button>
        )}
        {status === 'paused' && (
          <Button size="sm" variant="secondary" onClick={() => onAction('resume')} disabled={busy} data-testid="goal-resume">
            <Play /> Retomar
          </Button>
        )}
        {status !== 'archived' ? (
          <Button size="sm" variant="secondary" onClick={() => onAction('archive')} disabled={busy} data-testid="goal-archive">
            <Archive /> Arquivar
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => onAction('unarchive')} disabled={busy} data-testid="goal-unarchive">
            <ArchiveRestore /> Restaurar
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete} disabled={busy} data-testid="goal-delete">
          <Trash2 /> Excluir
        </Button>
      </div>
    </Card>
  );
}
