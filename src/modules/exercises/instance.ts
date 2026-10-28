// Instâncias de exercício na ficha a partir da biblioteca (P17, docs/BIBLIOTECA_EXERCICIOS.md §2, §9–11).
// Regra de identidade: cada uso de um item da biblioteca vira um ExerciseTemplate NOVO, com ID próprio, que é a
// identidade usada pelas sessões (`templateId`), pelas metas e pelo histórico. `catalogId` (ou `customExerciseId`) é só
// a origem, opcional: nada é ligado "ao vivo" ao catálogo, a instância é uma cópia editável independente.
// Configuração: valores iniciais genéricos por modalidade, ou uma configuração anterior da própria pessoa como ponto
// de partida (séries, repetições, descanso, duração, distância — NUNCA a carga). Sugestão ≠ configuração salva: só vale
// depois que a pessoa confirma no formulário.
import { exerciseMeasures, fmtRepRange, fromMetersTo, LOAD_MODES_BY_MODALITY } from '@/modules/training';
import type { DistanceUnit, ExerciseTemplate, RestDefaults, Routine } from '@/modules/training';
import { catalogKey, customKey } from './custom';
import { muscleText, templateEquipment } from './vocab';
import type { LibraryItem, LibraryKey } from './types';

/** Parâmetros planejados que podem ser reaproveitados de uma ficha anterior. */
export interface PlanConfig {
  sets: number;
  repMin: number;
  repMax: number;
  restSec: number;
  targetDurationSec?: number;
  targetDistance?: number;
  distanceUnit?: DistanceUnit;
}

export interface SuggestedConfig {
  config: PlanConfig;
  /** De onde veio (exibido como motivo). */
  source: { routineId: string; routineName: string; workoutLabel: string; workoutName: string; exerciseName: string };
}

/** Origem de uma instância na biblioteca (null = exercício criado à mão ou antes do P17). */
export function libraryKeyOf(t: { catalogId?: string; customExerciseId?: string }): LibraryKey | null {
  if (typeof t.catalogId === 'string' && t.catalogId) return catalogKey(t.catalogId);
  if (typeof t.customExerciseId === 'string' && t.customExerciseId) return customKey(t.customExerciseId);
  return null;
}

/** Valores iniciais genéricos (os mesmos do editor manual), não uma prescrição. */
export function defaultConfig(item: Pick<LibraryItem, 'modality' | 'mechanics'>, rest: Pick<RestDefaults, 'restCompoundSec' | 'restIsolationSec'>): PlanConfig {
  switch (item.modality) {
    case 'cardio':
      return { sets: 1, repMin: 1, repMax: 1, restSec: 0, distanceUnit: 'km' };
    case 'timed':
      return { sets: 3, repMin: 1, repMax: 1, restSec: 60, targetDurationSec: 30 };
    case 'bodyweight':
      return { sets: 3, repMin: 8, repMax: 12, restSec: rest.restIsolationSec };
    default:
      return { sets: 3, repMin: 8, repMax: 12, restSec: item.mechanics === 'isolation' ? rest.restIsolationSec : rest.restCompoundSec };
  }
}

export interface InstanceOptions {
  /** ID novo da instância (gerado pela tela uma única vez). */
  id: string;
  /** Grupos musculares das configurações (para gravar o texto que a pessoa já usa). */
  muscleGroups: readonly string[];
  rest: Pick<RestDefaults, 'restCompoundSec' | 'restIsolationSec'>;
  config?: PlanConfig;
}

/** Cria a instância da ficha a partir de um item da biblioteca. Pura; a gravação é uma operação da ficha. */
export function instanceFromItem(item: LibraryItem, o: InstanceOptions): ExerciseTemplate {
  const cfg = o.config ?? defaultConfig(item, o.rest);
  const primary = muscleText(item.primaryMuscles[0] ?? 'corpo_inteiro', o.muscleGroups);
  const secondary = [...new Set([...item.primaryMuscles.slice(1), ...item.secondaryMuscles].map((m) => muscleText(m, o.muscleGroups)))].filter((g) => g !== primary).slice(0, 4);
  const t: ExerciseTemplate = {
    id: o.id,
    name: item.name,
    muscleGroup: primary,
    // Campo obrigatório do modelo antigo. Sem classificação no catálogo (cardio, isometria), fica "composto" só para
    // o descanso padrão; a tela não mostra essa classificação para cardio e exercícios por tempo.
    category: item.mechanics ?? 'compound',
    equipment: templateEquipment(item.equipment),
    sets: cfg.sets,
    repMin: cfg.repMin,
    repMax: cfg.repMax,
    restSec: cfg.restSec,
    warmupSets: 0,
    modality: item.modality,
  };
  if (secondary.length) t.secondaryMuscles = secondary;
  if (item.modality !== 'cardio') t.laterality = item.laterality;
  const lm = item.loadMode ?? undefined;
  if (lm && LOAD_MODES_BY_MODALITY[item.modality].includes(lm) && item.modality !== 'resistance') t.loadMode = lm;
  if (item.modality === 'cardio') t.distanceUnit = cfg.distanceUnit ?? 'km';
  if (cfg.targetDurationSec != null && exerciseMeasures(t).duration) t.targetDurationSec = cfg.targetDurationSec;
  if (cfg.targetDistance != null && exerciseMeasures(t).distance) t.targetDistance = cfg.targetDistance;
  if (item.kind === 'catalog') {
    t.catalogId = item.refId;
    t.catalogVersion = item.version;
  } else t.customExerciseId = item.refId;
  return t;
}

