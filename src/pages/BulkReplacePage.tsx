import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Replace, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppLayout';
import { goalsLinkedToMany, mutateWorkout } from '@/db/library';
import { useRoutine, useSettings } from '@/hooks/data';
import { useLibrary } from '@/hooks/useLibrary';
import type { Workout } from '@/lib/types';
import { cn, uid } from '@/lib/utils';
import { MODALITY_LABEL } from '@/modules/training';
import { SUGGESTION_REASON_LABEL, anchorFromTemplate, bulkReplacePreview, replaceManyOp, suggest, type BulkReplacePreview, type LibraryItem } from '@/modules/exercises';
import { planSummary } from '@/features/workout/modelFormat';
import { LibraryPickerDialog } from '@/features/library/LibraryPickerDialog';
import { useModelCapability } from '@/features/compat/CompatGuard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type Step = 'select' | 'choose' | 'preview';

/**
 * Substituição múltipla assistida (IronTrack 2.0 F01/P18, docs/RECONHECIMENTO_EXERCICIOS.md §12): selecionar
 * exercícios de UM treino, escolher substitutos, ver as diferenças e os alertas, confirmar tudo. Cada substituto recebe
 * ID novo na posição do original; metas, sessões, histórico e analytics do anterior não são redirecionados. A gravação
 * é uma única operação (`replaceMany`) sobre a versão gravada: se algum exercício mudou desde a prévia, nada é gravado.
 */
