import { ArrowLeftRight, Check, ChevronDown, ChevronUp, Info, SkipForward } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DistanceUnit, SessionExercise, SessionSet, SetSide, SetType, Settings } from '@/lib/types';
import { NumberStepper } from './NumberStepper';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUnits } from '@/hooks/useUnits';
import { useNow } from '@/hooks/data';
import {
  DISTANCE_UNITS,
  EQUIPMENT_HINT,
  SET_SIDES,
  SIDE_LABEL,
  exerciseMeasures,
  fmtDurationSec,
  fmtRepRange,
  fmtStopwatch,
  fromMetersTo,
  isRecordableMeasure,
  isValidDistanceM,
  measuredSeconds,
  oppositeSide,
  paceSecPerUnit,
  setCompletionErrors,
  setTimerElapsedMs,
  timerBelongsTo,
  toMetersFrom,
  type SetTimerTarget,
} from '@/modules/training';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { distanceUnitOf, fmtDistance } from './modelFormat';
import { SetTimerPanel } from './SetTimerPanel';
import { setTimerStore, useSetTimer } from './setTimerStore';

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
  // Unidade de digitação da distância só nesta tela (P11); o valor gravado continua em metros.
  const [inputUnit, setInputUnit] = useState<DistanceUnit>(dUnit);
  // Atalho de alternância (P11): só em série pendente; nunca muda séries concluídas nem duplica séries.
  const lastSided = [...ex.sets].reverse().find((s) => s.id !== set.id && s.status === 'done' && (s.side === 'direito' || s.side === 'esquerdo'));
  const toggleTo = set.status === 'pending' ? (oppositeSide(set.side) ?? (set.side == null ? oppositeSide(lastSided?.side) : null)) : null;
  const pace = cardio ? paceSecPerUnit(set.durationSec, set.distance, dUnit) : null;
  return (
    <div className="flex flex-col gap-3">
      {ms.side && (
        <div className="flex items-center gap-2">
          <Segmented<SetSide | ''>
            className="flex-1"
            aria-label="Lado da série"
            value={set.side ?? ''}
            // Tocar no lado já escolhido volta para "não informado".
            onChange={(v) => onPatch({ side: v === set.side ? null : v || null })}
            options={SET_SIDES.map((v) => ({ value: v, label: SIDE_LABEL[v] }))}
          />
          {!compact && toggleTo && (
            <button
              type="button"
              onClick={() => onPatch({ side: toggleTo })}
              className="flex h-10 shrink-0 items-center gap-1 rounded-xl bg-secondary px-2.5 text-xs font-semibold"
              aria-label={`Trocar para o lado ${SIDE_LABEL[toggleTo].toLowerCase()}`}
              data-testid="toggle-side"
            >
              <ArrowLeftRight className="h-4 w-4" /> {toggleTo === 'direito' ? 'D' : 'E'}
            </button>
          )}
        </div>
      )}
      <div className={cn('grid gap-2', compact ? 'grid-cols-1' : 'grid-cols-1 min-[440px]:grid-cols-2 min-[440px]:gap-3')}>
        {ms.weight !== 'none' && (
          <NumberStepper
            label={ms.weight === 'adicional' ? `Carga adicional (+${unit})` : `Peso (${unit})`}
            suffix={ms.weight === 'adicional' ? 'colete, cinto ou anilha' : ms.weight === 'externa' && settings.showEquipmentHint ? EQUIPMENT_HINT[ex.equipment] : undefined}
            value={show(set.weight)}
            onChange={(v) => onPatch({ weight: parse(v) })}
            step={settings.weightStep}
            max={unit === 'kg' ? 1000 : 2200}
            testId="input-weight"
          />
        )}
        {ms.assistance && (
          <NumberStepper
            label={`Assistência (−${unit})`}
            suffix="elástico ou contrapeso: reduz o esforço"
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
              suffix={set.durationSec ? fmtDurationSec(set.durationSec) : undefined}
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
            key={inputUnit}
            label={`Distância (${inputUnit})`}
            value={set.distance != null ? Math.round(fromMetersTo(set.distance, inputUnit) * 100) / 100 : null}
            onChange={(v) => onPatch({ distance: v === null ? null : toMetersFrom(v, inputUnit) })}
            step={DISTANCE_STEP[inputUnit]}
            decimals={inputUnit === 'm' ? 0 : 2}
            max={inputUnit === 'm' ? 1_000_000 : inputUnit === 'km' ? 1000 : 621}
            testId="input-distance"
          />
        )}
      </div>
      {cardio && (
        <div className="flex flex-col gap-2 text-xs" data-testid="cardio-quick">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<DistanceUnit>
              size="sm"
              className="w-36"
              aria-label="Unidade da distância"
              value={inputUnit}
              onChange={setInputUnit}
              options={DISTANCE_UNITS.map((u) => ({ value: u, label: u }))}
            />
            {set.plannedDurationSec != null && set.durationSec !== set.plannedDurationSec && (
              <button type="button" className="h-8 rounded-lg bg-secondary px-2 font-semibold" onClick={() => onPatch({ durationSec: set.plannedDurationSec })} data-testid="use-target-duration">
                Meta {fmtDurationSec(set.plannedDurationSec)}
              </button>
            )}
            {set.plannedDistance != null && set.distance !== set.plannedDistance && (
              <button type="button" className="h-8 rounded-lg bg-secondary px-2 font-semibold" onClick={() => onPatch({ distance: set.plannedDistance })} data-testid="use-target-distance">
                Meta {fmtDistance(set.plannedDistance, dUnit)}
              </button>
            )}
          </div>
          {isValidDistanceM(set.distance) && (
            <p className="text-muted-foreground tabular" data-testid="distance-equivalents">
              {DISTANCE_UNITS.map((u) => fmtDistance(set.distance!, u)).join(' = ')}
              {pace != null && ` · ritmo ${fmtDurationSec(pace)} /${dUnit}`}
            </p>
          )}
        </div>
      )}
      {ex.loadMode === 'corporal' && !ms.distance && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5" /> Só peso corporal: sem carga registrada.
        </p>
      )}
      {ms.assistance && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5" /> Assistência é ajuda, não carga: quanto maior, menor a exigência.
        </p>
      )}
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
  sessionId,
  onGoToTimer,
  describeTimer,
}: {
  ex: SessionExercise;
  set: SessionSet;
  settings: Settings;
  lastText?: string;
  onPatch: (p: Partial<SessionSet>) => void;
  /** Conclui a série; `patch` (ex.: duração medida) é aplicado na mesma gravação. */
  onComplete: (patch?: Partial<SessionSet>) => void;
  onSkip: () => void;
  highlight?: boolean;
  /** Treino em andamento: habilita o cronômetro de execução (P11) em exercícios por tempo e cardio. */
  sessionId?: string;
  onGoToTimer?: (t: SetTimerTarget) => void;
  describeTimer?: (t: SetTimerTarget) => string;
}) {
  const { fmtW } = useUnits();
  const ms = exerciseMeasures(ex);
  const target: SetTimerTarget | null = sessionId && ms.duration ? { sessionId, exerciseId: ex.id, setId: set.id } : null;
  const { state: timer } = useSetTimer();
  const mine = target && timerBelongsTo(timer, target) ? timer : null;
  const timerActive = mine?.status === 'running' || mine?.status === 'paused';
  const [finishTimer, setFinishTimer] = useState(false);
  const now = useNow(1000, mine?.status === 'running');
  // No treino em andamento o botão de concluir só fica ativo 300 ms depois de a série aparecer: o segundo toque de
  // um toque duplo não conclui a série seguinte por engano.
  const [armed, setArmed] = useState(!sessionId);
  useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), 300);
    return () => clearTimeout(t);
  }, [armed]);
  const modelPlan = [
    set.plannedDurationSec ? fmtDurationSec(set.plannedDurationSec) : null,
    set.plannedDistance ? fmtDistance(set.plannedDistance, distanceUnitOf(ex)) : null,
  ].filter(Boolean);
  const planned = !ms.reps
    ? modelPlan.join(' · ') || null
    : set.plannedWeight != null || set.plannedReps
      ? `${set.plannedWeight != null ? fmtW(set.plannedWeight) : ms.weight === 'none' ? '' : '—'}${set.plannedWeight != null || ms.weight !== 'none' ? ' × ' : ''}${set.plannedReps ?? fmtRepRange(ex.repMin, ex.repMax)}`
      : null;
  // Com o cronômetro ativo, a série pode ser concluída usando a medida (confirmada no diálogo).
  const liveSec = mine ? measuredSeconds(setTimerElapsedMs(mine, now)) : 0;
  const errors = setCompletionErrors(ex, timerActive && liveSec >= 1 ? { ...set, durationSec: liveSec } : set);
  const canComplete = errors.length === 0;
  const manualValid = setCompletionErrors(ex, set).length === 0;
  const complete = () => {
    if (timerActive && target) setFinishTimer(true);
    else onComplete();
  };
  return (
    <section className={cn('rounded-3xl border bg-card p-3.5 shadow-2xl transition-shadow', highlight && 'border-primary animate-pulse-ring')} data-testid="set-editor">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-display text-base font-bold leading-tight">{ex.name}</p>
          <p className="text-sm font-medium text-primary">{setTitle(ex, set)}</p>
          {ms.side && (
            <p
              className={cn('mt-0.5 inline-block rounded-md px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide', set.side ? 'bg-primary text-primary-foreground' : 'bg-warn/15 text-warn')}
              data-testid="side-badge"
            >
              {set.side ? `Lado: ${SIDE_LABEL[set.side]}` : 'Lado não informado'}
            </p>
          )}
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
      {target && (
        <div className="mb-3">
          <SetTimerPanel target={target} set={set} onPatch={onPatch} onGoTo={onGoToTimer} describe={describeTimer} />
        </div>
      )}
      <SetFields ex={ex} set={set} settings={settings} onPatch={onPatch} />
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="xl" className="px-4" onClick={onSkip} aria-label="Pular série">
          <SkipForward />
        </Button>
        <Button
          size="xl"
          className="flex-1 font-display font-bold"
          onClick={complete}
          disabled={!canComplete || !armed}
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
      <Dialog open={finishTimer} onOpenChange={setFinishTimer}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>O cronômetro ainda está {mine?.status === 'paused' ? 'pausado' : 'contando'}</DialogTitle>
            <DialogDescription>Escolha qual duração gravar nesta série. Cancelar não altera nada.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Button
              size="lg"
              data-testid="finish-with-timer"
              disabled={!mine || !isRecordableMeasure(setTimerElapsedMs(mine, Date.now()))}
              onClick={() => {
                if (!target) return;
                const st = setTimerStore.stop(target);
                setFinishTimer(false);
                if (!st || !isRecordableMeasure(st.accumulatedMs)) return;
                onComplete({ durationSec: measuredSeconds(st.accumulatedMs) });
              }}
            >
              Encerrar e usar {mine ? fmtStopwatch(setTimerElapsedMs(mine, Date.now())) : ''}
            </Button>
            {manualValid && set.durationSec != null && (
              <Button
                size="lg"
                variant="secondary"
                data-testid="finish-with-manual"
                onClick={() => {
                  if (target) setTimerStore.stop(target);
                  setFinishTimer(false);
                  onComplete();
                }}
              >
                Concluir com {fmtDurationSec(set.durationSec)}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setFinishTimer(false)} data-testid="finish-cancel">
              Cancelar
            </Button>
          </div>
          <DialogFooter />
        </DialogContent>
      </Dialog>
    </section>
  );
}
