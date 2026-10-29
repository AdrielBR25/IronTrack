import type { DistanceUnit, WeightUnit } from '@/lib/types';
import { fmtDurationSec } from '@/modules/training';
import { toDisplay } from '@/lib/units';
import { fmtNum } from '@/lib/utils';
import { fmtDistance } from '@/features/workout/modelFormat';
import type { RecordUnit } from '@/modules/performance';

// Formatação dos valores de desempenho (P19). Unidade sempre visível; ausência vira "—", nunca zero.

export interface FmtCtx {
  weightUnit: WeightUnit;
  distanceUnit: DistanceUnit | null;
}

export function fmtPerf(value: number | null | undefined, unit: RecordUnit, ctx: FmtCtx): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'kg':
      return `${fmtNum(toDisplay(value, ctx.weightUnit), 1)} ${ctx.weightUnit}`;
    case 'repeticoes':
      return `${fmtNum(value, 0)} rep.`;
    case 'segundos':
      return fmtDurationSec(value);
    case 'metros':
      return fmtDistance(value, ctx.distanceUnit ?? 'km');
    case 'seg_por_km':
      return `${fmtDurationSec(value)} /km`;
  }
}

/** Diferença com sinal ("+2,5 kg", "−0:12"). */
export function fmtDiff(value: number | null, unit: RecordUnit, ctx: FmtCtx): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1e-9) return unit === 'repeticoes' ? '0' : `0 ${unitShort(unit, ctx)}`;
  const sign = value > 0 ? '+' : '−';
  return `${sign}${fmtPerf(Math.abs(value), unit, ctx)}`;
}

export function unitShort(unit: RecordUnit, ctx: FmtCtx): string {
  return unit === 'kg' ? ctx.weightUnit : unit === 'repeticoes' ? 'rep.' : unit === 'segundos' ? 's' : unit === 'metros' ? (ctx.distanceUnit ?? 'km') : 'min/km';
}

/** Nome da unidade por extenso, para legendas de gráfico. */
export function unitLong(unit: RecordUnit, ctx: FmtCtx): string {
  return unit === 'kg'
    ? ctx.weightUnit === 'kg'
      ? 'quilogramas (kg)'
      : 'libras (lb)'
    : unit === 'repeticoes'
      ? 'repetições'
      : unit === 'segundos'
        ? 'tempo (min:s)'
        : unit === 'metros'
          ? ctx.distanceUnit === 'm'
            ? 'metros (m)'
            : ctx.distanceUnit === 'mi'
              ? 'milhas (mi)'
              : 'quilômetros (km)'
          : 'minutos por km (menor = mais rápido)';
}

/** Valor do eixo do gráfico na unidade exibida. */
export function axisValue(value: number, unit: RecordUnit, ctx: FmtCtx): number {
  if (unit === 'kg') return toDisplay(value, ctx.weightUnit) ?? value;
  if (unit === 'metros') return ctx.distanceUnit === 'm' ? value : ctx.distanceUnit === 'mi' ? value / 1609.344 : value / 1000;
  return value;
}

export function signedPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v), 1)}%`;
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
/** dd/mm/aaaa de uma data local (yyyy-mm-dd). */
export const fmtIsoDate = (iso: string) => dateFmt.format(new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
