import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowDown, ArrowUp, Check, Lock, Pencil, Play, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { conflictMessage, saveCompletedSessionEdit } from '@/db/sessionEdits';
import { useSession, useSettings } from '@/hooks/data';
import {
  SessionEditError,
  addSet,
  appendExercise,
  checkDuration,
  correctExerciseIdentity,
  describeSessionChanges,
  measureDifferences,
  moveExercise,
  recordedDurationSec,
  removeExercise,
  removeSet,
  setDone,
  updateSet,
  validateSessionEdit,
} from '@/modules/training';
import type { LibraryItem } from '@/modules/exercises';
import type { WorkoutSession } from '@/lib/types';
import { fmtClock } from '@/lib/utils';
import { fmtDateTime } from '@/lib/dates';
import { SetFields, setTitle } from '@/features/workout/SetEditor';
import { ResumeDialog } from '@/features/workout/ResumeDialog';
import { sessionCandidate } from '@/features/library/sessionCandidate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm';

const LibraryBrowser = lazy(() => import('@/features/library/LibraryBrowser'));

/**
 * Edição de um treino FINALIZADO (P20, docs/EDICAO_HISTORICO.md). Usa os mesmos campos de série do treino em andamento,
 * com o relógio PARADO: nada aqui conta tempo. Tudo fica num rascunho local até "Salvar" (transação que confere se o
 * treino mudou em outra aba, guarda uma revisão e não troca ID, início nem fim), "Cancelar" (descarta) ou "Continuar"
 * (retoma o treino com as correções). Dois caminhos distintos para exercício errado:
 *  - Corrigir (cenário A): o registro estava com o exercício errado; as séries ficam, muda só a identidade;
 *  - Adicionar esquecido (cenário B): outro exercício que foi feito e não foi registrado; entra sem cargas automáticas.
 */
export default function SessionEditPage() {
  const { id } = useParams();
  const live = useSession(id);
  if (live === undefined) return <p className="p-4 text-muted-foreground">Carregando…</p>;
  if (!live || live.status !== 'completed') return <NotEditable live={live ?? null} />;
  return <Editor key={live.id} initial={live} live={live} />;
}

function NotEditable({ live }: { live: WorkoutSession | null }) {
  const navigate = useNavigate();
  return (
    <Card className="m-4 space-y-3 p-4" data-testid="edit-unavailable">
      <p>{live?.status === 'active' ? 'Este treino está em andamento. Edite pela tela do treino.' : 'Treino não encontrado neste aparelho.'}</p>
      <Button onClick={() => navigate(live?.status === 'active' ? '/treino' : '/historico')}>{live?.status === 'active' ? 'Abrir treino em andamento' : 'Voltar ao histórico'}</Button>
    </Card>
  );
}

