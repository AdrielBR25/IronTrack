import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { createCustomExercise, updateCustomExercise } from '@/db/library';
import type { CustomExercise, LibraryEquipment, LibraryMuscle, LoadMode, TrainingModality } from '@/lib/types';
import { cn, uid } from '@/lib/utils';
import { LATERALITY_LABEL, LOAD_MODES_BY_MODALITY, LOAD_MODE_LABEL, MODALITIES, MODALITY_LABEL } from '@/modules/training';
import { CUSTOM_LIMITS, EQUIPMENT_NAME, LIBRARY_EQUIPMENT, LIBRARY_MUSCLES, MECHANICS_LABEL, MUSCLE_NAME, customFieldErrors, type CustomFields, type Mechanics } from '@/modules/exercises';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const EMPTY: CustomFields = {
  name: '',
  modality: 'resistance',
  primaryMuscle: 'peitoral',
  secondaryMuscles: [],
  equipment: ['halteres'],
  laterality: 'bilateral',
  loadMode: 'externa',
  mechanics: null,
};

/** Ajusta lateralidade e tipo de carga à modalidade escolhida (sem combinações que a validação recusaria). */
function fitModality(f: CustomFields, m: TrainingModality): CustomFields {
  const allowed = LOAD_MODES_BY_MODALITY[m];
  return {
    ...f,
    modality: m,
    laterality: m === 'cardio' ? 'bilateral' : f.laterality,
    loadMode: m === 'cardio' ? null : f.loadMode && allowed.includes(f.loadMode) ? f.loadMode : (allowed[0] ?? null),
  };
}

