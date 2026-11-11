// Seleção editorial de passagens para o "versículo do dia" (IronTrack Life — Fase 05, docs/BIBLIA.md §4).
//
// Regras da seleção (verificadas em tests/bible.test.ts contra o texto da tradução):
//  - só referências que existem na tradução usada; o texto exibido vem SEMPRE do arquivo da tradução (nada copiado aqui);
//  - passagens que formam um pensamento completo: começam com maiúscula/aspas e terminam em ponto final, exclamação,
//    interrogação ou fecho de aspas (nada de meia frase solta);
//  - quando o sentido depende do contexto, a passagem traz `context` (uma frase neutra sobre quem fala e para quem), e o
//    app sempre oferece "Abrir capítulo".
// Escolher a passagem do dia NÃO usa IA: é determinístico (ver dailyIndex).

export const VERSE_THEMES = ['sabedoria', 'coragem', 'gratidão', 'esperança', 'disciplina', 'perseverança', 'paz', 'amor', 'fé', 'força', 'descanso', 'amizade', 'trabalho'] as const;
export type VerseTheme = (typeof VERSE_THEMES)[number];

export interface CuratedPassage {
  ref: string;
  theme: VerseTheme;
  context?: string;
}

export const CURATED: readonly CuratedPassage[] = [
  // sabedoria
  { ref: 'PRO.3.5-6', theme: 'sabedoria' },
  { ref: 'PRO.2.6', theme: 'sabedoria' },
  { ref: 'JAS.1.5', theme: 'sabedoria' },
  { ref: 'PRO.4.7', theme: 'sabedoria' },
  { ref: 'PRO.9.10', theme: 'sabedoria' },
  { ref: 'PSA.90.12', theme: 'sabedoria' },
  { ref: 'PRO.1.7', theme: 'sabedoria' },
  { ref: 'PRO.15.1', theme: 'sabedoria' },
  { ref: 'PRO.19.20', theme: 'sabedoria' },
  { ref: 'PRO.4.23', theme: 'sabedoria' },
  { ref: 'PSA.119.105', theme: 'sabedoria' },
  { ref: 'MIC.6.8', theme: 'sabedoria', context: 'O profeta Miqueias fala ao povo de Israel sobre o que Deus espera.' },
  // coragem
  { ref: 'JOS.1.9', theme: 'coragem', context: 'Palavras dirigidas a Josué quando ele assume a liderança de Israel.' },
  { ref: 'ISA.41.10', theme: 'coragem', context: 'Promessa dirigida a Israel no livro de Isaías.' },
  { ref: 'DEU.31.6', theme: 'coragem', context: 'Moisés fala ao povo antes da entrada na terra prometida.' },
  { ref: 'PSA.27.1', theme: 'coragem' },
  { ref: '2TI.1.7', theme: 'coragem' },
  { ref: 'PSA.31.24', theme: 'coragem' },
  { ref: '1CO.16.13', theme: 'coragem' },
  { ref: '1JN.4.18', theme: 'coragem' },
  { ref: 'ISA.43.2', theme: 'coragem', context: 'Promessa dirigida a Israel no livro de Isaías.' },
  // gratidão
  { ref: '1TH.5.16-18', theme: 'gratidão' },
  { ref: 'PSA.100.4-5', theme: 'gratidão' },
  { ref: 'COL.3.15', theme: 'gratidão' },
  { ref: 'PSA.107.1', theme: 'gratidão' },
  { ref: 'PSA.118.24', theme: 'gratidão' },
  { ref: 'PSA.139.14', theme: 'gratidão' },
  { ref: 'HAB.3.17-18', theme: 'gratidão' },
  // esperança
  { ref: 'ROM.15.13', theme: 'esperança' },
  { ref: 'LAM.3.22-23', theme: 'esperança' },
  { ref: 'JER.29.11', theme: 'esperança', context: 'Carta de Jeremias aos israelitas exilados na Babilônia.' },
  { ref: 'ISA.40.31', theme: 'esperança' },
  { ref: 'PSA.42.11', theme: 'esperança' },
  { ref: 'PSA.62.5-6', theme: 'esperança' },
  { ref: 'ROM.8.28', theme: 'esperança' },
  { ref: 'PSA.30.5', theme: 'esperança' },
  { ref: 'PSA.126.5-6', theme: 'esperança' },
  { ref: 'HEB.11.1', theme: 'esperança' },
  // disciplina
  { ref: '1CO.9.25-27', theme: 'disciplina', context: 'Paulo compara a vida de fé ao treino de um atleta.' },
  { ref: 'HEB.12.11', theme: 'disciplina' },
  { ref: 'PRO.12.1', theme: 'disciplina' },
  { ref: '2TI.2.15', theme: 'disciplina' },
  { ref: 'PRO.13.4', theme: 'disciplina' },
  { ref: 'PRO.6.6-8', theme: 'disciplina' },
  { ref: 'PRO.21.5', theme: 'disciplina' },
  { ref: 'ROM.12.2', theme: 'disciplina' },
  { ref: '1TI.4.8', theme: 'disciplina' },
  // perseverança
  { ref: 'GAL.6.9', theme: 'perseverança' },
  { ref: 'JAS.1.12', theme: 'perseverança' },
  { ref: 'HEB.12.1-2', theme: 'perseverança' },
  { ref: 'PHP.3.13-14', theme: 'perseverança' },
  { ref: 'ROM.5.3-5', theme: 'perseverança' },
  { ref: 'JAS.1.2-4', theme: 'perseverança' },
  { ref: '1CO.15.58', theme: 'perseverança' },
  { ref: '2CO.4.16-18', theme: 'perseverança' },
  { ref: '2TH.3.13', theme: 'perseverança' },
  // paz
  { ref: 'PHP.4.6-7', theme: 'paz' },
  { ref: 'JHN.14.27', theme: 'paz', context: 'Jesus fala aos discípulos na véspera da crucificação.' },
  { ref: 'JHN.16.33', theme: 'paz', context: 'Jesus fala aos discípulos na véspera da crucificação.' },
  { ref: 'ISA.26.3', theme: 'paz' },
  { ref: 'PSA.4.8', theme: 'paz' },
  { ref: 'MAT.5.9', theme: 'paz' },
  { ref: 'ROM.12.18', theme: 'paz' },
  { ref: 'PSA.46.10', theme: 'paz' },
  // amor
  { ref: '1CO.13.4-7', theme: 'amor' },
  { ref: 'EPH.4.32', theme: 'amor' },
  { ref: 'ROM.8.38-39', theme: 'amor' },
  { ref: 'GAL.5.22-23', theme: 'amor' },
  { ref: 'GAL.6.2', theme: 'amor' },
  // fé
  { ref: 'PSA.23.1-3', theme: 'fé' },
  { ref: 'PSA.1.1-3', theme: 'fé' },
  { ref: 'MAT.6.33-34', theme: 'fé' },
  { ref: 'MAT.7.7-8', theme: 'fé' },
  { ref: 'JHN.15.5', theme: 'fé' },
  { ref: 'PRO.16.9', theme: 'fé' },
  { ref: 'PSA.16.8', theme: 'fé' },
  { ref: 'JAS.4.8', theme: 'fé' },
  { ref: 'HEB.4.16', theme: 'fé' },
  { ref: 'PSA.19.14', theme: 'fé' },
  // força
  { ref: 'PSA.46.1', theme: 'força' },
  { ref: 'PHP.4.11-13', theme: 'força', context: 'Paulo escreve da prisão sobre aprender a viver contente em qualquer situação.' },
  { ref: 'PSA.73.26', theme: 'força' },
  { ref: 'EPH.6.10', theme: 'força' },
  { ref: 'PSA.121.1-2', theme: 'força' },
  { ref: '1CO.10.13', theme: 'força' },
  { ref: 'NEH.8.10', theme: 'força', context: 'Neemias fala ao povo reunido depois da leitura pública da Lei.' },
  // descanso
  { ref: 'MAT.11.28-30', theme: 'descanso' },
  { ref: 'PSA.55.22', theme: 'descanso' },
  { ref: 'PSA.34.18', theme: 'descanso' },
  { ref: '1PE.5.6-7', theme: 'descanso' },
  // amizade
  { ref: 'PRO.17.17', theme: 'amizade' },
  { ref: 'PRO.27.17', theme: 'amizade' },
  { ref: 'ECC.4.9-10', theme: 'amizade' },
  { ref: '1TH.5.11', theme: 'amizade' },
  // trabalho
  { ref: 'COL.3.23-24', theme: 'trabalho' },
  { ref: 'ECC.9.10', theme: 'trabalho' },
  { ref: 'PRO.22.29', theme: 'trabalho' },
  { ref: 'PRO.16.3', theme: 'trabalho' },
  { ref: 'MAT.5.14-16', theme: 'trabalho' },
  { ref: 'PHP.4.8', theme: 'trabalho' },
];

export const passagesByTheme = (theme: VerseTheme) => CURATED.filter((p) => p.theme === theme);

/** Dias desde 1970-01-01 de uma data local yyyy-mm-dd. */
export const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Semente estável por conta (a mesma passagem não aparece no mesmo dia para todo mundo, e nunca muda ao recarregar). */
export function seedOf(userId: string): number {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Permutação estável da seleção para a conta (Fisher–Yates com gerador determinístico). */
export function orderFor(seed: number, n = CURATED.length): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  let s = seed || 1;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Posição na seleção da passagem do dia `date` (data LOCAL no fuso da conta) e da extra número `extra` (0 = principal).
 * Percorre a permutação da conta: nenhuma repetição antes de passar por toda a seleção. Extras do dia usam as próximas
 * posições a partir do fim da seleção ao contrário, para não "gastar" as passagens dos dias seguintes.
 */
export function dailyIndex(seed: number, date: string, extra = 0): number {
  const order = orderFor(seed);
  const n = order.length;
  const d = ((dayNumber(date) % n) + n) % n;
  if (extra === 0) return order[d];
  return order[(((d - extra * 7) % n) + n) % n];
}
