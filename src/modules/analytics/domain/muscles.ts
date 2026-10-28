// Normalização analítica de grupos musculares (IronTrack 2.0 F01/P09). Ver docs/ANALYTICS_TREINAMENTO.md.
// Só leitura: o texto da ficha continua como foi digitado no banco; aqui ele é apenas comparado com uma
// tabela fixa de sinônimos. Nada é adivinhado: textos desconhecidos ficam como estão, e textos que citam
// mais de um grupo ou uma região ampla ("Pernas", "Peito e tríceps") não são forçados para um grupo.

export type MuscleGroupId =
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
  | 'abdomen';

/**
 * `canonico`: sinônimo reconhecido. `nao_reconhecido`: texto fora da tabela (mantido como está).
 * `ambiguo`: região ampla ou mais de um grupo no mesmo texto (não é atribuído a nenhum grupo). `vazio`: sem texto.
 */
export type MuscleMatch = 'canonico' | 'nao_reconhecido' | 'ambiguo' | 'vazio';

export interface NormalizedMuscle {
  /** Texto original da ficha, sem alteração. */
  original: string;
  /** Chave de agrupamento: id canônico, ou o texto dobrado para os não reconhecidos/ambíguos; null quando vazio. */
  key: string | null;
  /** Nome exibido: o canônico, ou o texto original sem espaços extras. */
  label: string;
  id: MuscleGroupId | null;
  match: MuscleMatch;
}

export const MUSCLE_LABEL: Record<MuscleGroupId, string> = {
  peitoral: 'Peitoral',
  costas: 'Costas',
  ombros: 'Ombros',
  biceps: 'Bíceps',
  triceps: 'Tríceps',
  antebraco: 'Antebraço',
  trapezio: 'Trapézio',
  lombar: 'Lombar',
  quadriceps: 'Quadríceps',
  posteriores: 'Posteriores de coxa',
  gluteos: 'Glúteos',
  adutores: 'Adutores',
  abdutores: 'Abdutores',
  panturrilhas: 'Panturrilhas',
  abdomen: 'Abdômen',
};

/**
 * Sinônimos já dobrados (minúsculas, sem acentos, espaços simples). Revisados contra os grupos padrão do app
 * (lib/defaults: Peito, Costas, Ombros, Bíceps, Tríceps, Antebraço, Quadríceps, Posterior de coxa, Glúteos,
 * Panturrilha, Abdômen, Trapézio), a ficha de exemplo e os termos citados no Prompt 09. Inclui nomes em
 * inglês comuns em fichas importadas.
 */
const SYNONYMS: Record<MuscleGroupId, readonly string[]> = {
  peitoral: ['peito', 'peitoral', 'peitorais', 'peitoral maior', 'chest', 'pecs'],
  costas: ['costas', 'dorsal', 'dorsais', 'grande dorsal', 'latissimo', 'latissimo do dorso', 'back', 'lats'],
  ombros: ['ombro', 'ombros', 'deltoide', 'deltoides', 'deltoide anterior', 'deltoide lateral', 'deltoide posterior', 'shoulders', 'shoulder', 'delts'],
  biceps: ['biceps', 'biceps braquial'],
  triceps: ['triceps', 'triceps braquial'],
  antebraco: ['antebraco', 'antebracos', 'forearm', 'forearms'],
  trapezio: ['trapezio', 'trapezios', 'traps'],
  lombar: ['lombar', 'lombares', 'eretores', 'eretores da espinha', 'lower back'],
  quadriceps: ['quadriceps', 'quadricipes', 'quads'],
  posteriores: ['posterior', 'posteriores', 'posterior de coxa', 'posteriores de coxa', 'posterior da coxa', 'isquiotibiais', 'isquiotibial', 'hamstrings', 'hamstring'],
  gluteos: ['gluteo', 'gluteos', 'gluteo maximo', 'glutes', 'glute'],
  adutores: ['adutor', 'adutores', 'adductors'],
  abdutores: ['abdutor', 'abdutores', 'abductors'],
  panturrilhas: ['panturrilha', 'panturrilhas', 'gastrocnemio', 'soleo', 'calves', 'calf'],
  abdomen: ['abdomen', 'abdominal', 'abdominais', 'abs', 'reto abdominal'],
};

/**
 * Regiões amplas ou termos que não apontam um grupo só. Ficam fora da distribuição por grupo (não são
 * divididos nem atribuídos a um grupo por palpite).
 */
const AMBIGUOUS = new Set([
  'perna', 'pernas', 'coxa', 'coxas', 'membros inferiores', 'inferiores', 'inferior',
  'braco', 'bracos', 'membros superiores', 'superiores', 'superior',
  'core', 'tronco', 'corpo inteiro', 'corpo todo', 'full body', 'fullbody', 'geral', 'outro', 'outros',
  'legs', 'arms', 'upper', 'lower',
]);

/** Separadores que indicam mais de um grupo no mesmo texto ("Peito e tríceps", "Costas/Bíceps"). */
const MULTI = /\s(?:e|and)\s|[/,;+&]/;

const LOOKUP: ReadonlyMap<string, MuscleGroupId> = new Map(
  (Object.entries(SYNONYMS) as [MuscleGroupId, readonly string[]][]).flatMap(([id, words]) => words.map((w) => [w, id] as const)),
);

/** Minúsculas, sem acentos, sem pontuação nas pontas e com espaços simples. Determinístico. */
export function foldMuscleText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .trim()
    .replace(/^[.\-_:]+|[.\-_:]+$/g, '')
    .trim();
}

export function normalizeMuscleGroup(raw: string | null | undefined): NormalizedMuscle {
  const original = typeof raw === 'string' ? raw : '';
  const tidy = original.replace(/[\s ]+/g, ' ').trim();
  const folded = foldMuscleText(original);
  if (!folded) return { original, key: null, label: '', id: null, match: 'vazio' };
  const id = LOOKUP.get(folded);
  if (id) return { original, key: id, label: MUSCLE_LABEL[id], id, match: 'canonico' };
  const match: MuscleMatch = AMBIGUOUS.has(folded) || MULTI.test(folded) ? 'ambiguo' : 'nao_reconhecido';
  // Prefixo evita colisão com um id canônico; variações só de caixa/acentos/espaços se juntam.
  return { original, key: `texto:${folded}`, label: tidy, id: null, match };
}

/** Memoiza a normalização dentro de uma montagem de índice (cada texto distinto é dobrado uma vez). */
export function createMuscleNormalizer(): (raw: string | null | undefined) => NormalizedMuscle {
  const cache = new Map<string, NormalizedMuscle>();
  return (raw) => {
    const k = typeof raw === 'string' ? raw : '';
    let v = cache.get(k);
    if (!v) cache.set(k, (v = normalizeMuscleGroup(k)));
    return v;
  };
}
