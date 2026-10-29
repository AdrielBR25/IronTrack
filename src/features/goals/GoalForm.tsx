import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { createGoal, GoalConflictError, updateGoal } from '@/db/goals';
import { fmtDateShort, todayISO } from '@/lib/dates';
import { cn, parseNum, uid } from '@/lib/utils';
import type { Routine, WeightUnit, WorkoutSession } from '@/lib/types';
import { useUnits } from '@/hooks/useUnits';
import {
  GOAL_TYPE_LABEL,
  GOAL_TYPES,
  GoalRuleError,
  goalExerciseOptions,
  goalFieldErrors,
  historyReference,
  isExerciseGoal,
  isGoalDate,
  optionsForGoalType,
  type GoalExerciseRef,
  type GoalField,
  type GoalFields,
  type GoalSide,
  type GoalType,
  type TrainingGoal,
} from '@/modules/goals';
import { fmtEvidence, fmtGoalValue, inputUnitLabel, suggestTitle, toDisplayValue, toStoredValue } from './goalFormat';

// Formulário de criação e edição de metas (IronTrack 2.0 F01/P12). Mostra só os campos do tipo escolhido, valida a
// cada alteração (goalFieldErrors, as mesmas regras da gravação) e exibe referências reais do histórico, nunca
// sugestões de valor. Não altera fichas nem treinos.

interface Draft {
  type: GoalType;
  optionValue: string;
  target: string;
  windowDays: string;
  minLoad: string;
  side: '' | GoalSide;
  title: string;
  titleEdited: boolean;
  startDate: string;
  targetDate: string;
}

const emptyDraft = (today: string): Draft => ({ type: 'weekly_frequency', optionValue: '', target: '', windowDays: '30', minLoad: '', side: '', title: '', titleEdited: false, startDate: today, targetDate: '' });

function draftFromGoal(g: TrainingGoal, weightUnit: WeightUnit): Draft {
  return {
    type: g.type,
    optionValue: '',
    target: String(toDisplayValue(g.type, g.exercise, g.targetValue, weightUnit)).replace('.', ','),
    windowDays: g.params.windowDays ? String(g.params.windowDays) : '30',
    minLoad: g.params.minLoadKg !== undefined ? String(toDisplayValue('max_load', null, g.params.minLoadKg, weightUnit)).replace('.', ',') : '',
    side: g.params.side ?? '',
    title: g.title,
    titleEdited: true,
    startDate: g.startDate,
    targetDate: g.targetDate ?? '',
  };
}

const FIELD_ORDER: GoalField[] = ['type', 'exercise', 'targetValue', 'windowDays', 'minLoadKg', 'side', 'title', 'startDate', 'targetDate', 'params'];

