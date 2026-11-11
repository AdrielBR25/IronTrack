// Peças da área Bíblia (Fase 05): versículo do dia, linhas de plano/reflexão/favorito, seletor de livro e capítulo,
// e o rodapé de créditos da tradução. Tudo no tema escuro + lime do app.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { BookOpen, ChevronRight, Heart, MessageCircle, RefreshCw, Sparkles, Star } from 'lucide-react';
import { BOOKS, TRANSLATION, formatKey, type BookInfo } from '@shared/bible/canon.ts';
import { REFLECTION_KIND_LABEL, type DailyVerseView, type MarkView, type PlanView, type ReflectionView } from '@shared/bible/protocol.ts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { lifeError } from '../life/forms';
import { Bar } from '../life/ui';
import { bibleApi } from './api';

export const shortDate = (d: string) => d.split('-').reverse().slice(0, 2).join('/');
export const passageText = (v: Pick<DailyVerseView, 'passage'>) =>
  v.passage.verses
    .filter((x) => !x.omitted)
    .map((x) => x.text)
    .join(' ');
/** Abrir o capítulo de uma referência no leitor, destacando os versículos. */
export const readerLink = (ref: string) => `/biblia/ler?ref=${encodeURIComponent(ref)}`;
/** Pergunta pronta para a IA (só preenche o campo; a pessoa decide se envia). */
export const askAiLink = (label: string) => `/assistente?q=${encodeURIComponent(`Quero refletir sobre ${label} (${TRANSLATION.short}). Me ajude a entender o contexto e separe o que é texto, contexto e interpretação.`)}`;

