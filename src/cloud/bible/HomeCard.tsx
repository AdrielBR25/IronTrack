// Cartão "Bíblia" do Início (Fase 05): passagem do dia (se ativada), continuar leitura e plano atual. Some do Início
// quando a pessoa desliga "Mostrar no Início" (a área continua no menu Mais).
import { Link } from 'react-router-dom';
import { BookOpen, ChevronRight } from 'lucide-react';
import { TRANSLATION } from '@shared/bible/canon.ts';
import { Card, CardContent } from '@/components/ui/card';
import { useLifeQuery } from '../life/api';
import { Bar } from '../life/ui';
import { bibleApi } from './api';
import { passageText, readerLink } from './ui';

export function BibleHomeCard() {
  const q = useLifeQuery(() => bibleApi.home());
  const d = q.data;
  if (!d || !d.prefs.showOnHome) return null;
  const plan = d.plans.find((p) => p.status === 'active');
  const verse = d.prefs.verseMode === 'daily' ? d.verse : null;
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bíblia</h2>
    <Card data-testid="home-bible">
      <CardContent className="space-y-3 p-4">
        <Link to="/biblia" className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <BookOpen className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Bíblia</span>
            <span className="block text-xs tabular-nums text-muted-foreground">{d.weekChapters || d.weekMinutes ? `Semana: ${d.weekChapters} cap. · ${d.weekMinutes} min` : 'Nenhuma leitura registrada nesta semana'}</span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </Link>
        {verse && (
          <Link to={readerLink(verse.passage.ref)} className="block rounded-xl bg-secondary/50 p-3">
            <span className="line-clamp-3 font-serif text-sm">“{passageText(verse)}”</span>
            <span className="mt-1 block text-xs font-semibold">
              {verse.passage.label} <span className="font-normal text-muted-foreground">· {TRANSLATION.short}</span>
            </span>
          </Link>
        )}
        {plan && (
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span className="truncate">{plan.next ? `${plan.title}: ${plan.next.label}` : plan.title}</span>
              <span className="tabular-nums">{plan.percent}%</span>
            </div>
            <Bar value={plan.percent / 100} className="h-1.5" label={plan.title} />
          </div>
        )}
        <Link to={d.resume ? readerLink(d.resume.ref) : '/biblia/ler'} className="flex items-center justify-center gap-1 rounded-xl bg-secondary py-2 text-xs font-semibold active:scale-[0.99]">
          <BookOpen className="h-3.5 w-3.5" />
          {d.resume ? `Continuar: ${d.resume.label}` : 'Ler Bíblia'}
        </Link>
      </CardContent>
    </Card>
    </section>
  );
}
