import { z } from 'zod';
import type { BodyEntry } from './types';
import { formatZodError, parseJsonText, type ParseResult } from './routineSchema';
import { uid } from './utils';

export const BODY_FORMAT = 'irontrack.avaliacoes';

const optNum = (min: number, max: number, label: string) =>
  z.number({ invalid_type_error: `${label} deve ser um número` }).min(min, `${label} mínimo ${min}`).max(max, `${label} máximo ${max}`).nullable().optional();

const entrySchema = z.object({
  data: z.string({ required_error: 'cada avaliação precisa de "data" (AAAA-MM-DD)' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'data no formato AAAA-MM-DD'),
  peso: optNum(20, 400, 'peso (kg)'),
  gordura: optNum(2, 70, 'gordura (%)'),
  cintura: optNum(30, 250, 'cintura (cm)'),
  abdomen: optNum(30, 250, 'abdômen (cm)'),
  braco: optNum(10, 80, 'braço (cm)'),
  coxa: optNum(20, 120, 'coxa (cm)'),
  observacoes: z.string().max(500).optional(),
});

const fileSchema = z.object({
  formato: z.literal(BODY_FORMAT, { errorMap: () => ({ message: `o campo "formato" deve ser "${BODY_FORMAT}"` }) }),
  versao: z.literal(1, { errorMap: () => ({ message: 'versão suportada: 1' }) }),
  avaliacoes: z.array(entrySchema).min(1, 'inclua pelo menos 1 avaliação'),
});

export function parseBodyJson(text: string): ParseResult<BodyEntry[]> {
  const raw = parseJsonText(text);
  if (!raw.ok) return raw;
  const res = fileSchema.safeParse(raw.value);
  if (!res.success) return { ok: false, errors: formatZodError(res.error).map((e) => e.replace(/^avaliacoes › (\d+)/, (_, n) => `Avaliação ${Number(n) + 1}`)) };
  const now = Date.now();
  return {
    ok: true,
    value: res.data.avaliacoes.map((a) => ({
      id: uid(),
      date: a.data,
      weightKg: a.peso ?? null,
      bodyFatPct: a.gordura ?? null,
      waistCm: a.cintura ?? null,
      abdomenCm: a.abdomen ?? null,
      armCm: a.braco ?? null,
      thighCm: a.coxa ?? null,
      notes: a.observacoes,
      createdAt: now,
    })),
  };
}
