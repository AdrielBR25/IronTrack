// Peças visuais do Conhecimento (Fase 04): capa do livro (imagem ou capa gerada), barras de progresso, cartões de
// livro/matéria/meta, formatação de minutos e redução de imagem da capa no aparelho. Visual escuro com verde-limão.
import { Link } from 'react-router-dom';
import { BookOpen, Brain, CheckCircle2, Clock, GraduationCap, Timer } from 'lucide-react';
import { BOOK_STATUS_LABEL, GOAL_METRIC_UNIT, SESSION_KIND_LABEL, type BookView, type GoalView, type SessionView, type SubjectColor, type SubjectView } from '@shared/knowledge/protocol.ts';
import { cn } from '@/lib/utils';
import { Bar } from '../life/ui';

export { addDays, dayLabel, localToday, mondayOf, shortDate, weekdayShort } from '../nutrition/ui';

export const fmtMin = (min: number) => {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
};

export const COLOR: Record<SubjectColor, { text: string; bar: string; soft: string; fill: string }> = {
  lime: { text: 'text-primary', bar: 'bg-primary', soft: 'bg-primary/15', fill: '#a3e635' },
  sky: { text: 'text-sky-400', bar: 'bg-sky-500', soft: 'bg-sky-500/15', fill: '#0ea5e9' },
  violet: { text: 'text-violet-400', bar: 'bg-violet-500', soft: 'bg-violet-500/15', fill: '#8b5cf6' },
  amber: { text: 'text-amber-400', bar: 'bg-amber-500', soft: 'bg-amber-500/15', fill: '#f59e0b' },
  rose: { text: 'text-rose-400', bar: 'bg-rose-500', soft: 'bg-rose-500/15', fill: '#f43f5e' },
  emerald: { text: 'text-emerald-400', bar: 'bg-emerald-500', soft: 'bg-emerald-500/15', fill: '#10b981' },
  orange: { text: 'text-orange-400', bar: 'bg-orange-500', soft: 'bg-orange-500/15', fill: '#f97316' },
  cyan: { text: 'text-cyan-400', bar: 'bg-cyan-500', soft: 'bg-cyan-500/15', fill: '#06b6d4' },
};

export const KIND_ICON = { reading: BookOpen, study: GraduationCap, focus: Brain } as const;

/** Capa do livro: a imagem guardada, ou uma capa gerada (cor do título + iniciais). */
export function BookCover({ book, className, mini }: { book: Pick<BookView, 'title' | 'author' | 'cover' | 'hue'>; className?: string; mini?: boolean }) {
  if (book.cover) return <img src={book.cover} alt="" className={cn('aspect-[2/3] w-full rounded-lg object-cover shadow-md', className)} />;
  return (
    <div
      aria-hidden
      className={cn('flex aspect-[2/3] w-full flex-col justify-between overflow-hidden rounded-lg p-2 shadow-md', className)}
      style={{ background: `linear-gradient(160deg, hsl(${book.hue} 55% 32%), hsl(${(book.hue + 40) % 360} 60% 16%))` }}
    >
      {mini ? <span className="font-display text-sm font-bold text-white/90">{book.title.trim().charAt(0).toUpperCase()}</span> : <span className="line-clamp-4 font-display text-[11px] font-bold leading-tight text-white/95">{book.title}</span>}
      {book.author && !mini && <span className="line-clamp-1 text-[9px] text-white/70">{book.author}</span>}
    </div>
  );
}

export function BookCard({ b }: { b: BookView }) {
  return (
    <Link to={`/conhecimento/livro/${b.id}`} className="block space-y-1.5" data-testid="book-card">
      <BookCover book={b} />
      <div className="space-y-1">
        <p className="line-clamp-2 text-xs font-medium leading-tight">{b.title}</p>
        {b.author && <p className="line-clamp-1 text-[11px] text-muted-foreground">{b.author}</p>}
        {b.status === 'done' ? (
          <p className="flex items-center gap-1 text-[11px] text-primary">
            <CheckCircle2 className="h-3 w-3" />
            Concluído
          </p>
        ) : b.percent != null && b.status !== 'want' ? (
          <div className="space-y-0.5">
            <Bar value={b.percent / 100} className="h-1.5" label={`Progresso de ${b.title}`} />
            <p className="text-[10px] tabular-nums text-muted-foreground">{b.percent}%</p>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{BOOK_STATUS_LABEL[b.status]}</p>
        )}
      </div>
    </Link>
  );
}

