import { useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DAY_STATUS_LABEL, type ResolvedMonth } from '@/modules/calendar';
import { fmtDayLong } from '@/features/planner/plannerFormat';
import { cn } from '@/lib/utils';
import { STATUS_ICON, STATUS_SHORT } from './calendarFormat';

// Visão mensal compacta (IronTrack 2.0 F01/P14). Os dias são resolvidos sob demanda pelo domínio; nenhum registro é
// criado. Cada dia tem estado em texto no rótulo acessível; setas do teclado movem a seleção (±1 dia, ±1 semana).

const HEAD = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

const TONE: Record<string, string> = {
  done: 'bg-primary/20 text-primary',
  trained: 'bg-primary/20 text-primary',
  partial: 'bg-primary/10 text-primary',
  in_progress: 'bg-primary/10 text-primary',
  planned: 'border-primary/50 text-foreground',
  suggested: 'border-dashed border-muted-foreground/50 text-muted-foreground',
  rest: 'bg-secondary/60 text-muted-foreground',
  free: 'bg-secondary/40 text-muted-foreground',
  not_recorded: 'text-muted-foreground',
  empty: 'text-muted-foreground',
};

export function MonthGrid({ month, selected, onSelect }: { month: ResolvedMonth; selected: string; onSelect: (date: string) => void }) {
  const days = month.weeks.flatMap((w) => w.days);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selIndex = Math.max(0, days.findIndex((d) => d.date === selected));
  const focusable = days.some((d) => d.date === selected) ? selIndex : days.findIndex((d) => d.inMonth);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 7 : e.key === 'ArrowUp' ? -7 : null;
    if (step === null) return;
    const to = i + step;
    if (to < 0 || to >= days.length) return;
    e.preventDefault();
    onSelect(days[to].date);
    refs.current[to]?.focus();
  };
  return (
    <div data-testid="month-grid" data-month={month.month}>
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] font-medium uppercase text-muted-foreground" aria-hidden>
        {HEAD.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      <ol className="grid grid-cols-7 gap-1" aria-label="Dias do mês">
        {days.map((d, i) => {
          const Icon = STATUS_ICON[d.status];
          const isSel = d.date === selected;
          const extra = [
            d.plan.sessions.length ? `${d.plan.sessions.length} ${d.plan.sessions.length === 1 ? 'treino registrado' : 'treinos registrados'}` : '',
            d.origin === 'plan_exception' ? 'exceção do planejamento' : '',
            d.hasWarning ? 'divergência entre agendas' : '',
            d.inMonth ? '' : 'fora do mês',
          ]
            .filter(Boolean)
            .join(', ');
          return (
            <li key={d.date} className="min-w-0">
              <button
                ref={(el) => (refs.current[i] = el)}
                type="button"
                onClick={() => onSelect(d.date)}
                onKeyDown={(e) => onKey(e, i)}
                tabIndex={i === focusable ? 0 : -1}
                aria-pressed={isSel}
                aria-current={d.isToday ? 'date' : undefined}
                aria-label={`${fmtDayLong(d.date)}: ${DAY_STATUS_LABEL[d.status]}${extra ? `, ${extra}` : ''}`}
                data-testid="month-day"
                data-date={d.date}
                data-status={d.status}
                data-warning={d.hasWarning ? 'true' : 'false'}
                className={cn(
                  'relative flex min-h-11 w-full flex-col items-center justify-center gap-0.5 rounded-lg border border-transparent py-1 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-16',
                  TONE[d.status],
                  !d.inMonth && 'opacity-40',
                  isSel && 'ring-2 ring-primary',
                  d.isToday && !isSel && 'border-primary',
                )}
              >
                <span className={cn('text-sm font-semibold leading-none tabular', d.isToday && 'text-primary')}>{Number(d.date.slice(8))}</span>
                {d.status !== 'empty' && <Icon className="h-3 w-3" aria-hidden />}
                <span className="hidden max-w-full truncate px-0.5 text-[10px] leading-tight md:block" aria-hidden>
                  {d.status === 'empty' ? '' : STATUS_SHORT[d.status]}
                </span>
                {d.hasWarning && <AlertTriangle className="absolute right-0.5 top-0.5 h-2.5 w-2.5 text-warn" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Legenda dos ícones do calendário (visível; os rótulos acessíveis já têm o texto completo). */
export function CalendarLegend({ className }: { className?: string }) {
  const items: [keyof typeof STATUS_ICON, string][] = [
    ['done', 'concluído'],
    ['partial', 'parcial'],
    ['planned', 'planejado'],
    ['suggested', 'sugestão da agenda anterior'],
    ['rest', 'descanso'],
    ['free', 'dia livre'],
    ['not_recorded', 'sem registro'],
  ];
  return (
    <ul className={cn('flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground', className)} aria-hidden data-testid="calendar-legend">
      {items.map(([k, t]) => {
        const I = STATUS_ICON[k];
        return (
          <li key={k} className="flex items-center gap-1">
            <I className="h-3 w-3" /> {t}
          </li>
        );
      })}
      <li className="flex items-center gap-1">
        <AlertTriangle className="h-3 w-3 text-warn" /> divergência entre agendas
      </li>
    </ul>
  );
}
