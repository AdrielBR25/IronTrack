// Filtros de período dos painéis de desempenho (P19). Mesma aritmética de calendário do analytics (datas locais da
// sessão, `startedAt`; nunca a data de edição). Os períodos do analytics (7/30/60/90 dias) não mudam.
import { localDate, type DateRange } from '@/modules/analytics';

export const PERF_PERIOD_DAYS = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 } as const;
export type PerfPeriodKey = keyof typeof PERF_PERIOD_DAYS | 'all';
export const PERF_PERIOD_KEYS: PerfPeriodKey[] = ['7d', '30d', '90d', '180d', '365d', 'all'];

export const PERF_PERIOD_LABEL: Record<PerfPeriodKey, { short: string; long: string }> = {
  '7d': { short: '7d', long: 'Últimos 7 dias' },
  '30d': { short: '30d', long: 'Últimos 30 dias' },
  '90d': { short: '90d', long: 'Últimos 90 dias' },
  '180d': { short: '180d', long: 'Últimos 180 dias' },
  '365d': { short: '1 ano', long: 'Últimos 365 dias' },
  all: { short: 'Tudo', long: 'Todo o histórico' },
};

const DAY_MS = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayNum(iso: string): number {
  if (!ISO_RE.test(iso)) throw new Error(`Data inválida: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

const fromDayNum = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

export const isPerfPeriodKey = (v: unknown): v is PerfPeriodKey => typeof v === 'string' && (PERF_PERIOD_KEYS as string[]).includes(v);

/** "Últimos 30 dias" = hoje e os 29 dias anteriores. "Todo o histórico" começa na primeira sessão (ou hoje). */
export function perfRange(period: PerfPeriodKey, today: string, firstDate: string | null): DateRange {
  const to = dayNum(today);
  const from = period === 'all' ? (firstDate && firstDate < today ? dayNum(firstDate) : to) : to - (PERF_PERIOD_DAYS[period] - 1);
  return { from: fromDayNum(from), to: today, days: to - from + 1 };
}

export const inPerfRange = (date: string, r: DateRange) => date >= r.from && date <= r.to;

export { localDate };
