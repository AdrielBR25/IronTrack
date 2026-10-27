import { ArrowDown, ArrowUp, Check, ChevronDown, MoreVertical, Plus, Repeat, SkipForward, TrendingDown, TrendingUp, Minus as MinusIcon, Info } from 'lucide-react';
import { useState } from 'react';
import type { SessionExercise, SessionSet, Settings } from '@/lib/types';
import type { ExerciseHistoryEntry } from '@/lib/session';
import { suggestProgression } from '@/lib/progression';
import { fmtRepRange } from '@/lib/routineSchema';
import { cn, fmtClock } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUnits } from '@/hooks/useUnits';
import { fmtDateShort } from '@/lib/dates';
import { EQUIPMENT_LABEL } from '@/lib/units';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function summarizeSets(sets: SessionSet[], fmtW: (n: number | null | undefined, u?: boolean) => string): string {
  return sets
    .filter((s) => s.type !== 'warmup' && s.status === 'done')
    .map((s) => `${fmtW(s.weight, false)}×${s.reps ?? 0}`)
    .join(' · ');
}

function SetRow({
  ex,
  set,
  index,
  current,
  onSelect,
}: {
  ex: SessionExercise;
  set: SessionSet;
  index: number;
  current: boolean;
  onSelect: () => void;
}) {
  const { fmtW } = useUnits();
  const done = set.status === 'done';
  const skipped = set.status === 'skipped';
  const wDelta = done && set.plannedWeight != null && set.weight != null ? set.weight - set.plannedWeight : null;
  const repsState = done && set.type === 'normal' && set.reps != null ? (set.reps > ex.repMax ? 'above' : set.reps < ex.repMin ? 'below' : 'in') : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`set-row-${set.status}`}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
        current ? 'bg-primary/10 ring-2 ring-primary' : done ? 'bg-secondary/60' : 'hover:bg-secondary/50',
        skipped && 'opacity-50',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
          done ? 'bg-primary text-primary-foreground' : set.type === 'warmup' ? 'bg-warn/15 text-warn' : 'bg-secondary text-muted-foreground',
        )}
      >
        {done ? <Check className="h-4 w-4" /> : skipped ? <SkipForward className="h-3.5 w-3.5" /> : set.type === 'warmup' ? 'A' : set.type === 'drop' ? 'D' : index}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-display text-base font-semibold tabular">
          {set.weight != null ? fmtW(set.weight) : '— kg'} × {set.reps ?? '—'}
          {set.rir != null && <span className="ml-1.5 text-xs font-normal text-muted-foreground">RIR {set.rir}</span>}
          {set.rpe != null && <span className="ml-1.5 text-xs font-normal text-muted-foreground">RPE {set.rpe}</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {set.type === 'warmup' ? 'Aquecimento' : set.type === 'drop' ? 'Drop-set' : skipped ? 'Pulada' : done ? 'Concluída' : current ? 'Série atual' : 'Pendente'}
          {set.note ? ` · ${set.note}` : ''}
        </span>
      </span>
      {wDelta !== null && wDelta !== 0 && (
        <Badge variant={wDelta > 0 ? 'default' : 'warn'} className="tabular">
          {wDelta > 0 ? <TrendingUp /> : <TrendingDown />}
          {wDelta > 0 ? '+' : ''}
          {fmtW(wDelta)}
        </Badge>
      )}
      {repsState === 'above' && <ArrowUp className="h-4 w-4 text-primary" aria-label="acima da faixa" />}
      {repsState === 'below' && <ArrowDown className="h-4 w-4 text-warn" aria-label="abaixo da faixa" />}
    </button>
  );
}

