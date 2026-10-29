// Períodos e calendário do motor de análise. Datas de calendário (yyyy-mm-dd) são aritmética pura em UTC,
// o que torna a contagem de dias imune a horário de verão; só a conversão do instante da sessão para a
// data usa o fuso local do aparelho (tsToISODate). Semana: segunda a domingo.
import { tsToISODate } from '@/lib/dates';
import type { DateRange, PeriodKey } from './types';

const DAY_MS = 86_400_000;

export const PERIOD_DAYS: Record<Exclude<PeriodKey, 'all'>, number> = { '7d': 7, '30d': 30, '60d': 60, '90d': 90 };
export const PERIOD_KEYS: PeriodKey[] = ['7d', '30d', '60d', '90d', 'all'];

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Número do dia (dias desde 1970-01-01) de uma data de calendário. */
export function dayNumber(iso: string): number {
  if (!ISO_RE.test(iso)) throw new Error(`Data inválida: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function shiftDays(iso: string, n: number): string {
  return fromDayNumber(dayNumber(iso) + n);
}

/** Dias de calendário de a até b, contando as duas pontas. */
export function daysInclusive(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from) + 1;
}

/** Segunda-feira da semana que contém a data. */
export function weekStart(iso: string): string {
  const n = dayNumber(iso);
  // 1970-01-01 foi quinta-feira: (n + 3) % 7 é 0 na segunda.
  return fromDayNumber(n - (((n + 3) % 7) + 7) % 7);
}

export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function nextMonthStart(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Data local (fuso do aparelho) de um instante. */
export function localDate(ts: number): string {
  return tsToISODate(ts);
}

export function makeRange(from: string, to: string): DateRange {
  return { from, to, days: daysInclusive(from, to) };
}

/**
 * Janela do período terminando hoje (inclusive). "Últimos 30 dias" = hoje e os 29 dias anteriores.
 * "Todo o histórico" vai da primeira sessão concluída até hoje (ou só hoje, sem sessões).
 */
export function resolvePeriod(period: PeriodKey, today: string, firstSessionDate: string | null): DateRange {
  if (period === 'all') {
    const from = firstSessionDate && firstSessionDate < today ? firstSessionDate : today;
    return makeRange(from, today);
  }
  return makeRange(shiftDays(today, -(PERIOD_DAYS[period] - 1)), today);
}

/** Janela anterior com a mesma duração, imediatamente antes de range. */
export function previousRange(range: DateRange): DateRange {
  return makeRange(shiftDays(range.from, -range.days), shiftDays(range.from, -1));
}

export const inRange = (date: string, range: DateRange) => date >= range.from && date <= range.to;
