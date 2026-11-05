// Livros, capítulos e referências da Bíblia (IronTrack Life — Fase 05, docs/BIBLIA.md). Compartilhado entre a API e o app.
//
// A estrutura vem do ÍNDICE da tradução usada (shared/bible/data/bpm/index.ts, gerado do texto oficial): nada aqui
// presume um cânon. Hoje há uma tradução (BPM, 66 livros); outra tradução licenciada entraria com o próprio índice.
//
// Formatos de referência gravados no banco e trocados com a API (sempre com o id USFM de 3 caracteres do livro):
//   capítulo  "JHN.3"         passagem "JHN.3.16" | "JHN.3.16-18"        trecho de capítulos "JHN.3-JHN.5"
import { BPM_INDEX } from './data/bpm/index.ts';

export type BookId = (typeof BPM_INDEX.books)[number]['id'];
export type Testament = 'OT' | 'NT';

export interface BookInfo {
  id: BookId;
  name: string;
  long: string;
  abbrev: string;
  testament: Testament;
  /** Versículos por capítulo (índice 0 = capítulo 1). */
  verses: readonly number[];
  /** Palavras por capítulo (para estimar tempo de leitura e equilibrar planos). */
  words: readonly number[];
  chapters: number;
  /** Posição no cânon da tradução (0…). */
  order: number;
}

/** Tradução disponível. A licença foi conferida na fonte original (ver docs/BIBLIA.md §2). */
export const TRANSLATION = {
  id: 'BPM' as const,
  name: BPM_INDEX.name,
  short: 'BPM',
  language: BPM_INDEX.language,
  license: BPM_INDEX.license,
  licenseUrl: BPM_INDEX.licenseUrl,
  source: 'eBible.org',
  sourceUrl: 'https://ebible.org/porbrbsl/',
  downloadUrl: BPM_INDEX.source,
  sourceDate: BPM_INDEX.sourceDate,
  /** Crédito exibido junto de cada passagem (não exigido pela licença; mantido por transparência). */
  credit: 'Bíblia Portuguesa Mundial (BPM) · domínio público · eBible.org',
  /** Aviso da própria fonte: a tradução ainda está em revisão. */
  draftNotice: 'A fonte informa que esta tradução ainda está em revisão (rascunho).',
  canon: BPM_INDEX.canon,
  totals: BPM_INDEX.totals,
};
export const TRANSLATIONS = [TRANSLATION] as const;
export type TranslationId = (typeof TRANSLATIONS)[number]['id'];

export const BOOKS: readonly BookInfo[] = BPM_INDEX.books.map((b, order) => ({
  id: b.id,
  name: b.name,
  long: b.long,
  abbrev: b.abbrev,
  testament: b.testament,
  verses: b.verses,
  words: b.words,
  chapters: b.verses.length,
  order,
}));
const BY_ID = new Map<string, BookInfo>(BOOKS.map((b) => [b.id, b]));
export const BOOK_IDS = BOOKS.map((b) => b.id) as readonly BookId[];
export const bookById = (id: string | null | undefined): BookInfo | undefined => (id ? BY_ID.get(id.toUpperCase()) : undefined);
export const isBookId = (id: unknown): id is BookId => typeof id === 'string' && BY_ID.has(id);
export const verseCount = (b: string, c: number): number => bookById(b)?.verses[c - 1] ?? 0;
export const hasChapter = (b: string, c: number): boolean => Number.isInteger(c) && c >= 1 && c <= (bookById(b)?.chapters ?? 0);

// ------------------------------------------------------------------ ordem global dos capítulos

const CH_START: number[] = [];
{
  let n = 0;
  for (const b of BOOKS) {
    CH_START.push(n);
    n += b.chapters;
  }
}
export const TOTAL_CHAPTERS = BOOKS.reduce((s, b) => s + b.chapters, 0);