export function ExerciseCard({
  ex,
  index,
  settings,
  history,
  expanded,
  currentSetId,
  onToggle,
  onSelectSet,
  onAddSet,
  onApplyWeight,
  onSubstitute,
  onSkipExercise,
}: {
  ex: SessionExercise;
  index: number;
  settings: Settings;
  history: ExerciseHistoryEntry[];
  expanded: boolean;
  currentSetId: string | null;
  onToggle: () => void;
  onSelectSet: (set: SessionSet) => void;
  onAddSet: (type: 'normal' | 'drop') => void;
  onApplyWeight: (kg: number) => void;
  onSubstitute: () => void;
  onSkipExercise: () => void;
}) {
  const { fmtW } = useUnits();
  const [menu, setMenu] = useState(false);
  const done = ex.sets.filter((s) => s.status === 'done' && s.type !== 'warmup').length;
  const working = ex.sets.filter((s) => s.type !== 'warmup' && s.status !== 'skipped').length;
  const finished = ex.sets.every((s) => s.status !== 'pending');
  const isCurrent = ex.sets.some((s) => s.id === currentSetId);
  const sugg = suggestProgression(
    { repMin: ex.repMin, repMax: ex.repMax, plannedSets: ex.plannedSets, equipment: ex.equipment },
    history[0]?.sets ?? null,
    settings.progression,
    history[1]?.sets ?? null,
  );
  const pendingNormal = ex.sets.filter((s) => s.status === 'pending' && s.type === 'normal');
  const alreadyApplied = sugg.suggestedWeight != null && pendingNormal.length > 0 && pendingNormal.every((s) => s.weight === sugg.suggestedWeight);
  let n = 0;

  return (
    <article
      id={`ex-${ex.id}`}
      className={cn('scroll-mt-28 rounded-3xl border bg-card transition-colors', isCurrent && 'border-primary/50', finished && !isCurrent && 'opacity-80')}
      data-testid="exercise-card"
    >
      <div className="flex items-start gap-3 p-4">
        <button type="button" onClick={onToggle} className="flex flex-1 items-start gap-3 text-left min-w-0" aria-expanded={expanded}>
          <span
            className={cn(
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-display text-sm font-bold',
              finished ? 'bg-primary text-primary-foreground' : isCurrent ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
            )}
          >
            {finished ? <Check className="h-4 w-4" /> : index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-base font-bold uppercase leading-tight tracking-tight">{ex.name}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Badge variant="secondary">{ex.muscleGroup}</Badge>
              <span className="tabular font-semibold text-foreground">
                {ex.plannedSets} × {fmtRepRange(ex.repMin, ex.repMax)}
              </span>
              <span className="tabular">descanso {fmtClock(ex.restSec)}</span>
              <span>{EQUIPMENT_LABEL[ex.equipment]}</span>
            </span>
            {ex.substitutedFrom && <span className="mt-1 block text-xs text-warn">Substituiu: {ex.substitutedFrom}</span>}
          </span>
          <span className="flex flex-col items-end gap-1">
            <span className="text-xs font-semibold tabular text-muted-foreground">
              {done}/{working}
            </span>
            <ChevronDown className={cn('h-5 w-5 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
          </span>
        </button>
        <Button size="icon-sm" variant="ghost" aria-label={`Opções de ${ex.name}`} onClick={() => setMenu(true)}>
          <MoreVertical />
        </Button>
      </div>

      {expanded && (
        <div className="space-y-3 px-4 pb-4">
          {ex.notes && (
            <p className="flex gap-2 rounded-xl bg-secondary/50 p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              {ex.notes}
            </p>
          )}

          {history.length > 0 && (
            <div className="rounded-xl border border-dashed p-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Histórico recente</p>
              <ul className="space-y-0.5 text-sm">
                {history.slice(0, 3).map((h) => (
                  <li key={h.sessionId} className="flex gap-2 tabular">
                    <span className="w-14 shrink-0 text-muted-foreground">{fmtDateShort(h.date)}</span>
                    <span className="truncate">{summarizeSets(h.sets, fmtW) || '—'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sugg.kind !== 'none' && (
            <div
              className={cn(
                'flex items-start gap-3 rounded-xl p-3 text-sm',
                sugg.kind === 'increase' ? 'bg-primary/10' : sugg.kind === 'decrease' ? 'bg-warn/10' : 'bg-secondary/50',
              )}
              data-testid="progression-suggestion"
            >
              {sugg.kind === 'increase' ? (
                <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : sugg.kind === 'decrease' ? (
                <TrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              ) : (
                <MinusIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <p className="flex-1">{sugg.reason}</p>
              {(sugg.kind === 'increase' || sugg.kind === 'decrease') && sugg.suggestedWeight != null && pendingNormal.length > 0 && (
                <Button size="sm" variant={alreadyApplied ? 'secondary' : 'default'} disabled={alreadyApplied} onClick={() => onApplyWeight(sugg.suggestedWeight!)}>
                  {alreadyApplied ? 'Aplicado' : `Usar ${fmtW(sugg.suggestedWeight)}`}
                </Button>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            {ex.sets.map((s) => {
              if (s.type === 'normal') n++;
              return <SetRow key={s.id} ex={ex} set={s} index={n} current={s.id === currentSetId} onSelect={() => onSelectSet(s)} />;
            })}
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={() => onAddSet('normal')}>
              <Plus /> Série extra
            </Button>
            <Button variant="outline" size="sm" className="flex-1" onClick={() => onAddSet('drop')}>
              <Plus /> Drop-set
            </Button>
          </div>
        </div>
      )}

      <Dialog open={menu} onOpenChange={setMenu}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ex.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="justify-start"
              onClick={() => {
                setMenu(false);
                onSubstitute();
              }}
            >
              <Repeat /> Substituir exercício
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="justify-start"
              onClick={() => {
                setMenu(false);
                onAddSet('normal');
              }}
            >
              <Plus /> Adicionar série extra
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="justify-start"
              disabled={finished}
              onClick={() => {
                setMenu(false);
                onSkipExercise();
              }}
            >
              <SkipForward /> Pular exercício (séries restantes)
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}
