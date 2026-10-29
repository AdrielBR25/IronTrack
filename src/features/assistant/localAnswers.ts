// Respostas locais do assistente (IronTrack 2.0 F01/P20, docs/IA_ASSISTENTE.md §local). Perguntas sobre a execução,
// os músculos, os erros comuns ou os cuidados de um exercício do CATÁLOGO são respondidas com o próprio catálogo, no
// aparelho: nada é enviado a nenhuma IA e a resposta é a mesma orientação geral e conservadora da biblioteca. Puro.
import { foldText } from '@/modules/exercises';

export interface LocalExercise {
  name: string;
  aliases: readonly string[];
  primary: readonly string[];
  secondary: readonly string[];
  equipment: readonly string[];
  instructions: readonly string[];
  commonMistakes: readonly string[];
  safetyNotes: readonly string[];
}

/** Exercício do catálogo citado na pergunta (o nome ou apelido mais longo que aparece inteiro). */
export function findExercise(question: string, list: readonly LocalExercise[]): LocalExercise | null {
  const q = ` ${foldText(question)} `;
  let best: { ex: LocalExercise; len: number } | null = null;
  for (const ex of list)
    for (const n of [ex.name, ...ex.aliases]) {
      const f = foldText(n);
      if (f.length >= 4 && q.includes(` ${f} `) && (!best || f.length > best.len)) best = { ex, len: f.length };
    }
  return best?.ex ?? null;
}

export type LocalTopic = 'execucao' | 'musculos' | 'erros' | 'cuidados' | 'geral';

export function topicOf(question: string): LocalTopic {
  const q = foldText(question);
  if (/\b(musculo|musculos|trabalha|ativa|grupo)/.test(q)) return 'musculos';
  if (/\berro/.test(q)) return 'erros';
  if (/\b(cuidado|seguranc|seguro|dor|lesao)/.test(q)) return 'cuidados';
  if (/\b(como|execut|fazer|faco|tecnica|postura|forma)/.test(q)) return 'execucao';
  return 'geral';
}

const list = (items: readonly string[]) => items.map((t, i) => `${i + 1}. ${t}`).join('\n');

/** Texto da resposta local (null quando o catálogo não tem o que responder). */
export function localAnswer(question: string, exercises: readonly LocalExercise[]): { exercise: string; text: string } | null {
  const ex = findExercise(question, exercises);
  if (!ex) return null;
  const topic = topicOf(question);
  const muscles = `Principais: ${ex.primary.join(', ')}${ex.secondary.length ? `. Secundários: ${ex.secondary.join(', ')}` : ''}.`;
  const parts: string[] = [];
  if (topic === 'musculos') parts.push(muscles);
  else if (topic === 'erros') parts.push(ex.commonMistakes.length ? `Erros comuns:\n${list(ex.commonMistakes)}` : 'O catálogo não lista erros comuns para este exercício.');
  else if (topic === 'cuidados') parts.push(ex.safetyNotes.length ? `Cuidados:\n${list(ex.safetyNotes)}` : 'O catálogo não lista cuidados específicos para este exercício.');
  else parts.push(`Como executar:\n${list(ex.instructions)}`, muscles);
  if (topic === 'execucao' && ex.commonMistakes.length) parts.push(`Evite: ${ex.commonMistakes.join(' ')}`);
  parts.push('Fonte: catálogo do IronTrack, no aparelho (nada foi enviado). Orientação geral; não substitui um profissional.');
  return { exercise: ex.name, text: `${ex.name}\n\n${parts.join('\n\n')}` };
}
