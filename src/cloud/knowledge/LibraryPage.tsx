// Biblioteca pessoal (Fase 04): estante visual com capas, filtros por status/categoria e busca. Sem APIs externas: a
// capa é uma foto reduzida no aparelho ou uma capa gerada.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import { BOOK_STATUS, BOOK_STATUS_LABEL, type BookStatus } from '@shared/knowledge/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { knowledgeApi } from './api';
import { BookDialog } from './forms';
import { BookCard } from './ui';

export default function LibraryPage() {
  const q = useLifeQuery(() => knowledgeApi.books().then((r) => r.books));
  const [status, setStatus] = useState<BookStatus | 'all'>('all');
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [add, setAdd] = useState(false);
  const books = q.data ?? [];
  const cats = useMemo(() => [...new Set(books.map((b) => b.category).filter(Boolean) as string[])].sort(), [books]);
  const list = books.filter((b) => (status === 'all' || b.status === status) && (!cat || b.category === cat) && (!text || `${b.title} ${b.author ?? ''}`.toLowerCase().includes(text.toLowerCase())));
  const count = (s: BookStatus) => books.filter((b) => b.status === s).length;

  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-library">
      <PageHeader
        title="Biblioteca"
        subtitle={books.length ? `${books.length} livro(s) · ${count('done')} concluído(s)` : undefined}
        action={
          <div className="flex gap-1">
            <Link to="/conhecimento" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Conhecimento">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </div>
        }
      />
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar título ou autor" className="pl-9" aria-label="Buscar" />
        </div>
        <Button onClick={() => setAdd(true)} data-testid="book-add">
          <Plus className="h-4 w-4" />
          Livro
        </Button>
      </div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
        {(['all', ...BOOK_STATUS] as const).map((s) => (
          <button key={s} type="button" onClick={() => setStatus(s)} className={cn('shrink-0 rounded-full px-3 py-1.5 text-xs', status === s ? 'bg-primary font-semibold text-primary-foreground' : 'bg-secondary text-muted-foreground')}>
            {s === 'all' ? `Todos (${books.length})` : `${BOOK_STATUS_LABEL[s]} (${count(s)})`}
          </button>
        ))}
        {cats.length > 0 && (
          <NativeSelect value={cat} onChange={(e) => setCat(e.target.value)} className="h-8 w-auto shrink-0 text-xs" aria-label="Categoria">
            <option value="">Categoria</option>
            {cats.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </NativeSelect>
        )}
      </div>
      {q.loading && !q.data ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Carregando…</p>
      ) : list.length === 0 ? (
        <div className="space-y-3 rounded-2xl border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">{books.length ? 'Nenhum livro com esses filtros.' : 'Sua estante está vazia. Comece pelo livro que está na sua mesa.'}</p>
          {!books.length && (
            <Button variant="secondary" onClick={() => setAdd(true)}>
              Adicionar primeiro livro
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4">
          {list.map((b) => (
            <BookCard key={b.id} b={b} />
          ))}
        </div>
      )}
      <BookDialog open={add} onOpenChange={setAdd} />
    </div>
  );
}
