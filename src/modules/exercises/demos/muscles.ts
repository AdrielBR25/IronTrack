// Músculos do humanoide e do mapa 2D (P20, docs/MAPA_ANATOMICO.md). Uma taxonomia só: os grupos da biblioteca
// (LibraryMuscle, os mesmos IDs da normalização do analytics do P09) são traduzidos aqui nas regiões desenhadas. O mapa
// 3D e o mapa 2D usam esta mesma tabela, então nunca divergem.
// Regras: só regiões anatômicas reais; cada grupo acende exatamente as regiões que o compõem; nada é inventado para
// grupos sem região própria (ex.: `corpo_inteiro` acende todas e o texto explica que é um movimento global).
import type { LibraryMuscle } from '../types';
import type { Segment, Side } from './rig';
import type { Vec3 } from './math';

/** Regiões musculares desenhadas (uma por lado quando são pares). */
export type MusclePart =
  | 'peitoral'
  | 'deltoide'
  | 'biceps'
  | 'triceps'
  | 'antebraco'
  | 'trapezio'
  | 'dorsal'
  | 'eretores'
  | 'reto_abdominal'
  | 'obliquos'
  | 'gluteo_maximo'
  | 'gluteo_medio'
  | 'quadriceps'
  | 'isquiotibiais'
  | 'adutores'
  | 'panturrilha';

export const PART_LABEL: Record<MusclePart, string> = {
  peitoral: 'Peitoral maior',
  deltoide: 'Deltoide',
  biceps: 'Bíceps braquial',
  triceps: 'Tríceps braquial',
  antebraco: 'Antebraço',
  trapezio: 'Trapézio',
  dorsal: 'Grande dorsal e romboides',
  eretores: 'Eretores da espinha (lombar)',
  reto_abdominal: 'Reto abdominal',
  obliquos: 'Oblíquos',
  gluteo_maximo: 'Glúteo máximo',
  gluteo_medio: 'Glúteo médio (abdutores)',
  quadriceps: 'Quadríceps',
  isquiotibiais: 'Isquiotibiais (posteriores da coxa)',
  adutores: 'Adutores',
  panturrilha: 'Panturrilha (gastrocnêmio e sóleo)',
};

/** Regiões de cada grupo da biblioteca. */
export const MUSCLE_PARTS: Record<Exclude<LibraryMuscle, 'corpo_inteiro'>, MusclePart[]> = {
  peitoral: ['peitoral'],
  costas: ['dorsal'],
  ombros: ['deltoide'],
  biceps: ['biceps'],
  triceps: ['triceps'],
  antebraco: ['antebraco'],
  trapezio: ['trapezio'],
  lombar: ['eretores'],
  quadriceps: ['quadriceps'],
  posteriores: ['isquiotibiais'],
  gluteos: ['gluteo_maximo'],
  adutores: ['adutores'],
  abdutores: ['gluteo_medio'],
  panturrilhas: ['panturrilha'],
  abdomen: ['reto_abdominal', 'obliquos'],
};

export const ALL_PARTS = Object.keys(PART_LABEL) as MusclePart[];

export type Emphasis = 'primary' | 'secondary';

/** Destaque de cada região: principal vence secundário; `corpo_inteiro` acende tudo no nível pedido. */
export function emphasisFor(primary: readonly LibraryMuscle[], secondary: readonly LibraryMuscle[]): Map<MusclePart, Emphasis> {
  const out = new Map<MusclePart, Emphasis>();
  const partsOf = (m: LibraryMuscle) => (m === 'corpo_inteiro' ? ALL_PARTS : MUSCLE_PARTS[m]);
  for (const m of secondary) for (const p of partsOf(m)) out.set(p, 'secondary');
  for (const m of primary) for (const p of partsOf(m)) out.set(p, 'primary');
  return out;
}

