import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, ChevronDown, Link2, Link2Off, Search, SkipForward } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppLayout';
import { applyLinks, unlinkExercise, type LinkBatchResult } from '@/db/library';
import { useCurrentProfile, useRoutines } from '@/hooks/data';
import { useLibrary } from '@/hooks/useLibrary';
import { cn } from '@/lib/utils';
import {
  MATCH_TIER_LABEL,
  instanceFingerprint,
  legacyInventory,
  libraryKeyOf,
  recognitionSummary,
  recognize,
  refOfItem,
  type LibraryItem,
  type MatchCandidate,
  type Recognition,
  type SheetEntry,
} from '@/modules/exercises';
import { planSummary } from '@/features/workout/modelFormat';
import { LibraryPickerDialog } from '@/features/library/LibraryPickerDialog';
import { LinkComparisonView, LinkConfirmDialog, linkResultSummary } from '@/features/library/LinkConfirmDialog';
import { useModelCapability } from '@/features/compat/CompatGuard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const entryKey = (e: SheetEntry) => `${e.routineId}/${e.workoutId}/${e.exercise.id}`;
const groupKey = (e: SheetEntry) => `${e.routineId}/${e.workoutId}`;

/** Agrupa por rotina e treino, mantendo a ordem do inventário. */
function groupEntries(list: readonly SheetEntry[]) {
  const groups: { key: string; title: string; routineName: string; entries: SheetEntry[] }[] = [];
  for (const e of list) {
    const k = groupKey(e);
    let g = groups.find((x) => x.key === k);
    if (!g) groups.push((g = { key: k, title: `Ficha ${e.workoutLabel} — ${e.workoutName}`, routineName: e.routineName, entries: [] }));
    g.entries.push(e);
  }
  return groups;
}

