// Diário espiritual (Fase 05): reflexões, gratidões e anotações privadas, com data, passagem opcional, título,
// etiquetas e favorito. Busca sem acento. Nada daqui entra em compartilhamentos, relatórios públicos ou no XP.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Lock, Plus, Search, Star, Trash2 } from 'lucide-react';
import { formatKey, parseQuery, passageKey } from '@shared/bible/canon.ts';
import { REFLECTION_KIND_LABEL, type ReflectionKind, type ReflectionView } from '@shared/bible/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { localToday } from '../knowledge/ui';
import { bibleApi } from './api';
import { ReflectionRow } from './ui';

type Filter = 'all' | ReflectionKind | 'favorite';

export default function JournalPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [edit, setEdit] = useState<ReflectionView | 'new' | null>(params.get('nova') ? 'new' : null);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const list = useLifeQuery(() => bibleApi.reflections({ q: q || undefined, kind: filter !== 'all' && filter !== 'favorite' ? filter : undefined, favorite: filter === 'favorite' }).then((r) => r.reflections), [q, filter]);
  return (
    <div className="space-y-4 pb-10" data-testid="bible-journal">
      <PageHeader
        title="Diário espiritual"
        subtitle={
          <span className="flex items-center gap-1">
            <Lock className="h-3 w-3" /> Privado: só você vê
          </span>
        }
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Button className="w-full" onClick={() => setEdit('new')} data-testid="bible-journal-new">
        <Plus className="h-4 w-4" /> Nova reflexão ou gratidão
      </Button>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar no diário" className="pl-9" aria-label="Buscar no diário" />
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1 text-xs">
        {(['all', 'reflection', 'gratitude', 'note', 'favorite'] as Filter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={cn('shrink-0 rounded-full px-3 py-1.5', filter === f ? 'bg-primary text-primary-foreground' : 'bg-secondary')}>
            {f === 'all' ? 'Tudo' : f === 'favorite' ? 'Favoritas' : REFLECTION_KIND_LABEL[f]}
          </button>
        ))}
      </div>
      <Card>
        <CardContent className="divide-y divide-border/60 px-4 py-1">
          {(list.data ?? []).map((r) => (
            <ReflectionRow key={r.id} r={r} onClick={() => setEdit(r)} />
          ))}
          {list.data && !list.data.length && <p className="py-4 text-center text-sm text-muted-foreground">{q || filter !== 'all' ? 'Nada encontrado.' : 'Seu diário está vazio. Escreva quando quiser — sem metas nem cobranças.'}</p>}
        </CardContent>
      </Card>
      <ReflectionDialog
        value={edit}
        onClose={() => {
          setEdit(null);
          if (params.get('nova')) setParams({});
        }}
      />
    </div>
  );
}

function ReflectionDialog({ value, onClose }: { value: ReflectionView | 'new' | null; onClose: () => void }) {
  const cur = value && value !== 'new' ? value : null;
  const [kind, setKind] = useState<ReflectionKind>('reflection');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [ref, setRef] = useState('');
  const [tags, setTags] = useState('');
  const [date, setDate] = useState(localToday());
  const [fav, setFav] = useState(false);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  useEffect(() => {
    setKind(cur?.kind ?? 'reflection');
    setTitle(cur?.title ?? '');
    setContent(cur?.content ?? '');
    setRef(cur?.ref ? formatKey(cur.ref) : '');
    setTags(cur?.tags.join(', ') ?? '');
    setDate(cur?.date ?? localToday());
    setFav(cur?.favorite ?? false);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsedRef = () => {
    if (!ref.trim()) return null;
    const p = parseQuery(ref);
    if (p.kind === 'ref') return passageKey(p.ref);
    throw new Error(p.kind === 'invalid' ? p.message : 'Passagem não reconhecida (ex.: Salmo 23 ou João 3:16).');
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = { kind, title: title || null, content, ref: parsedRef(), tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8), favorite: fav, date };
      if (cur) await bibleApi.updateReflection(cur.id, cur.version, body);
      else await bibleApi.createReflection(body);
      toast.success('Salvo no diário.');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error && !('code' in e) ? e.message : lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cur ? 'Editar' : 'Nova entrada'}</DialogTitle>
          <DialogDescription>Privada. A IA só lê o diário quando você pede (e dá para desligar em Ajustes).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Segmented
            aria-label="Tipo"
            value={kind}
            onChange={setKind}
            size="sm"
            options={[
              { value: 'reflection', label: 'Reflexão' },
              { value: 'gratitude', label: 'Gratidão' },
              { value: 'note', label: 'Anotação' },
            ]}
          />
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título (opcional)" maxLength={120} />
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} maxLength={8000} placeholder={kind === 'gratitude' ? 'Hoje sou grato por…' : 'Escreva com suas palavras…'} data-testid="bible-journal-text" />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Passagem (opcional)</Label>
              <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Salmo 23" />
            </div>
            <div className="space-y-1">
              <Label>Data</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Etiquetas, separadas por vírgula" />
          <button type="button" onClick={() => setFav((x) => !x)} className="flex items-center gap-2 text-sm">
            <Star className={cn('h-4 w-4', fav ? 'fill-primary text-primary' : 'text-muted-foreground')} /> Favorita
          </button>
        </div>
        <DialogFooter>
          {cur && (
            <Button variant="ghost" onClick={() => setDel(true)}>
              <Trash2 className="h-4 w-4" /> Excluir
            </Button>
          )}
          <Button disabled={busy || !content.trim()} onClick={() => void save()} data-testid="bible-journal-save">
            Salvar
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={del}
          onOpenChange={setDel}
          title="Excluir esta entrada?"
          destructive
          confirmLabel="Excluir"
          onConfirm={async () => {
            if (!cur) return;
            try {
              await bibleApi.deleteReflection(cur.id);
              onClose();
            } catch (e) {
              toast.error(lifeError(e));
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
