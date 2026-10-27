// Utilitários de data trabalhando sempre com datas locais no formato yyyy-mm-dd.

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = fromISODate(s);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function weekday(s: string): number {
  return fromISODate(s).getDay();
}

/** Segunda-feira da semana (yyyy-mm-dd) que contém a data. */
export function startOfWeek(s: string): string {
  const wd = weekday(s);
  const diff = wd === 0 ? -6 : 1 - wd;
  return addDays(s, diff);
}

export function startOfDayTs(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function tsToISODate(ts: number): string {
  return toISODate(new Date(ts));
}

export function todayISO(): string {
  return toISODate(new Date());
}

const WD_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WD_LONG = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const weekdayShort = (i: number) => WD_SHORT[i];
export const weekdayLong = (i: number) => WD_LONG[i];

export function fmtDateLong(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

export function fmtDateShort(ts: number | string): string {
  const d = typeof ts === 'string' ? fromISODate(ts) : new Date(ts);
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(d).replace('.', '');
}

export function fmtDateTime(ts: number): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date(ts))
    .replace('.', '');
}

export function fmtTime(ts: number): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}