function Counter({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="rounded-2xl border p-3" data-testid={testId}>
      <p className="font-display text-2xl font-bold tabular">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

type Review = { entries: SheetEntry[]; index: number; picks: Map<string, { item: LibraryItem; candidate: MatchCandidate | null }>; skipped: Set<string>; result: LinkBatchResult | null };

/**
 * Reconhecimento assistido de exercícios antigos (IronTrack 2.0 F01/P18, docs/RECONHECIMENTO_EXERCICIOS.md).
 * Lista os exercícios das fichas sem origem na biblioteca, agrupados por rotina e treino, com sugestões explicadas.
 * Nada é associado sozinho: cada associação passa por uma confirmação (individual ou revisão em lote), e só a
 * referência de origem é gravada. `?treino=<rotina>/<treino>` limita a lista a um treino (vindo do editor).
 */
export default function ExerciseRecognitionPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const only = params.get('treino');
  const routines = useRoutines();
  const profile = useCurrentProfile();
  const { data, error } = useLibrary();
  const outdated = useModelCapability().newer;
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [showIgnored, setShowIgnored] = useState(false);
  const [showLinked, setShowLinked] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ entry: SheetEntry; item: LibraryItem; candidate: MatchCandidate | null } | null>(null);
  const [picking, setPicking] = useState<{ entry: SheetEntry; forReview: boolean } | null>(null);
  const [toUnlink, setToUnlink] = useState<SheetEntry | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);

  const inventory = useMemo(() => {
    const inv = legacyInventory(routines ?? [], profile?.id);
    if (!only) return inv;
    const keep = (e: SheetEntry) => groupKey(e) === only;
    const unlinked = inv.unlinked.filter(keep);
    return { unlinked, linked: inv.linked.filter(keep), workoutsAffected: unlinked.length ? 1 : 0 };
  }, [routines, profile?.id, only]);
  const recognitions = useMemo(() => {
    const m = new Map<string, Recognition>();
    if (data) for (const e of inventory.unlinked) m.set(e.exercise.id, recognize(e.exercise, data.items));
    return m;
  }, [inventory, data]);
  const summary = recognitionSummary(inventory, recognitions);
  const visible = inventory.unlinked.filter((e) => !ignored.has(entryKey(e)));
  const ignoredList = inventory.unlinked.filter((e) => ignored.has(entryKey(e)));
  const back = () => {
    if (only) navigate(`/treinos/${only}`);
    else navigate('/exercicios');
  };
  const snap = (e: SheetEntry): SheetEntry => ({ ...e, exercise: { ...e.exercise } });

  const toggleSelect = (k: string) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const startReview = () => {
    const entries = selected.map((k) => inventory.unlinked.find((e) => entryKey(e) === k)).filter((e): e is SheetEntry => !!e).map(snap);
    if (!entries.length) return;
    const picks = new Map<string, { item: LibraryItem; candidate: MatchCandidate | null }>();
    setReview({ entries, index: 0, picks, skipped: new Set(), result: null });
  };

  const unlink = async (e: SheetEntry) => {
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return;
    }
    try {
      const r = await unlinkExercise(e.routineId, e.workoutId, e.exercise.id, instanceFingerprint(e.exercise));
      toast.success(r.changed ? `Associação de ${e.exercise.name} desfeita. A ficha e o histórico não mudaram.` : 'Este exercício já estava sem associação.');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const applyReview = async () => {
    if (!review || busy) return;
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return;
    }
    const reqs = review.entries
      .filter((e) => review.picks.has(entryKey(e)))
      .map((e) => ({ routineId: e.routineId, workoutId: e.workoutId, id: e.exercise.id, expected: instanceFingerprint(e.exercise), ref: refOfItem(review.picks.get(entryKey(e))!.item), name: e.exercise.name }));
    if (!reqs.length) return;
    setBusy(true);
    try {
      const result = await applyLinks(reqs);
      setReview({ ...review, result });
      if (result.applied) {
        toast.success(linkResultSummary(result));
        setSelected([]);
        setSelecting(false);
      } else toast.error('Nada foi gravado. Veja o motivo de cada exercício.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const suggestionBlock = (e: SheetEntry) => {
    const rec = recognitions.get(e.exercise.id);
    const top = rec?.candidates[0];
    if (!rec || !top)
      return (
        <p className="text-xs text-muted-foreground" data-testid="recognition-none">
          {MATCH_TIER_LABEL.nenhuma}: use "Escolher na biblioteca".
        </p>
      );
    return (
      <div className="space-y-0.5 text-xs" data-testid="recognition-suggestion">
        <p>
          <Badge variant={top.tier === 'forte' ? 'default' : 'outline'}>{MATCH_TIER_LABEL[top.tier]}</Badge> <span className="text-muted-foreground">Sugestão:</span>{' '}
          <span className="font-semibold">{top.item.name}</span>
        </p>
        <p className="text-muted-foreground">{top.explanation}</p>
        {top.warnings.length > 0 && <p className="text-warn">{top.warnings.length === 1 ? '1 aviso' : `${top.warnings.length} avisos`} para conferir antes de associar.</p>}
        {rec.candidates.length > 1 && <p className="text-muted-foreground">Outras possibilidades: {rec.candidates.slice(1).map((c) => c.item.name).join(', ')}.</p>}
      </div>
    );
  };

  const row = (e: SheetEntry, isIgnored = false) => {
    const k = entryKey(e);
    const top = recognitions.get(e.exercise.id)?.candidates[0] ?? null;
    const sel = selected.includes(k);
    return (
      <Card key={k} className={cn('space-y-2 p-3', sel && 'border-primary')} data-testid="legacy-exercise">
        <div className="flex items-start gap-2">
          {selecting && !isIgnored && (
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
              checked={sel}
              onChange={() => toggleSelect(k)}
              aria-label={`Selecionar ${e.exercise.name}`}
              data-testid="legacy-select"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="break-words font-semibold">{e.exercise.name}</p>
            <p className="text-xs text-muted-foreground">
              {e.exercise.muscleGroup} · <span className="tabular">{planSummary(e.exercise)}</span> · <span className="italic">Sem associação.</span>
            </p>
          </div>
        </div>
        {suggestionBlock(e)}
        {!selecting && (
          <div className="flex flex-wrap gap-1.5">
            {top && (
              <Button size="sm" onClick={() => setConfirm({ entry: snap(e), item: top.item, candidate: top })} data-testid="legacy-link">
                <Link2 /> Associar
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setPicking({ entry: snap(e), forReview: false })} data-testid="legacy-choose">
              <Search /> {top ? 'Escolher outro' : 'Escolher na biblioteca'}
            </Button>
            {isIgnored ? (
              <Button size="sm" variant="ghost" onClick={() => setIgnored((s) => new Set([...s].filter((x) => x !== k)))}>
                Voltar à lista
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setIgnored((s) => new Set(s).add(k))} data-testid="legacy-ignore">
                <SkipForward /> Ignorar por enquanto
              </Button>
            )}
          </div>
        )}
      </Card>
    );
  };

  const current = review && !review.result && review.index < review.entries.length ? review.entries[review.index] : null;
  const currentPick = current ? (review!.picks.get(entryKey(current)) ?? null) : null;
  const currentTop = current ? (recognitions.get(current.exercise.id)?.candidates[0] ?? null) : null;
  const reviewShown = current ? (currentPick ?? (currentTop ? { item: currentTop.item, candidate: currentTop } : null)) : null;
  const atSummary = !!review && !review.result && review.index >= review.entries.length;
  const advance = (patch: (r: Review) => void) =>
    setReview((r) => {
      if (!r) return r;
      const next: Review = { ...r, picks: new Map(r.picks), skipped: new Set(r.skipped) };
      patch(next);
      next.index = r.index + 1;
      return next;
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reconhecer exercícios antigos"
        subtitle="Associe exercícios das suas fichas à biblioteca"
        action={
          <Button variant="ghost" size="icon" aria-label="Voltar" onClick={back}>
            <ArrowLeft />
          </Button>
        }
      />
      <p className="text-sm text-muted-foreground">
        Exercícios criados antes da biblioteca não têm origem. Aqui você associa cada um manualmente: nada é associado sozinho, e associar grava só a referência de origem.
        Nome, séries, carga, metas, sessões antigas e histórico continuam iguais.
      </p>
      {only && (
        <p className="text-sm" role="status">
          Mostrando só um treino.{' '}
          <button className="font-medium text-primary underline-offset-2 hover:underline" onClick={() => navigate('/exercicios/reconhecer')}>
            Ver todas as fichas
          </button>
        </p>
      )}

      {error ? (
        <Card className="p-4 text-sm" role="alert">
          Não foi possível ler a biblioteca ({error}). Nada foi alterado.
        </Card>
      ) : !data || !routines ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <>
          <section aria-label="Resumo" className="grid grid-cols-2 gap-2 min-[520px]:grid-cols-3 md:grid-cols-5" data-testid="recognition-summary">
            <Counter label="sem referência" value={summary.unlinked} testId="count-unlinked" />
            <Counter label="fichas afetadas" value={summary.workoutsAffected} testId="count-workouts" />
            <Counter label="com sugestão" value={summary.withSuggestions} testId="count-suggested" />
            <Counter label="exigem busca manual" value={summary.manual} testId="count-manual" />
            <Counter label="já associados" value={summary.linked} testId="count-linked" />
          </section>

          {inventory.unlinked.length === 0 ? (
            <Card className="space-y-1 p-4 text-sm" data-testid="recognition-empty">
              <p className="font-semibold">Nenhum exercício sem referência.</p>
              <p className="text-muted-foreground">Todos os exercícios {only ? 'deste treino' : 'das suas fichas'} já têm origem na biblioteca.</p>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={selecting ? 'secondary' : 'outline'}
                  aria-pressed={selecting}
                  onClick={() => {
                    setSelecting((s) => !s);
                    setSelected([]);
                  }}
                  data-testid="toggle-batch"
                >
                  <Check /> {selecting ? 'Cancelar seleção' : 'Selecionar vários'}
                </Button>
                {selecting && (
                  <p className="text-sm text-muted-foreground" aria-live="polite">
                    {selected.length} {selected.length === 1 ? 'selecionado' : 'selecionados'}
                  </p>
                )}
              </div>
              {groupEntries(visible).map((g) => (
                <section key={g.key} className="space-y-2" aria-label={g.title}>
                  <h2 className="text-sm font-semibold">
                    {g.title} <span className="font-normal text-muted-foreground">· {g.routineName}</span>
                  </h2>
                  {g.entries.map((e) => row(e))}
                </section>
              ))}
              {visible.length === 0 && <p className="text-sm text-muted-foreground">Todos os exercícios restantes foram ignorados por enquanto.</p>}
              {ignoredList.length > 0 && (
                <section className="space-y-2">
                  <Button variant="ghost" size="sm" aria-expanded={showIgnored} onClick={() => setShowIgnored((s) => !s)}>
                    <ChevronDown className={cn('transition-transform', showIgnored && 'rotate-180')} /> Ignorados por enquanto ({ignoredList.length})
                  </Button>
                  {showIgnored && ignoredList.map((e) => row(e, true))}
                </section>
              )}
              {selecting && (
                <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-10 md:bottom-4">
                  <Button size="lg" className="w-full shadow-lg" disabled={!selected.length} onClick={startReview} data-testid="batch-review">
                    Revisar {selected.length || ''} {selected.length === 1 ? 'selecionado' : 'selecionados'}
                  </Button>
                </div>
              )}
            </>
          )}

          {inventory.linked.length > 0 && (
            <section className="space-y-2">
              <Button variant="ghost" size="sm" aria-expanded={showLinked} onClick={() => setShowLinked((s) => !s)} data-testid="toggle-linked">
                <ChevronDown className={cn('transition-transform', showLinked && 'rotate-180')} /> Já associados ({inventory.linked.length})
              </Button>
              {showLinked &&
                inventory.linked.map((e) => {
                  const k = libraryKeyOf(e.exercise)!;
                  const origin = data.byKey.get(k);
                  return (
                    <Card key={entryKey(e)} className="flex items-center gap-2 p-3" data-testid="linked-exercise">
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-semibold">{e.exercise.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Ficha {e.workoutLabel} · origem: {origin ? origin.name : 'item que não está mais na biblioteca'}
                        </p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setToUnlink(snap(e))} data-testid="linked-unlink">
                        <Link2Off /> Desfazer
                      </Button>
                    </Card>
                  );
                })}
            </section>
          )}
        </>
      )}

      <LinkConfirmDialog entry={confirm?.entry ?? null} item={confirm?.item ?? null} candidate={confirm?.candidate} onClose={() => setConfirm(null)} />

      {data && (
        <LibraryPickerDialog
          open={!!picking}
          onOpenChange={(o) => !o && setPicking(null)}
          title={picking ? `Associar "${picking.entry.exercise.name}" a…` : ''}
          description="Escolher abre a confirmação. Nada é gravado antes dela."
          index={data.index}
          suggestions={picking ? (recognitions.get(picking.entry.exercise.id)?.candidates ?? []).map((c) => ({ item: c.item, label: `${c.tier === 'forte' ? 'Correspondência forte' : 'Correspondência possível'}: ${c.explanation}` })) : []}
          onPick={(item) => {
            if (!picking) return;
            const candidate = (recognitions.get(picking.entry.exercise.id)?.candidates ?? []).find((c) => c.item.key === item.key) ?? null;
            if (picking.forReview && review) {
              const k = entryKey(picking.entry);
              setReview({ ...review, picks: new Map(review.picks).set(k, { item, candidate }) });
            } else setConfirm({ entry: picking.entry, item, candidate });
            setPicking(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!toUnlink}
        onOpenChange={(o) => !o && setToUnlink(null)}
        title={`Desfazer a associação de ${toUnlink?.exercise.name}?`}
        description="Só a referência de origem sai. O exercício continua na ficha com o mesmo nome, ID e configuração; metas, sessões, histórico, favoritos e o exercício da biblioteca não mudam. Você pode associar de novo depois."
        confirmLabel="Desfazer associação"
        onConfirm={() => (toUnlink ? unlink(toUnlink) : undefined)}
      />

      {/* Enquanto a escolha manual está aberta, a revisão fica escondida (um diálogo por vez) e volta no mesmo passo. */}
      <Dialog open={!!review && !picking} onOpenChange={(o) => !o && setReview(null)}>
        <DialogContent data-testid="batch-dialog">
          {current && review && (
            <>
              <DialogHeader>
                <DialogTitle>
                  Revisar {review.index + 1} de {review.entries.length}
                </DialogTitle>
                <DialogDescription>
                  Ficha {current.workoutLabel} · {current.routineName}. Confirme, escolha outro ou pule. Nada é gravado antes do resumo.
                </DialogDescription>
              </DialogHeader>
              {reviewShown ? (
                <LinkComparisonView entry={current} item={reviewShown.item} candidate={reviewShown.candidate} />
              ) : (
                <p className="text-sm">
                  <span className="font-semibold">{current.exercise.name}</span>: {MATCH_TIER_LABEL.nenhuma.toLowerCase()}. Escolha na biblioteca ou pule.
                </p>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => advance((r) => (r.picks.delete(entryKey(current)), r.skipped.add(entryKey(current))))} data-testid="batch-skip">
                  Pular
                </Button>
                <Button variant="outline" onClick={() => setPicking({ entry: current, forReview: true })} data-testid="batch-choose">
                  {reviewShown ? 'Escolher outro' : 'Escolher na biblioteca'}
                </Button>
                <Button disabled={!reviewShown} onClick={() => advance((r) => (r.picks.set(entryKey(current), reviewShown!), r.skipped.delete(entryKey(current))))} data-testid="batch-confirm-one">
                  Confirmar este
                </Button>
              </DialogFooter>
            </>
          )}
          {atSummary && review && (
            <>
              <DialogHeader>
                <DialogTitle>Resumo da associação</DialogTitle>
                <DialogDescription>Só as associações que você confirmou serão gravadas, todas juntas. Se algo mudou em outra aba desde a revisão, nada é gravado.</DialogDescription>
              </DialogHeader>
              <ul className="space-y-1 text-sm" data-testid="batch-summary">
                {review.entries.map((e) => {
                  const p = review.picks.get(entryKey(e));
                  return (
                    <li key={entryKey(e)} className="break-words">
                      {p ? (
                        <>
                          <span className="font-semibold">{e.exercise.name}</span> → {p.item.name}
                        </>
                      ) : (
                        <span className="text-muted-foreground">{e.exercise.name}: pulado</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setReview({ ...review, index: 0 })}>
                  Revisar de novo
                </Button>
                <Button size="lg" disabled={!review.picks.size || busy} onClick={() => void applyReview()} data-testid="batch-apply">
                  Aplicar {review.picks.size} {review.picks.size === 1 ? 'associação' : 'associações'}
                </Button>
              </DialogFooter>
            </>
          )}
          {review?.result && (
            <>
              <DialogHeader>
                <DialogTitle>{review.result.applied ? 'Associações gravadas' : 'Nada foi gravado'}</DialogTitle>
                <DialogDescription>{linkResultSummary(review.result)}</DialogDescription>
              </DialogHeader>
              <ul className="space-y-1 text-sm" data-testid="batch-result">
                {review.result.results.map((x) => (
                  <li key={`${x.request.routineId}/${x.request.workoutId}/${x.request.id}`} className="break-words">
                    <span className="font-semibold">{x.request.name}</span>: {x.message}
                  </li>
                ))}
              </ul>
              <DialogFooter>
                <Button onClick={() => setReview(null)}>Fechar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
