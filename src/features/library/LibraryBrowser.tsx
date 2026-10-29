import { Suspense, lazy, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Filter, Search, Star, X } from 'lucide-react';
import { toast } from 'sonner';
import { setFavorite } from '@/db/library';
import { useLibrary } from '@/hooks/useLibrary';
import { MODALITIES } from '@/modules/training';
import {
  EMPTY_FILTERS,
  EQUIPMENT_NAME,
  FILTER_MUSCLES,
  LIBRARY_EQUIPMENT,
  MODALITY_FILTER_LABEL,
  MOVEMENT_LABEL,
  MOVEMENT_PATTERNS,
  MUSCLE_NAME,
  activeFilterCount,
  searchLibrary,
  type LibraryFilters,
  type LibraryItem,
  type LibraryKey,
} from '@/modules/exercises';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ExerciseThumb, VisualBadge } from '@/features/anatomy/ExerciseThumb';
import { ChipGroup, toggle } from './ChipGroup';

const ExerciseVisual = lazy(() => import('@/features/anatomy/ExerciseVisual'));

type Tab = 'todos' | 'favoritos' | 'recentes' | 'meus';
const PAGE = 30;

/**
 * Navegador completo da biblioteca para escolher um exercício durante o treino ou na edição do histórico (P20,
 * docs/BIBLIOTECA_VISUAL.md). Mesma busca e filtros da biblioteca (P17) + padrão de movimento, abas Favoritos, Recentes
 * e Meus exercícios, detalhes com músculos e demonstração. Carregado sob demanda: o catálogo e o 3D não entram no pacote
 * principal da tela de treino. Escolher não grava nada: quem chama mostra a prévia e confirma.
 */
