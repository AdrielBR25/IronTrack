// Regras puras da tela do assistente (P05).
import { describe, expect, it } from 'vitest';
import { MAX_QUESTION_CHARS, friendlyError, purposeFor, validateQuestion } from '@/features/assistant/assistantModel';
import { AIError } from '@/modules/ai';

describe('assistente: validação e regras puras', () => {
  it('mensagem vazia ou só com espaços é recusada', () => {
    expect(validateQuestion('')).toMatchObject({ ok: false });
    expect(validateQuestion('   \n\t ')).toMatchObject({ ok: false, error: expect.stringContaining('Escreva') });
  });

  it('limites de tamanho: até 2.000 caracteres (após aparar), acima é recusado', () => {
    expect(MAX_QUESTION_CHARS).toBe(2000);
    expect(validateQuestion(`  ${'a'.repeat(2000)}  `)).toEqual({ ok: true, text: 'a'.repeat(2000) });
    expect(validateQuestion('a'.repeat(2001))).toMatchObject({ ok: false, error: expect.stringContaining('2.000') });
  });

  it('finalidade derivada das categorias', () => {
    expect(purposeFor([])).toBe('general_question');
    expect(purposeFor(['training_history', 'training_summary'])).toBe('training_review');
    expect(purposeFor(['training_history', 'profile_preferences'])).toBe('training_review');
    expect(purposeFor(['body_measurements', 'body_evolution'])).toBe('body_review');
    expect(purposeFor(['body_measurements', 'training_history'])).toBe('general_question');
    expect(purposeFor(['profile_preferences'])).toBe('general_question');
  });

  it('erros: frase fixa, nunca a mensagem interna', () => {
    expect(friendlyError(new AIError('timeout')).message).toMatch(/demorou demais/);
    const e = friendlyError(new Error('stack interno com dado pessoal 80 kg'));
    expect(e.code).toBe('unknown');
    expect(e.message).not.toMatch(/80 kg|stack/);
  });
});
