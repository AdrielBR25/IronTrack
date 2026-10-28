import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Filter, Plus, Search, Star, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppLayout';
import { customExerciseReferences, deleteCustomExercise, removeFavoriteRecord, setCustomArchived, setFavorite } from '@/db/library';
import { useRoutine } from '@/hooks/data';
import { useLibrary } from '@/hooks/useLibrary';
import type { CustomExercise, ExerciseLaterality, LibraryEquipment, LibraryMuscle, TrainingModality } from '@/lib/types';
import { cn } from '@/lib/utils';
import { MODALITIES } from '@/modules/training';
import {
  EMPTY_FILTERS,
  EQUIPMENT_NAME,
  FILTER_MUSCLES,
  LIBRARY_EQUIPMENT,
  MODALITY_FILTER_LABEL,
  MUSCLE_NAME,
  SUGGESTION_REASON_LABEL,
  activeFilterCount,
  anchorFromTemplate,
  duplicateFields,
  libraryKeyOf,
  searchLibrary,
  suggest,
  type CustomFields,
  type LibraryFilters,
  type LibraryItem,
  type LibraryKey,
} from '@/modules/exercises';
import { ExerciseDetailDialog } from '@/features/library/ExerciseDetailDialog';
import { CustomExerciseDialog } from '@/features/library/CustomExerciseDialog';
import { AddToWorkoutFlow, type WorkoutTarget } from '@/features/library/AddToWorkoutFlow';
import { SubstituteDialog } from '@/features/library/SubstituteDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { ConfirmDialog } from '@/components/ui/confirm';

type Tab = 'todos' | 'favoritos' | 'meus';
const PAGE = 60;

