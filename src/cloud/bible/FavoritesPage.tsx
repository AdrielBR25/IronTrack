// Favoritos e destaques (Fase 05): passagens salvas com o texto da tradução, etiquetas e atalho para o capítulo.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import type { MarkKind } from '@shared/bible/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { bibleApi } from './api';
import { MarkRow, TranslationCredit } from './ui';

export default function FavoritesPage() {
  const [kind, setKind] = useState<MarkKind>('favorite');
  const [tag, setTag] = useState<string | null>(null);
  const q = useLifeQuery(() => bibleApi.marks({ kind, text: true }).then((r) => r.marks), [kind]);
  const marks = q.data ?? [];
  const tags = [...new Set(marks.flatMap((m) => m.tags))].sort();
  const shown = tag ? marks.filter((m) => m.tags.includes(tag)) : marks;
  const remove = async (id: string) => {
    try {
      await bibleApi.deleteMark(id);
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  return (
    <div className="space-y-4 pb-10" data-testid="bible-favorites">
      <PageHeader
        title="Favoritos"
        subtitle="Passagens salvas e destacadas"
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Segmented
        aria-label="Tipo"
        value={kind}
        onChange={(k) => (setKind(k), setTag(null))}
        options={[
          { value: 'favorite', label: 'Favoritos' },
          { value: 'highlight', label: 'Destaques' },
        ]}
      />
      {tags.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 text-xs">
          {tags.map((t) => (
            <button key={t} type="button" onClick={() => setTag(tag === t ? null : t)} className={cn('shrink-0 rounded-full px-3 py-1.5', tag === t ? 'bg-primary text-primary-foreground' : 'bg-secondary')}>
              #{t}
            </button>
          ))}
        </div>
      )}
      <Card>
        <CardContent className="divide-y divide-border/60 px-4 py-1">
          {shown.map((m) => (
            <MarkRow key={m.id} m={m} onRemove={() => void remove(m.id)} />
          ))}
          {q.data && !shown.length && <p className="py-4 text-center text-sm text-muted-foreground">Nada salvo ainda. No leitor, toque num versículo para favoritar ou destacar.</p>}
        </CardContent>
      </Card>
      <TranslationCredit />
    </div>
  );
}