export default function LibraryBrowser({
  open,
  onOpenChange,
  title,
  description,
  chooseLabel,
  exclude,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  chooseLabel: string;
  exclude?: ReadonlySet<LibraryKey>;
  onPick: (item: LibraryItem) => void;
}) {
  const { data, error } = useLibrary();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [tab, setTab] = useState<Tab>('todos');
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [detail, setDetail] = useState<LibraryItem | null>(null);
  useEffect(() => {
    if (open) {
      setQuery('');
      setDetail(null);
      setLimit(PAGE);
    }
  }, [open]);

  const effective = useMemo<LibraryFilters>(() => ({ ...filters, favoritesOnly: tab === 'favoritos', customOnly: tab === 'meus', archived: 'hide' }), [filters, tab]);
  const results = useMemo(() => {
    if (!data) return [];
    let list = searchLibrary(data.index, deferred, effective, data.favorites).filter((i) => !exclude?.has(i.key));
    if (tab === 'recentes') {
      const order = new Map(data.recent.map((k, i) => [k, i]));
      list = list.filter((i) => order.has(i.key)).sort((a, b) => order.get(a.key)! - order.get(b.key)!);
    }
    return list;
  }, [data, deferred, effective, exclude, tab]);
  useEffect(() => setLimit(PAGE), [deferred, effective]);
  const nFilters = activeFilterCount(filters);

  const toggleFavorite = async (item: LibraryItem) => {
    try {
      await setFavorite(item.key, !data?.favorites.has(item.key));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const fav = detail ? !!data?.favorites.has(detail.key) : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="library-browser">
        {detail ? (
          <>
            <DialogHeader>
              <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={() => setDetail(null)} data-testid="browser-back">
                <ArrowLeft /> Voltar à lista
              </Button>
              <DialogTitle className="break-words">{detail.name}</DialogTitle>
              <DialogDescription>
                {detail.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')} · {detail.equipment.map((e) => EQUIPMENT_NAME[e]).join(', ')} · {MODALITY_FILTER_LABEL[detail.modality]}
                {detail.movementPattern ? ` · ${MOVEMENT_LABEL[detail.movementPattern]}` : ''}
              </DialogDescription>
            </DialogHeader>
            <Suspense fallback={<div className="h-40 animate-pulse rounded-2xl bg-secondary/50" />}>
              <ExerciseVisual item={detail} instructions={detail.instructions} />
            </Suspense>
            {detail.instructions.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Como executar</h3>
                <ol className="list-decimal space-y-0.5 pl-5 text-sm">
                  {detail.instructions.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              </section>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant={fav ? 'secondary' : 'outline'} size="sm" aria-pressed={fav} onClick={() => void toggleFavorite(detail)}>
                <Star className={cn(fav && 'fill-current text-primary')} /> {fav ? 'Favorito' : 'Favoritar'}
              </Button>
              <Button className="flex-1" onClick={() => onPick(detail)} data-testid="browser-choose-detail">
                <Check /> {chooseLabel}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </DialogHeader>
            <Segmented
              size="sm"
              aria-label="Lista"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'todos', label: 'Todos' },
                { value: 'favoritos', label: 'Favoritos' },
                { value: 'recentes', label: 'Recentes' },
                { value: 'meus', label: 'Meus' },
              ]}
            />
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input type="search" aria-label="Pesquisar na biblioteca" placeholder="Nome, grupo, equipamento…" className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="browser-search" />
              </div>
              <Button variant={nFilters ? 'secondary' : 'outline'} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)} data-testid="browser-filters-toggle">
                <Filter /> {nFilters ? nFilters : ''}
                <span className="sr-only">Filtros</span>
              </Button>
            </div>
            {filtersOpen && (
              <div className="space-y-3 rounded-2xl border p-3" data-testid="browser-filters">
                <ChipGroup legend="Grupo muscular" options={FILTER_MUSCLES} value={filters.muscles} onToggle={(m) => setFilters({ ...filters, muscles: toggle(filters.muscles, m) })} label={(m) => MUSCLE_NAME[m]} />
                <ChipGroup legend="Equipamento" options={LIBRARY_EQUIPMENT} value={filters.equipment} onToggle={(e) => setFilters({ ...filters, equipment: toggle(filters.equipment, e) })} label={(e) => EQUIPMENT_NAME[e]} />
                <ChipGroup legend="Modalidade" options={MODALITIES} value={filters.modalities} onToggle={(m) => setFilters({ ...filters, modalities: toggle(filters.modalities, m) })} label={(m) => MODALITY_FILTER_LABEL[m]} />
                <ChipGroup legend="Padrão de movimento" options={MOVEMENT_PATTERNS} value={filters.movements ?? []} onToggle={(m) => setFilters({ ...filters, movements: toggle(filters.movements ?? [], m) })} label={(m) => MOVEMENT_LABEL[m]} />
                {nFilters > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                    <X /> Limpar filtros
                  </Button>
                )}
              </div>
            )}
            {error ? (
              <p role="alert" className="text-sm">
                Não foi possível ler os exercícios salvos neste aparelho ({error}).
              </p>
            ) : !data ? (
              <p className="text-sm text-muted-foreground">Carregando a biblioteca…</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="browser-count">
                  {results.length} {results.length === 1 ? 'exercício' : 'exercícios'}
                </p>
                {results.length === 0 && (
                  <p className="text-sm text-muted-foreground" data-testid="browser-empty">
                    {tab === 'favoritos' ? 'Nenhum favorito com esses filtros.' : tab === 'recentes' ? 'Nenhum exercício usado recentemente com origem da biblioteca.' : tab === 'meus' ? 'Nenhum exercício personalizado. Crie na Biblioteca.' : 'Nenhum exercício encontrado.'}
                  </p>
                )}
                <ul className="space-y-1.5">
                  {results.slice(0, limit).map((item) => (
                    <li key={item.key} className="flex items-center gap-2 rounded-xl border p-1.5 pl-2" data-testid="browser-item">
                      <ExerciseThumb item={item} />
                      <button type="button" className="min-w-0 flex-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setDetail(item)} aria-label={`Detalhes de ${item.name}`}>
                        <span className="block break-words font-semibold">{item.name}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant="secondary">{item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}</Badge>
                          <span>{EQUIPMENT_NAME[item.equipment[0]]}</span>
                          {item.kind === 'custom' && <Badge variant="outline">meu</Badge>}
                          {data.favorites.has(item.key) && <Star className="h-3 w-3 fill-current text-primary" aria-label="favorito" />}
                          <VisualBadge item={item} />
                        </span>
                      </button>
                      <Button size="sm" variant="secondary" onClick={() => onPick(item)} aria-label={`${chooseLabel}: ${item.name}`} data-testid="browser-choose">
                        Escolher
                      </Button>
                    </li>
                  ))}
                </ul>
                {results.length > limit && (
                  <Button variant="outline" onClick={() => setLimit((l) => l + PAGE)}>
                    Mostrar mais ({results.length - limit})
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