function ChipGroup<T extends string>({ legend, options, value, onToggle, label }: { legend: string; options: readonly T[]; value: readonly T[]; onToggle: (v: T) => void; label: (v: T) => string }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o);
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(o)}
              className={cn('min-h-9 rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', on ? 'border-primary bg-primary/10 font-medium text-foreground' : 'text-muted-foreground')}
            >
              {on ? '✓ ' : ''}
              {label(o)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

const toggle = <T,>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/**
 * Biblioteca de exercícios (IronTrack 2.0 F01/P17, docs/BIBLIOTECA_EXERCICIOS.md). Funciona offline: catálogo estático
 * no próprio pacote desta tela (carregada sob demanda) + personalizados e favoritos do perfil no IndexedDB.
 * Modos pela URL: `?para=<rotina>/<treino>` adiciona à ficha; `&substituir=<id do exercício>` troca um exercício.
 */
export default function ExerciseLibraryPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const para = params.get('para');
  const [destRoutineId, destWorkoutId] = para ? para.split('/') : [undefined, undefined];
  const replaceId = params.get('substituir');
  const destRoutine = useRoutine(destRoutineId);
  const destWorkout = destRoutine?.workouts.find((w) => w.id === destWorkoutId);
  const target: WorkoutTarget | null = destRoutine && destWorkout ? { routineId: destRoutine.id, workoutId: destWorkout.id } : null;
  const replacing = replaceId ? (destWorkout?.exercises.find((e) => e.id === replaceId) ?? null) : null;
  const backToEditor = () => navigate(destRoutine && destWorkout ? `/treinos/${destRoutine.id}/${destWorkout.id}` : '/treinos');

  const { data, error } = useLibrary();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [tab, setTab] = useState<Tab>('todos');
  const [showArchived, setShowArchived] = useState(false);
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [detailKey, setDetailKey] = useState<LibraryKey | null>(null);
  const [adding, setAdding] = useState<LibraryItem | null>(null);
  const [substitute, setSubstitute] = useState<LibraryItem | null>(null);
  const [form, setForm] = useState<{ open: boolean; editing: CustomExercise | null; initial: CustomFields | null }>({ open: false, editing: null, initial: null });
  const [usage, setUsage] = useState<{ templates: number; sessions: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CustomExercise | null>(null);

  const effective: LibraryFilters = useMemo(
    () => ({ ...filters, favoritesOnly: filters.favoritesOnly || tab === 'favoritos', customOnly: filters.customOnly || tab === 'meus', archived: tab === 'meus' && showArchived ? 'only' : 'hide' }),
    [filters, tab, showArchived],
  );
  const results = useMemo(() => (data ? searchLibrary(data.index, deferredQuery, effective, data.favorites) : []), [data, deferredQuery, effective]);
  useEffect(() => setLimit(PAGE), [deferredQuery, effective]);

  const detail = detailKey && data ? (data.byKey.get(detailKey) ?? null) : null;
  const detailCustom = detail?.kind === 'custom' ? (data?.customs.find((c) => c.id === detail.refId) ?? null) : null;
  useEffect(() => {
    setUsage(null);
    if (detailCustom) void customExerciseReferences(detailCustom.id).then(setUsage);
  }, [detailCustom?.id, detailCustom?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const nFilters = activeFilterCount(filters);
  const showSuggestions = !!data && !deferredQuery.trim() && nFilters === 0 && tab === 'todos';
  const suggestions = useMemo(() => {
    if (!data || !showSuggestions) return [];
    const inWorkout = new Set((destWorkout?.exercises ?? []).map(libraryKeyOf).filter((k): k is LibraryKey => !!k));
    return suggest({ items: data.items, favorites: data.favorites, recent: data.recent, anchor: replacing ? anchorFromTemplate(replacing) : null, exclude: replacing ? undefined : inWorkout, limit: 6 });
  }, [data, showSuggestions, replacing, destWorkout]);

  const toggleFavorite = async (item: LibraryItem) => {
    try {
      const on = await setFavorite(item.key, !data?.favorites.has(item.key));
      toast.success(on ? `${item.name} nos favoritos` : `${item.name} removido dos favoritos`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const choose = (item: LibraryItem) => {
    if (replacing) setSubstitute(item);
    else setAdding(item);
  };
  const actionLabel = replacing ? 'Escolher como substituto' : target ? `Adicionar ao Treino ${destWorkout?.label}` : 'Adicionar à ficha';

  const listCard = (item: LibraryItem, reason?: string) => {
    const fav = !!data?.favorites.has(item.key);
    const inWorkout = !!destWorkout?.exercises.some((e) => libraryKeyOf(e) === item.key);
    return (
      <Card key={item.key} className="flex items-center gap-2 p-2 pl-3" data-testid="library-item">
        <button className="min-w-0 flex-1 py-1 text-left" onClick={() => setDetailKey(item.key)}>
          <span className="block truncate font-semibold">{item.name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="secondary">{item.primaryMuscles.map((m) => MUSCLE_NAME[m]).join(', ')}</Badge>
            <span>{EQUIPMENT_NAME[item.equipment[0]]}</span>
            {MODALITY_FILTER_LABEL[item.modality] !== EQUIPMENT_NAME[item.equipment[0]] && <span>· {MODALITY_FILTER_LABEL[item.modality]}</span>}
            {item.laterality === 'unilateral' && item.modality !== 'cardio' && <Badge variant="outline">unilateral</Badge>}
            {item.kind === 'custom' && <Badge variant="outline">meu</Badge>}
            {item.archived && <Badge variant="warn">arquivado</Badge>}
            {inWorkout && <Badge variant="outline">já na ficha</Badge>}
          </span>
          {reason && <span className="mt-0.5 block text-xs text-primary">{reason}</span>}
        </button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-pressed={fav}
          aria-label={fav ? `Remover ${item.name} dos favoritos` : `Favoritar ${item.name}`}
          onClick={() => void toggleFavorite(item)}
          data-testid="favorite-toggle"
        >
          <Star className={cn(fav && 'fill-current text-primary')} />
        </Button>
        {(target || replacing) && !item.archived && (
          <Button size="icon-sm" variant="secondary" aria-label={`${replacing ? 'Escolher' : 'Adicionar'} ${item.name}`} onClick={() => choose(item)} data-testid="library-choose">
            <Plus />
          </Button>
        )}
      </Card>
    );
  };

  const filterPanel = (
    <div className="space-y-4" data-testid="library-filters">
      <ChipGroup legend="Grupo muscular" options={FILTER_MUSCLES} value={filters.muscles} onToggle={(m: LibraryMuscle) => setFilters({ ...filters, muscles: toggle(filters.muscles, m) })} label={(m) => MUSCLE_NAME[m]} />
      <ChipGroup legend="Equipamento" options={LIBRARY_EQUIPMENT} value={filters.equipment} onToggle={(e: LibraryEquipment) => setFilters({ ...filters, equipment: toggle(filters.equipment, e) })} label={(e) => EQUIPMENT_NAME[e]} />
      <ChipGroup legend="Modalidade" options={MODALITIES} value={filters.modalities} onToggle={(m: TrainingModality) => setFilters({ ...filters, modalities: toggle(filters.modalities, m) })} label={(m) => MODALITY_FILTER_LABEL[m]} />
      <ChipGroup
        legend="Execução e listas"
        options={['bilateral', 'unilateral', 'favoritos', 'personalizados'] as const}
        value={[...(filters.laterality ? [filters.laterality] : []), ...(filters.favoritesOnly ? (['favoritos'] as const) : []), ...(filters.customOnly ? (['personalizados'] as const) : [])]}
        onToggle={(v) => {
          if (v === 'favoritos') setFilters({ ...filters, favoritesOnly: !filters.favoritesOnly });
          else if (v === 'personalizados') setFilters({ ...filters, customOnly: !filters.customOnly });
          else setFilters({ ...filters, laterality: filters.laterality === v ? null : (v as ExerciseLaterality) });
        }}
        label={(v) => ({ bilateral: 'Bilateral', unilateral: 'Unilateral', favoritos: 'Favoritos', personalizados: 'Personalizados' })[v]}
      />
      {nFilters > 0 && (
        <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)} data-testid="clear-filters">
          <X /> Limpar filtros
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Exercícios"
        subtitle="Biblioteca offline e meus exercícios"
        action={
          <Button size="icon" aria-label="Criar exercício" title="Criar exercício" onClick={() => setForm({ open: true, editing: null, initial: null })} data-testid="create-custom">
            <Plus />
          </Button>
        }
      />

      {(target || para) && (
        <div className="flex items-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-sm" role="status" data-testid="library-destination">
          <Button variant="ghost" size="icon-sm" aria-label="Voltar à ficha" onClick={backToEditor}>
            <ArrowLeft />
          </Button>
          <p className="min-w-0 flex-1">
            {!destRoutine || !destWorkout
              ? 'A ficha de destino não existe mais (talvez tenha sido excluída em outra aba).'
              : replaceId && !replacing
                ? 'O exercício a substituir não está mais na ficha.'
                : replacing
                  ? <>Substituindo <span className="font-semibold">{replacing.name}</span> no Treino {destWorkout.label}: escolha o substituto.</>
                  : <>Adicionando ao <span className="font-semibold">Treino {destWorkout.label} · {destWorkout.name}</span> ({destRoutine.name}).</>}
          </p>
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          aria-label="Pesquisar exercícios"
          placeholder="Pesquisar por nome, grupo, equipamento…"
          className="pl-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="library-search"
        />
      </div>

      <div className="flex items-center gap-2">
        <Segmented
          className="min-w-0 flex-1"
          aria-label="Lista"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'todos', label: 'Todos' },
            { value: 'favoritos', label: 'Favoritos' },
            { value: 'meus', label: 'Meus' },
          ]}
        />
        <Button variant="outline" className="shrink-0 md:hidden" aria-expanded={filtersOpen} aria-controls="library-filters-panel" onClick={() => setFiltersOpen((o) => !o)} data-testid="toggle-filters">
          <Filter /> Filtros{nFilters ? ` (${nFilters})` : ''}
        </Button>
      </div>
      {tab === 'meus' && (
        <Segmented
          size="sm"
          aria-label="Situação"
          value={showArchived ? 'arquivados' : 'ativos'}
          onChange={(v) => setShowArchived(v === 'arquivados')}
          options={[
            { value: 'ativos', label: 'Ativos' },
            { value: 'arquivados', label: 'Arquivados' },
          ]}
        />
      )}

      <div className="md:grid md:grid-cols-[15rem_1fr] md:gap-6">
        <aside id="library-filters-panel" className={cn('mb-4 rounded-2xl border p-3 md:mb-0 md:block md:self-start', filtersOpen ? 'block' : 'hidden')} aria-label="Filtros">
          {filterPanel}
        </aside>

        <section className="min-w-0 space-y-2" aria-label="Exercícios">
          {error ? (
            <Card className="p-4 text-sm" role="alert">
              Não foi possível ler os exercícios salvos neste aparelho ({error}). O catálogo padrão continua disponível depois de recarregar; nada foi apagado.
            </Card>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">Carregando a biblioteca…</p>
          ) : data.items.length === 0 ? (
            <Card className="p-4 text-sm">Catálogo indisponível neste momento. Recarregue a página.</Card>
          ) : (
            <>
              {showSuggestions && suggestions.length > 0 && (
                <div className="space-y-2" data-testid="library-suggestions">
                  <h2 className="text-sm font-semibold text-muted-foreground">{replacing ? 'Sugestões para substituir' : 'Sugestões'}</h2>
                  {suggestions.map((s) => listCard(s.item, SUGGESTION_REASON_LABEL[s.reason]))}
                  <h2 className="pt-2 text-sm font-semibold text-muted-foreground">Todos os exercícios</h2>
                </div>
              )}
              <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="library-count">
                {results.length} {results.length === 1 ? 'exercício' : 'exercícios'}
              </p>
              {tab === 'favoritos' && data.orphanFavorites.length > 0 && (
                <Card className="space-y-2 p-3 text-sm">
                  <p>{data.orphanFavorites.length} favorito(s) de exercícios que não existem mais nesta biblioteca. Eles não são trocados por outro exercício.</p>
                  <Button variant="outline" size="sm" onClick={() => void Promise.all(data.orphanFavorites.map((f) => removeFavoriteRecord(f.id)))}>
                    Remover favoritos indisponíveis
                  </Button>
                </Card>
              )}
              {data.invalidCustomIds.length > 0 && tab === 'meus' && (
                <p className="text-xs text-warn">{data.invalidCustomIds.length} exercício(s) salvo(s) com formato inválido foram ignorados (preservados no banco).</p>
              )}
              {results.length === 0 ? (
                <Card className="space-y-2 p-4 text-sm" data-testid="library-empty">
                  <p className="font-semibold">
                    {tab === 'favoritos' && !deferredQuery && !nFilters ? 'Nenhum favorito ainda.' : tab === 'meus' && !deferredQuery && !nFilters ? (showArchived ? 'Nenhum exercício arquivado.' : 'Você ainda não criou exercícios.') : 'Nenhum exercício encontrado.'}
                  </p>
                  {tab === 'favoritos' && <p className="text-muted-foreground">Toque na estrela de um exercício para guardá-lo aqui.</p>}
                  {(deferredQuery || nFilters > 0) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuery('');
                        setFilters(EMPTY_FILTERS);
                      }}
                    >
                      Limpar busca e filtros
                    </Button>
                  )}
                  {tab === 'meus' && !showArchived && (
                    <Button size="sm" onClick={() => setForm({ open: true, editing: null, initial: null })}>
                      <Plus /> Criar exercício
                    </Button>
                  )}
                </Card>
              ) : (
                results.slice(0, limit).map((item) => listCard(item))
              )}
              {results.length > limit && (
                <Button variant="outline" className="w-full" onClick={() => setLimit((l) => l + PAGE)}>
                  Mostrar mais ({results.length - limit})
                </Button>
              )}
            </>
          )}
        </section>
      </div>

      <ExerciseDetailDialog
        item={detail}
        onOpenChange={(o) => !o && setDetailKey(null)}
        favorite={!!detail && !!data?.favorites.has(detail.key)}
        onToggleFavorite={() => detail && void toggleFavorite(detail)}
        onAdd={detail ? () => (choose(detail), setDetailKey(null)) : undefined}
        addLabel={actionLabel}
        onDuplicate={detail ? () => (setForm({ open: true, editing: null, initial: duplicateFields(detail) }), setDetailKey(null)) : undefined}
        onEdit={detailCustom ? () => setForm({ open: true, editing: detailCustom, initial: null }) : undefined}
        onArchive={
          detailCustom
            ? async (archived) => {
                try {
                  await setCustomArchived(detailCustom.id, archived);
                  toast.success(archived ? 'Exercício arquivado: fichas e histórico não mudam' : 'Exercício restaurado');
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }
            : undefined
        }
        onDelete={detailCustom ? () => setConfirmDelete(detailCustom) : undefined}
        usage={detail?.kind === 'custom' ? usage : null}
      />
      <CustomExerciseDialog
        open={form.open}
        onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))}
        editing={form.editing}
        initialFields={form.initial}
        usage={form.editing ? usage : null}
        onSaved={(c) => {
          if (!form.editing) {
            setTab('meus');
            setShowArchived(false);
            setDetailKey(`custom:${c.id}`);
          }
        }}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        destructive
        title={`Excluir ${confirmDelete?.name}?`}
        description="Exclusão definitiva. Só é permitida porque o exercício não está em nenhuma ficha nem no histórico."
        confirmLabel="Excluir"
        onConfirm={async () => {
          if (!confirmDelete) return;
          try {
            await deleteCustomExercise(confirmDelete.id, confirmDelete.revision);
            setDetailKey(null);
            toast.success('Exercício excluído');
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      />
      <AddToWorkoutFlow
        item={adding}
        target={target}
        onClose={() => setAdding(null)}
        onAdded={(t) => {
          if (target) navigate(`/treinos/${t.routineId}/${t.workoutId}`);
        }}
      />
      {destRoutine && destWorkout && (
        <SubstituteDialog
          routineId={destRoutine.id}
          workoutId={destWorkout.id}
          current={replacing}
          item={substitute}
          onClose={() => setSubstitute(null)}
          onDone={() => {
            setSubstitute(null);
            backToEditor();
          }}
        />
      )}
    </div>
  );
}
