// Vocabulário da biblioteca (P17): listas, rótulos pt-BR e as pontes para o modelo da ficha.
// Os grupos musculares reutilizam a normalização do analytics (P09): mesmos IDs, mesmos rótulos e a mesma tabela de
// sinônimos para reconhecer o texto que a pessoa já usa nas fichas ("Peito", "Posterior de coxa"...).
import { MUSCLE_LABEL, normalizeMuscleGroup, type MuscleGroupId } from '@/modules/analytics';
import type { Equipment, TrainingModality } from '@/modules/training';
import type { Difficulty, LibraryEquipment, LibraryMuscle, Mechanics, MovementPattern } from './types';

export const LIBRARY_MUSCLES: readonly LibraryMuscle[] = [
  'peitoral',
  'costas',
  'ombros',
  'biceps',
  'triceps',
  'antebraco',
  'trapezio',
  'lombar',
  'quadriceps',
  'posteriores',
  'gluteos',
  'adutores',
  'abdutores',
  'panturrilhas',
  'abdomen',
  'corpo_inteiro',
];

export const MUSCLE_NAME: Record<LibraryMuscle, string> = { ...MUSCLE_LABEL, corpo_inteiro: 'Corpo inteiro' };

/** Grupos oferecidos no filtro (Prompt 17 §10). Os demais continuam pesquisáveis pelo nome. */
export const FILTER_MUSCLES: readonly LibraryMuscle[] = ['peitoral', 'costas', 'ombros', 'biceps', 'triceps', 'quadriceps', 'posteriores', 'gluteos', 'panturrilhas', 'abdomen', 'corpo_inteiro'];

export const LIBRARY_EQUIPMENT: readonly LibraryEquipment[] = ['barra', 'halteres', 'maquina', 'polia', 'banco', 'peso_corporal', 'elastico', 'esteira', 'bicicleta', 'outros'];

export const EQUIPMENT_NAME: Record<LibraryEquipment, string> = {
  barra: 'Barra',
  halteres: 'Halteres',
  maquina: 'Máquina',
  polia: 'Polia',
  banco: 'Banco',
  peso_corporal: 'Peso corporal',
  elastico: 'Elástico',
  esteira: 'Esteira',
  bicicleta: 'Bicicleta',
  outros: 'Outros',
};

/** Equipamento gravado na ficha (modelo existente). O banco não é equipamento de carga: cai no seguinte da lista. */
export const TEMPLATE_EQUIPMENT: Record<LibraryEquipment, Equipment | null> = {
  barra: 'barbell',
  halteres: 'dumbbell',
  maquina: 'machine',
  polia: 'cable',
  banco: null,
  peso_corporal: 'bodyweight',
  elastico: 'other',
  esteira: 'machine',
  bicicleta: 'machine',
  outros: 'other',
};

/** Caminho inverso (só para comparar uma instância antiga com itens da biblioteca nas sugestões). */
export const FROM_TEMPLATE_EQUIPMENT: Record<Equipment, LibraryEquipment> = {
  barbell: 'barra',
  dumbbell: 'halteres',
  machine: 'maquina',
  cable: 'polia',
  bodyweight: 'peso_corporal',
  other: 'outros',
};

/** Modalidades no filtro (rótulos curtos; os longos continuam em MODALITY_LABEL do treinamento). */
export const MODALITY_FILTER_LABEL: Record<TrainingModality, string> = {
  resistance: 'Resistência',
  bodyweight: 'Peso corporal',
  timed: 'Tempo',
  cardio: 'Cardio',
};

export const MOVEMENT_LABEL: Record<MovementPattern, string> = {
  empurrar_horizontal: 'Empurrar (horizontal)',
  empurrar_vertical: 'Empurrar (vertical)',
  puxar_horizontal: 'Puxar (horizontal)',
  puxar_vertical: 'Puxar (vertical)',
  agachar: 'Agachar',
  dobrar_quadril: 'Dobrar o quadril',
  avanco: 'Avanço / passada',
  isolado_superior: 'Isolado — membros superiores',
  isolado_inferior: 'Isolado — membros inferiores',
  core_flexao: 'Abdômen — flexão do tronco',
  core_estabilizacao: 'Abdômen — estabilização',
  locomocao: 'Locomoção',
  isometria: 'Sustentação (isometria)',
  mobilidade: 'Alongamento / mobilidade',
  corpo_inteiro: 'Corpo inteiro',
};

export const MECHANICS_LABEL: Record<Mechanics, string> = { compound: 'Composto (multiarticular)', isolation: 'Isolador (monoarticular)' };

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { iniciante: 'Iniciante', intermediario: 'Intermediário', avancado: 'Avançado' };

export const isLibraryMuscle = (v: unknown): v is LibraryMuscle => typeof v === 'string' && (LIBRARY_MUSCLES as readonly string[]).includes(v);
export const isLibraryEquipment = (v: unknown): v is LibraryEquipment => typeof v === 'string' && (LIBRARY_EQUIPMENT as readonly string[]).includes(v);

/**
 * Texto do grupo muscular gravado na ficha. Se a pessoa já tem, nas configurações, um grupo que a normalização do P09
 * reconhece como o mesmo (ex.: "Peito" para peitoral), ele é usado; senão, o rótulo canônico. Nada de palpite por nome.
 */
export function muscleText(m: LibraryMuscle, userGroups: readonly string[]): string {
  if (m !== 'corpo_inteiro') for (const g of userGroups) if (normalizeMuscleGroup(g).id === m) return g;
  return MUSCLE_NAME[m];
}

/** Grupo da biblioteca correspondente ao texto de uma ficha (null se não reconhecido ou ambíguo). */
export function muscleFromText(text: string | null | undefined): LibraryMuscle | null {
  const n = normalizeMuscleGroup(text);
  if (n.id) return n.id satisfies MuscleGroupId;
  return n.label && /^corpo (inteiro|todo)$/i.test(n.label.trim()) ? 'corpo_inteiro' : null;
}

/** Equipamento da ficha a partir da lista da biblioteca (primeiro equipamento que tenha correspondência). */
export function templateEquipment(list: readonly LibraryEquipment[]): Equipment {
  for (const e of list) {
    const t = TEMPLATE_EQUIPMENT[e];
    if (t) return t;
  }
  return 'other';
}
