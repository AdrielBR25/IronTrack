// Progresso por livro (Fase 05): capítulos diferentes registrados como lidos, no cânon da tradução.
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { BOOKS } from '@shared/bible/canon.ts';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { useLifeQuery } from '../life/api';
import { Bar } from '../life/ui';
import { bibleApi } from './api';
import { readerLink } from './ui';

export default function ProgressPage() {
  const q = useLifeQuery(() => bibleApi.progress().then((r) => r.progress));
  const p = q.data;
  const read = new Map(p?.books.map((b) => [b.id, b.read]) ?? []);
  return (
    <div className="space-y-4 pb-10" data-testid="bible-progress">
      <PageHeader
        title="Progresso"
        subtitle={p ? `${p.chaptersRead} de ${p.totalChapters} capítulos registrados` : 'Carregando…'}
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      {(['OT', 'NT'] as const).map((t) => (
        <section key={t} className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t === 'OT' ? 'Antigo Testamento' : 'Novo Testamento'}</h2>
          <Card>
            <CardContent className="divide-y divide-border/60 px-4 py-1">
              {BOOKS.filter((b) => b.testament === t).map((b) => {
                const n = read.get(b.id) ?? 0;
                const firstUnread = p ? Array.from({ length: b.chapters }, (_, i) => i + 1).find((c) => !p.readKeys.includes(`${b.id}.${c}`)) ?? 1 : 1;
                return (
                  <Link key={b.id} to={readerLink(`${b.id}.${firstUnread}`)} className="block space-y-1 py-2">
                    <span className="flex justify-between text-sm">
                      <span>{b.name}</span>
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {n}/{b.chapters}
                      </span>
                    </span>
                    <Bar value={n / b.chapters} className="h-1" label={b.name} />
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}
