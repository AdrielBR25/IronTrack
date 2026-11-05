// Livro (Fase 04): capa, progresso, ritmo, sessões, notas/trechos/reflexões, avaliação e resenha.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Pencil, Play, Plus, Star, Trash2 } from 'lucide-react';
import { BOOK_STATUS_LABEL, NOTE_KINDS, NOTE_KIND_LABEL, type NoteKind, type NoteView, type SessionView } from '@shared/knowledge/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Input, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { Bar } from '../life/ui';
import { knowledgeApi } from './api';
import { BookDialog, ManualSessionDialog } from './forms';
import { Section } from './parts';
import { BookCover, SessionRow, fmtMin, intOrNull } from './ui';

export default function BookPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const q = useLifeQuery(() => knowledgeApi.book(id), [id]);
  const [edit, setEdit] = useState(false);
  const [manual, setManual] = useState(false);
  const [del, setDel] = useState(false);
  const [session, setSession] = useState<SessionView | null>(null);
  const [page, setPage] = useState('');
  const [review, setReview] = useState('');
  const b = q.data?.book;
  useEffect(() => setReview(b?.review ?? ''), [b?.review]);

  if (q.error) return <p className="py-10 text-center text-sm text-muted-foreground">{lifeError(q.error)}</p>;
  if (!b) return <p className="py-10 text-center text-sm text-muted-foreground">Carregando…</p>;

  const patch = async (p: Record<string, unknown>, msg?: string) => {
    try {
      await knowledgeApi.updateBook(b.id, b.version, p);
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(lifeError(e));
    }
  };

  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-book">
      <PageHeader
        title={b.title}
        subtitle={b.author ?? undefined}
        action={
          <div className="flex">
            <button type="button" onClick={() => setEdit(true)} className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Editar livro">
              <Pencil className="h-5 w-5" />
            </button>
            <Link to="/conhecimento/biblioteca" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para a biblioteca">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </div>
        }
      />
      <Card>
        <CardContent className="flex gap-4 p-4">
          <BookCover book={b} className="w-24 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs text-muted-foreground">
              {BOOK_STATUS_LABEL[b.status]}
              {b.category ? ` · ${b.category}` : ''}
            </p>
            <p className="font-display text-2xl font-bold tabular-nums" data-testid="book-progress">
              {b.percent != null ? `${b.percent}%` : `pág. ${b.currentPage}`}
            </p>
            {b.percent != null && <Bar value={b.percent / 100} label="Progresso" />}
            <p className="text-xs tabular-nums text-muted-foreground">
              {b.totalPages ? `pág. ${b.currentPage} de ${b.totalPages}` : 'Sem total de páginas'} · {fmtMin(b.stats.minutes)} lidos · {b.stats.sessions} sessão(ões)
            </p>
            {b.pace.pagesPerReadingDay != null && (
              <p className="text-xs text-muted-foreground">
                Ritmo: {b.pace.pagesPerReadingDay} pág./dia de leitura
                {b.pace.forecastFinish ? ` · previsão de término ${b.pace.forecastFinish.split('-').reverse().join('/')}` : ''}
              </p>
            )}
            {b.targetDate && <p className="text-xs text-muted-foreground">Meta de conclusão: {b.targetDate.split('-').reverse().join('/')}</p>}
          </div>
        </CardContent>
      </Card>

      {b.status !== 'done' && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Button asChild size="lg" data-testid="book-read">
            <Link to={`/conhecimento/foco?livro=${b.id}`}>
              <Play className="h-4 w-4" />
              Ler agora
            </Link>
          </Button>
          <Button size="lg" variant="secondary" onClick={() => setManual(true)}>
            <Plus className="h-4 w-4" />
            Registrar
          </Button>
        </div>
      )}

      {b.status !== 'done' && (
        <Card>
          <CardContent className="flex items-end gap-2 p-4">
            <label className="flex-1 space-y-1 text-xs">
              <span className="text-muted-foreground">Atualizar página (sem sessão)</span>
              <Input inputMode="numeric" value={page} onChange={(e) => setPage(e.target.value)} placeholder={String(b.currentPage)} />
            </label>
            <Button
              variant="secondary"
              disabled={intOrNull(page) == null}
              onClick={async () => {
                await patch({ currentPage: intOrNull(page) }, 'Página atualizada.');
                setPage('');
              }}
            >
              Salvar
            </Button>
          </CardContent>
        </Card>
      )}

      {b.status === 'done' && (
        <Section title="Avaliação e resenha">
          <div className="space-y-3 py-3">
            <div className="flex gap-1" role="radiogroup" aria-label="Nota">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={b.rating === n} aria-label={`${n} estrela(s)`} onClick={() => void patch({ rating: b.rating === n ? null : n })}>
                  <Star className={cn('h-7 w-7', (b.rating ?? 0) >= n ? 'fill-primary text-primary' : 'text-muted-foreground')} />
                </button>
              ))}
            </div>
            <Textarea rows={3} value={review} onChange={(e) => setReview(e.target.value)} placeholder="O que ficou deste livro para você?" maxLength={2000} />
            {review !== (b.review ?? '') && (
              <Button size="sm" onClick={() => void patch({ review: review || null }, 'Resenha salva.')}>
                Salvar resenha
              </Button>
            )}
          </div>
        </Section>
      )}

      <Notes bookId={b.id} notes={q.data?.notes ?? []} reload={q.reload} />

      <Section title="Sessões">
        {q.data?.sessions.length ? q.data.sessions.map((s) => <SessionRow key={s.id} s={s} onClick={() => setSession(s)} />) : <p className="py-2 text-xs text-muted-foreground">Nenhuma sessão neste livro ainda.</p>}
      </Section>

      <Button variant="ghost" className="w-full text-destructive" onClick={() => setDel(true)}>
        <Trash2 className="h-4 w-4" />
        Remover livro
      </Button>

      <BookDialog open={edit} onOpenChange={setEdit} book={b} />
      <ManualSessionDialog open={manual} onOpenChange={setManual} preset={{ kind: 'reading', bookId: b.id }} />
      <SessionDeleteDialog session={session} onClose={() => setSession(null)} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        destructive
        title="Remover livro?"
        description="As sessões continuam no histórico (sem o livro). O XP do livro concluído e das metas dele é estornado."
        confirmLabel="Remover"
        onConfirm={async () => {
          try {
            await knowledgeApi.deleteBook(b.id);
            nav('/conhecimento/biblioteca');
          } catch (e) {
            toast.error(lifeError(e));
          }
        }}
      />
    </div>
  );
}

