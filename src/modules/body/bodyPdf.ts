import type { BodyEntry } from './types';
import { uid } from '@/lib/utils';

// Leitura do "Relatório Comparativo Antropométrico" (PDF exportado pelo Dietbox e
// semelhantes). A extração de texto (pdf.js) é separada da interpretação: aqui
// recebemos os trechos de texto com suas posições e montamos a tabela
// data × medida a partir das coordenadas, ignorando as diferenças "(+1,23)".

export interface TextItem {
  str: string;
  /** canto inferior esquerdo, em pontos (origem embaixo, como no PDF) */
  x: number;
  y: number;
  w: number;
}

export interface ParsedEvaluation {
  date: string; // yyyy-mm-dd
  values: Partial<Record<BodyNumericKey, number>>;
  skinfolds: Record<string, number>;
  circumferences: Record<string, number>;
}

export type BodyNumericKey =
  | 'heightM'
  | 'weightKg'
  | 'bmi'
  | 'fatMassKg'
  | 'bodyFatPct'
  | 'leanMassKg'
  | 'leanPct'
  | 'waistHipRatio'
  | 'bodyDensity'
  | 'skinfoldSumMm'
  | 'armMuscleArea'
  | 'armFatArea'
  | 'waistCm'
  | 'abdomenCm'
  | 'hipCm'
  | 'thighCm'
  | 'armCm';

export type PdfParseResult = { ok: true; patient?: string; evaluations: ParsedEvaluation[] } | { ok: false; error: string };

