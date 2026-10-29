import { cn } from '@/lib/utils';

/** Grupo de filtros em pílulas (biblioteca P17; reutilizado pelo navegador da biblioteca no treino, P20). */
export function ChipGroup<T extends string>({ legend, options, value, onToggle, label }: { legend: string; options: readonly T[]; value: readonly T[]; onToggle: (v: T) => void; label: (v: T) => string }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o);
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(o)}
              className={cn('min-h-9 rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', on ? 'border-primary bg-primary/10 font-medium text-foreground' : 'text-muted-foreground')}
            >
              {on ? '✓ ' : ''}
              {label(o)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export const toggle = <T,>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