export function SessionDeleteDialog({ session, onClose }: { session: SessionView | null; onClose: () => void }) {
  return (
    <ConfirmDialog
      open={!!session}
      onOpenChange={(o) => !o && onClose()}
      destructive
      title="Excluir esta sessão?"
      description={session ? `${session.title} · ${fmtMin(session.activeMin)}${session.xp ? ` · o XP (+${session.xp}) será estornado` : ''}. Se a página do livro não mudou depois, ela volta para onde estava.` : ''}
      confirmLabel="Excluir"
      onConfirm={async () => {
        if (!session) return;
        try {
          await knowledgeApi.deleteSession(session.id);
          toast.success('Sessão excluída.');
          onClose();
        } catch (e) {
          toast.error(lifeError(e));
        }
      }}
    />
  );
}

export function Notes({ bookId, subjectId, notes, reload }: { bookId?: string; subjectId?: string; notes: NoteView[]; reload: () => void }) {
  const [kind, setKind] = useState<NoteKind>('note');
  const [text, setText] = useState('');
  const [page, setPage] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await knowledgeApi.createNote({ bookId: bookId ?? null, subjectId: subjectId ?? null, kind, content: text, page: bookId ? intOrNull(page) : null });
      setText('');
      setPage('');
      reload();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Notas">
      <div className="space-y-2 py-3">
        <Segmented size="sm" aria-label="Tipo de nota" value={kind} onChange={setKind} options={NOTE_KINDS.map((k) => ({ value: k, label: NOTE_KIND_LABEL[k] }))} />
        <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder={kind === 'excerpt' ? 'Um trecho curto que você destacou' : kind === 'reflection' ? 'O que isso mudou em você?' : 'Anotação'} data-testid="note-text" />
        <div className="flex gap-2">
          {bookId && <Input inputMode="numeric" value={page} onChange={(e) => setPage(e.target.value)} placeholder="Página" className="w-24" />}
          <Button size="sm" className="ml-auto" disabled={busy || !text.trim()} onClick={add} data-testid="note-add">
            Adicionar
          </Button>
        </div>
      </div>
      {notes.map((n) => (
        <div key={n.id} className="group flex gap-2 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              {NOTE_KIND_LABEL[n.kind]}
              {n.page != null ? ` · pág. ${n.page}` : ''}
            </p>
            <p className={cn('whitespace-pre-wrap text-sm', n.kind === 'excerpt' && 'border-l-2 border-primary/50 pl-2 italic')}>{n.content}</p>
          </div>
          <button
            type="button"
            aria-label="Excluir nota"
            className="self-start p-1 text-muted-foreground"
            onClick={async () => {
              try {
                await knowledgeApi.deleteNote(n.id);
                reload();
              } catch (e) {
                toast.error(lifeError(e));
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </Section>
  );
}
