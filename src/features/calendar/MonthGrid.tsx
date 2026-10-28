import { useRef } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { DAY_STATUS_LABEL, type ResolvedDay, type ResolvedMonth, type UnifiedDayStatus } from '@/modules/calendar';
import { fmtDayLong } from '@/features/planner/plannerFormat';
import { cn } from '@/lib/utils';
import { DEFAULT_CALENDAR_PREFS, type CalendarPrefs } from './calendarPrefs';
import { STATUS_ICON, STATUS_SHORT } from './calendarFormat';

// Visão mensal compacta (IronTrack 2.0 F01/P14; P15: indicadores de sessão, exceção, descanso e divergência, "hoje"
// em texto, preferências de exibição e resumo do dia selecionado). Os dias são resolvidos sob demanda pelo domínio;
// nenhum registro é criado. Cada dia tem o estado em texto no rótulo acessível (nunca só cor); setas do teclado movem
// a seleção (±1 dia, ±1 semana), Home/End vão ao início/fim da semana. Previsão nunca aparece como sessão confirmada.

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

/** Estado exibido conforme as preferências (só apresentação: o dia resolvido não muda). */
export function displayStatus(d: ResolvedDay, prefs: CalendarPrefs): UnifiedDayStatus {
  if (!prefs.showLegacy && d.status === 'suggested') return 'empty';
  if (!prefs.showLegacy && d.origin === 'legacy' && d.status === 'rest') return 'empty';
  if (!prefs.showSessions && (d.status === 'done' || d.status === 'partial')) return d.isPast ? 'not_recorded' : 'planned';
  if (!prefs.showSessions && d.status === 'trained') return 'empty';
  return d.status;
}

/** Texto completo do dia para leitores de tela (estado + marcas), respeitando as preferências. */
export function dayAccessibleText(d: ResolvedDay, prefs: CalendarPrefs, extraMarks: string[] = []): string {
  const status = displayStatus(d, prefs);
  const marks = [
    d.isToday ? 'hoje' : '',
    prefs.showSessions && d.plan.sessions.length ? `${d.plan.sessions.length} ${d.plan.sessions.length === 1 ? 'sessão concluída' : 'sessões concluídas'}` : '',
    d.origin === 'plan_exception' ? 'exceção do planejamento' : '',
    d.hasWarning ? 'divergência entre agendas' : '',
    ...extraMarks,
  ].filter(Boolean);
  return `${fmtDayLong(d.date)}: ${DAY_STATUS_LABEL[status]}${marks.length ? `, ${marks.join(', ')}` : ''}`;
}

export function MonthGrid({ month, selected, onSelect, prefs = DEFAULT_CALENDAR_PREFS }: { month: ResolvedMonth; selected: string; onSelect: (date: string) => void; prefs?: CalendarPrefs }) {
  const days = month.weeks.flatMap((w) => w.days);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selIndex = Math.max(0, days.findIndex((d) => d.date === selected));
  const focusable = days.some((d) => d.date === selected) ? selIndex : days.findIndex((d) => d.inMonth);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const col = i % 7;
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 7 : e.key === 'ArrowUp' ? -7 : e.key === 'Home' ? -col : e.key === 'End' ? 6 - col : null;
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
          const status = displayStatus(d, prefs);
          const Icon = STATUS_ICON[status];
          const isSel = d.date === selected;
          const sessions = prefs.showSessions ? d.plan.sessions.length : 0;
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
                aria-label={dayAccessibleText(d, prefs, d.inMonth ? [] : ['fora do mês'])}
                data-testid="month-day"
                data-date={d.date}
                data-status={status}
                data-warning={d.hasWarning ? 'true' : 'false'}
                data-exception={d.origin === 'plan_exception' ? 'true' : 'false'}
                data-sessions={sessions}
                className={cn(
                  'relative flex min-h-12 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-transparent py-1 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-16',
                  TONE[status],
                  !d.inMonth && 'opacity-40',
                  isSel && 'ring-2 ring-primary',
                  d.isToday && !isSel && 'border-primary',
                )}
              >
                <span className={cn('text-sm font-semibold leading-none tabular', d.isToday && 'text-primary underline decoration-2 underline-offset-2')}>{Number(d.date.slice(8))}</span>
                {status !== 'empty' && <Icon className="h-3 w-3" aria-hidden />}
                <span className="hidden max-w-full truncate px-0.5 text-[10px] leading-tight md:block" aria-hidden>
                  {d.isToday ? 'Hoje' : status === 'empty' ? '' : STATUS_SHORT[status]}
                </span>
                {d.hasWarning && <AlertTriangle className="absolute right-0.5 top-0.5 h-2.5 w-2.5 text-warn" aria-hidden />}
                {d.origin === 'plan_exception' && (
                  <span className="absolute left-0.5 top-0.5 text-[8px] font-bold leading-none text-muted-foreground" aria-hidden>
                    E
                  </span>
                )}
                {sessions > 1 && (
                  <span className="absolute bottom-0.5 right-0.5 flex items-center text-[8px] font-bold leading-none text-primary" aria-hidden>
                    <Check className="h-2 w-2" />
                    {sessions}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Legenda dos ícones do calendário (visível; os rótulos acessíveis já têm o texto completo). */
export function CalendarLegend({ className, prefs = DEFAULT_CALENDAR_PREFS }: { className?: string; prefs?: CalendarPrefs }) {
  const items: [keyof typeof STATUS_ICON, string][] = [
    ['planned', 'planejado'],
    ...(prefs.showSessions ? ([['done', 'concluído'], ['partial', 'parcial']] as [keyof typeof STATUS_ICON, string][]) : []),
    ...(prefs.showLegacy ? ([['suggested', 'sugestão da agenda anterior']] as [keyof typeof STATUS_ICON, string][]) : []),
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
        <span className="text-[9px] font-bold">E</span> exceção (só neste dia)
      </li>
      <li className="flex items-center gap-1">
        <span className="font-semibold text-primary underline decoration-2 underline-offset-2">n</span> hoje
      </li>
      <li className="flex items-center gap-1">
        <AlertTriangle className="h-3 w-3 text-warn" /> divergência entre agendas
      </li>
    </ul>
  );
}
