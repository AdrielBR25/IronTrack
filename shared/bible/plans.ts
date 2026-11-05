// Planos de leitura bíblica (IronTrack Life — Fase 05, docs/BIBLIA.md §5). Funções PURAS: o servidor gera e grava o
// cronograma do plano na criação (uma lista de dias, cada dia com os capítulos), e o app usa as mesmas funções para a
// prévia. Os planos são montados a partir dos livros e capítulos que EXISTEM na tradução (canon.ts), sem presumir cânon.
//
// Progresso não depende do calendário: o "dia do plano" é o primeiro ainda não concluído. Pausar ou atrasar nunca apaga
// o histórico; reorganizar redistribui só o que falta.
import { BOOKS, bookChapters, chapterKey, chapterWords, chaptersBetween, parseKey, READING_WPM, type ChapterRef } from './canon.ts';

export const PLAN_TEMPLATES = ['knowing', 'gospels', 'psalms', 'proverbs', 'daily15', 'd30', 'd90', 'whole'] as const;
export type PlanTemplate = (typeof PLAN_TEMPLATES)[number];

export interface TemplateInfo {
  id: PlanTemplate;
  title: string;
  description: string;
  /** Duração padrão (dias). */
  days: number;
}

/** Seleção editorial de capítulos para quem está começando (visão geral da narrativa bíblica). */
export const KNOWING_CHAPTERS: readonly string[] = [
  'GEN.1', 'GEN.2', 'GEN.3', 'GEN.12', 'GEN.22', 'EXO.3', 'EXO.14', 'EXO.20', 'DEU.6', 'JOS.1',
  'RUT.1', '1SA.16', '1SA.17', '2SA.7', '1KI.18', 'PSA.1', 'PSA.23', 'PSA.51', 'PSA.103', 'PRO.3',
  'ECC.3', 'ISA.40', 'ISA.53', 'JER.31', 'DAN.6', 'JON.1', 'JON.2', 'JON.3', 'JON.4', 'MIC.6',
  'MAT.5', 'MAT.6', 'MAT.7', 'MRK.4', 'LUK.15', 'JHN.1', 'JHN.3', 'JHN.11', 'JHN.20', 'ACT.2',
  'ACT.9', 'ROM.5', 'ROM.8', 'ROM.12', '1CO.13', '1CO.15', 'GAL.5', 'EPH.2', 'PHP.4', 'COL.3',
  'HEB.11', 'HEB.12', 'JAS.1', '1PE.1', '1JN.4', 'REV.21', 'REV.22',
];

export const TEMPLATES: Record<PlanTemplate, TemplateInfo> = {
  knowing: { id: 'knowing', title: 'Conhecendo a Bíblia', description: 'Uma visão geral em capítulos-chave: criação, patriarcas, êxodo, reis, profetas, Evangelhos, igreja e cartas.', days: 30 },
  gospels: { id: 'gospels', title: 'Evangelhos', description: 'Mateus, Marcos, Lucas e João, cerca de dois capítulos por dia.', days: 45 },
  psalms: { id: 'psalms', title: 'Salmos', description: 'Os 150 salmos em um mês, cerca de cinco por dia.', days: 30 },
  proverbs: { id: 'proverbs', title: 'Provérbios', description: 'Um capítulo de Provérbios por dia.', days: 31 },
  daily15: { id: 'daily15', title: 'Leitura diária de 15 minutos', description: 'O Novo Testamento em porções de cerca de 15 minutos (estimativa pelo número de palavras).', days: 0 },
  d30: { id: 'd30', title: 'Plano de 30 dias', description: 'Lucas e Atos em 30 dias: a vida de Jesus e o começo da igreja, na sequência do mesmo autor.', days: 30 },
  d90: { id: 'd90', title: 'Plano de 90 dias', description: 'O Novo Testamento completo em 90 dias, cerca de três capítulos por dia.', days: 90 },
  whole: { id: 'whole', title: 'Bíblia completa', description: 'Todos os livros da tradução, na ordem dela, em um ano (cerca de 3 a 4 capítulos por dia).', days: 365 },
};

const range = (a: string, z: string) => chaptersBetween(parseKey(a)!, parseKey(z)!);
const books = (...ids: string[]) => ids.flatMap((b) => bookChapters(b));

/** Capítulos de um modelo (na ordem de leitura). */
export function templateChapters(t: PlanTemplate): ChapterRef[] {
  switch (t) {
    case 'knowing':
      return KNOWING_CHAPTERS.map((k) => parseKey(k)!).map((r) => ({ b: r.b, c: r.c }));
    case 'gospels':
      return books('MAT', 'MRK', 'LUK', 'JHN');
    case 'psalms':
      return books('PSA');
    case 'proverbs':
      return books('PRO');
    case 'd30':
      return books('LUK', 'ACT');
    case 'daily15':
    case 'd90':
      return range('MAT.1', `REV.${BOOKS[BOOKS.length - 1].chapters}`);
    case 'whole':
      return BOOKS.flatMap((b) => bookChapters(b.id));
  }
}

