import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, reloadOnceForStaleChunk } from '@/lib/staleChunks';

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('Fase 07: arquivos de tela de uma versão antiga', () => {
  it('reconhece as mensagens de falha de chunk dos navegadores', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Week-abc.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('recarrega só uma vez por minuto (sem laço de recarga)', () => {
    const s = memStorage();
    const reload = vi.fn();
    expect(reloadOnceForStaleChunk(s, 1_000_000, reload)).toBe(true);
    expect(reloadOnceForStaleChunk(s, 1_030_000, reload)).toBe(false);
    expect(reloadOnceForStaleChunk(s, 1_070_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