function Chips<T extends string>({ legend, options, value, onToggle, label, max, disabledValue }: { legend: string; options: readonly T[]; value: T[]; onToggle: (v: T) => void; label: (v: T) => string; max: number; disabledValue?: T }) {
  const full = value.length >= max;
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o);
          const disabled = o === disabledValue || (!on && full);
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onToggle(o)}
              className={cn('min-h-9 rounded-full border px-3 text-sm', on ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground', disabled && 'opacity-40')}
            >
              {on ? '✓ ' : ''}
              {label(o)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Criar, editar ou duplicar um exercício personalizado (P17). Texto simples com limites; nada de HTML. Editar o modelo
 * não muda fichas nem sessões que vieram dele (são cópias) — a tela avisa quando ele já é usado.
 */
export function CustomExerciseDialog({
  open,
  onOpenChange,
  editing,
  initialFields,
  usage,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Exercício em edição (null = novo). */
  editing: CustomExercise | null;
  /** Campos iniciais de um novo (ex.: "Duplicar"). */
  initialFields?: CustomFields | null;
  /** Onde o exercício em edição já é usado. */
  usage?: { templates: number; sessions: number } | null;
  onSaved?: (c: CustomExercise) => void;
}) {
  const [f, setF] = useState<CustomFields>(EMPTY);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [newId, setNewId] = useState(() => `cx_${uid()}`);
  useEffect(() => {
    if (!open) return;
    setErrors([]);
    setNewId(`cx_${uid()}`);
    if (editing) {
      const { name, modality, primaryMuscle, secondaryMuscles, equipment, laterality, loadMode, mechanics, instructions, notes } = editing;
      setF({ name, modality, primaryMuscle, secondaryMuscles: [...secondaryMuscles], equipment: [...equipment], laterality, loadMode, mechanics, instructions, notes });
    } else setF(initialFields ? { ...initialFields } : EMPTY);
  }, [open, editing?.id, editing?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<CustomFields>) => setF((x) => ({ ...x, ...p }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const loadOptions = LOAD_MODES_BY_MODALITY[f.modality];

  const submit = async () => {
    const errs = customFieldErrors({ ...f, name: f.name.trim(), instructions: f.instructions || undefined, notes: f.notes || undefined });
    setErrors(errs);
    if (errs.length) return;
    setBusy(true);
    try {
      const saved = editing ? await updateCustomExercise(editing.id, editing.revision, f) : await createCustomExercise(newId, f);
      toast.success(editing ? 'Exercício atualizado' : 'Exercício criado');
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e) {
      const err = e as Error & { details?: string[] };
      setErrors([err.message, ...(err.details ?? [])]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="custom-exercise-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar meu exercício' : 'Criar exercício'}</DialogTitle>
          <DialogDescription>Fica só neste aparelho, no seu perfil. Fichas e histórico já gravados não mudam quando você edita.</DialogDescription>
        </DialogHeader>
        {editing && usage && (usage.templates > 0 || usage.sessions > 0) && (
          <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" role="note">
            Usado em {usage.templates} ficha(s) e {usage.sessions} treino(s). As alterações valem só para novas adições: as fichas e o histórico guardam a própria cópia.
          </p>
        )}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cx-name">Nome</Label>
            <Input id="cx-name" maxLength={CUSTOM_LIMITS.maxName} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: Remada máquina articulada" />
          </div>
          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cx-modality">Modalidade</Label>
              <NativeSelect id="cx-modality" value={f.modality} onChange={(e) => setF((x) => fitModality(x, e.target.value as TrainingModality))}>
                {MODALITIES.map((m) => (
                  <option key={m} value={m}>
                    {MODALITY_LABEL[m]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cx-primary">Grupo muscular principal</Label>
              <NativeSelect
                id="cx-primary"
                value={f.primaryMuscle}
                onChange={(e) => {
                  const m = e.target.value as LibraryMuscle;
                  set({ primaryMuscle: m, secondaryMuscles: f.secondaryMuscles.filter((x) => x !== m) });
                }}
              >
                {LIBRARY_MUSCLES.map((m) => (
                  <option key={m} value={m}>
                    {MUSCLE_NAME[m]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <Chips
            legend={`Grupos secundários (opcional, até ${CUSTOM_LIMITS.maxSecondary})`}
            options={LIBRARY_MUSCLES}
            value={f.secondaryMuscles}
            onToggle={(m) => set({ secondaryMuscles: toggle(f.secondaryMuscles, m) })}
            label={(m) => MUSCLE_NAME[m]}
            max={CUSTOM_LIMITS.maxSecondary}
            disabledValue={f.primaryMuscle}
          />
          <Chips
            legend="Equipamento (ao menos um; o primeiro marcado é o principal)"
            options={LIBRARY_EQUIPMENT}
            value={f.equipment}
            onToggle={(e) => set({ equipment: toggle(f.equipment, e as LibraryEquipment) })}
            label={(e) => EQUIPMENT_NAME[e]}
            max={CUSTOM_LIMITS.maxEquipment}
          />
          <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
            {f.modality !== 'cardio' && (
              <div className="space-y-1.5">
                <Label>Execução</Label>
                <Segmented
                  value={f.laterality}
                  onChange={(v) => set({ laterality: v })}
                  options={[
                    { value: 'bilateral', label: LATERALITY_LABEL.bilateral },
                    { value: 'unilateral', label: LATERALITY_LABEL.unilateral },
                  ]}
                />
              </div>
            )}
            {loadOptions.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="cx-load">Tipo de carga</Label>
                <NativeSelect id="cx-load" value={f.loadMode ?? ''} onChange={(e) => set({ loadMode: e.target.value as LoadMode })}>
                  {loadOptions.map((l) => (
                    <option key={l} value={l}>
                      {f.modality === 'timed' && l === 'corporal' ? 'Sem carga' : LOAD_MODE_LABEL[l]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {(f.modality === 'resistance' || f.modality === 'bodyweight') && (
              <div className="space-y-1.5">
                <Label htmlFor="cx-mech">Mecânica</Label>
                <NativeSelect id="cx-mech" value={f.mechanics ?? ''} onChange={(e) => set({ mechanics: (e.target.value || null) as Mechanics | null })}>
                  <option value="">Não classificar</option>
                  <option value="compound">{MECHANICS_LABEL.compound}</option>
                  <option value="isolation">{MECHANICS_LABEL.isolation}</option>
                </NativeSelect>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-instructions">Instruções (opcional, uma por linha)</Label>
            <Textarea id="cx-instructions" maxLength={CUSTOM_LIMITS.maxText} value={f.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-notes">Observações (opcional)</Label>
            <Textarea id="cx-notes" maxLength={CUSTOM_LIMITS.maxText} value={f.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
          </div>
          {errors.length > 0 && (
            <ul className="space-y-1 text-sm text-destructive" role="alert">
              {errors.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="submit" size="lg" disabled={busy} data-testid="custom-save">
              {editing ? 'Salvar alterações' : 'Criar exercício'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