/**
 * Distribui os capítulos em `days` dias equilibrando o tempo de leitura (palavras) e mantendo a ordem. Cada dia tem pelo
 * menos um capítulo; com mais dias do que capítulos, usa um capítulo por dia.
 */
export function distribute(chapters: ChapterRef[], days: number): ChapterRef[][] {
  const n = chapters.length;
  if (!n) return [];
  const d = Math.max(1, Math.min(days, n));
  const w = chapters.map((c) => Math.max(1, chapterWords(c)));
  const total = w.reduce((a, b) => a + b, 0);
  const out: ChapterRef[][] = [];
  let i = 0;
  let acc = 0;
  for (let day = 0; day < d; day++) {
    const left = d - day;
    const target = ((total - acc) / left) * 1;
    const cur: ChapterRef[] = [];
    let sum = 0;
    // Pega capítulos até chegar perto da meta do dia, deixando pelo menos um capítulo para cada dia restante.
    while (i < n - (left - 1)) {
      const next = w[i];
      if (cur.length && sum + next / 2 > target) break;
      cur.push(chapters[i]);
      sum += next;
      i++;
    }
    acc += sum;
    out.push(cur);
  }
  // Sobra (arredondamento) vai para o último dia.
  while (i < n) out[out.length - 1].push(chapters[i++]);
  return out;
}

/** Porções de ~`minutes` minutos (estimativa pelas palavras). */
export function byMinutes(chapters: ChapterRef[], minutes: number): ChapterRef[][] {
  const budget = minutes * READING_WPM;
  const out: ChapterRef[][] = [];
  let cur: ChapterRef[] = [];
  let sum = 0;
  for (const c of chapters) {
    const w = chapterWords(c);
    if (cur.length && sum + w / 2 > budget) {
      out.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(c);
    sum += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type PlanSchedule = string[][];

/** Cronograma de um modelo (chaves "JHN.3"). `days` opcional muda a duração (quando o modelo permite). */
export function templateSchedule(t: PlanTemplate, days?: number | null): PlanSchedule {
  const ch = templateChapters(t);
  const parts = t === 'daily15' ? byMinutes(ch, days && days > 0 && days <= 60 ? days : 15) : t === 'proverbs' && !days ? ch.map((c) => [c]) : distribute(ch, days || TEMPLATES[t].days);
  return parts.map((d) => d.map(chapterKey));
}

/** Plano personalizado: trecho de capítulos (ou livros inteiros, na ordem pedida) em `days` dias ou `perDay` capítulos por dia. */
export function customSchedule(chapters: ChapterRef[], o: { days?: number | null; perDay?: number | null }): PlanSchedule {
  if (o.perDay) {
    const out: string[][] = [];
    for (let i = 0; i < chapters.length; i += o.perDay) out.push(chapters.slice(i, i + o.perDay).map(chapterKey));
    return out;
  }
  return distribute(chapters, o.days ?? Math.ceil(chapters.length / 2)).map((d) => d.map(chapterKey));
}

/**
 * Reorganiza: mantém os dias concluídos (na ordem) e redistribui os capítulos dos dias que faltam em `remainingDays` dias.
 * Devolve o novo cronograma e o mapa índice antigo → novo dos dias concluídos (o histórico continua valendo).
 */
export function reschedule(schedule: PlanSchedule, completed: Set<number>, remainingDays: number): { schedule: PlanSchedule; moved: Map<number, number> } {
  const done: { old: number; day: string[] }[] = [];
  const rest: ChapterRef[] = [];
  schedule.forEach((day, i) => {
    if (completed.has(i)) done.push({ old: i, day });
    else for (const k of day) rest.push(parseKey(k) as ChapterRef);
  });
  const moved = new Map<number, number>();
  done.forEach((d, i) => moved.set(d.old, i));
  const next = [...done.map((d) => d.day), ...distribute(rest, Math.max(1, remainingDays)).map((d) => d.map(chapterKey))];
  return { schedule: next, moved };
}

export const scheduleChapters = (s: PlanSchedule) => s.reduce((n, d) => n + d.length, 0);
export const dayMinutes = (day: string[]) => Math.max(1, Math.round(day.reduce((n, k) => n + chapterWords(parseKey(k) as ChapterRef), 0) / READING_WPM));