function Editor({ initial, live }: { initial: WorkoutSession; live: WorkoutSession }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [conflict, setConflict] = useState<string | null>(null);
  const [browser, setBrowser] = useState<{ mode: 'correct'; exId: string } | { mode: 'add' } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const baseRef = useRef(base);
  baseRef.current = base;

  // Outra aba (ou uma restauração) gravou depois que a edição abriu: avisa; nada é gravado por cima.
  useEffect(() => {
    if (live.updatedAt !== baseRef.current.updatedAt) setConflict(conflictMessage('changed'));
  }, [live.updatedAt]);

  const changes = useMemo(() => describeSessionChanges(base, draft), [base, draft]);
  const issues = useMemo(() => validateSessionEdit(draft), [draft]);
  const dirty = changes.length > 0;
  const recorded = recordedDurationSec(draft);
  const [hh, setHh] = useState(String(Math.floor(recorded / 3600)));
  const [mm, setMm] = useState(String(Math.floor((recorded % 3600) / 60)));
  const durCheck = checkDuration(Number(hh || 0) * 3600 + Number(mm || 0) * 60 + (recorded % 60));

  const applyDuration = (h: string, m: string) => {
    setHh(h);
    setMm(m);
    const c = checkDuration(Number(h || 0) * 3600 + Number(m || 0) * 60 + (recordedDurationSec(base) % 60));
    if (c.ok) setDraft((d) => ({ ...d, durationSec: c.value }));
  };

  const reload = () => {
    setBase(live);
    setDraft(live);
    setConflict(null);
    const r = recordedDurationSec(live);
    setHh(String(Math.floor(r / 3600)));
    setMm(String(Math.floor((r % 3600) / 60)));
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await saveCompletedSessionEdit(base, draft);
      if (r.status === 'saved' || r.status === 'unchanged') {
        toast.success(r.status === 'saved' ? 'Treino corrigido. A versão anterior ficou guardada.' : 'Nada mudou.');
        navigate(`/historico/${base.id}`, { replace: true });
      } else if (r.status === 'invalid') toast.error(r.issues.map((i) => i.message).join(' '));
      else setConflict(conflictMessage(r.reason));
    } finally {
      setBusy(false);
    }
  };

  const onPick = (item: LibraryItem) => {
    if (!browser) return;
    if (browser.mode === 'add') {
      const ex = sessionCandidate(item, settings, [], { noLoads: true });
      setDraft((d) => appendExercise(d, ex, Date.now(), true));
      setBrowser(null);
      toast.success(`${item.name} adicionado. Preencha e marque as séries que você fez.`);
      return;
    }
    const target = sessionCandidate(item, settings, [], { noLoads: true });
    try {
      setDraft((d) => correctExerciseIdentity(d, browser.exId, target));
      toast.success(`Corrigido para ${item.name}. As séries continuam as mesmas.`);
    } catch (e) {
      toast.error(e instanceof SessionEditError ? e.message : String(e));
    }
    setBrowser(null);
  };

  const correctingEx = browser?.mode === 'correct' ? draft.exercises.find((e) => e.id === browser.exId) : undefined;

  return (
    <div className="mx-auto min-h-dvh max-w-3xl space-y-4 px-4 pb-36 pt-safe" data-testid="session-edit">
      <div className="sticky top-0 z-20 -mx-4 space-y-2 border-b bg-background/95 px-4 pb-2 pt-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-lg font-bold">
              <span className="text-primary">Treino {draft.workoutLabel}</span> · {draft.workoutName}
            </h1>
            <p className="text-xs text-muted-foreground">{fmtDateTime(draft.startedAt)}</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 font-display text-sm font-bold tabular" aria-label={`Duração registrada ${fmtClock(recorded)}, relógio parado`} data-testid="frozen-clock">
            <Lock className="h-3.5 w-3.5" aria-hidden /> {fmtClock(recorded)}
          </span>
        </div>
        <p role="status" className="flex items-center gap-1.5 rounded-xl bg-warn/15 px-3 py-1.5 text-sm font-semibold text-warn" data-testid="editing-banner">
          <Pencil className="h-4 w-4" aria-hidden /> Editando treino finalizado
        </p>
      </div>

      {conflict && (
        <Card className="space-y-2 border-destructive/50 p-3 text-sm" role="alert" data-testid="edit-conflict">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden /> {conflict}
          </p>
          {live.status === 'completed' && (
            <Button size="sm" variant="outline" onClick={reload} data-testid="edit-reload">
              <RefreshCw /> Recarregar a versão atual (descarta este rascunho)
            </Button>
          )}
        </Card>
      )}

      <p className="text-sm text-muted-foreground">O relógio está parado: editar não conta tempo. A duração só muda se você corrigir abaixo. Nada é gravado até tocar em Salvar.</p>

      <Card className="space-y-2 p-3">
        <p className="text-sm font-semibold">Duração registrada</p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-sm">
            <Input type="number" inputMode="numeric" min={0} max={24} className="w-16" value={hh} onChange={(e) => applyDuration(e.target.value, mm)} aria-label="Horas" data-testid="edit-hours" /> h
          </label>
          <label className="flex items-center gap-1 text-sm">
            <Input type="number" inputMode="numeric" min={0} max={59} className="w-16" value={mm} onChange={(e) => applyDuration(hh, e.target.value)} aria-label="Minutos" data-testid="edit-minutes" /> min
          </label>
        </div>
        {!durCheck.ok && <p className="text-xs text-destructive">{durCheck.error}</p>}
      </Card>

      {draft.exercises.map((ex, i) => {
        const exIssues = issues.filter((x) => x.exerciseId === ex.id);
        return (
          <Card key={ex.id} className="space-y-2 p-3" data-testid="edit-exercise">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="break-words font-semibold">{ex.name}</p>
                <p className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                  <span>{ex.muscleGroup}</span>
                  {ex.substitutedFrom && <Badge variant="outline">substituiu {ex.substitutedFrom}</Badge>}
                  {ex.replacedBy && <Badge variant="outline">trocado durante o treino</Badge>}
                  {ex.addedAfterFinishAt && <Badge variant="outline">adicionado depois</Badge>}
                  {ex.correctedFrom && <Badge variant="outline">corrigido (era {ex.correctedFrom.name})</Badge>}
                </p>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label={`Mover ${ex.name} para cima`} disabled={i === 0} onClick={() => setDraft((d) => moveExercise(d, ex.id, -1))}>
                <ArrowUp />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Mover ${ex.name} para baixo`} disabled={i === draft.exercises.length - 1} onClick={() => setDraft((d) => moveExercise(d, ex.id, 1))}>
                <ArrowDown />
              </Button>
            </div>
            <ul className="space-y-2">
              {ex.sets.map((s) => (
                <li key={s.id} className="space-y-1.5 rounded-xl border p-2" data-testid="edit-set">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-sm font-medium">{setTitle(ex, s)}</span>
                    <Button
                      size="sm"
                      variant={s.status === 'done' ? 'secondary' : 'outline'}
                      aria-pressed={s.status === 'done'}
                      onClick={() => setDraft((d) => setDone(d, ex.id, s.id, s.status !== 'done'))}
                      data-testid="edit-set-done"
                    >
                      {s.status === 'done' ? <Check /> : <X />} {s.status === 'done' ? 'Feita' : s.status === 'skipped' ? 'Pulada' : 'Não feita'}
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Remover ${setTitle(ex, s)}`} onClick={() => setDraft((d) => removeSet(d, ex.id, s.id))}>
                      <Trash2 />
                    </Button>
                  </div>
                  <SetFields compact ex={ex} set={s} settings={settings} onPatch={(p) => setDraft((d) => updateSet(d, ex.id, s.id, p))} />
                </li>
              ))}
            </ul>
            {exIssues.length > 0 && (
              <ul className="text-xs text-destructive" data-testid="edit-issues">
                {exIssues.map((x) => (
                  <li key={`${x.setId}:${x.message}`}>{x.message}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setDraft((d) => addSet(d, ex.id))} data-testid="edit-add-set">
                <Plus /> Série
              </Button>
              <Button size="sm" variant="outline" onClick={() => setBrowser({ mode: 'correct', exId: ex.id })} data-testid="edit-correct">
                <Pencil /> Corrigir exercício
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRemoving(ex.id)} data-testid="edit-remove-exercise">
                <Trash2 /> Remover
              </Button>
            </div>
          </Card>
        );
      })}

      <Card className="space-y-2 p-3">
        <Button variant="outline" className="w-full" onClick={() => setBrowser({ mode: 'add' })} data-testid="edit-add-exercise">
          <Plus /> Adicionar exercício esquecido
        </Button>
        <p className="text-xs text-muted-foreground">
          Use <strong>Corrigir exercício</strong> quando o registro estava com o exercício errado (as séries foram feitas, só muda qual exercício). Use <strong>Adicionar exercício esquecido</strong> para um exercício que você fez e não registrou (entra sem cargas automáticas).
        </p>
      </Card>

      <Card className="space-y-2 p-3">
        <p className="text-sm font-semibold">Observações</p>
        <Textarea value={draft.notes ?? ''} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} placeholder="Como foi o treino?" data-testid="edit-notes" />
      </Card>

      {issues.some((x) => !x.exerciseId) && (
        <ul className="text-sm text-destructive">
          {issues
            .filter((x) => !x.exerciseId)
            .map((x) => (
              <li key={x.message}>{x.message}</li>
            ))}
        </ul>
      )}
      {dirty && (
        <Card className="p-3 text-sm" data-testid="edit-summary">
          <p className="font-semibold">Alterações</p>
          <ul className="list-disc pl-5">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-safe backdrop-blur">
        <div className="mx-auto flex max-w-3xl gap-2 p-3">
          <Button variant="ghost" onClick={() => (dirty ? setLeaving(true) : navigate(`/historico/${base.id}`))} data-testid="edit-cancel">
            Cancelar
          </Button>
          <Button variant="outline" className="flex-1" disabled={!!conflict || issues.length > 0} onClick={() => setResumeOpen(true)} data-testid="edit-continue">
            <Play /> Continuar
          </Button>
          <Button className="flex-1" disabled={busy || !!conflict || issues.length > 0 || !dirty} onClick={() => void save()} data-testid="edit-save">
            <Save /> Salvar
          </Button>
        </div>
      </div>

      {browser && (
        <Suspense fallback={null}>
          <LibraryBrowser
            open
            onOpenChange={(o) => !o && setBrowser(null)}
            title={browser.mode === 'add' ? 'Adicionar exercício esquecido' : `Corrigir ${correctingEx?.name ?? 'exercício'}`}
            description={
              browser.mode === 'add'
                ? 'O exercício entra no fim deste treino, sem cargas automáticas. Preencha as séries que você fez.'
                : 'Escolha o exercício que você realmente fez. As séries ficam; só é possível quando os dois registram as mesmas medidas.'
            }
            chooseLabel={browser.mode === 'add' ? 'Adicionar' : 'Corrigir para este'}
            onPick={(item) => {
              if (browser.mode === 'correct' && correctingEx) {
                const diffs = measureDifferences(correctingEx, sessionCandidate(item, settings, [], { noLoads: true }));
                if (diffs.length && correctingEx.sets.some((s) => s.status !== 'pending')) {
                  toast.error(`Não dá para corrigir para ${item.name}: o registro é diferente (${diffs.join(' ')}). Remova o exercício e adicione o correto.`);
                  return;
                }
              }
              onPick(item);
            }}
          />
        </Suspense>
      )}

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        destructive
        title={`Remover ${draft.exercises.find((e) => e.id === removing)?.name ?? 'exercício'}?`}
        description="As séries dele saem deste treino quando você salvar. A versão anterior fica guardada e pode ser restaurada nos detalhes do treino."
        confirmLabel="Remover"
        onConfirm={() => {
          if (removing) setDraft((d) => removeExercise(d, removing));
          setRemoving(null);
        }}
      />
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        destructive
        title="Descartar as alterações?"
        description="Nada do que você mudou aqui será gravado. O treino continua como estava."
        confirmLabel="Descartar"
        onConfirm={() => navigate(`/historico/${base.id}`)}
      />
      <ResumeDialog base={base} draft={dirty ? draft : null} open={resumeOpen} onOpenChange={setResumeOpen} onConflict={setConflict} />
    </div>
  );
}
