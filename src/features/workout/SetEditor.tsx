import { Check, ChevronDown, ChevronUp, SkipForward } from 'lucide-react';
import { useState } from 'react';
import type { SessionExercise, SessionSet, SetSide, SetType, Settings } from '@/lib/types';
import { NumberStepper } from './NumberStepper';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUnits } from '@/hooks/useUnits';
import { EQUIPMENT_HINT, SET_SIDES, SIDE_LABEL, exerciseMeasures, fmtDurationSec, fmtRepRange, fromMetersTo, setCompletionErrors, toMetersFrom } from '@/modules/training';
import { cn } from '@/lib/utils';
import { distanceUnitOf, fmtDistance } from './modelFormat';

const DISTANCE_STEP = { m: 100, km: 0.5, mi: 0.25 } as const;

export const SET_TYPE_OPTIONS: { value: SetType; label: string }[] = [
  { value: 'warmup', label: 'Aquec.' },
  { value: 'normal', label: 'Normal' },
  { value: 'drop', label: 'Drop-set' },
];

export function setTitle(ex: SessionExercise, set: SessionSet): string {
  const same = ex.sets.filter((s) => s.type === set.type);
  const n = same.findIndex((s) => s.id === set.id) + 1;
  if (set.type === 'warmup') return `Aquecimento ${n}`;
  if (set.type === 'drop') return `Drop-set ${n}`;
  return `Série ${n} de ${Math.max(ex.plannedSets, same.length)}`;
}

