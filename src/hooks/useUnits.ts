import { useCallback } from 'react';
import { useSettings } from './data';
import { fromDisplay, toDisplay } from '@/lib/units';
import { fmtNum } from '@/lib/utils';

export function useUnits() {
  const { weightUnit } = useSettings();
  const show = useCallback((kg: number | null | undefined) => toDisplay(kg, weightUnit), [weightUnit]);
  const parse = useCallback((v: number | null) => fromDisplay(v, weightUnit), [weightUnit]);
  const fmtW = useCallback(
    (kg: number | null | undefined, withUnit = true) => {
      const v = toDisplay(kg, weightUnit);
      return v === null ? '—' : `${fmtNum(v, 1)}${withUnit ? ` ${weightUnit}` : ''}`;
    },
    [weightUnit],
  );
  const fmtVol = useCallback(
    (kg: number) => {
      const v = toDisplay(kg, weightUnit) ?? 0;
      if (v >= 10000) return `${fmtNum(v / 1000, 1)} t`.replace(' t', weightUnit === 'kg' ? ' t' : 'k lb');
      return `${fmtNum(v, 0)} ${weightUnit}`;
    },
    [weightUnit],
  );
  return { unit: weightUnit, show, parse, fmtW, fmtVol };
}
