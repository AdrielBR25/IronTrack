import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { EMPTY_FILTERS, EQUIPMENT_NAME, MODALITY_FILTER_LABEL, MUSCLE_NAME, searchLibrary, type LibraryIndex, type LibraryItem, type LibraryKey } from '@/modules/exercises';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const PAGE = 30;

/**
 * Escolha manual de um exercício da biblioteca (P18): busca local com as mesmas regras da biblioteca, sugestões
 * opcionais no topo (com o motivo) e lista paginada (nunca centenas de itens de uma vez). Arquivados não aparecem.
 * Escolher não grava nada: quem chama mostra a confirmação.
 */
export function LibraryPickerDialog({
  open,
  onOpenChange,
  title,
  description,
  index,
  suggestions = [],
  exclude,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  index: LibraryIndex;
  suggestions?: { item: LibraryItem; label: string }[];
  exclude?: ReadonlySet<LibraryKey>;
  onPick: (item: LibraryItem) => void;
}) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => {
    if (open) {
      setQuery('');
      setLimit(PAGE);
    }
  }, [open]);
  useEffect(() => setLimit(PAGE), [deferred]);
  const results = useMemo(() => searchLibrary(index, deferred, EMPTY_FILTERS).filter((i) => !exclude?.has(i.key)), [index, deferred, exclude]);

  const row = (item: LibraryItem, hint?: string) => (
    <li key={`${hint ? 's' : 'r'}:${item.key}`}>
      <button
        type="button"
        className="w-full rounded-xl border p-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onPick(item)}
        data-testid="picker-item"
      >
        <span className="block break-words font-semibold">{item.name}</span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="secondary">{item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}</Badge>
          <span>{EQUIPMENT_NAME[item.equipment[0]]}</span>
          <span>· {MODALITY_FILTER_LABEL[item.modality]}</span>
          {item.laterality === 'unilateral' && item.modality !== 'cardio' && <Badge variant="outline">unilateral</Badge>}
          {item.kind === 'custom' && <Badge variant="outline">meu</Badge>}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-primary">{hint}</span>}
      </button>
    </li>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="library-picker">
        <DialogHeader>
          <DialogTitle className="break-words">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" aria-label="Pesquisar na biblioteca" placeholder="Pesquisar por nome, grupo, equipamento…" className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="picker-search" />
        </div>
        {!deferred.trim() && suggestions.length > 0 && (
          <section aria-label="Sugestões" className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sugestões (confira antes de confirmar)</h3>
            <ul className="space-y-1.5">{suggestions.map((s) => row(s.item, s.label))}</ul>
          </section>
        )}
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {results.length} {results.length === 1 ? 'exercício' : 'exercícios'}
        </p>
        <ul className="space-y-1.5">{results.slice(0, limit).map((i) => row(i))}</ul>
        {results.length > limit && (
          <Button variant="outline" onClick={() => setLimit((l) => l + PAGE)}>
            Mostrar mais ({results.length - limit})
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
