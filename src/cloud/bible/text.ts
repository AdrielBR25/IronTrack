// Texto bíblico no app (Fase 05, docs/BIBLIA.md §2). Os 66 livros da BPM (domínio público) vão no build como arquivos
// JSON separados (um por livro, fora do pacote principal e fora do pré-cache do PWA para não pesar a instalação).
// Cada livro baixado é conferido pelo SHA-256 do índice antes de ser usado e fica no cache do service worker: depois
// de aberto uma vez, lê sem conexão. "Baixar para ler offline" busca todos de uma vez.
import { useEffect, useState } from 'react';
import { BOOKS, bookById, type BookData } from '@shared/bible/canon.ts';
import { BPM_INDEX } from '@shared/bible/data/bpm/index.ts';

const URLS = import.meta.glob('../../../shared/bible/data/bpm/*.json', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const urlOf = (id: string) => Object.entries(URLS).find(([k]) => k.endsWith(`/${id}.json`))?.[1];

const cache = new Map<string, Promise<BookData>>();

async function sha256(text: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // contexto sem crypto (http local): o servidor confere do lado dele
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class BibleLoadError extends Error {}

export function loadBook(id: string): Promise<BookData> {
  const b = bookById(id);
  if (!b) return Promise.reject(new BibleLoadError('Livro inexistente.'));
  const hit = cache.get(b.id);
  if (hit) return hit;
  const p = (async () => {
    const url = urlOf(b.id);
    if (!url) throw new BibleLoadError('Arquivo do livro ausente neste build.');
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new BibleLoadError('Sem conexão e este livro ainda não foi baixado. Abra com internet uma vez ou use “Baixar para ler offline”.');
    }
    if (!res.ok) throw new BibleLoadError('Não foi possível abrir o livro.');
    const raw = await res.text();
    const got = await sha256(raw);
    if (got && got !== BPM_INDEX.books[b.order].sha256) throw new BibleLoadError('O arquivo deste livro não confere com a tradução. Atualize o app.');
    return JSON.parse(raw) as BookData;
  })();
  cache.set(b.id, p);
  p.catch(() => cache.delete(b.id));
  return p;
}

export function useBook(id: string | null): { data: BookData | null; error: string | null; loading: boolean } {
  const [s, setS] = useState<{ data: BookData | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!id });
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setS((x) => ({ data: x.data && x.data.id === id ? x.data : null, error: null, loading: true }));
    loadBook(id)
      .then((data) => alive && setS({ data, error: null, loading: false }))
      .catch((e: unknown) => alive && setS({ data: null, error: e instanceof Error ? e.message : 'Erro ao abrir.', loading: false }));
    return () => {
      alive = false;
    };
  }, [id]);
  return s;
}

/** Baixa todos os livros (ficam no cache do service worker). Devolve quantos deram certo. */
export async function downloadAll(onProgress?: (done: number, total: number) => void): Promise<number> {
  let done = 0;
  let okCount = 0;
  for (let i = 0; i < BOOKS.length; i += 6) {
    await Promise.all(
      BOOKS.slice(i, i + 6).map((b) =>
        loadBook(b.id)
          .then(() => okCount++)
          .catch(() => undefined)
          .finally(() => onProgress?.(++done, BOOKS.length)),
      ),
    );
  }
  return okCount;
}

/** Quantos livros já estão no cache do aparelho (Cache Storage do service worker). */
export async function cachedBooks(): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  try {
    const c = await caches.open(BIBLE_CACHE);
    const keys = await c.keys();
    return keys.length;
  } catch {
    return 0;
  }
}
export const BIBLE_CACHE = 'irontrack-bible-bpm';
