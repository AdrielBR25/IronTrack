// Classificação analítica de exercícios (IronTrack 2.0 F01/P09). Ver docs/ANALYTICS_TREINAMENTO.md §15.
// Determinística e conservadora: usa só campos estruturados (equipamento e cargas registradas). O nome do
// exercício NUNCA é usado ("Prancha" pode ter sido registrada em repetições; "Rosca alternada" não diz se a
// carga é por lado). O que os dados não sustentam fica "desconhecido". Os atributos explícitos são o
// contrato para uma versão futura do editor (docs/MODELO_EXERCICIOS_V2.md): hoje nenhum registro os tem.

/** Atributos combináveis: um exercício unilateral também pode ter carga externa. */
export type ExerciseModality = 'resistance_weighted' | 'bodyweight' | 'timed' | 'cardio' | 'unilateral' | 'unknown';

/**
 * `externa`: carga externa registrada. `corporal`: só peso corporal. `corporal_com_adicional`: peso corporal com
 * carga extra registrada. `corporal_assistida`: com assistência (só por atributo explícito). `desconhecida`.
 */
export type LoadKind = 'externa' | 'corporal' | 'corporal_com_adicional' | 'corporal_assistida' | 'desconhecida';
export type Laterality = 'bilateral' | 'unilateral' | 'desconhecida';

/** Contrato futuro: atributos gravados explicitamente pelo editor. Nenhum campo existe no banco (Dexie v2). */
export interface ExplicitExerciseAttributes {
  modality?: 'resistance' | 'bodyweight' | 'timed' | 'cardio';
  laterality?: 'bilateral' | 'unilateral';
  loadMode?: 'externa' | 'corporal' | 'adicional' | 'assistida';
}

export interface ClassificationInput {
  /** Equipamento da ficha (texto livre para tolerar registros antigos ou corrompidos). */
  equipment?: string | null;
  /** Há séries realizadas com carga válida (> 0)? */
  hasLoadedSets: boolean;
  hasUnloadedSets: boolean;
  /** Dados por série que só existiriam com o modelo futuro. */
  hasDuration?: boolean;
  hasDistance?: boolean;
  hasSide?: boolean;
  explicit?: ExplicitExerciseAttributes | null;
}

export interface ExerciseClassification {
  /** Atributos em ordem fixa; 'unknown' aparece sozinho. */
  modalities: ExerciseModality[];
  load: LoadKind;
  laterality: Laterality;
  /** O que os registros permitem medir. */
  measures: { reps: boolean; externalLoad: boolean; duration: boolean; distance: boolean; side: boolean };
  /** `explicito`: atributos gravados; `dados_existentes`: equipamento e cargas; `desconhecido`. */
  source: 'explicito' | 'dados_existentes' | 'desconhecido';
  /** Por que cada atributo foi decidido (códigos estáveis, para testes e documentação). */
  evidence: string[];
}

const ORDER: ExerciseModality[] = ['resistance_weighted', 'bodyweight', 'timed', 'cardio', 'unilateral'];
const LOADED_EQUIPMENT = new Set(['barbell', 'dumbbell', 'machine', 'cable', 'other']);

export function classifyExercise(input: ClassificationInput): ExerciseClassification {
  const tags = new Set<ExerciseModality>();
  const evidence: string[] = [];
  const x = input.explicit ?? null;
  let load: LoadKind = 'desconhecida';
  let laterality: Laterality = 'desconhecida';
  const timedOrCardio = x?.modality === 'timed' || x?.modality === 'cardio';

  if (x?.modality === 'timed') (tags.add('timed'), evidence.push('explicito:tempo'));
  if (x?.modality === 'cardio') (tags.add('cardio'), evidence.push('explicito:cardio'));

  // Carga.
  if (x?.loadMode) {
    evidence.push(`explicito:carga_${x.loadMode}`);
    load = { externa: 'externa', corporal: 'corporal', adicional: 'corporal_com_adicional', assistida: 'corporal_assistida' }[x.loadMode] as LoadKind;
  } else if (x?.modality === 'bodyweight' || input.equipment === 'bodyweight') {
    evidence.push(x?.modality === 'bodyweight' ? 'explicito:peso_corporal' : 'equipamento:peso_corporal');
    // Assistência nunca é deduzida: hoje não há como registrá-la.
    load = input.hasLoadedSets ? 'corporal_com_adicional' : 'corporal';
    if (input.hasLoadedSets) evidence.push('series:carga_adicional');
  } else if (input.hasLoadedSets && (x?.modality === 'resistance' || LOADED_EQUIPMENT.has(input.equipment ?? ''))) {
    load = 'externa';
    evidence.push(x?.modality === 'resistance' ? 'explicito:carga_externa' : 'equipamento_e_series:carga_externa');
  } else if (!timedOrCardio) {
    evidence.push(input.hasLoadedSets ? 'equipamento:desconhecido' : 'series:sem_carga_registrada');
  }
  if (load === 'externa') tags.add('resistance_weighted');
  if (load === 'corporal' || load === 'corporal_com_adicional' || load === 'corporal_assistida') tags.add('bodyweight');

  // Lateralidade: equipamento (ex.: halteres) não diz se a execução é unilateral.
  if (x?.laterality) {
    laterality = x.laterality;
    evidence.push(`explicito:${x.laterality}`);
    if (x.laterality === 'unilateral') tags.add('unilateral');
  }

  const modalities = tags.size ? ORDER.filter((m) => tags.has(m)) : (['unknown'] as ExerciseModality[]);
  return {
    modalities,
    load,
    laterality,
    measures: {
      reps: input.hasLoadedSets || input.hasUnloadedSets,
      externalLoad: input.hasLoadedSets && load !== 'corporal_assistida',
      duration: !!input.hasDuration,
      distance: !!input.hasDistance,
      side: !!input.hasSide,
    },
    source: x && Object.keys(x).length ? 'explicito' : modalities[0] === 'unknown' ? 'desconhecido' : 'dados_existentes',
    evidence,
  };
}

/**
 * O 1RM estimado (e as métricas de carga) só valem para carga externa: em peso corporal a carga registrada é só a
 * adicional, e somá-la ao peso do corpo exigiria uma fórmula por exercício que o app não tem.
 */
export const supportsLoadMetrics = (c: ExerciseClassification) => c.measures.externalLoad && !c.modalities.includes('bodyweight');
