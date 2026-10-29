import type { z } from 'zod';

// Validação compartilhada pelos formatos JSON do app (ficha, avaliações, backup).
// Sem regras de domínio: cada formato informa seus próprios rótulos de caminho.

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseJsonText(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, errors: [`JSON inválido: ${(e as Error).message}`] };
  }
}

/**
 * Caminho legível de um problema: segmentos unidos por " › ". Um segmento com rótulo
 * seguido de índice vira "Rótulo N" (base 1); ex.: { treinos: 'Treino' } → "Treino 2".
 */
function pathToText(path: (string | number)[], labels: Record<string, string>): string {
  const out: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const next = path[i + 1];
    if (typeof p === 'string' && typeof next === 'number' && Object.prototype.hasOwnProperty.call(labels, p)) {
      out.push(`${labels[p]} ${next + 1}`);
      i++;
    } else out.push(String(p));
  }
  return out.join(' › ');
}

/** Até 12 mensagens no formato "caminho: mensagem". */
export function formatZodError(err: z.ZodError, pathLabels: Record<string, string> = {}): string[] {
  return err.issues.slice(0, 12).map((i) => {
    const where = pathToText(i.path, pathLabels);
    return where ? `${where}: ${i.message}` : i.message;
  });
}
