// Texto bíblico no servidor (Fase 05, docs/BIBLIA.md §2). Lê os MESMOS arquivos empacotados com o app
// (shared/bible/data/bpm/*.json, gerados de eBible.org por scripts/build-bible.py) e confere o SHA-256 de cada livro
// contra o índice antes de usar: se um arquivo foi alterado, o livro não é servido (nada de texto adulterado ou parcial).
// Usado pela busca por palavras, pelo versículo do dia e pelas ferramentas da IA. Nunca gera nem completa versículos.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BOOKS, TRANSLATION, bookById, formatRef, hasChapter, normalize, parseKey, passageKey, verseCount, type BookData, type BookInfo, type PassageRef } from '../../../../shared/bible/canon.ts';
import { BPM_INDEX } from '../../../../shared/bible/data/bpm/index.ts';
import type { PassageVerse, PassageView } from '../../../../shared/bible/protocol.ts';

const cache = new Map<string, BookData>();

export class BibleTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BibleTextError';
  }
}

/** Livro inteiro (com conferência de integridade na primeira leitura). */
export function loadBook(id: string): BookData {
  const book = bookById(id);
  if (!book) throw new BibleTextError(`livro inexistente: ${id}`);
  const hit = cache.get(book.id);
  if (hit) return hit;
  const raw = readFileSync(new URL(`../../../../shared/bible/data/bpm/${book.id}.json`, import.meta.url), 'utf8');
  const expected = BPM_INDEX.books[book.order].sha256;
  const got = createHash('sha256').update(raw, 'utf8').digest('hex');
  if (got !== expected) throw new BibleTextError(`arquivo da tradução alterado: ${book.id}`);
  const data = JSON.parse(raw) as BookData;
  cache.set(book.id, data);
  return data;
}

const verseOut = (v: BookData['c'][number][number]): PassageVerse => (v.o ? { v: v.v, text: '', omitted: true, ...(v.n ? { note: v.n } : {}) } : { v: v.v, text: v.t });

/** Passagem com texto real. `maxVerses` corta passagens longas (a IA nunca recebe livros inteiros). */
export function passage(r: PassageRef, maxVerses = 60): PassageView & { truncated: boolean } {
  if (!hasChapter(r.b, r.c)) throw new BibleTextError('capítulo inexistente');
  const ch = loadBook(r.b).c[r.c - 1];
  const v1 = r.v1 ?? 1;
  const v2 = Math.min(r.v2 ?? (r.v1 ? r.v1 : ch.length), ch.length);
  const slice = ch.slice(v1 - 1, v2);
  const truncated = slice.length > maxVerses;
  const verses = slice.slice(0, maxVerses).map(verseOut);
  const shown: PassageRef = r.v1 || truncated ? { b: r.b, c: r.c, v1, v2: truncated ? v1 + maxVerses - 1 : v2 } : { b: r.b, c: r.c };
  return { ref: passageKey(shown), label: formatRef(shown), translation: TRANSLATION.short, verses, truncated };
}

export const passageByKey = (key: string, maxVerses?: number) => {
  const r = parseKey(key);
  if (!r) throw new BibleTextError('referência inválida');
  return passage(r, maxVerses);
};

/** Texto corrido de uma passagem (favoritos, versículo do dia). */
export const passageText = (key: string) =>
  passageByKey(key)
    .verses.filter((v) => !v.omitted)
    .map((v) => v.text)
    .join(' ');

export interface SearchHit {
  ref: string;
  label: string;
  text: string;
}

/**
 * Busca por palavras (todas precisam aparecer no versículo; sem acento/caixa). Opcional: só um livro ou testamento.
 * Devolve no máximo `limit` versículos, na ordem do cânon, e o total encontrado.
 */
export function search(q: string, o: { limit?: number; book?: string | null; testament?: 'OT' | 'NT' | null } = {}): { total: number; hits: SearchHit[] } {
  const terms = normalize(q)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(' ')
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (!terms.length) return { total: 0, hits: [] };
  const limit = Math.min(200, Math.max(1, o.limit ?? 50));
  const books: BookInfo[] = o.book ? [bookById(o.book)!].filter(Boolean) : BOOKS.filter((b) => !o.testament || b.testament === o.testament);
  const hits: SearchHit[] = [];
  let total = 0;
  const re = terms.map((t) => new RegExp(`(^|[^\\p{L}])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
  for (const b of books) {
    const data = loadBook(b.id);
    data.c.forEach((ch, ci) => {
      for (const v of ch) {
        if (v.o) continue;
        const n = normalize(v.t);
        if (!re.every((r) => r.test(n))) continue;
        total++;
        if (hits.length < limit) hits.push({ ref: `${b.id}.${ci + 1}.${v.v}`, label: formatRef({ b: b.id, c: ci + 1, v1: v.v }), text: v.t });
      }
    });
  }
  return { total, hits };
}

/** Confere todos os livros (usado no teste de integridade e no diagnóstico). */
export function verifyAll(): { books: number; chapters: number; verses: number } {
  let chapters = 0;
  let verses = 0;
  for (const b of BOOKS) {
    const d = loadBook(b.id);
    if (d.c.length !== b.chapters) throw new BibleTextError(`${b.id}: capítulos não batem com o índice`);
    d.c.forEach((ch, i) => {
      if (ch.length !== verseCount(b.id, i + 1)) throw new BibleTextError(`${b.id} ${i + 1}: versículos não batem com o índice`);
      ch.forEach((v, j) => {
        if (v.v !== j + 1) throw new BibleTextError(`${b.id} ${i + 1}: numeração fora de ordem`);
        if (!v.o && !v.t) throw new BibleTextError(`${b.id} ${i + 1}:${v.v}: versículo vazio`);
      });
      chapters++;
      verses += ch.length;
    });
  }
  return { books: BOOKS.length, chapters, verses };
}