/**
 * Forma de cada região no humanoide: elipsoide preso a um segmento (centro e raios no sistema local do segmento, em m).
 * Pares são espelhados no eixo X (`mirror`). Os valores seguem a anatomia de superfície: peitoral na frente do peito,
 * dorsal atrás e para fora, bíceps na frente do braço, tríceps atrás, quadríceps na frente da coxa etc.
 */
export interface PartShape {
  part: MusclePart;
  segment: Segment | `${'upperArm' | 'forearm' | 'thigh' | 'shin'}${Side}`;
  center: Vec3;
  radii: Vec3;
  /** Gira o elipsoide em torno do X local (graus), para acompanhar a fibra. */
  tilt?: number;
}

const both = (part: MusclePart, seg: 'upperArm' | 'forearm' | 'thigh' | 'shin', center: Vec3, radii: Vec3, medial = false): PartShape[] =>
  (['L', 'R'] as const).map((s) => {
    const k = s === 'L' ? 1 : -1;
    // No membro, X local já é espelhado pelo lado; o "medial" (para dentro) é −X no esquerdo e +X no direito.
    return { part, segment: `${seg}${s}`, center: [medial ? -k * Math.abs(center[0]) : center[0], center[1], center[2]], radii };
  });

const pair = (part: MusclePart, segment: Segment, center: Vec3, radii: Vec3, tilt?: number): PartShape[] =>
  [1, -1].map((k) => ({ part, segment, center: [k * center[0], center[1], center[2]], radii, ...(tilt ? { tilt } : {}) }));

export const PART_SHAPES: readonly PartShape[] = [
  ...pair('peitoral', 'chest', [0.085, 0.17, 0.095], [0.085, 0.07, 0.035]),
  ...pair('trapezio', 'chest', [0.07, 0.27, -0.05], [0.085, 0.06, 0.035], -20),
  ...pair('dorsal', 'chest', [0.1, 0.08, -0.085], [0.075, 0.13, 0.03]),
  ...pair('eretores', 'abdomen', [0.04, 0.1, -0.085], [0.035, 0.12, 0.03]),
  { part: 'reto_abdominal', segment: 'abdomen', center: [0, 0.11, 0.095], radii: [0.065, 0.13, 0.025] },
  ...pair('obliquos', 'abdomen', [0.115, 0.1, 0.035], [0.03, 0.1, 0.06]),
  ...pair('gluteo_maximo', 'pelvis', [0.07, -0.02, -0.085], [0.08, 0.085, 0.05]),
  ...pair('gluteo_medio', 'pelvis', [0.15, 0.03, -0.01], [0.04, 0.065, 0.06]),
  ...both('deltoide', 'upperArm', [0, -0.03, 0], [0.065, 0.075, 0.062]),
  ...both('biceps', 'upperArm', [0, -0.15, 0.03], [0.035, 0.09, 0.028]),
  ...both('triceps', 'upperArm', [0, -0.15, -0.032], [0.037, 0.1, 0.028]),
  ...both('antebraco', 'forearm', [0, -0.09, 0], [0.042, 0.09, 0.04]),
  ...both('quadriceps', 'thigh', [0, -0.21, 0.04], [0.06, 0.17, 0.042]),
  ...both('isquiotibiais', 'thigh', [0, -0.23, -0.04], [0.055, 0.16, 0.04]),
  ...both('adutores', 'thigh', [0.045, -0.13, 0], [0.03, 0.12, 0.045], true),
  ...both('panturrilha', 'shin', [0, -0.12, -0.035], [0.045, 0.1, 0.04]),
];

/** Regiões visíveis de frente e de costas (legenda e mapa 2D). */
export const FRONT_PARTS: readonly MusclePart[] = ['peitoral', 'deltoide', 'biceps', 'antebraco', 'reto_abdominal', 'obliquos', 'quadriceps', 'adutores', 'gluteo_medio'];
export const BACK_PARTS: readonly MusclePart[] = ['trapezio', 'deltoide', 'triceps', 'antebraco', 'dorsal', 'eretores', 'gluteo_maximo', 'gluteo_medio', 'isquiotibiais', 'panturrilha'];
