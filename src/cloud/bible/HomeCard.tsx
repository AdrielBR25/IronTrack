// Bíblia no Início (Fase 05 → Fase 08): versículo do dia compacto (duas linhas, expande ao tocar), abrir o capítulo e
// continuar a leitura/plano. Some do Início quando a pessoa desliga "Mostrar no Início" (a área continua no menu Mais).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { TRANSLATION } from '@shared/bible/canon.ts';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { bibleApi } from './api';
import { passageText, readerLink } from './ui';

export function BibleHomeCard() {
  const q = useLifeQuery(() => bibleApi.home());
  const [open, setOpen] = useState(false);
  const d = q.data;
  if (!d || !d.prefs.showOnHome) return null;
  const plan = d.plans.find((p) => p.status === 'active');
  const verse = d.prefs.verseMode === 'daily' ? d.verse : null;
  const resumeTo = d.resume ? readerLink(d.resume.ref) : plan?.next ? '/biblia/planos' : '/biblia/ler';
  const resumeText = d.resume ? `Continuar: ${d.resume.label}` : plan?.next ? `${plan.title}: ${plan.next.label}` : 'Ler a Bíblia';
  return (
    <section className="space-y-2" data-testid="home-bible">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-sm font-semibold text-foreground/90">{verse ? 'Versículo do dia' : 'Bíblia'}</h2>
        <Link to="/biblia" className="rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
          Abrir
        </Link>
      </div>
      <Card className="p-3.5">
        {verse && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="block w-full text-left" data-testid="home-verse">
            <span className={cn('block font-serif text-[15px] leading-relaxed text-foreground/90', !open && 'line-clamp-2')}>“{passageText(verse)}”</span>
            <span className="mt-1.5 flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold">
                {verse.passage.label} <span className="font-normal text-muted-foreground">· {TRANSLATION.short}</span>
              </span>
              <span className="flex items-center gap-0.5 text-muted-foreground">
                {open ? 'Menos' : 'Ler tudo'}
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
              </span>
            </span>
          </button>
        )}
        <div className={cn('flex flex-wrap gap-2', verse && 'mt-3 border-t border-border/50 pt-3')}>
          {verse && (
            <Link to={readerLink(verse.passage.ref)} className="flex items-center gap-1 rounded-lg bg-secondary/70 px-3 py-2 text-xs font-semibold transition hover:bg-secondary active:scale-[0.98]">
              Abrir capítulo
            </Link>
          )}
          <Link to={resumeTo} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-secondary/70 px-3 py-2 text-xs font-semibold transition hover:bg-secondary active:scale-[0.98]">
            <BookOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{resumeText}</span>
            {plan && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{plan.percent}%</span>}
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Link>
        </div>
      </Card>
    </section>
  );
}
