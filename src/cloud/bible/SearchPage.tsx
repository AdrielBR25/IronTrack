// Busca na Bíblia (Fase 05): referência ("João 3:16", "Sl 23") abre direto no leitor; palavras buscam no texto da
// tradução (no servidor, sem acento/caixa). Nada é gerado: os resultados são versículos reais com referência.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Search } from 'lucide-react';
import { BOOKS, parseQuery, passageKey } from '@shared/bible/canon.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { lifeError } from '../life/forms';
import { bibleApi } from './api';
import { TranslationCredit, readerLink } from './ui';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [text, setText] = useState(params.get('q') ?? '');
  const [book, setBook] = useState(params.get('livro') ?? '');
  const [res, setRes] = useState<{ total: number; hits: { ref: string; label: string; text: string }[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (q: string) => {
    setMsg(null);
    const p = parseQuery(q);
    if (p.kind === 'ref') return nav(readerLink(passageKey(p.ref)));
    if (p.kind === 'book' && !book) return nav(readerLink(`${p.book.id}.1`));
    if (p.kind === 'invalid') return setMsg(p.message);
    setBusy(true);
    try {
      const r = await bibleApi.search(q, book || null);
      setRes({ total: r.total ?? 0, hits: r.hits ?? [] });
    } catch (e) {
      setMsg(`${lifeError(e)} A busca por palavras precisa de conexão; a busca por referência funciona offline.`);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (params.get('q')) void run(params.get('q')!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-4 pb-10" data-testid="bible-search">
      <PageHeader
        title="Buscar"
        subtitle="Referência ou palavras"
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(text ? { q: text } : {});
          void run(text);
        }}
      >
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="João 3:16 ou “paz”" className="pl-9" aria-label="Buscar" data-testid="bible-search-input" />
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <NativeSelect value={book} onChange={(e) => setBook(e.target.value)} aria-label="Livro">
            <option value="">Toda a Bíblia</option>
            {BOOKS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" disabled={busy || !text.trim()}>
            Buscar
          </Button>
        </div>
      </form>
      {msg && <p className="rounded-xl bg-secondary p-3 text-sm">{msg}</p>}
      {res && (
        <>
          <p className="px-1 text-xs text-muted-foreground">{res.total ? `${res.total} versículo(s)${res.total > res.hits.length ? ` · mostrando ${res.hits.length}` : ''}` : 'Nada encontrado nesta tradução.'}</p>
          <Card>
            <CardContent className="divide-y divide-border/60 px-4 py-1">
              {res.hits.map((h) => (
                <Link key={h.ref} to={readerLink(h.ref)} className="block py-2.5" data-testid="bible-search-hit">
                  <span className="block text-xs font-semibold">{h.label}</span>
                  <span className="block font-serif text-sm text-muted-foreground">{h.text}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        </>
      )}
      <TranslationCredit />
    </div>
  );
}