/** Campos de uma série (usado no painel inferior e na edição de série concluída). */
export function SetFields({
  ex,
  set,
  settings,
  onPatch,
  compact,
}: {
  ex: SessionExercise;
  set: SessionSet;
  settings: Settings;
  onPatch: (p: Partial<SessionSet>) => void;
  compact?: boolean;
}) {
  const { unit, show, parse } = useUnits();
  const ms = exerciseMeasures(ex);
  const dUnit = distanceUnitOf(ex);
  const cardio = ms.distance;
  const [more, setMore] = useState(Boolean(set.rir != null || set.rpe != null || set.note));
  const effort: 'rir' | 'rpe' = set.rpe != null ? 'rpe' : 'rir';
  const [effortMode, setEffortMode] = useState<'rir' | 'rpe'>(effort);
  return (
    <div className="flex flex-col gap-3">
      {ms.side && (
        <Segmented<SetSide | ''>
          aria-label="Lado da série"
          value={set.side ?? ''}
          // Tocar no lado já escolhido volta para "não informado".
          onChange={(v) => onPatch({ side: v === set.side ? null : v || null })}
          options={SET_SIDES.map((v) => ({ value: v, label: SIDE_LABEL[v] }))}
        />
      )}
      <div className={cn('grid gap-2', compact ? 'grid-cols-1' : 'grid-cols-1 min-[440px]:grid-cols-2 min-[440px]:gap-3')}>
        {ms.weight !== 'none' && (
          <NumberStepper
            label={ms.weight === 'adicional' ? `Carga adicional (${unit})` : `Peso (${unit})`}
            suffix={ms.weight === 'externa' && settings.showEquipmentHint ? EQUIPMENT_HINT[ex.equipment] : undefined}
            value={show(set.weight)}
            onChange={(v) => onPatch({ weight: parse(v) })}
            step={settings.weightStep}
            max={unit === 'kg' ? 1000 : 2200}
            testId="input-weight"
          />
        )}
        {ms.assistance && (
          <NumberStepper
            label={`Assistência (${unit})`}
            suffix="quanto a máquina ou o elástico ajudam"
            value={show(set.assistanceKg)}
            onChange={(v) => onPatch({ assistanceKg: parse(v) })}
            step={settings.weightStep}
            max={unit === 'kg' ? 500 : 1100}
            testId="input-assistance"
          />
        )}
        {ms.reps && <NumberStepper label="Repetições" value={set.reps} onChange={(v) => onPatch({ reps: v })} step={settings.repStep} integer max={200} decimals={0} testId="input-reps" />}
        {ms.duration &&
          (cardio ? (
            <NumberStepper
              label="Duração (min)"
              value={set.durationSec != null ? Math.round((set.durationSec / 60) * 10) / 10 : null}
              onChange={(v) => onPatch({ durationSec: v === null ? null : Math.round(v * 60) })}
              step={1}
              decimals={1}
              max={1440}
              testId="input-duration"
            />
          ) : (
            <NumberStepper
              label="Duração (s)"
              suffix={set.durationSec && set.durationSec >= 60 ? fmtDurationSec(set.durationSec) : undefined}
              value={set.durationSec ?? null}
              onChange={(v) => onPatch({ durationSec: v })}
              step={5}
              integer
              decimals={0}
              max={86_400}
              testId="input-duration"
            />
          ))}
        {ms.distance && (
          <NumberStepper
            label={`Distância (${dUnit})`}
            value={set.distance != null ? Math.round(fromMetersTo(set.distance, dUnit) * 100) / 100 : null}
            onChange={(v) => onPatch({ distance: v === null ? null : toMetersFrom(v, dUnit) })}
            step={DISTANCE_STEP[dUnit]}
            decimals={dUnit === 'm' ? 0 : 2}
            max={dUnit === 'm' ? 1_000_000 : dUnit === 'km' ? 1000 : 621}
            testId="input-distance"
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <Segmented size="sm" className="flex-1" aria-label="Tipo de série" value={set.type} onChange={(v) => onPatch({ type: v })} options={SET_TYPE_OPTIONS} />
        <button
          type="button"
          aria-expanded={more}
          aria-label="RIR/RPE e observação (opcional)"
          className={cn('flex h-10 shrink-0 items-center gap-0.5 rounded-xl px-2.5 text-xs font-semibold', more ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground')}
          onClick={() => setMore((m) => !m)}
        >
          RIR {more ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>
      {more && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
          <Segmented
            size="sm"
            className="w-28"
            aria-label="Escala de esforço"
            value={effortMode}
            onChange={(m) => {
              setEffortMode(m);
              onPatch({ rir: null, rpe: null });
            }}
            options={[
              { value: 'rir', label: 'RIR' },
              { value: 'rpe', label: 'RPE' },
            ]}
          />
          <div className="flex gap-1 overflow-x-auto no-scrollbar">
            {(effortMode === 'rir' ? [0, 1, 2, 3, 4] : [6, 7, 8, 9, 10]).map((n) => {
              const active = effortMode === 'rir' ? set.rir === n : set.rpe === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => onPatch(effortMode === 'rir' ? { rir: active ? null : n, rpe: null } : { rpe: active ? null : n, rir: null })}
                  className={cn('h-8 min-w-9 rounded-lg px-2 text-sm font-semibold tabular', active ? 'bg-primary text-primary-foreground' : 'bg-secondary')}
                >
                  {n}
                  {effortMode === 'rir' && n === 4 ? '+' : ''}
                </button>
              );
            })}
          </div>
          <Input className="col-span-2 h-10 text-sm" placeholder="Observação da série" value={set.note ?? ''} onChange={(e) => onPatch({ note: e.target.value })} />
        </div>
      )}
    </div>
  );
}

export function SetEditor({
  ex,
  set,
  settings,
  lastText,
  onPatch,
  onComplete,
  onSkip,
  highlight,
}: {
  ex: SessionExercise;
  set: SessionSet;
  settings: Settings;
  lastText?: string;
  onPatch: (p: Partial<SessionSet>) => void;
  onComplete: () => void;
  onSkip: () => void;
  highlight?: boolean;
}) {
  const { fmtW } = useUnits();
  const ms = exerciseMeasures(ex);
  const modelPlan = [
    set.plannedDurationSec ? fmtDurationSec(set.plannedDurationSec) : null,
    set.plannedDistance ? fmtDistance(set.plannedDistance, distanceUnitOf(ex)) : null,
  ].filter(Boolean);
  const planned = !ms.reps
    ? modelPlan.join(' · ') || null
    : set.plannedWeight != null || set.plannedReps
      ? `${set.plannedWeight != null ? fmtW(set.plannedWeight) : ms.weight === 'none' ? '' : '—'}${set.plannedWeight != null || ms.weight !== 'none' ? ' × ' : ''}${set.plannedReps ?? fmtRepRange(ex.repMin, ex.repMax)}`
      : null;
  const errors = setCompletionErrors(ex, set);
  const canComplete = errors.length === 0;
  return (
    <section className={cn('rounded-3xl border bg-card p-3.5 shadow-2xl transition-shadow', highlight && 'border-primary animate-pulse-ring')} data-testid="set-editor">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-base font-bold leading-tight">{ex.name}</p>
          <p className="text-sm font-medium text-primary">{setTitle(ex, set)}</p>
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          {planned && (
            <p>
              Plano: <span className="font-semibold text-foreground tabular">{planned}</span>
            </p>
          )}
          {lastText && (
            <p>
              Anterior: <span className="tabular">{lastText}</span>
            </p>
          )}
        </div>
      </div>
      <SetFields ex={ex} set={set} settings={settings} onPatch={onPatch} />
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="xl" className="px-4" onClick={onSkip} aria-label="Pular série">
          <SkipForward />
        </Button>
        <Button
          size="xl"
          className="flex-1 font-display font-bold"
          onClick={onComplete}
          disabled={!canComplete}
          aria-describedby={canComplete ? undefined : 'set-errors'}
          data-testid="complete-set"
        >
          <Check className="!size-6" /> CONCLUIR SÉRIE
        </Button>
      </div>
      {!canComplete && (
        <p id="set-errors" role="status" className="mt-2 text-center text-xs text-warn" data-testid="set-errors">
          {errors.join(' ')}
        </p>
      )}
    </section>
  );
}
