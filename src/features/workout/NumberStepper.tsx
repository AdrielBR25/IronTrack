import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn, fmtNum, parseNum } from '@/lib/utils';

/**
 * Campo numérico grande com botões − e +. Mantém o texto digitado localmente
 * enquanto focado (para aceitar "52," etc.) e abre teclado numérico no celular.
 */
export function NumberStepper({
  value,
  onChange,
  step,
  min = 0,
  max = 9999,
  decimals = 2,
  label,
  suffix,
  integer,
  testId,
  size = 'lg',
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step: number;
  min?: number;
  max?: number;
  decimals?: 0 | 1 | 2;
  label: string;
  suffix?: React.ReactNode;
  integer?: boolean;
  testId?: string;
  size?: 'md' | 'lg';
}) {
  const [text, setText] = useState(value === null ? '' : fmtNum(value, decimals).replace(/\./g, ''));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value === null ? '' : fmtNum(value, decimals).replace(/\./g, ''));
  }, [value, decimals]);

  const bump = (dir: 1 | -1) => {
    const base = value ?? 0;
    let next = Math.round((base + dir * step) * 1000) / 1000;
    next = Math.min(max, Math.max(min, next));
    onChange(integer ? Math.round(next) : next);
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const btn = size === 'lg' ? 'h-[52px] w-14' : 'h-11 w-11';
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`Diminuir ${label}`}
          onClick={() => bump(-1)}
          className={cn(btn, 'flex shrink-0 items-center justify-center rounded-2xl bg-secondary text-foreground active:scale-95 active:bg-accent')}
        >
          <Minus className="h-6 w-6" />
        </button>
        <input
          data-testid={testId}
          aria-label={label}
          inputMode={integer ? 'numeric' : 'decimal'}
          pattern={integer ? '[0-9]*' : '[0-9]*[.,]?[0-9]*'}
          enterKeyHint="done"
          autoComplete="off"
          value={text}
          onFocus={(e) => {
            focused.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            focused.current = false;
            setText(value === null ? '' : fmtNum(value, decimals).replace(/\./g, ''));
          }}
          onChange={(e) => {
            const t = e.target.value.replace(/[^0-9.,]/g, '');
            setText(t);
            const n = parseNum(t);
            if (n === null) onChange(null);
            else if (n >= min && n <= max) onChange(integer ? Math.round(n) : n);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className={cn(
            'min-w-0 flex-1 rounded-2xl border border-input bg-background text-center font-display font-bold tabular outline-none focus:border-primary focus:ring-2 focus:ring-primary/30',
            size === 'lg' ? 'h-[52px] text-3xl' : 'h-11 text-xl',
          )}
        />
        <button
          type="button"
          aria-label={`Aumentar ${label}`}
          onClick={() => bump(1)}
          className={cn(btn, 'flex shrink-0 items-center justify-center rounded-2xl bg-secondary text-foreground active:scale-95 active:bg-accent')}
        >
          <Plus className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}