/** Aplica uma configuração (sugerida ou digitada) a uma instância, só nos campos que a modalidade usa. */
export function applyConfig(t: ExerciseTemplate, cfg: PlanConfig): ExerciseTemplate {
  const ms = exerciseMeasures(t);
  const out: ExerciseTemplate = { ...t, sets: cfg.sets, restSec: cfg.restSec };
  if (ms.reps) {
    out.repMin = cfg.repMin;
    out.repMax = cfg.repMax;
  }
  if (ms.duration) {
    if (cfg.targetDurationSec != null) out.targetDurationSec = cfg.targetDurationSec;
    else delete out.targetDurationSec;
  }
  if (ms.distance) {
    if (cfg.targetDistance != null) out.targetDistance = cfg.targetDistance;
    else delete out.targetDistance;
    if (cfg.distanceUnit) out.distanceUnit = cfg.distanceUnit;
  }
  return out;
}

const configOf = (t: ExerciseTemplate): PlanConfig => {
  const c: PlanConfig = { sets: t.sets, repMin: t.repMin, repMax: t.repMax, restSec: t.restSec };
  if (t.targetDurationSec != null) c.targetDurationSec = t.targetDurationSec;
  if (t.targetDistance != null) c.targetDistance = t.targetDistance;
  if (t.distanceUnit) c.distanceUnit = t.distanceUnit;
  return c;
};

/**
 * Configuração anterior do MESMO item da biblioteca (mesmo catalogId/customExerciseId, nunca por nome) nas fichas do
 * perfil, para usar como ponto de partida. Escolhe a ficha alterada mais recentemente; empate pela ordem estável
 * (rotina, treino, posição). Só itens de mesma modalidade. A carga planejada nunca entra.
 */
export function previousConfig(key: LibraryKey, routines: readonly Routine[], modality: LibraryItem['modality'], profileId?: string | null): SuggestedConfig | null {
  const sorted = [...routines].filter((r) => !profileId || !r.profileId || r.profileId === profileId).sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  for (const r of sorted)
    for (const w of r.workouts ?? [])
      for (const t of w.exercises ?? []) {
        if (libraryKeyOf(t) !== key || (t.modality ?? 'resistance') !== modality) continue;
        return { config: configOf(t), source: { routineId: r.id, routineName: r.name, workoutLabel: w.label, workoutName: w.name, exerciseName: t.name } };
      }
  return null;
}

/** "3 × 8–12 · descanso 90 s", "1 × 20 min · 5 km" (resumo curto de uma configuração para a sugestão). */
export function describeConfig(cfg: PlanConfig, modality: LibraryItem['modality']): string {
  const parts: string[] = [];
  if (modality === 'cardio') {
    if (cfg.targetDurationSec != null) parts.push(`${Math.round(cfg.targetDurationSec / 60)} min`);
    if (cfg.targetDistance != null) parts.push(`${String(Math.round(fromMetersTo(cfg.targetDistance, cfg.distanceUnit ?? 'km') * 100) / 100).replace('.', ',')} ${cfg.distanceUnit ?? 'km'}`);
    if (!parts.length) parts.push(`${cfg.sets} ${cfg.sets === 1 ? 'série' : 'séries'}`);
  } else if (modality === 'timed') parts.push(`${cfg.sets} × ${cfg.targetDurationSec ?? '—'} s`);
  else parts.push(`${cfg.sets} × ${fmtRepRange(cfg.repMin, cfg.repMax)}`);
  if (cfg.restSec > 0) parts.push(`descanso ${cfg.restSec} s`);
  return parts.join(' · ');
}

// ---------- Substituição ----------