function norm(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENERAL: [RegExp, BodyNumericKey][] = [
  [/^altura/, 'heightM'],
  [/^peso/, 'weightKg'],
  [/^imc/, 'bmi'],
  [/^% ?massa gorda|^percentual de gordura|^% ?gordura/, 'bodyFatPct'],
  [/^massa gorda/, 'fatMassKg'],
  [/^% ?massa magra/, 'leanPct'],
  [/^massa magra/, 'leanMassKg'],
  [/^razao cintura/, 'waistHipRatio'],
  [/^densidade/, 'bodyDensity'],
  [/^soma de dobras/, 'skinfoldSumMm'],
  [/^area muscular do braco/, 'armMuscleArea'],
  [/^area de gordura do braco/, 'armFatArea'],
];

const CIRC: [RegExp, BodyNumericKey][] = [
  [/^cintura/, 'waistCm'],
  [/^abdom/, 'abdomenCm'],
  [/^quadril/, 'hipCm'],
  [/^coxa( direita)?$|^coxa medial|^coxa proximal/, 'thighCm'],
  [/^braco( relaxado)?( direito)?$/, 'armCm'],
];

const NUM = /^[-+]?\d{1,4}(?:[.,]\d+)?\s*(?:kg|cm|mm|m|%)?$/i;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function toNumber(s: string): number | null {
  const m = /^([-+]?\d{1,4}(?:[.,]\d+)?)/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function clean(s: string) {
  return s.replace(/\s+/g, ' ').trim();
}

export function parseAnthropometricItems(raw: TextItem[]): PdfParseResult {
  const items = raw.map((i) => ({ ...i, str: clean(i.str) })).filter((i) => i.str);
  const dateItems = items.filter((i) => DATE.test(i.str));
  if (!dateItems.length) return { ok: false, error: 'Não encontrei as datas das avaliações neste PDF.' };

  // Linha de cabeçalho: a linha com mais datas.
  const rowsByY = new Map<number, typeof dateItems>();
  for (const d of dateItems) {
    const key = [...rowsByY.keys()].find((y) => Math.abs(y - d.y) < 3) ?? d.y;
    rowsByY.set(key, [...(rowsByY.get(key) ?? []), d]);
  }
  const header = [...rowsByY.values()].sort((a, b) => b.length - a.length)[0].sort((a, b) => a.x - b.x);
  const headerY = header[0].y;
  const columns = header.map((d) => {
    const [, dd, mm, yyyy] = DATE.exec(d.str)!;
    return { date: `${yyyy}-${mm}-${dd}`, cx: d.x + d.w / 2 };
  });
  const spacing = columns.length > 1 ? Math.min(...columns.slice(1).map((c, i) => c.cx - columns[i].cx)) : 80;
  const labelMaxX = columns[0].cx - spacing * 0.45;
  const tolerance = Math.min(30, spacing * 0.3);

  const below = items.filter((i) => i.y < headerY - 2);
  const isDelta = (i: (typeof items)[number]) =>
    i.str.startsWith('(') || i.str.endsWith(')') || below.some((p) => /^\(\+?-?$/.test(p.str) && Math.abs(p.y - i.y) < 2 && Math.abs(p.x + p.w - i.x) < 3);

  // Rótulos (coluna da esquerda) e valores (próximos ao centro de uma coluna de data).
  const labels = below.filter((i) => i.x + i.w / 2 < labelMaxX && !NUM.test(i.str));
  const values = below.filter((i) => NUM.test(i.str) && !isDelta(i) && i.x + i.w / 2 >= labelMaxX);

  // Agrupa valores em linhas.
  const valueRows: { y: number; cells: Map<number, { v: number; d: number }> }[] = [];
  for (const v of values) {
    const cx = v.x + v.w / 2;
    let best = -1;
    let bestD = Infinity;
    columns.forEach((c, idx) => {
      const d = Math.abs(c.cx - cx);
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    });
    if (best < 0 || bestD > tolerance) continue;
    const n = toNumber(v.str);
    if (n === null) continue;
    let row = valueRows.find((r) => Math.abs(r.y - v.y) < 3);
    if (!row) {
      row = { y: v.y, cells: new Map() };
      valueRows.push(row);
    }
    const prev = row.cells.get(best);
    if (!prev || bestD < prev.d) row.cells.set(best, { v: n, d: bestD });
  }

  // Seções (Circunferências / Pregas cutâneas): rótulos sem valores na mesma linha.
  const sections = labels
    .filter((l) => /^circunfer|^pregas|^dobras cut/.test(norm(l.str)) && !valueRows.some((r) => Math.abs(r.y - l.y) < 3))
    .map((l) => ({ y: l.y, kind: norm(l.str).startsWith('circunfer') ? ('circ' as const) : ('fold' as const) }));
  const sectionAt = (y: number): 'general' | 'circ' | 'fold' => {
    const above = sections.filter((s) => s.y > y).sort((a, b) => a.y - b.y)[0];
    return above?.kind ?? 'general';
  };

  const evaluations: ParsedEvaluation[] = columns.map((c) => ({ date: c.date, values: {}, skinfolds: {}, circumferences: {} }));
  for (const row of valueRows.sort((a, b) => b.y - a.y)) {
    // Rótulo: textos à esquerda na mesma altura (ou quebrados em 2 linhas próximas).
    const parts = labels.filter((l) => Math.abs(l.y - row.y) <= 7).sort((a, b) => b.y - a.y || a.x - b.x);
    if (!parts.length) continue;
    const label = clean(parts.map((p) => p.str).join(' '));
    const key = norm(label);
    const section = sectionAt(row.y);
    let target: BodyNumericKey | undefined;
    if (section === 'general') target = GENERAL.find(([re]) => re.test(key))?.[1];
    else if (section === 'circ') target = CIRC.find(([re]) => re.test(key))?.[1];
    for (const [idx, cell] of row.cells) {
      const ev = evaluations[idx];
      if (section === 'fold') ev.skinfolds[label] = cell.v;
      else if (target) ev.values[target] = cell.v;
      else if (section === 'circ') ev.circumferences[label] = cell.v;
    }
  }

  const useful = evaluations.filter((e) => Object.keys(e.values).length + Object.keys(e.skinfolds).length > 0);
  if (!useful.length) return { ok: false, error: 'Encontrei as datas, mas nenhuma medida reconhecível. O PDF é um relatório comparativo antropométrico?' };
  const nameItem = items.find((i) => /^nome:?$/i.test(i.str));
  const patient = nameItem ? items.find((i) => Math.abs(i.y - nameItem.y) < 2 && i.x > nameItem.x)?.str : undefined;
  return { ok: true, patient, evaluations: useful };
}

export function evaluationToEntry(e: ParsedEvaluation, now = Date.now()): BodyEntry {
  return {
    id: uid(),
    date: e.date,
    weightKg: e.values.weightKg ?? null,
    bodyFatPct: e.values.bodyFatPct ?? null,
    waistCm: e.values.waistCm ?? null,
    abdomenCm: e.values.abdomenCm ?? null,
    armCm: e.values.armCm ?? null,
    thighCm: e.values.thighCm ?? null,
    hipCm: e.values.hipCm ?? null,
    heightM: e.values.heightM ?? null,
    bmi: e.values.bmi ?? null,
    fatMassKg: e.values.fatMassKg ?? null,
    leanMassKg: e.values.leanMassKg ?? null,
    leanPct: e.values.leanPct ?? null,
    waistHipRatio: e.values.waistHipRatio ?? null,
    bodyDensity: e.values.bodyDensity ?? null,
    skinfoldSumMm: e.values.skinfoldSumMm ?? null,
    armMuscleArea: e.values.armMuscleArea ?? null,
    armFatArea: e.values.armFatArea ?? null,
    skinfolds: Object.keys(e.skinfolds).length ? e.skinfolds : undefined,
    circumferences: Object.keys(e.circumferences).length ? e.circumferences : undefined,
    source: 'pdf',
    createdAt: now,
  };
}

/** Separa as avaliações de meses que ainda não existem no app. */
export function newMonthsOnly(parsed: ParsedEvaluation[], existing: Pick<BodyEntry, 'date'>[]) {
  const have = new Set(existing.map((e) => e.date.slice(0, 7)));
  const fresh: ParsedEvaluation[] = [];
  const skipped: ParsedEvaluation[] = [];
  const seen = new Set<string>();
  for (const p of [...parsed].sort((a, b) => a.date.localeCompare(b.date))) {
    const m = p.date.slice(0, 7);
    if (have.has(m) || seen.has(m)) skipped.push(p);
    else {
      fresh.push(p);
      seen.add(m);
    }
  }
  return { fresh, skipped };
}

/** Extrai os trechos de texto (com posição) de todas as páginas do PDF, no navegador. */
export async function extractPdfItems(data: ArrayBuffer): Promise<TextItem[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const out: TextItem[] = [];
  // Páginas seguintes são deslocadas para baixo para não misturar linhas.
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const offset = (p - 1) * 10000;
    for (const it of tc.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      out.push({ str: it.str, x: it.transform[4], y: it.transform[5] - offset, w: it.width });
    }
  }
  await doc.destroy();
  return out;
}
