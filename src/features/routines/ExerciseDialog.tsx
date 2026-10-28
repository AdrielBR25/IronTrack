import { useEffect, useState, type ReactNode } from 'react';
import { saveSettings } from '@/db/db';
import { useSettings } from '@/hooks/data';
import { useUnits } from '@/hooks/useUnits';
import type { DistanceUnit, Equipment, ExerciseCategory, ExerciseLaterality, ExerciseModelFields, ExerciseTemplate, LoadMode, TrainingModality } from '@/lib/types';
import { cn, fmtNum, parseNum, uid } from '@/lib/utils';
import {
  DISTANCE_UNITS,
  DISTANCE_UNIT_LABEL,
  EQUIPMENT_LABEL,
  LATERALITY_LABEL,
  LOAD_MODES_BY_MODALITY,
  LOAD_MODE_LABEL,
  MODALITY_LABEL,
  MODEL_LIMITS,
  exerciseMeasures,
  fmtRepRange,
  fromMetersTo,
  isValidDistanceM,
  isValidDurationSec,
  parseRepRange,
  toMetersFrom,
} from '@/modules/training';
import { Button } from '@/components/ui/button';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Formulário de um exercício da ficha (editor manual desde o P10; extraído do WorkoutEditorPage no P17 para ser
// reutilizado ao adicionar um exercício da biblioteca: mesmos campos, mesma validação e mesmas regras de modalidade).

type Draft = {
  name: string;
  muscleGroup: string;
  category: ExerciseCategory;
  equipment: Equipment;
  sets: string;
  reps: string;
  restSec: string;
  warmupSets: string;
  targetWeight: string;
  notes: string;
  substitutes: string;
  // Modelo v3 (P10). '' = não definido. Campos escondidos pela modalidade continuam no rascunho: trocar a
  // modalidade e voltar não apaga nada do que foi digitado.
  modality: TrainingModality | '';
  laterality: ExerciseLaterality | '';
  loadMode: LoadMode | '';
  secondaryMuscles: string[];
  distanceUnit: DistanceUnit;
  /** Duração planejada: segundos (tempo) ou minutos (cardio), como digitado. */
  targetDuration: string;
  targetDistance: string;
};

const num = (n: number, d: 0 | 1 | 2) => fmtNum(n, d).replace(/\./g, '');

function toDraft(e: ExerciseTemplate | null, groups: string[], restC: number, show: (n: number | null | undefined) => number | null): Draft {
  return {
    name: e?.name ?? '',
    muscleGroup: e?.muscleGroup ?? groups[0] ?? 'Peito',
    category: e?.category ?? 'compound',
    equipment: e?.equipment ?? 'barbell',
    sets: String(e?.sets ?? 3),
    reps: e ? fmtRepRange(e.repMin, e.repMax) : '8–12',
    restSec: String(e?.restSec ?? restC),
    warmupSets: String(e?.warmupSets ?? 0),
    targetWeight: e?.targetWeight != null ? String(show(e.targetWeight)).replace('.', ',') : '',
    notes: e?.notes ?? '',
    substitutes: (e?.substitutes ?? []).join(', '),
    modality: e?.modality ?? '',
    laterality: e?.laterality ?? '',
    loadMode: e?.loadMode ?? '',
    secondaryMuscles: [...(e?.secondaryMuscles ?? [])],
    distanceUnit: e?.distanceUnit ?? 'km',
    targetDuration: e?.targetDurationSec != null ? (e.modality === 'cardio' ? num(e.targetDurationSec / 60, 1) : String(e.targetDurationSec)) : '',
    targetDistance: e?.targetDistance != null ? num(fromMetersTo(e.targetDistance, e.distanceUnit ?? 'km'), 2) : '',
  };
}

/**
 * Metadados a gravar. Campos visíveis vêm do rascunho; campos que a modalidade escolhida esconde ficam como
 * estavam no exercício (nada é apagado por trocar de modalidade), exceto combinações que a nova escolha torna
 * contraditórias (tipo de carga incompatível, cardio unilateral), que são removidas explicitamente.
 */
function modelFromDraft(d: Draft, initial: ExerciseModelFields | null, duration: number | null, distanceM: number | null): ExerciseModelFields {
  const m = d.modality || undefined;
  const ms = exerciseMeasures({ modality: m });
  const out: ExerciseModelFields = {};
  if (m) out.modality = m;
  const lateralityShown = m !== 'cardio';
  const lat = lateralityShown ? d.laterality || undefined : undefined;
  if (lat) out.laterality = lat;
  const loadShown = m === 'bodyweight' || m === 'timed';
  const lm = loadShown ? d.loadMode || undefined : m ? undefined : initial?.loadMode;
  if (lm && (!m || LOAD_MODES_BY_MODALITY[m].includes(lm))) out.loadMode = lm;
  if (d.secondaryMuscles.length) out.secondaryMuscles = d.secondaryMuscles;
  if (ms.distance) out.distanceUnit = d.distanceUnit;
  else if (initial?.distanceUnit) out.distanceUnit = initial.distanceUnit;
  if (ms.duration) {
    if (duration !== null) out.targetDurationSec = duration;
  } else if (initial?.targetDurationSec != null) out.targetDurationSec = initial.targetDurationSec;
  if (ms.distance) {
    if (distanceM !== null) out.targetDistance = distanceM;
  } else if (initial?.targetDistance != null) out.targetDistance = initial.targetDistance;
  return out;
}

const MODEL_KEYS: (keyof ExerciseModelFields)[] = ['modality', 'laterality', 'loadMode', 'secondaryMuscles', 'distanceUnit', 'targetDurationSec', 'targetDistance'];

/** Modalidade, tipo de carga, execução e grupos secundários. Só mostra o que a modalidade usa. */
function ModalityFields({ d, set, primaryGroup, groups }: { d: Draft; set: (p: Partial<Draft>) => void; primaryGroup: string; groups: string[] }) {
  const loadOptions = d.modality === 'bodyweight' || d.modality === 'timed' ? LOAD_MODES_BY_MODALITY[d.modality] : [];
  const secondaryChoices = [...new Set([...groups, ...d.secondaryMuscles])].filter((g) => g !== primaryGroup);
  const full = d.secondaryMuscles.length >= MODEL_LIMITS.maxSecondaryMuscles;
  return (
    <div className="space-y-3 rounded-2xl border border-dashed p-3" data-testid="modality-fields">
      <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ex-modality">Modalidade</Label>
          <NativeSelect id="ex-modality" value={d.modality} onChange={(e) => set({ modality: e.target.value as Draft['modality'] })}>
            <option value="">Não definida (carga × repetições)</option>
            {(Object.keys(MODALITY_LABEL) as TrainingModality[]).map((m) => (
              <option key={m} value={m}>
                {MODALITY_LABEL[m]}
              </option>
            ))}
          </NativeSelect>
        </div>
        {d.modality !== 'cardio' && (
          <div className="space-y-1.5">
            <Label htmlFor="ex-laterality">Execução</Label>
            <NativeSelect id="ex-laterality" value={d.laterality} onChange={(e) => set({ laterality: e.target.value as Draft['laterality'] })}>
              <option value="">Não informada</option>
              {(Object.keys(LATERALITY_LABEL) as ExerciseLaterality[]).map((l) => (
                <option key={l} value={l}>
                  {LATERALITY_LABEL[l]}
                  {l === 'unilateral' ? ' (um lado por série)' : ''}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        {loadOptions.length > 0 && (
          <div className="space-y-1.5 min-[400px]:col-span-2">
            <Label htmlFor="ex-loadmode">Tipo de carga</Label>
            <NativeSelect id="ex-loadmode" value={loadOptions.includes(d.loadMode as LoadMode) ? d.loadMode : ''} onChange={(e) => set({ loadMode: e.target.value as Draft['loadMode'] })}>
              <option value="">Não informado</option>
              {loadOptions.map((l) => (
                <option key={l} value={l}>
                  {d.modality === 'timed' && l === 'corporal' ? 'Sem carga' : LOAD_MODE_LABEL[l]}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>
      {secondaryChoices.length > 0 && (
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">
            Grupos secundários <span className="font-normal text-muted-foreground">(opcional, até {MODEL_LIMITS.maxSecondaryMuscles})</span>
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {secondaryChoices.map((g) => {
              const on = d.secondaryMuscles.includes(g);
              return (
                <button
                  key={g}
                  type="button"
                  aria-pressed={on}
                  disabled={!on && full}
                  onClick={() => set({ secondaryMuscles: on ? d.secondaryMuscles.filter((x) => x !== g) : [...d.secondaryMuscles, g] })}
                  className={cn('min-h-9 rounded-full border px-3 text-sm', on ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground', !on && full && 'opacity-40')}
                >
                  {g}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
    </div>
  );
}

export function ExerciseDialog({
  open,
  onOpenChange,
  initial,
  onSave,
  title,
  submitLabel = 'Salvar exercício',
  header,
  resetKey,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: ExerciseTemplate | null;
  onSave: (e: ExerciseTemplate) => void;
  /** P17: título próprio (ex.: "Adicionar à ficha"); padrão: novo/editar. */
  title?: string;
  submitLabel?: string;
  /** P17: conteúdo acima do formulário (origem na biblioteca, sugestão de configuração). */
  header?: ReactNode;
  /** P17: muda para recarregar o rascunho a partir de `initial` com o diálogo aberto (aplicar uma sugestão). */
  resetKey?: unknown;
}) {
  const settings = useSettings();
  const { unit, show, parse } = useUnits();
  const [d, setD] = useState<Draft>(() => toDraft(initial, settings.muscleGroups, settings.restCompoundSec, show));
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setD(toDraft(initial, settings.muscleGroups, settings.restCompoundSec, show));
      setErrors([]);
      setNewGroup(null);
    }
  }, [open, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const groups = settings.muscleGroups.includes(d.muscleGroup) ? settings.muscleGroups : [...settings.muscleGroups, d.muscleGroup];
  // Campos visíveis conforme a modalidade escolhida (mesma regra usada no treino ativo).
  const ms = exerciseMeasures(modelFromDraft(d, initial, null, null));

  const submit = async () => {
    const errs: string[] = [];
    const reps = parseRepRange(d.reps.trim());
    const sets = Number(d.sets);
    const rest = Number(d.restSec);
    const warm = Number(d.warmupSets);
    const tw = d.targetWeight.trim() ? parseNum(d.targetWeight) : null;
    const durRaw = d.targetDuration.trim() ? parseNum(d.targetDuration) : null;
    const duration = durRaw === null ? null : Math.round(d.modality === 'cardio' ? durRaw * 60 : durRaw);
    const distRaw = d.targetDistance.trim() ? parseNum(d.targetDistance) : null;
    const distanceM = distRaw === null ? null : toMetersFrom(distRaw, d.distanceUnit);
    const model = modelFromDraft(d, initial, duration, distanceM);
    const ms = exerciseMeasures(model);
    if (!d.name.trim()) errs.push('Informe o nome do exercício.');
    // Repetições só são exigidas quando o exercício registra repetições; escondidas, ficam como estavam.
    if (ms.reps && !reps) errs.push('Repetições: use um número (10) ou uma faixa (6-10, 8–12).');
    if (!Number.isInteger(sets) || sets < 1 || sets > 20) errs.push('Séries: de 1 a 20.');
    if (!Number.isInteger(rest) || rest < 0 || rest > 900) errs.push('Descanso: de 0 a 900 segundos.');
    if (!Number.isInteger(warm) || warm < 0 || warm > 5) errs.push('Aquecimento: de 0 a 5 séries.');
    if (ms.weight !== 'none' && d.targetWeight.trim() && (tw === null || tw < 0)) errs.push('Carga planejada inválida.');
    if (ms.duration && d.targetDuration.trim() && !isValidDurationSec(duration))
      errs.push(`Duração planejada: maior que zero e até ${MODEL_LIMITS.maxDurationSec / 3600} h.`);
    if (ms.distance && d.targetDistance.trim() && !isValidDistanceM(distanceM)) errs.push('Distância planejada: maior que zero e até 1 000 km.');
    if (d.secondaryMuscles.length > MODEL_LIMITS.maxSecondaryMuscles) errs.push(`No máximo ${MODEL_LIMITS.maxSecondaryMuscles} grupos secundários.`);
    if (newGroup !== null && !newGroup.trim()) errs.push('Informe o nome do novo grupo muscular.');
    setErrors(errs);
    if (errs.length) return;
    const range = reps ?? (initial ? { min: initial.repMin, max: initial.repMax } : { min: 8, max: 12 });
    let muscleGroup = d.muscleGroup;
    if (newGroup !== null) {
      muscleGroup = newGroup.trim();
      if (!settings.muscleGroups.includes(muscleGroup)) await saveSettings({ muscleGroups: [...settings.muscleGroups, muscleGroup] });
    }
    // Parte do registro original (preserva campos desconhecidos) sem os metadados, que são recalculados.
    const base: Partial<ExerciseTemplate> = { ...(initial ?? {}) };
    for (const k of MODEL_KEYS) delete base[k];
    onSave({
      ...base,
      id: initial?.id ?? uid(),
      name: d.name.trim(),
      muscleGroup,
      category: d.category,
      equipment: d.equipment,
      sets,
      repMin: range.min,
      repMax: range.max,
      restSec: rest,
      warmupSets: warm,
      targetWeight: ms.weight === 'none' ? initial?.targetWeight : tw === null ? undefined : (parse(tw) ?? undefined),
      notes: d.notes.trim() || undefined,
      substitutes: d.substitutes.split(',').map((s) => s.trim()).filter(Boolean),
      ...model,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title ?? (initial ? 'Editar exercício' : 'Novo exercício')}</DialogTitle>
        </DialogHeader>
        {header}
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ex-name">Nome</Label>
            <Input id="ex-name" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: Supino reto com barra" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ex-group">Grupo muscular</Label>
            {newGroup === null ? (
              <NativeSelect
                id="ex-group"
                value={d.muscleGroup}
                onChange={(e) => {
                  if (e.target.value === '__new') setNewGroup('');
                  else set({ muscleGroup: e.target.value });
                }}
              >
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
                <option value="__new">+ Criar novo grupo…</option>
              </NativeSelect>
            ) : (
              <div className="flex gap-2">
                <Input autoFocus placeholder="Nome do novo grupo" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
                <Button variant="ghost" onClick={() => setNewGroup(null)}>
                  Cancelar
                </Button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Segmented
                value={d.category}
                onChange={(v) => set({ category: v, restSec: String(v === 'compound' ? settings.restCompoundSec : settings.restIsolationSec) })}
                options={[
                  { value: 'compound', label: 'Composto' },
                  { value: 'isolation', label: 'Isolador' },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ex-equip">Equipamento</Label>
              <NativeSelect id="ex-equip" value={d.equipment} onChange={(e) => set({ equipment: e.target.value as Equipment })}>
                {(Object.keys(EQUIPMENT_LABEL) as Equipment[]).map((k) => (
                  <option key={k} value={k}>
                    {EQUIPMENT_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <ModalityFields d={d} set={set} primaryGroup={newGroup ?? d.muscleGroup} groups={settings.muscleGroups} />
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ex-sets">Séries</Label>
              <Input id="ex-sets" inputMode="numeric" value={d.sets} onChange={(e) => set({ sets: e.target.value.replace(/\D/g, '') })} />
            </div>
            {ms.reps && (
              <div className="space-y-1.5">
                <Label htmlFor="ex-reps">Repetições</Label>
                <Input id="ex-reps" value={d.reps} onChange={(e) => set({ reps: e.target.value })} placeholder="6-10" />
              </div>
            )}
            {ms.duration && (
              <div className="space-y-1.5">
                <Label htmlFor="ex-duration">{ms.distance ? 'Duração (min)' : 'Duração (s)'}</Label>
                <Input
                  id="ex-duration"
                  inputMode={ms.distance ? 'decimal' : 'numeric'}
                  value={d.targetDuration}
                  onChange={(e) => set({ targetDuration: e.target.value.replace(ms.distance ? /[^0-9.,]/g : /\D/g, '') })}
                  placeholder="opcional"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="ex-rest">Descanso (s)</Label>
              <Input id="ex-rest" inputMode="numeric" value={d.restSec} onChange={(e) => set({ restSec: e.target.value.replace(/\D/g, '') })} />
            </div>
          </div>
          {ms.distance && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ex-distance">Distância ({d.distanceUnit})</Label>
                <Input id="ex-distance" inputMode="decimal" value={d.targetDistance} onChange={(e) => set({ targetDistance: e.target.value.replace(/[^0-9.,]/g, '') })} placeholder="opcional" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ex-distance-unit">Unidade de distância</Label>
                <NativeSelect id="ex-distance-unit" value={d.distanceUnit} onChange={(e) => set({ distanceUnit: e.target.value as DistanceUnit })}>
                  {DISTANCE_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u} ({DISTANCE_UNIT_LABEL[u]})
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          )}
          {(ms.reps || ms.weight !== 'none') && (
            <div className="grid grid-cols-2 gap-3">
              {ms.reps && (
                <div className="space-y-1.5">
                  <Label htmlFor="ex-warm">Séries de aquecimento</Label>
                  <Input id="ex-warm" inputMode="numeric" value={d.warmupSets} onChange={(e) => set({ warmupSets: e.target.value.replace(/\D/g, '') })} />
                </div>
              )}
              {ms.weight !== 'none' && (
                <div className="space-y-1.5">
                  <Label htmlFor="ex-weight">{ms.weight === 'adicional' ? `Carga adicional planejada (${unit})` : `Carga planejada (${unit})`}</Label>
                  <Input id="ex-weight" inputMode="decimal" value={d.targetWeight} onChange={(e) => set({ targetWeight: e.target.value })} placeholder="opcional" />
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ex-notes">Observações de execução</Label>
            <Textarea id="ex-notes" value={d.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Ex.: cadência 2-0-1, amplitude completa" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ex-subs">Substitutos (separados por vírgula)</Label>
            <Input id="ex-subs" value={d.substitutes} onChange={(e) => set({ substitutes: e.target.value })} placeholder="Ex.: Supino com halteres, Supino máquina" />
          </div>
          {errors.length > 0 && (
            <ul className="space-y-1 text-sm text-destructive">
              {errors.map((e) => (
                <li key={e}>• {e}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="submit" size="lg">
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

