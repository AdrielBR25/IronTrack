// Modelos da biblioteca de exercícios (IronTrack 2.0 F01/P17). Ver docs/BIBLIOTECA_EXERCICIOS.md.
// Quatro entidades, com identidades separadas de propósito:
//  1. CatalogExercise  — modelo padrão, estático e versionado no código (`catalogId`, nunca gravado no banco);
//  2. CustomExercise   — modelo criado pela pessoa (tabela `customExercises`, Dexie v6, ID `cx_…`);
//  3. ExerciseTemplate — instância do exercício dentro de uma ficha (ID próprio; `catalogId`/`customExerciseId`
//                        são só uma referência opcional de origem, ver src/modules/training/types.ts);
//  4. SessionSet       — série executada dentro de uma sessão (cópia, nunca ligada ao catálogo).
// Uma mudança no catálogo ou num exercício personalizado nunca altera fichas nem sessões: a instância é uma cópia.
// Só importa tipos da API pública do treinamento (este arquivo é agregado por src/lib/types.ts).
import type { ExerciseLaterality, LoadMode, TrainingModality } from '@/modules/training';

/**
 * Grupos musculares da biblioteca: os mesmos IDs canônicos da normalização do analytics (P09,
 * src/modules/analytics/domain/muscles.ts) mais `corpo_inteiro`, usado em cardio e movimentos globais.
 * Um teste garante que a lista continua igual à do analytics.
 */
export type LibraryMuscle =
  | 'peitoral'
  | 'costas'
  | 'ombros'
  | 'biceps'
  | 'triceps'
  | 'antebraco'
  | 'trapezio'
  | 'lombar'
  | 'quadriceps'
  | 'posteriores'
  | 'gluteos'
  | 'adutores'
  | 'abdutores'
  | 'panturrilhas'
  | 'abdomen'
  | 'corpo_inteiro';

/**
 * Equipamentos da biblioteca (mais detalhados que o `Equipment` da ficha). Ao criar a instância, o primeiro item
 * vira o equipamento da ficha pela tabela `TEMPLATE_EQUIPMENT` (o modelo da ficha não muda).
 */
export type LibraryEquipment = 'barra' | 'halteres' | 'maquina' | 'polia' | 'banco' | 'peso_corporal' | 'elastico' | 'esteira' | 'bicicleta' | 'outros';

/** Padrão de movimento: descrição geral, sem pretensão biomecânica precisa. */
export type MovementPattern =
  | 'empurrar_horizontal'
  | 'empurrar_vertical'
  | 'puxar_horizontal'
  | 'puxar_vertical'
  | 'agachar'
  | 'dobrar_quadril'
  | 'avanco'
  | 'isolado_superior'
  | 'isolado_inferior'
  | 'core_flexao'
  | 'core_estabilizacao'
  | 'locomocao'
  | 'isometria'
  | 'mobilidade'
  | 'corpo_inteiro';

/** Mecânica: multiarticular (composto) ou monoarticular (isolador). null = não classificado (cardio, isometria…). */
export type Mechanics = 'compound' | 'isolation';

/** Complexidade técnica geral. Não é avaliação médica nem de aptidão. */
export type Difficulty = 'iniciante' | 'intermediario' | 'avancado';

/** Exercício padrão do catálogo. Dado estático versionado no código (sem rede, sem IA, sem imagens remotas). */
export interface CatalogExercise {
  /** Identificador estável (slug minúsculo, sem prefixo `cx_`). Nunca reutilizado para outro exercício. */
  catalogId: string;
  name: string;
  aliases: string[];
  modality: TrainingModality;
  /** Grupos principais (o primeiro vira o grupo da instância na ficha). */
  primaryMuscles: LibraryMuscle[];
  secondaryMuscles: LibraryMuscle[];
  /** Equipamentos usados (o primeiro é o principal). */
  equipment: LibraryEquipment[];
  movementPattern: MovementPattern;
  laterality: ExerciseLaterality;
  /** null em cardio (sem carga registrada). */
  loadMode: LoadMode | null;
  mechanics: Mechanics | null;
  difficulty: Difficulty;
  /** Passos curtos e conservadores de execução. */
  instructions: string[];
  commonMistakes: string[];
  safetyNotes: string[];
  tags: string[];
  source: 'irontrack-base';
  /** Versão da entrada; sobe quando o conteúdo da entrada muda. A instância guarda a versão copiada. */
  version: number;
}

/** Exercício personalizado (tabela `customExercises`, Dexie v6, backup v7). */
export interface CustomExercise {
  /** `cx_` + identificador aleatório gerado uma única vez. Nunca coincide com um `catalogId`. */
  id: string;
  /** Perfil proprietário (preenchido pelo banco na criação; nunca muda). */
  profileId?: string;
  name: string;
  modality: TrainingModality;
  primaryMuscle: LibraryMuscle;
  secondaryMuscles: LibraryMuscle[];
  equipment: LibraryEquipment[];
  laterality: ExerciseLaterality;
  loadMode: LoadMode | null;
  mechanics: Mechanics | null;
  /** Texto simples (sem HTML), opcional. */
  instructions?: string;
  notes?: string;
  /** Data (ms) do arquivamento; null = ativo. Arquivado continua existindo (fichas e histórico não perdem a origem). */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Concorrência otimista entre abas: toda edição confere e incrementa. */
  revision: number;
}

/** Alvo de um favorito: exercício do catálogo ou personalizado. */
export type LibraryKey = `catalog:${string}` | `custom:${string}`;

/** Favorito (tabela `exerciseFavorites`, Dexie v6, backup v7). ID determinístico `<perfil>~<alvo>`: sem duplicatas. */
export interface ExerciseFavorite {
  id: string;
  profileId?: string;
  target: LibraryKey;
  createdAt: number;
}

/** Visão única de um exercício da biblioteca (catálogo ou personalizado) para busca, filtros e telas. */
export interface LibraryItem {
  kind: 'catalog' | 'custom';
  key: LibraryKey;
  /** catalogId ou id do personalizado. */
  refId: string;
  name: string;
  aliases: string[];
  modality: TrainingModality;
  primaryMuscles: LibraryMuscle[];
  secondaryMuscles: LibraryMuscle[];
  equipment: LibraryEquipment[];
  movementPattern: MovementPattern | null;
  laterality: ExerciseLaterality;
  loadMode: LoadMode | null;
  mechanics: Mechanics | null;
  difficulty: Difficulty | null;
  instructions: string[];
  commonMistakes: string[];
  safetyNotes: string[];
  notes: string | null;
  tags: string[];
  archived: boolean;
  version: number;
}
