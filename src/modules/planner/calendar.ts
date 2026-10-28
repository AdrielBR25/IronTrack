// Calendário do planejamento (IronTrack 2.0 F01/P13, docs/PLANEJAMENTO_SEMANAL.md §4).
// Datas de calendário (yyyy-mm-dd) são aritmética pura em UTC (imune a horário de verão e ao fuso do aparelho);
// só a conversão do INSTANTE de uma sessão para o dia usa o fuso local (`localDate`, a mesma regra do analytics e das
// metas). Semana: segunda a domingo. Nunca se compara o `toISOString()` de um instante com um dia local.
import { localDate, weekStart } from '@/modules/analytics';

const DAY_MS = 86_400_000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Data de calendário válida (yyyy-mm-dd que existe de fato, sem 31/02). */
export function isPlanDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

const fromDayNumber = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

export function planAddDays(iso: string, n: number): string {
  return fromDayNumber(dayNumber(iso) + n);
}

/** Dia da semana (0 = domingo … 6 = sábado) de uma data de calendário, sem depender do fuso. */
export function planWeekday(iso: string): number {
  // 1970-01-01 foi quinta-feira (4).
  return (((dayNumber(iso) + 4) % 7) + 7) % 7;
}

/** Segunda-feira da semana que contém a data (mesma regra das metas e do analytics). */
export const weekOf = (iso: string): string => weekStart(iso);

/** Os 7 dias (segunda → domingo) da semana que começa em `monday`. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => planAddDays(monday, i));
}

/** Segunda-feira `n` semanas depois (n < 0: antes). */
export const shiftWeek = (monday: string, n: number): string => planAddDays(weekOf(monday), 7 * n);

/** Dia local em que a sessão começou (fuso do aparelho). */
export const sessionDay = (startedAt: number): string => localDate(startedAt);

/** Ordem de exibição dos dias: segunda (1) … domingo (0). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