/** Posição do capítulo no cânon (0…TOTAL_CHAPTERS−1); −1 se não existe. */
export function chapterIndex(b: string, c: number): number {
  const book = bookById(b);
  if (!book || !hasChapter(book.id, c)) return -1;
  return CH_START[book.order] + c - 1;
}
export function chapterAt(i: number): ChapterRef | null {
  if (i < 0 || i >= TOTAL_CHAPTERS) return null;
  let lo = 0;
  let hi = BOOKS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (CH_START[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return { b: BOOKS[lo].id, c: i - CH_START[lo] + 1 };
}
export const nextChapter = (r: ChapterRef) => chapterAt(chapterIndex(r.b, r.c) + 1);
export const prevChapter = (r: ChapterRef) => chapterAt(chapterIndex(r.b, r.c) - 1);

/** Capítulos de `from` a `to` (inclusive, na ordem do cânon). Vazio se `to` vem antes. */
export function chaptersBetween(from: ChapterRef, to: ChapterRef, max = 1200): ChapterRef[] {
  const a = chapterIndex(from.b, from.c);
  const z = chapterIndex(to.b, to.c);
  if (a < 0 || z < a) return [];
  const out: ChapterRef[] = [];
  for (let i = a; i <= z && out.length < max; i++) out.push(chapterAt(i)!);
  return out;
}
export const bookChapters = (b: string): ChapterRef[] => {
  const book = bookById(b);
  return book ? Array.from({ length: book.chapters }, (_, i) => ({ b: book.id, c: i + 1 })) : [];
};
export const chapterWords = (r: ChapterRef): number => bookById(r.b)?.words[r.c - 1] ?? 0;

// ------------------------------------------------------------------ referências

export interface ChapterRef {
  b: BookId;
  c: number;
}
export interface PassageRef extends ChapterRef {
  /** Sem versículos = capítulo inteiro. */
  v1?: number;
  v2?: number;
}

export const chapterKey = (r: ChapterRef): string => `${r.b}.${r.c}`;
export function passageKey(r: PassageRef): string {
  if (!r.v1) return chapterKey(r);
  return r.v2 && r.v2 !== r.v1 ? `${r.b}.${r.c}.${r.v1}-${r.v2}` : `${r.b}.${r.c}.${r.v1}`;
}

/** Lê "JHN.3", "JHN.3.16", "JHN.3.16-18" (formato do banco/API). Valida contra o índice da tradução. */
export function parseKey(key: string | null | undefined): PassageRef | null {
  const m = /^([1-3A-Z]{3})\.(\d{1,3})(?:\.(\d{1,3})(?:-(\d{1,3}))?)?$/.exec(key ?? '');
  if (!m) return null;
  const b = bookById(m[1]);
  const c = Number(m[2]);
  if (!b || !hasChapter(b.id, c)) return null;
  if (!m[3]) return { b: b.id, c };
  const n = verseCount(b.id, c);
  const v1 = Number(m[3]);
  const v2 = m[4] ? Number(m[4]) : v1;
  if (v1 < 1 || v2 < v1 || v2 > n) return null;
  return v2 === v1 ? { b: b.id, c, v1 } : { b: b.id, c, v1, v2 };
}

/** Lê um trecho de capítulos "JHN.3-JHN.5" (ou um capítulo só). */
export function parseSpan(s: string | null | undefined): { from: ChapterRef; to: ChapterRef } | null {
  const [a, z] = (s ?? '').split('-');
  const from = parseKey(a);
  const to = z ? parseKey(z) : from;
  if (!from || !to || from.v1 || to.v1 || chapterIndex(to.b, to.c) < chapterIndex(from.b, from.c)) return null;
  return { from: { b: from.b, c: from.c }, to: { b: to.b, c: to.c } };
}
export const spanKey = (from: ChapterRef, to: ChapterRef) => (from.b === to.b && from.c === to.c ? chapterKey(from) : `${chapterKey(from)}-${chapterKey(to)}`);

/** "João 3", "João 3:16", "João 3:16–18". */
export function formatRef(r: PassageRef, o: { abbrev?: boolean } = {}): string {
  const b = bookById(r.b);
  const name = b ? (o.abbrev ? b.abbrev : b.name) : r.b;
  if (!r.v1) return `${name} ${r.c}`;
  return r.v2 && r.v2 !== r.v1 ? `${name} ${r.c}:${r.v1}–${r.v2}` : `${name} ${r.c}:${r.v1}`;
}
export const formatKey = (key: string) => {
  const r = parseKey(key);
  if (r) return formatRef(r);
  const s = parseSpan(key);
  return s ? formatSpan(s.from, s.to) : key;
};
/** "João 3–5", "João 21 – Atos 2". */
export function formatSpan(from: ChapterRef, to: ChapterRef): string {
  if (from.b === to.b) return from.c === to.c ? formatRef(from) : `${bookById(from.b)?.name ?? from.b} ${from.c}–${to.c}`;
  return `${formatRef(from)} – ${formatRef(to)}`;
}

// ------------------------------------------------------------------ leitura de referências digitadas ("João 3:16")

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[º°ª]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Nomes alternativos usados no Brasil (além do nome e da abreviatura da própria tradução). */
const ALIASES: Record<string, string[]> = {
  GEN: ['gen', 'genesis'],
  EXO: ['ex', 'exo', 'exodo'],
  LEV: ['lev', 'levitico'],
  NUM: ['num', 'numeros'],
  DEU: ['deut', 'deuteronomio'],
  JOS: ['js', 'josue'],
  JDG: ['jui', 'juizes'],
  RUT: ['rute'],
  PSA: ['salmo', 'salmos', 'sal', 'sls'],
  PRO: ['prov', 'proverbio', 'proverbios', 'pr'],
  ECC: ['ec', 'eclesiastes', 'coelet'],
  SNG: ['cantares', 'canticos', 'cantico dos canticos', 'cânticos', 'cant', 'cantares de salomao'],
  ISA: ['isa', 'isaias'],
  JER: ['jer', 'jeremias'],
  LAM: ['lam', 'lamentacoes', 'lamentacoes de jeremias'],
  EZK: ['eze', 'ezequiel'],
  DAN: ['dan', 'daniel'],
  HOS: ['os', 'oseias'],
  JOL: ['joel'],
  AMO: ['amos'],
  OBA: ['obadias', 'abdias', 'ab'],
  JON: ['jonas'],
  MIC: ['miq', 'miqueias'],
  NAM: ['naum'],
  HAB: ['hab', 'habacuque'],
  ZEP: ['sof', 'sofonias'],
  HAG: ['ageu'],
  ZEC: ['zac', 'zacarias'],
  MAL: ['mal', 'malaquias'],
  MAT: ['mat', 'mateus', 'mt'],
  MRK: ['mar', 'marcos', 'mc', 'mr'],
  LUK: ['luc', 'lucas', 'lc'],
  JHN: ['joao', 'jo'],
  ACT: ['atos', 'atos dos apostolos', 'at'],
  ROM: ['rom', 'romanos'],
  PHP: ['fil', 'filipenses', 'fl'],
  PHM: ['filemon', 'filemom', 'flm'],
  JAS: ['tiago', 'tg'],
  JUD: ['judas'],
  REV: ['apocalipse', 'ap', 'apoc', 'revelacao'],
};
const NAME_TO_ID = new Map<string, BookId>();
for (const b of BOOKS) {
  const keys = [b.name, b.abbrev, b.long, ...(ALIASES[b.id] ?? [])];
  for (const k of keys) {
    const n = normalize(k);
    NAME_TO_ID.set(n, b.id);
    NAME_TO_ID.set(n.replace(/\s/g, ''), b.id);
  }
}
// "Jn" é Jonas na tradução; "Jó" e "Jo" diferem só no acento: sem acento, "jo" = João (uso comum), "jó" já normalizado = "jo".
NAME_TO_ID.set('jo', 'JHN');
NAME_TO_ID.set('job', 'JOB');

/** Encontra o livro por um nome digitado ("1 Coríntios", "1co", "salmo", "jo"). */
export function findBook(name: string): BookInfo | undefined {
  const raw = name.trim();
  if (/^jó$/i.test(raw)) return bookById('JOB');
  const n = normalize(raw).replace(/^(i{1,3})\s/, (_m, r: string) => `${r.length} `).replace(/^([1-3])\s*(?=[a-z])/, '$1 ');
  const id = NAME_TO_ID.get(n) ?? NAME_TO_ID.get(n.replace(/\s/g, ''));
  return id ? bookById(id) : undefined;
}

export type ParsedQuery = { kind: 'ref'; ref: PassageRef } | { kind: 'book'; book: BookInfo } | { kind: 'invalid'; message: string } | { kind: 'text' };

/**
 * Interpreta o que a pessoa digitou: referência ("João 3:16", "Jo 3.16-18", "Salmo 23", "1Co 13"), só o livro
 * ("Provérbios") ou texto livre (busca por palavras). Referência a capítulo/versículo inexistente vira `invalid`.
 */
export function parseQuery(q: string): ParsedQuery {
  const s = q.trim().replace(/[–—]/g, '-');
  const m = /^((?:[1-3]|i{1,3})?\s*[^\d:.,-]+?)\s*(\d{1,3})(?:\s*[:.,]\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?$/i.exec(s);
  if (m) {
    const book = findBook(m[1]);
    if (book) {
      const c = Number(m[2]);
      if (!hasChapter(book.id, c)) return { kind: 'invalid', message: `${book.name} tem ${book.chapters} capítulo${book.chapters > 1 ? 's' : ''}.` };
      if (!m[3]) return { kind: 'ref', ref: { b: book.id, c } };
      const n = verseCount(book.id, c);
      const v1 = Number(m[3]);
      const v2 = m[4] ? Number(m[4]) : v1;
      if (v1 < 1 || v1 > n || v2 < v1) return { kind: 'invalid', message: `${book.name} ${c} tem ${n} versículos.` };
      return { kind: 'ref', ref: v2 > v1 ? { b: book.id, c, v1, v2: Math.min(v2, n) } : { b: book.id, c, v1 } };
    }
  }
  const book = findBook(s);
  if (book) return { kind: 'book', book };
  return { kind: 'text' };
}

// ------------------------------------------------------------------ texto (o formato dos arquivos gerados)

/** Versículo como está no arquivo: t = texto; p = começa parágrafo; q = poesia; o = omitido na tradução (n = nota). */
export interface VerseData {
  v: number;
  t: string;
  p?: 1;
  q?: 1;
  o?: 1;
  n?: string;
}
export interface BookData {
  id: BookId;
  c: VerseData[][];
  /** Títulos/cabeçalhos da própria tradução (ex.: títulos dos Salmos), antes do versículo `v`. */
  h?: { c: number; v: number; t: string }[];
}

/** Estimativa de leitura (≈ 180 palavras por minuto, leitura atenta). */
export const READING_WPM = 180;
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / READING_WPM));