export default function BulkReplacePage() {
  const { routineId, workoutId } = useParams();
  const navigate = useNavigate();
  const routine = useRoutine(routineId);
  const workout = routine?.workouts.find((w) => w.id === workoutId);
  const settings = useSettings();
  const { data } = useLibrary();
  const outdated = useModelCapability().newer;
  const [step, setStep] = useState<Step>('select');
  const [selected, setSelected] = useState<string[]>([]);
  const [picks, setPicks] = useState<Map<string, { item: LibraryItem; newId: string }>>(new Map());
  const [picking, setPicking] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Workout | null>(null);
  const [goals, setGoals] = useState<Map<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const editor = () => navigate(routine && workout ? `/treinos/${routine.id}/${workout.id}` : '/treinos');

  useEffect(() => {
    if (step !== 'preview' || !snapshot) return;
    setGoals(null);
    void goalsLinkedToMany(snapshot.exercises.map((e) => e.id)).then(setGoals);
  }, [step, snapshot]);

  const preview: BulkReplacePreview | null = useMemo(() => {
    if (step !== 'preview' || !snapshot || !goals) return null;
    const list = selected.filter((id) => picks.has(id)).map((id) => ({ id, item: picks.get(id)!.item, newId: picks.get(id)!.newId }));
    return bulkReplacePreview(snapshot, list, { muscleGroups: settings.muscleGroups, rest: settings }, goals);
  }, [step, snapshot, goals, selected, picks, settings]);

  if (routine === undefined) return null;
  if (!routine || !workout) {
    return (
      <div className="space-y-3">
        <p>Treino não encontrado (talvez tenha sido excluído em outra aba).</p>
        <Button onClick={() => navigate('/treinos')}>Voltar</Button>
      </div>
    );
  }

  const pickingEx = picking ? workout.exercises.find((e) => e.id === picking) : null;
  const pickerSuggestions =
    pickingEx && data ? suggest({ items: data.items, favorites: data.favorites, recent: data.recent, anchor: anchorFromTemplate(pickingEx), limit: 6 }).map((s) => ({ item: s.item, label: SUGGESTION_REASON_LABEL[s.reason] })) : [];
  const chosenAll = selected.length > 0 && selected.every((id) => picks.has(id));
  const stillThere = selected.filter((id) => workout.exercises.some((e) => e.id === id));

  const confirm = async () => {
    if (!preview || busy || !preview.rows.length) return;
    if (outdated) {
      toast.error('Atualize o IronTrack antes de editar: estes dados já foram usados por uma versão mais nova.');
      return;
    }
    setBusy(true);
    try {
      const r = await mutateWorkout(routine.id, workout.id, replaceManyOp(preview));
      toast.success(r.changed ? `${preview.rows.length} ${preview.rows.length === 1 ? 'exercício substituído' : 'exercícios substituídos'}. Metas e histórico dos anteriores continuam com eles.` : 'As substituições já estavam gravadas.');
      editor();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Substituir vários"
        subtitle={`Treino ${workout.label} · ${workout.name}`}
        action={
          <Button variant="ghost" size="icon" aria-label="Voltar à ficha" onClick={editor}>
            <ArrowLeft />
          </Button>
        }
      />
      <ol className="flex gap-2 text-xs" aria-label="Etapas">
        {(['select', 'choose', 'preview'] as const).map((s, i) => (
          <li key={s} aria-current={step === s ? 'step' : undefined} className={cn('rounded-full border px-2.5 py-1', step === s ? 'border-primary bg-primary/10 font-semibold' : 'text-muted-foreground')}>
            {i + 1}. {{ select: 'Selecionar', choose: 'Substitutos', preview: 'Prévia' }[s]}
          </li>
        ))}
      </ol>

      {step === 'select' && (
        <section className="space-y-2" aria-label="Selecionar exercícios">
          <p className="text-sm text-muted-foreground">Marque os exercícios que deseja substituir. Os demais ficam como estão.</p>
          {workout.exercises.length === 0 && <Card className="p-4 text-sm">Este treino não tem exercícios.</Card>}
          {workout.exercises.map((ex, i) => {
            const on = selected.includes(ex.id);
            return (
              <label key={ex.id} className={cn('flex cursor-pointer items-center gap-3 rounded-2xl border p-3', on && 'border-primary bg-primary/5')} data-testid="bulk-select-row">
                <input
                  type="checkbox"
                  className="h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                  checked={on}
                  onChange={() => setSelected((s) => (s.includes(ex.id) ? s.filter((x) => x !== ex.id) : [...s, ex.id]))}
                  data-testid="bulk-select"
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words font-semibold">
                    <span className="mr-1 text-xs text-muted-foreground tabular">{i + 1}</span>
                    {ex.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {ex.muscleGroup} · {planSummary(ex)}
                  </span>
                </span>
              </label>
            );
          })}
          <Button size="lg" className="w-full" disabled={!selected.length} onClick={() => setStep('choose')} data-testid="bulk-next-choose">
            Escolher substitutos ({selected.length})
          </Button>
        </section>
      )}

      {step === 'choose' && (
        <section className="space-y-2" aria-label="Escolher substitutos">
          <p className="text-sm text-muted-foreground">Escolha um substituto para cada exercício marcado. Nada é gravado antes da prévia.</p>
          {stillThere.length < selected.length && (
            <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm" role="alert">
              {selected.length - stillThere.length} exercício(s) marcado(s) não está(ão) mais na ficha (talvez removido(s) em outra aba) e ficará(ão) de fora.
            </p>
          )}
          {selected.map((id) => {
            const ex = workout.exercises.find((e) => e.id === id);
            if (!ex) return null;
            const p = picks.get(id);
            return (
              <Card key={id} className="space-y-2 p-3" data-testid="bulk-choose-row">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="break-words font-semibold">{ex.name}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {p ? <span className="break-words font-semibold text-primary">{p.item.name}</span> : <span className="text-muted-foreground">sem substituto</span>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant={p ? 'outline' : 'default'} onClick={() => setPicking(id)} data-testid="bulk-pick">
                    <Search /> {p ? 'Trocar substituto' : 'Escolher substituto'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSelected((s) => s.filter((x) => x !== id));
                      setPicks((m) => {
                        const n = new Map(m);
                        n.delete(id);
                        return n;
                      });
                    }}
                  >
                    <X /> Não substituir
                  </Button>
                </div>
              </Card>
            );
          })}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => setStep('select')}>
              Voltar
            </Button>
            <Button
              disabled={!chosenAll || !stillThere.length}
              onClick={() => {
                setSnapshot({ ...workout, exercises: workout.exercises.map((e) => ({ ...e })) });
                setStep('preview');
              }}
              data-testid="bulk-next-preview"
            >
              Ver prévia
            </Button>
          </div>
        </section>
      )}

      {step === 'preview' && (
        <section className="space-y-3" aria-label="Prévia da substituição" data-testid="bulk-preview">
          {!preview ? (
            <p className="text-sm text-muted-foreground">Montando a prévia…</p>
          ) : (
            <>
              <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm font-medium" data-testid="bulk-goal-note">
                {preview.goalNote}
                {preview.linkedGoals > 0 && ` (${preview.linkedGoals} ${preview.linkedGoals === 1 ? 'meta ligada' : 'metas ligadas'} aos exercícios marcados.)`} Substituir não migra metas.
              </p>
              {preview.rows.map((r) => (
                <Card key={r.current.id} className="space-y-2 p-3 text-sm" data-testid="bulk-preview-row">
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Original</p>
                      <p className="break-words font-semibold">{r.current.name}</p>
                      <p className="text-xs text-muted-foreground">{r.current.modality ? MODALITY_LABEL[r.current.modality] : 'Modalidade não informada'}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Substituto</p>
                      <p className="break-words font-semibold">{r.next.name}</p>
                      <p className="text-xs text-muted-foreground">{r.next.modality ? MODALITY_LABEL[r.next.modality] : '—'}</p>
                    </div>
                  </div>
                  <p className="text-xs">
                    <span className="font-semibold">Preservado:</span> {r.kept.join(', ')} · <span className="tabular">{planSummary(r.next)}</span>
                  </p>
                  {r.dropped.length > 0 && (
                    <p className="text-xs">
                      <span className="font-semibold">Descartado:</span> {r.dropped.join('; ')}.
                    </p>
                  )}
                  {r.modalityNotes.map((n) => (
                    <p key={n} className="text-xs text-warn">
                      {n}
                    </p>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Metas ligadas ao original: {r.linkedGoals} (continuam com ele) · Nova identidade: <code className="break-all" data-testid="bulk-new-id">{r.next.id}</code>
                  </p>
                </Card>
              ))}
              <section aria-label="Ordem final da ficha">
                <h2 className="text-sm font-semibold">Ordem final da ficha</h2>
                <ol className="list-decimal space-y-0.5 pl-6 text-sm" data-testid="bulk-final-order">
                  {preview.finalOrder.map((o) => (
                    <li key={o.id} className={cn('break-words', o.replaced && 'font-semibold text-primary')}>
                      {o.name} {o.replaced && <Badge variant="outline">novo</Badge>}
                    </li>
                  ))}
                </ol>
              </section>
              <p className="text-xs text-muted-foreground">Sessões antigas, histórico e analytics dos exercícios originais permanecem intactos. Outras fichas, o catálogo e a rotação não mudam.</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => setStep('choose')}>
                  Voltar
                </Button>
                <Button size="lg" disabled={busy || !preview.rows.length} onClick={() => void confirm()} data-testid="bulk-confirm">
                  <Replace /> Confirmar tudo
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {data && (
        <LibraryPickerDialog
          open={!!picking}
          onOpenChange={(o) => !o && setPicking(null)}
          title={pickingEx ? `Substituto para "${pickingEx.name}"` : ''}
          description="Escolher não grava nada: a troca só acontece ao confirmar a prévia."
          index={data.index}
          suggestions={pickerSuggestions}
          onPick={(item) => {
            if (!picking) return;
            setPicks((m) => new Map(m).set(picking, { item, newId: m.get(picking)?.item.key === item.key ? m.get(picking)!.newId : uid() }));
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