export interface SubstitutionPreview {
  current: ExerciseTemplate;
  /** Nova instância (ID NOVO). O ID antigo sai da ficha; histórico e metas ficam com ele. */
  next: ExerciseTemplate;
  modalityChanged: boolean;
  /** Mensagens sobre o que muda de modalidade/medida. */
  modalityNotes: string[];
  /** Campos copiados do exercício atual. */
  kept: string[];
  /** Campos que não passam para o substituto. */
  dropped: string[];
  /** Metas ligadas ao exercício atual (por ID); não são redirecionadas. */
  linkedGoals: number;
  historyNote: string;
  goalNote: string | null;
}

const measureName = (t: ExerciseTemplate) => {
  const ms = exerciseMeasures(t);
  if (ms.distance) return 'duração e distância';
  if (ms.duration) return 'duração';
  return ms.weight === 'none' ? 'repetições' : 'carga e repetições';
};

/**
 * Prévia da troca de um exercício da ficha por outro da biblioteca. A troca cria uma instância NOVA (novo ID): o
 * histórico do exercício anterior continua sendo dele (as sessões guardam o próprio `templateId`) e as metas ligadas
 * ao ID anterior não são redirecionadas. Copia só o que tem o mesmo significado nos dois (séries e descanso sempre;
 * repetições, duração e distância quando os dois medem isso); carga planejada e observações nunca.
 */
export function substitutionPreview(current: ExerciseTemplate, item: LibraryItem, o: Omit<InstanceOptions, 'config'> & { linkedGoals: number }): SubstitutionPreview {
  const fresh = instanceFromItem(item, o);
  const a = exerciseMeasures(current);
  const b = exerciseMeasures(fresh);
  const kept = ['séries', 'descanso'];
  const dropped: string[] = [];
  const cfg: PlanConfig = { sets: current.sets, restSec: current.restSec, repMin: fresh.repMin, repMax: fresh.repMax };
  if (a.reps && b.reps) {
    cfg.repMin = current.repMin;
    cfg.repMax = current.repMax;
    kept.push('repetições');
  } else if (a.reps) dropped.push(`repetições (${fmtRepRange(current.repMin, current.repMax)}): o substituto não registra repetições`);
  if (a.duration && b.duration && current.targetDurationSec != null) {
    cfg.targetDurationSec = current.targetDurationSec;
    kept.push('duração planejada');
  } else if (current.targetDurationSec != null && a.duration) dropped.push('duração planejada: o substituto não registra duração');
  if (a.distance && b.distance && current.targetDistance != null) {
    cfg.targetDistance = current.targetDistance;
    cfg.distanceUnit = current.distanceUnit;
    kept.push('distância planejada');
  } else if (current.targetDistance != null && a.distance) dropped.push('distância planejada: o substituto não registra distância');
  if (current.targetWeight != null) dropped.push('carga planejada: é de outro exercício e não vale como ponto de partida');
  if (current.warmupSets > 0) dropped.push('séries de aquecimento (reconfigure se quiser)');
  if (current.notes) dropped.push('observações de execução');
  const next = applyConfig(fresh, cfg);
  const modalityChanged = (current.modality ?? null) !== (next.modality ?? null);
  const modalityNotes: string[] = [];
  if (measureName(current) !== measureName(next)) modalityNotes.push(`O registro muda de ${measureName(current)} para ${measureName(next)}.`);
  if (modalityChanged && !modalityNotes.length) modalityNotes.push('A modalidade muda, mas o tipo de registro continua o mesmo.');
  if ((current.laterality === 'unilateral') !== (next.laterality === 'unilateral'))
    modalityNotes.push(next.laterality === 'unilateral' ? 'O substituto é unilateral: cada série registra o lado.' : 'O substituto não é unilateral: as séries deixam de registrar o lado.');
  return {
    current,
    next,
    modalityChanged,
    modalityNotes,
    kept,
    dropped,
    linkedGoals: o.linkedGoals,
    historyNote: `O histórico de "${current.name}" continua como está. "${next.name}" começa um histórico próprio; nada é transferido entre os dois.`,
    goalNote: o.linkedGoals
      ? `${o.linkedGoals === 1 ? '1 meta continua ligada' : `${o.linkedGoals} metas continuam ligadas`} a "${current.name}" e não passa${o.linkedGoals === 1 ? '' : 'm'} para o substituto. Crie uma meta nova se quiser acompanhar "${next.name}".`
      : null,
  };
}

/** Rótulo curto da origem de uma instância. */
export function originLabel(t: { catalogId?: string; customExerciseId?: string }): string | null {
  if (t.catalogId) return 'Biblioteca';
  if (t.customExerciseId) return 'Meu exercício';
  return null;
}

