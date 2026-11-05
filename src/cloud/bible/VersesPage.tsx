// Histórico das passagens do dia (Fase 05): a principal de cada dia e as "outras passagens" pedidas.
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { useLifeQuery } from '../life/api';
import { bibleApi } from './api';
import { TranslationCredit, passageText, readerLink, shortDate } from './ui';

export default function VersesPage() {
  const q = useLifeQuery(() => bibleApi.verseHistory().then((r) => r.verses));
  return (
    <div className="space-y-4 pb-10" data-testid="bible-verses">
      <PageHeader
        title="Passagens do dia"
        subtitle="Seleção editorial verificada, uma por dia"
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Card>
        <CardContent className="divide-y divide-border/60 px-4 py-1">
          {(q.data ?? []).map((v) => (
            <Link key={`${v.date}-${v.seq}`} to={readerLink(v.passage.ref)} className="block space-y-1 py-3">
              <span className="block text-[11px] text-muted-foreground">
                {shortDate(v.date)} · {v.seq === 0 ? 'do dia' : 'outra passagem'} · {v.theme}
              </span>
              <span className="line-clamp-3 block font-serif text-sm">“{passageText(v)}”</span>
              <span className="block text-xs font-semibold">{v.passage.label}</span>
            </Link>
          ))}
          {q.data && !q.data.length && <p className="py-4 text-center text-sm text-muted-foreground">Nenhuma passagem ainda.</p>}
        </CardContent>
      </Card>
      <TranslationCredit />
    </div>
  );
}
