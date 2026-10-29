// Identidade dos exercícios nas metas (IronTrack 2.0 F01/P12). Ver docs/METAS_TREINAMENTO.md §4.
//
// O histórico liga exercícios pelo nome normalizado (`exerciseKey`), o que junta exercícios diferentes com o
// mesmo nome e separa um exercício renomeado. As metas não usam o nome: guardam os IDs dos exercícios da ficha
// (`ExerciseTemplate.id`, únicos e preservados ao renomear) e só contam séries de cópias na sessão que tenham o
// mesmo `templateId`. Exercícios substituídos durante o treino (`substitutedFrom`) nunca contam, porque a cópia
// mantém o `templateId` do exercício original. Sessões antigas sem `templateId` não são associadas por nome.
import { exerciseKey } from '@/lib/utils';
import type { Routine, SessionExercise } from '@/modules/training';
import type { GoalExerciseModality, GoalExerciseRef, GoalType } from './types';
import { exerciseGoalBlocker } from './validation';

const MODALITIES: readonly string[] = ['resistance', 'bodyweight', 'timed', 'cardio'];
const LOAD_MODES: readonly string[] = ['externa', 'corporal', 'adicional', 'assistida'];
const LATERALITIES: readonly string[] = ['bilateral', 'unilateral'];
const DISTANCE_UNITS: readonly string[] = ['m', 'km', 'mi'];
const pick = <T extends string>(list: readonly string[], v: unknown): T | null => (typeof v === 'string' && list.includes(v) ? (v as T) : null);

/** Fotografia dos atributos de um exercício (ficha ou cópia na sessão), só com valores válidos. */
export function exerciseRefAttributes(e: { modality?: unknown; loadMode?: unknown; laterality?: unknown; equipment?: unknown; distanceUnit?: unknown }): Pick<
  GoalExerciseRef,
  'modality' | 'loadMode' | 'laterality' | 'equipment' | 'distanceUnit'
> {
  return {
    modality: pick(MODALITIES, e.modality),
    loadMode: pick(LOAD_MODES, e.loadMode),
    laterality: pick(LATERALITIES, e.laterality),
    equipment: typeof e.equipment === 'string' ? e.equipment : null,
    distanceUnit: pick(DISTANCE_UNITS, e.distanceUnit),
  };
}

/** Família de medição: exercícios sem modalidade são lidos como musculação (carga × repetições), como no analytics. */
export type MeasureFamily = 'carga' | 'corporal' | 'tempo' | 'cardio';
export const measureFamily = (m: GoalExerciseModality | null): MeasureFamily => (m === 'timed' ? 'tempo' : m === 'cardio' ? 'cardio' : m === 'bodyweight' ? 'corporal' : 'carga');

export interface GoalExerciseOption {
  /** Identificador da opção no formulário (rotina + IDs). */
  value: string;
  ref: GoalExerciseRef;
  routineName: string;
  /** Rótulos dos treinos em que o exercício aparece (ex.: ["A", "C"]). */
  workoutLabels: string[];
}

/**
 * Exercícios disponíveis para metas, a partir das fichas. Dentro de uma mesma rotina, ocorrências com o mesmo nome
 * e os mesmos atributos (modalidade, carga, lateralidade, equipamento) viram uma opção com todos os IDs, e o rótulo
 * mostra em quais treinos aparecem. Rotinas diferentes nunca são juntadas.
 */
export function goalExerciseOptions(routines: readonly Routine[]): GoalExerciseOption[] {
  const out: GoalExerciseOption[] = [];
  for (const r of routines) {
    const groups = new Map<string, GoalExerciseOption>();
    for (const w of r.workouts ?? [])
      for (const e of w.exercises ?? []) {
        if (typeof e?.id !== 'string' || !e.id.trim() || typeof e.name !== 'string' || !e.name.trim()) continue;
        const attrs = exerciseRefAttributes(e);
        const k = [exerciseKey(e.name), attrs.modality, attrs.loadMode, attrs.laterality, attrs.equipment].join('|');
        const g = groups.get(k);
        if (g) {
          if (!g.ref.templateIds.includes(e.id)) g.ref.templateIds.push(e.id);
          if (!g.workoutLabels.includes(w.label)) g.workoutLabels.push(w.label);
          continue;
        }
        groups.set(k, { value: '', ref: { templateIds: [e.id], routineId: r.id, name: e.name.trim(), ...attrs }, routineName: r.name, workoutLabels: [w.label] });
      }
    for (const g of groups.values()) out.push({ ...g, value: `${r.id}|${g.ref.templateIds.join(',')}` });
  }
  return out.sort((a, b) => a.ref.name.localeCompare(b.ref.name, 'pt-BR') || a.routineName.localeCompare(b.routineName, 'pt-BR'));
}

/** Opções que servem a um tipo de meta. */
export const optionsForGoalType = (options: readonly GoalExerciseOption[], type: GoalType) => options.filter((o) => exerciseGoalBlocker(type, o.ref) === null);

export type ExerciseAvailabilityState = 'disponivel' | 'renomeado' | 'parcial' | 'modalidade_alterada' | 'removido';

export interface ExerciseAvailability {
  state: ExerciseAvailabilityState;
  /** Nome atual na ficha (quando ainda existe). */
  currentName: string | null;
  /** IDs da meta que não estão mais em nenhuma ficha. */
  missing: number;
}

/**
 * Situação do exercício da meta nas fichas atuais. A meta nunca é apagada nem reassociada automaticamente:
 * se o exercício saiu das fichas, ela continua usando o histórico registrado com os mesmos IDs.
 */
export function goalExerciseAvailability(ref: GoalExerciseRef, routines: readonly Routine[]): ExerciseAvailability {
  const found = new Map<string, { name: string; modality: GoalExerciseModality | null }>();
  for (const r of routines)
    for (const w of r.workouts ?? [])
      for (const e of w.exercises ?? []) if (ref.templateIds.includes(e.id)) found.set(e.id, { name: e.name, modality: exerciseRefAttributes(e).modality });
  if (!found.size) return { state: 'removido', currentName: null, missing: ref.templateIds.length };
  const first = found.get(ref.templateIds.find((id) => found.has(id))!)!;
  const missing = ref.templateIds.length - found.size;
  if ([...found.values()].some((f) => measureFamily(f.modality) !== measureFamily(ref.modality))) return { state: 'modalidade_alterada', currentName: first.name, missing };
  if (missing) return { state: 'parcial', currentName: first.name, missing };
  if (exerciseKey(first.name) !== exerciseKey(ref.name)) return { state: 'renomeado', currentName: first.name, missing };
  return { state: 'disponivel', currentName: first.name, missing };
}

/**
 * Relação entre uma cópia de exercício na sessão e a meta:
 *  - 'match': mesmo ID da ficha, não substituído, mesma família de medição;
 *  - 'incompatible': mesmo ID, mas registrado com outra modalidade (não entra, para não misturar medidas);
 *  - 'substituted': mesmo ID, mas o exercício foi trocado durante o treino (não entra);
 *  - null: outro exercício.
 */
export function goalExerciseMatch(ref: GoalExerciseRef, ex: Pick<SessionExercise, 'templateId' | 'substitutedFrom' | 'modality'>): 'match' | 'incompatible' | 'substituted' | null {
  if (typeof ex.templateId !== 'string' || !ref.templateIds.includes(ex.templateId)) return null;
  if (ex.substitutedFrom) return 'substituted';
  return measureFamily(pick(MODALITIES, ex.modality)) === measureFamily(ref.modality) ? 'match' : 'incompatible';
}