export function GoalForm({
  open,
  onOpenChange,
  editing,
  live,
  routines,
  sessions,
  profileId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Meta em edição (versão lida ao abrir); ausente = criar. */
  editing?: TrainingGoal | null;
  /** Versão atual da meta em edição no banco (observada): detecta alteração ou exclusão em outra aba. */
  live?: TrainingGoal | null;
  routines: Routine[];
  sessions: WorkoutSession[];
  profileId?: string;
}) {
  const { unit: weightUnit } = useUnits();
  const today = todayISO();
  const [draft, setDraft] = useState<Draft>(() => (editing ? draftFromGoal(editing, weightUnit) : emptyDraft(today)));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [base, setBase] = useState<TrainingGoal | null>(editing ?? null);
  // Um único ID por abertura do formulário: tocar duas vezes em "Criar" não cria duas metas.
  const newId = useRef(uid());

  useEffect(() => {
    if (!open) return;
    newId.current = uid();
    setDraft(editing ? draftFromGoal(editing, weightUnit) : emptyDraft(todayISO()));
    setBase(editing ?? null);
    setTouched(new Set());
    setSubmitted(false);
    setServerError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const allOptions = useMemo(() => goalExerciseOptions(routines), [routines]);
  const options = useMemo(() => optionsForGoalType(allOptions, draft.type), [allOptions, draft.type]);
  const exerciseGoal = isExerciseGoal(draft.type);
  const exercise: GoalExerciseRef | null = base ? base.exercise : exerciseGoal ? (options.find((o) => o.value === draft.optionValue)?.ref ?? null) : null;

  const fields: GoalFields = useMemo(() => {
    const stored = toStoredValue(draft.type, exercise, parseNum(draft.target), weightUnit);
    const minLoadKg = draft.type === 'reps' && draft.minLoad.trim() ? toStoredValue('max_load', null, parseNum(draft.minLoad), weightUnit) : undefined;
    const windowDays = draft.type === 'session_count' ? parseNum(draft.windowDays) : null;
    const side = draft.side && exercise?.laterality === 'unilateral' && ['reps', 'max_load', 'e1rm'].includes(draft.type) ? draft.side : undefined;
    const params = {
      ...(draft.type === 'session_count' ? { windowDays: windowDays ?? Number.NaN } : {}),
      ...(minLoadKg !== undefined ? { minLoadKg: minLoadKg ?? Number.NaN } : {}),
      ...(side ? { side } : {}),
    };
    const title = draft.titleEdited ? draft.title : suggestTitle(draft.type, exercise, stored, windowDays, weightUnit);
    return {
      type: draft.type,
      title,
      exercise,
      targetValue: stored ?? Number.NaN,
      params,
      startDate: draft.startDate,
      targetDate: draft.type === 'session_count' ? null : draft.targetDate || null,
    };
  }, [draft, exercise, weightUnit]);

  const errors = goalFieldErrors(fields);
  const valid = Object.keys(errors).length === 0;
  const show = (f: GoalField) => (submitted || touched.has(f) ? errors[f] : undefined);
  const touch = (f: GoalField) => setTouched((t) => (t.has(f) ? t : new Set(t).add(f)));
  const set = (patch: Partial<Draft>, f?: GoalField) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (f) touch(f);
    setServerError(null);
  };

  const reference = useMemo(
    () => historyReference({ type: fields.type, exercise: fields.exercise, params: fields.params, profileId }, sessions, today),
    [fields.type, fields.exercise, fields.params, profileId, sessions, today],
  );

  const changedElsewhere = !!base && !!live && live.revision !== base.revision;
  const deletedElsewhere = !!base && open && live === null;

  async function submit() {
    setSubmitted(true);
    if (!valid || saving || deletedElsewhere) return;
    setSaving(true);
    try {
      if (base) {
        await updateGoal(base.id, base.revision, { title: fields.title, targetValue: fields.targetValue, params: fields.params, startDate: fields.startDate, targetDate: fields.targetDate });
        toast.success('Meta atualizada');
      } else {
        await createGoal(newId.current, fields);
        toast.success('Meta criada');
      }
      onOpenChange(false);
    } catch (e) {
      if (e instanceof GoalConflictError) setServerError(e.message);
      else if (e instanceof GoalRuleError) setServerError([e.message, ...e.details].join(' '));
      else setServerError('Não foi possível gravar a meta. Nada foi alterado; tente de novo.');
    } finally {
      setSaving(false);
    }
  }

  const unitLabel = inputUnitLabel(draft.type, exercise, weightUnit);
  const unilateral = exercise?.laterality === 'unilateral' && ['reps', 'max_load', 'e1rm'].includes(draft.type);
  const firstError = FIELD_ORDER.find((f) => show(f));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="goal-form">
        <DialogHeader>
          <DialogTitle>{base ? 'Editar meta' : 'Nova meta'}</DialogTitle>
          <DialogDescription>O progresso é calculado com os treinos concluídos neste aparelho. Fichas e treinos não são alterados.</DialogDescription>
        </DialogHeader>

        {changedElsewhere && (
          <div role="alert" className="flex gap-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="goal-changed-elsewhere">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <div className="min-w-0 space-y-2">
              <p>Esta meta foi alterada em outra aba. Salvar agora não sobrescreve a outra alteração: carregue a versão atual e revise.</p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setBase(live!);
                  setDraft(draftFromGoal(live!, weightUnit));
                  setServerError(null);
                }}
              >
                Carregar versão atual
              </Button>
            </div>
          </div>
        )}
        {deletedElsewhere && (
          <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="goal-deleted-elsewhere">
            Esta meta foi excluída em outra aba. Nada será gravado.
          </p>
        )}

        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="goal-type">Tipo</Label>
            <NativeSelect
              id="goal-type"
              data-testid="goal-type"
              value={draft.type}
              disabled={!!base}
              onChange={(e) => set({ type: e.target.value as GoalType, optionValue: '', side: '' }, 'type')}
            >
              {GOAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {GOAL_TYPE_LABEL[t]}
                </option>
              ))}
            </NativeSelect>
            {base && <p className="text-xs text-muted-foreground">Tipo e exercício não mudam na edição: para medir outra coisa, crie uma meta nova.</p>}
          </div>

          {exerciseGoal && (
            <div className="space-y-1.5">
              <Label htmlFor="goal-exercise">Exercício</Label>
              {base ? (
                <p className="rounded-xl border px-3 py-2.5 text-sm" data-testid="goal-exercise-fixed">
                  {base.exercise?.name}
                </p>
              ) : options.length === 0 ? (
                <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground" data-testid="goal-no-exercise">
                  Nenhum exercício das suas fichas registra esse tipo de medida. Crie ou classifique um exercício em Treinos (por exemplo, “por tempo” para duração ou “cardio” para distância).
                </p>
              ) : (
                <NativeSelect
                  id="goal-exercise"
                  data-testid="goal-exercise"
                  value={draft.optionValue}
                  aria-invalid={!!show('exercise')}
                  aria-describedby={show('exercise') ? 'goal-exercise-error' : undefined}
                  onChange={(e) => set({ optionValue: e.target.value, side: '' }, 'exercise')}
                  onBlur={() => touch('exercise')}
                >
                  <option value="">Escolha…</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.ref.name} · {o.routineName} ({o.workoutLabels.length > 1 ? 'treinos' : 'treino'} {o.workoutLabels.join(', ')})
                    </option>
                  ))}
                </NativeSelect>
              )}
              <FieldError id="goal-exercise-error" text={show('exercise')} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="goal-target">Objetivo</Label>
            <div className="flex items-center gap-2">
              <Input
                id="goal-target"
                data-testid="goal-target"
                inputMode="decimal"
                enterKeyHint="done"
                autoComplete="off"
                className="min-w-0 flex-1"
                value={draft.target}
                aria-invalid={!!show('targetValue')}
                aria-describedby={show('targetValue') ? 'goal-target-error' : 'goal-target-unit'}
                onChange={(e) => set({ target: e.target.value }, 'targetValue')}
              />
              <span id="goal-target-unit" className="shrink-0 text-sm text-muted-foreground" data-testid="goal-target-unit">
                {unitLabel}
              </span>
            </div>
            <FieldError id="goal-target-error" text={show('targetValue')} />
          </div>

          {draft.type === 'session_count' && (
            <div className="space-y-1.5">
              <Label htmlFor="goal-window">Em quantos dias</Label>
              <div className="flex items-center gap-2">
                <Input id="goal-window" data-testid="goal-window" inputMode="numeric" className="min-w-0 flex-1" value={draft.windowDays} aria-invalid={!!show('windowDays')} onChange={(e) => set({ windowDays: e.target.value }, 'windowDays')} />
                <span className="shrink-0 text-sm text-muted-foreground">dias a partir do início</span>
              </div>
              <FieldError text={show('windowDays')} />
            </div>
          )}

          {draft.type === 'reps' && exercise && exercise.loadMode !== 'corporal' && exercise.loadMode !== 'assistida' && (
            <div className="space-y-1.5">
              <Label htmlFor="goal-minload">Carga mínima da série (opcional)</Label>
              <div className="flex items-center gap-2">
                <Input id="goal-minload" data-testid="goal-minload" inputMode="decimal" className="min-w-0 flex-1" value={draft.minLoad} aria-invalid={!!show('minLoadKg')} onChange={(e) => set({ minLoad: e.target.value }, 'minLoadKg')} />
                <span className="shrink-0 text-sm text-muted-foreground">{weightUnit}</span>
              </div>
              <p className="text-xs text-muted-foreground">Em branco: conta a melhor série sem assistência, com qualquer carga.</p>
              <FieldError text={show('minLoadKg')} />
            </div>
          )}

          {unilateral && (
            <div className="space-y-1.5">
              <Label htmlFor="goal-side">Lado</Label>
              <NativeSelect id="goal-side" data-testid="goal-side" value={draft.side} onChange={(e) => set({ side: e.target.value as Draft['side'] }, 'side')}>
                <option value="">Qualquer lado (vale o melhor registrado)</option>
                <option value="direito">Só o lado direito</option>
                <option value="esquerdo">Só o lado esquerdo</option>
              </NativeSelect>
              <FieldError text={show('side')} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="goal-title">Título</Label>
            <Input
              id="goal-title"
              data-testid="goal-title"
              maxLength={120}
              value={fields.title}
              aria-invalid={!!show('title')}
              onChange={(e) => set({ title: e.target.value, titleEdited: true }, 'title')}
            />
            <FieldError text={show('title')} />
          </div>

          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="goal-start">Início</Label>
              <Input id="goal-start" data-testid="goal-start" type="date" value={draft.startDate} aria-invalid={!!show('startDate')} onChange={(e) => set({ startDate: e.target.value }, 'startDate')} />
              <FieldError text={show('startDate')} />
            </div>
            {draft.type !== 'session_count' && (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="goal-deadline">Prazo (opcional)</Label>
                <Input id="goal-deadline" data-testid="goal-deadline" type="date" value={draft.targetDate} min={draft.startDate} aria-invalid={!!show('targetDate')} onChange={(e) => set({ targetDate: e.target.value }, 'targetDate')} />
                <FieldError text={show('targetDate')} />
              </div>
            )}
          </div>

          <HistoryNote fields={fields} reference={reference} weightUnit={weightUnit} />

          {serverError && (
            <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="goal-save-error">
              {serverError}
            </p>
          )}
          {submitted && firstError && !valid && (
            <p className="text-sm text-destructive" role="status">
              Revise os campos destacados.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" data-testid="goal-save" disabled={saving || deletedElsewhere || (submitted && !valid)}>
              {base ? 'Salvar' : 'Criar meta'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ text, id }: { text?: string; id?: string }) {
  if (!text) return null;
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {text}
    </p>
  );
}

function HistoryNote({ fields, reference, weightUnit }: { fields: GoalFields; reference: ReturnType<typeof historyReference>; weightUnit: WeightUnit }) {
  let text: string | null = null;
  if (fields.type === 'weekly_frequency' && reference.recentWeeks.length) {
    text = `Sessões nas últimas 4 semanas: ${reference.recentWeeks.map((w) => w.count).join(', ')}.`;
  } else if (fields.type === 'session_count' && reference.recentWindow) {
    text = `Nos últimos ${reference.recentWindow.days} dias: ${reference.recentWindow.count} ${reference.recentWindow.count === 1 ? 'sessão concluída' : 'sessões concluídas'}.`;
  } else if (fields.exercise) {
    text = reference.best
      ? `Seu melhor registro: ${fmtEvidence(fields, reference.best, weightUnit)}. A meta só é marcada como atingida com um registro a partir do início.`
      : 'Ainda não há registros deste exercício para esta medida. A meta pode ser criada; o progresso aparece depois do primeiro treino.';
  }
  if (!text) return null;
  const reached = !!reference.best && Number.isFinite(fields.targetValue) && reference.best.value >= fields.targetValue && isGoalDate(fields.startDate);
  return (
    <div className={cn('flex gap-2 rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground')} data-testid="goal-history-note">
      <History className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0">
        {text}
        {reached && fields.exercise && ` Esse valor (${fmtGoalValue(fields, fields.targetValue, weightUnit)}) já foi registrado antes; a meta conta só registros a partir de ${fmtDateShort(fields.startDate)}.`}
      </p>
    </div>
  );
}