/** Linha de livro em andamento (dashboard). */
export function BookRow({ b }: { b: BookView }) {
  return (
    <Link to={`/conhecimento/livro/${b.id}`} className="flex items-center gap-3 py-2">
      <BookCover book={b} mini className="w-10 shrink-0 rounded-md" />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block truncate text-sm font-medium">{b.title}</span>
        <span className="block text-xs tabular-nums text-muted-foreground">
          {b.totalPages ? `pág. ${b.currentPage} de ${b.totalPages}` : `pág. ${b.currentPage}`}
          {b.pace.forecastFinish ? ` · termina ~${b.pace.forecastFinish.split('-').reverse().slice(0, 2).join('/')}` : ''}
        </span>
        {b.percent != null && <Bar value={b.percent / 100} className="h-1.5" label={`Progresso de ${b.title}`} />}
      </span>
      {b.percent != null && <span className="text-xs font-semibold tabular-nums text-primary">{b.percent}%</span>}
    </Link>
  );
}

export function SubjectRow({ s }: { s: SubjectView }) {
  const c = COLOR[s.color];
  return (
    <Link to={`/conhecimento/materia/${s.id}`} className="flex items-center gap-3 py-2.5" data-testid="subject-row">
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', c.soft, c.text)}>
        <GraduationCap className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="block truncate text-sm font-medium">{s.name}</span>
        <span className="block text-xs tabular-nums text-muted-foreground">
          {fmtMin(s.minutesWeek)}
          {s.weeklyGoalMin ? ` de ${fmtMin(s.weeklyGoalMin)} na semana` : ' na semana'}
          {s.topics.total ? ` · ${s.topics.done}/${s.topics.total} tópicos` : ''}
        </span>
        {s.weeklyGoalMin ? <Bar value={s.minutesWeek / s.weeklyGoalMin} tone={c.bar} className="h-1.5" label={`Meta semanal de ${s.name}`} /> : null}
      </span>
    </Link>
  );
}

export const goalUnit = (g: Pick<GoalView, 'metric'>) => GOAL_METRIC_UNIT[g.metric];
export const goalProgressText = (g: GoalView) => (g.metric === 'book_finish' ? (g.current.met ? 'Livro concluído' : 'Em leitura') : `${g.current.progress}/${g.target} ${goalUnit(g)}`.trim());
const periodText = (g: GoalView) => (g.period === 'daily' ? (g.current.scheduledToday ? 'hoje' : 'fora dos dias escolhidos') : g.period === 'weekly' ? 'nesta semana' : g.dueDate ? `até ${g.dueDate.split('-').reverse().join('/')}` : '');

export function GoalRow({ g, compact }: { g: GoalView; compact?: boolean }) {
  const v = g.metric === 'book_finish' ? (g.current.met ? 1 : 0) : g.current.progress / g.target;
  return (
    <div className="space-y-1.5 py-2" data-testid="knowledge-goal">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          {g.current.met && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
          <span className="truncate">{g.title}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{goalProgressText(g)}</span>
      </div>
      <Bar value={v} className="h-1.5" label={g.title} />
      {!compact && (
        <p className="text-[11px] text-muted-foreground">
          {periodText(g)}
          {g.week ? ` · semana: ${g.week.met}/${g.week.scheduled} dias` : ''}
          {g.linkedName ? ` · conta para "${g.linkedName}"` : ''}
        </p>
      )}
    </div>
  );
}

export function SessionRow({ s, onClick }: { s: SessionView; onClick?: () => void }) {
  const Icon = KIND_ICON[s.kind];
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 py-2 text-left" data-testid="knowledge-session">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{s.title}</span>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {s.mode === 'manual' ? <Clock className="h-3 w-3" /> : <Timer className="h-3 w-3" />}
          {SESSION_KIND_LABEL[s.kind]} · {s.date.split('-').reverse().slice(0, 2).join('/')}
          {s.pagesRead ? ` · ${s.pagesRead} pág.` : ''}
        </span>
      </span>
      <span className="text-right">
        <span className="block text-sm font-semibold tabular-nums">{fmtMin(s.activeMin)}</span>
        {s.xp > 0 && <span className="block text-[10px] font-semibold text-primary">+{s.xp} XP</span>}
      </span>
    </button>
  );
}

/** Reduz a imagem da capa no aparelho (até 360px, JPEG) — a capa não depende de nenhum serviço externo. */
export async function coverFromFile(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error('Imagem inválida.'));
      i.src = url;
    });
    const scale = Math.min(1, 360 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.82, 0.7, 0.55, 0.4]) {
      const d = c.toDataURL('image/jpeg', q);
      if (d.length < 150_000) return d;
    }
    throw new Error('A imagem ficou grande demais.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const intOrNull = (v: string) => {
  const t = v.trim();
  if (!t) return null;
  const n = Math.round(Number(t.replace(',', '.')));
  return Number.isFinite(n) ? n : null;
};