export function VerseOfDayCard({ verse, onChange, compact }: { verse: DailyVerseView; onChange?: (v: DailyVerseView) => void; compact?: boolean }) {
  const [busy, setBusy] = useState<'fav' | 'other' | null>(null);
  const text = passageText(verse);
  const fav = async () => {
    setBusy('fav');
    try {
      await bibleApi.addMark({ kind: 'favorite', ref: verse.passage.ref, tags: [verse.theme] });
      onChange?.({ ...verse, favorite: true });
      toast.success('Salvo nos favoritos.');
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(null);
    }
  };
  const other = async () => {
    setBusy('other');
    try {
      onChange?.((await bibleApi.anotherVerse()).verse);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="overflow-hidden border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card" data-testid="bible-verse">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-primary">
          <span className="flex items-center gap-1">
            <Sparkles className="h-3.5 w-3.5" />
            {verse.seq === 0 ? 'Passagem do dia' : 'Outra passagem'} · {verse.theme}
          </span>
          <span className="text-muted-foreground">{TRANSLATION.short}</span>
        </div>
        <blockquote className={cn('font-serif leading-relaxed', compact ? 'line-clamp-4 text-[15px]' : 'text-[17px]')} data-testid="bible-verse-text">
          “{text}”
        </blockquote>
        <p className="text-sm font-semibold" data-testid="bible-verse-ref">
          {verse.passage.label}
        </p>
        {verse.context && !compact && <p className="rounded-xl bg-secondary/60 p-2 text-xs text-muted-foreground">Contexto: {verse.context}</p>}
        {!compact && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" size="sm" asChild>
              <Link to={readerLink(verse.passage.ref)}>
                <BookOpen className="h-4 w-4" />
                Abrir capítulo
              </Link>
            </Button>
            <Button variant="secondary" size="sm" disabled={verse.favorite || !!busy} onClick={() => void fav()} data-testid="bible-verse-fav">
              <Heart className={cn('h-4 w-4', verse.favorite && 'fill-primary text-primary')} />
              {verse.favorite ? 'Nos favoritos' : 'Favoritar'}
            </Button>
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void other()} data-testid="bible-verse-other">
              <RefreshCw className={cn('h-4 w-4', busy === 'other' && 'animate-spin')} />
              Outra passagem
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link to={askAiLink(verse.passage.label)}>
                <MessageCircle className="h-4 w-4" />
                Refletir com IA
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PlanRow({ p }: { p: PlanView }) {
  return (
    <Link to={`/biblia/planos/${p.id}`} className="block space-y-1.5 py-2.5" data-testid="bible-plan-row">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{p.title}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {p.doneDays}/{p.totalDays} dias
        </span>
      </div>
      <Bar value={p.percent / 100} className="h-1.5" label={p.title} />
      <p className="truncate text-[11px] text-muted-foreground">
        {p.status === 'paused' ? 'Pausado · ' : p.status === 'completed' ? 'Concluído · ' : ''}
        {p.next ? `Próximo: dia ${p.next.day + 1} · ${p.next.label} · ~${p.next.minutes} min` : 'Todos os dias lidos'}
      </p>
    </Link>
  );
}

export function ReflectionRow({ r, onClick }: { r: ReflectionView; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className="block w-full space-y-0.5 py-2.5 text-left" data-testid="bible-reflection-row">
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {r.favorite && <Star className="h-3 w-3 fill-primary text-primary" />}
        {REFLECTION_KIND_LABEL[r.kind]} · {shortDate(r.date)}
        {r.label ? ` · ${r.label}` : ''}
      </span>
      {r.title && <span className="block truncate text-sm font-medium">{r.title}</span>}
      <span className="line-clamp-2 text-sm text-muted-foreground">{r.content}</span>
    </button>
  );
}

export function MarkRow({ m, onRemove }: { m: MarkView; onRemove?: () => void }) {
  return (
    <div className="flex items-start gap-3 py-2.5" data-testid="bible-mark-row">
      <Link to={readerLink(m.ref)} className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{m.label}</span>
        {m.text && <span className="line-clamp-3 font-serif text-sm text-muted-foreground">{m.text}</span>}
        {m.tags.length > 0 && <span className="mt-1 block text-[11px] text-primary">{m.tags.map((t) => `#${t}`).join(' ')}</span>}
      </Link>
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded-full p-1 text-muted-foreground active:bg-accent" aria-label={`Remover ${m.label}`}>
          <Heart className="h-4 w-4 fill-primary text-primary" />
        </button>
      )}
    </div>
  );
}

/** Seletor de livro → capítulo (o cânon da tradução: 39 + 27 livros). */
export function ChapterPicker({ open, onOpenChange, onPick, current }: { open: boolean; onOpenChange: (o: boolean) => void; onPick: (b: string, c: number) => void; current?: string }) {
  const [t, setT] = useState<'OT' | 'NT'>(() => (BOOKS.find((b) => b.id === current)?.testament ?? 'OT'));
  const [book, setBook] = useState<BookInfo | null>(null);
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setBook(null);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{book ? book.long : 'Escolher livro'}</DialogTitle>
          <DialogDescription>{book ? `${book.chapters} capítulos` : `${TRANSLATION.name} · ${BOOKS.length} livros`}</DialogDescription>
        </DialogHeader>
        {!book ? (
          <div className="space-y-3">
            <Segmented
              aria-label="Testamento"
              value={t}
              onChange={setT}
              options={[
                { value: 'OT', label: 'Antigo' },
                { value: 'NT', label: 'Novo' },
              ]}
            />
            <div className="grid grid-cols-2 gap-1.5">
              {BOOKS.filter((b) => b.testament === t).map((b) => (
                <button key={b.id} type="button" onClick={() => setBook(b)} className={cn('rounded-xl bg-secondary/60 px-3 py-2 text-left text-sm active:bg-accent', b.id === current && 'ring-1 ring-primary')} data-testid={`bible-book-${b.id}`}>
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-6 gap-1.5">
              {Array.from({ length: book.chapters }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    onPick(book.id, i + 1);
                    close(false);
                  }}
                  className="aspect-square rounded-xl bg-secondary/60 text-sm tabular-nums active:bg-primary active:text-primary-foreground"
                  data-testid={`bible-chapter-${i + 1}`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setBook(null)}>
              Outros livros
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TranslationCredit({ className }: { className?: string }) {
  return (
    <p className={cn('text-center text-[11px] leading-relaxed text-muted-foreground', className)} data-testid="bible-credit">
      {TRANSLATION.credit}.{' '}
      <Link to="/biblia/ajustes#traducao" className="underline">
        Sobre a tradução
      </Link>
    </p>
  );
}

export function NavTile({ to, label, icon: Icon }: { to: string; label: string; icon: typeof BookOpen }) {
  return (
    <Link to={to} className="flex flex-col items-center gap-1 rounded-2xl bg-card p-3 text-center text-[11px] active:scale-[0.98]">
      <Icon className="h-5 w-5 text-primary" />
      {label}
    </Link>
  );
}

export function LinkRow({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-2 py-2.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" />
    </Link>
  );
}

export const refLabel = (ref: string | null) => (ref ? formatKey(ref) : '');
