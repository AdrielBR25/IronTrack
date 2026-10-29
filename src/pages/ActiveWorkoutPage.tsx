import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Flag, HelpCircle, Plus, Trash2, Trophy, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useActiveSession, useCompletedSessions, useNow, useSettings } from '@/hooks/data';
import { completeSession, discardSession, saveSessionGuarded } from '@/db/repo';
import {
  addSet,
  carryForwardWeight,
  completeSet,
  historyFor,
  nextPending,
  removeSet,
  restAfter,
  sessionProgress,
  setLabel,
  skipExercise,
  skipSet,
  undoSet,
  updateSet,
  type SetRef,
  adjustRest,
  pauseRest,
  resumeRest,
  startRest,
  sessionPRs,
  sessionVolume,
  validSetCount,
  completionPct,
  shouldAdvance,
  setCompletionErrors,
  type SetTimerTarget,
  appendExercise,
  applySwap,
  effectiveDurationSec,
  swapPreview,
  type SwapPreview,
} from '@/modules/training';
import { audioAvailable, closeRestNotifications, notificationState, unlockAudio, vibrationAvailable } from '@/lib/alerts';
import type { SessionExercise, SessionSet, WorkoutSession } from '@/lib/types';
import type { LibraryItem, LibraryKey } from '@/modules/exercises';
import { SwapPreviewDialog } from '@/features/workout/SwapPreviewDialog';
import { sessionCandidate } from '@/features/library/sessionCandidate';
import { ExerciseCard, summarizeSets } from '@/features/workout/ExerciseCard';
import { SetEditor, SetFields, setTitle } from '@/features/workout/SetEditor';
import { RestPanel } from '@/features/workout/RestPanel';
import { SetTimerChip } from '@/features/workout/SetTimerPanel';
import { setTimerStore, useSetTimer } from '@/features/workout/setTimerStore';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useUnits } from '@/hooks/useUnits';
import { fmtClock, fmtDuration, uid } from '@/lib/utils';
import { cn } from '@/lib/utils';

// P20: biblioteca completa (catálogo, filtros, 3D) só é baixada quando a pessoa abre a troca ou o "Adicionar exercício".
const LibraryBrowser = lazy(() => import('@/features/library/LibraryBrowser'));
const WorkoutHelpSheet = lazy(() => import('@/features/workout/WorkoutHelpSheet'));

/** Chaves da biblioteca já presentes no treino (não aparecem de novo como opção). */
const keysIn = (s: WorkoutSession) => new Set(s.exercises.flatMap((e): LibraryKey[] => (e.catalogId ? [`catalog:${e.catalogId}`] : e.customExerciseId ? [`custom:${e.customExerciseId}`] : [])));

function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const req = async () => {
      try {
        if (document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen');
      } catch {
        /* sem permissão */
      }
    };
    void req();
    document.addEventListener('visibilitychange', req);
    return () => {
      document.removeEventListener('visibilitychange', req);
      void lock?.release().catch(() => undefined);
    };
  }, [enabled]);
}

export default function ActiveWorkoutPage() {
  const session = useActiveSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (session === null) navigate('/', { replace: true });
  }, [session, navigate]);
  if (!session) return <div className="flex min-h-dvh items-center justify-center text-muted-foreground">Carregando treino…</div>;
  return <WorkoutRunner key={session.id} initial={session} />;
}

function WorkoutRunner({ initial }: { initial: WorkoutSession }) {
  const live = useActiveSession();
  const navigate = useNavigate();
  const settings = useSettings();
  const completed = useCompletedSessions();
  const { fmtW, fmtVol } = useUnits();
  // Estado local para resposta imediata; cada alteração é gravada no IndexedDB.
  const [session, setSession] = useState<WorkoutSession>(initial);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [focusSet, setFocusSet] = useState<SetRef | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<{ exId: string; setId: string } | null>(null);
  const [browser, setBrowser] = useState<{ mode: 'swap'; exId: string } | { mode: 'add' } | null>(null);
  const [swap, setSwap] = useState<{ preview: SwapPreview; candidate: SessionExercise; exId: string } | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const now = useNow(1000);
  useWakeLock(true);

  // Gravação segura (P11, docs/CRONOMETROS_E_CONCORRENCIA.md §9). `confirmedRef` é a última versão do banco que esta
  // tela conhece; cada gravação compara com o banco na mesma transação e, se outra aba (ou o aviso de descanso)
  // gravou antes, mescla em três vias em vez de sobrescrever. As gravações desta aba saem em fila, na ordem.
  const confirmedRef = useRef<WorkoutSession>(initial);
  const dirtyRef = useRef(false);
  const closedRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');

  // Sincroniza mudanças vindas do banco (outra aba, aviso de descanso) quando não há edição local pendente.
  useEffect(() => {
    if (live && live.id === session.id && !dirtyRef.current && live.updatedAt > sessionRef.current.updatedAt) {
      confirmedRef.current = live;
      sessionRef.current = live;
      setSession(live);
    }
  }, [live, session.id]);

  const flush = useCallback(() => {
    queueRef.current = queueRef.current.then(async () => {
      if (!dirtyRef.current || closedRef.current) return;
      const local = sessionRef.current;
      setSaveState('saving');
      try {
        const r = await saveSessionGuarded(confirmedRef.current, local);
        if (r.status === 'closed') {
          closedRef.current = true;
          dirtyRef.current = false;
          setSaveState('saved');
          toast.warning('Este treino foi finalizado ou descartado em outra aba.', { description: 'As alterações feitas aqui depois disso não foram gravadas.' });
          return;
        }
        if (r.conflicts.length) toast.warning('Este treino também foi alterado em outra aba.', { description: 'Onde as duas mudaram a mesma coisa, ficou o que foi gravado primeiro. Confira as séries.' });
        if (sessionRef.current === local) {
          dirtyRef.current = false;
          confirmedRef.current = r.session;
          sessionRef.current = r.session;
          setSession(r.session);
        } else {
          // Houve novas edições durante a gravação: elas partiram de `local`, que vira a base da próxima mescla.
          confirmedRef.current = r.status === 'saved' ? r.session : local;
        }
        setSaveState(dirtyRef.current ? 'saving' : 'saved');
      } catch {
        setSaveState('error');
        toast.error('Não foi possível salvar a última alteração.', { description: 'Os dados continuam na tela. Toque em "tentar de novo" no topo.' });
      }
    });
    return queueRef.current;
  }, []);

  const commit = useCallback(
    (next: WorkoutSession) => {
      if (closedRef.current) return;
      const stamped = { ...next, updatedAt: Date.now() };
      sessionRef.current = stamped;
      dirtyRef.current = true;
      setSession(stamped);
      void flush();
    },
    [flush],
  );

  const history = useCallback((key: string) => historyFor(key, completed ?? [], 5), [completed]);

  const current: SetRef | null = useMemo(() => {
    if (focusSet) {
      const ex = session.exercises.find((e) => e.id === focusSet.exerciseId);
      if (ex?.sets.find((s) => s.id === focusSet.setId && s.status === 'pending')) return focusSet;
    }
    return nextPending(session, session.focusExerciseId);
  }, [session, focusSet]);

  const currentEx = current ? session.exercises.find((e) => e.id === current.exerciseId) : undefined;
  const currentSet = currentEx?.sets.find((s) => s.id === current?.setId);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpEx = currentEx ?? session.exercises.find((e) => e.id === session.focusExerciseId) ?? session.exercises[0] ?? null;

  const scrollTo = (exId: string) => {
    requestAnimationFrame(() => document.getElementById(`ex-${exId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const doComplete = (patch?: Partial<SessionSet>) => {
    const base = sessionRef.current;
    if (!current) return;
    const ex0 = base.exercises.find((e) => e.id === current.exerciseId);
    const set0 = ex0?.sets.find((s) => s.id === current.setId);
    // Ação repetida (toque duplo, tela desatualizada): só uma série pendente pode ser concluída, uma vez.
    if (!ex0 || !set0 || set0.status !== 'pending') return;
    // Nunca conclui uma série com valores inválidos (o botão já fica desabilitado; isto protege atalhos).
    if (setCompletionErrors(ex0, { ...set0, ...patch }).length) return;
    unlockAudio();
    void closeRestNotifications();
    const patched = patch ? updateSet(base, current.exerciseId, current.setId, patch) : base;
    let next = carryForwardWeight(completeSet(patched, current.exerciseId, current.setId), current.exerciseId, current.setId);
    const following = nextPending(next, current.exerciseId);
    const secs = restAfter(next, current, following, settings);
    next = {
      ...next,
      focusExerciseId: following?.exerciseId ?? current.exerciseId,
      rest: following && secs > 0 ? startRest(secs, Date.now(), { nextLabel: setLabel(next, following), exerciseId: following.exerciseId, setId: following.setId }) : null,
    };
    setFocusSet(null);
    commit(next);
    // O cronômetro de execução desta série termina com ela (o descanso não é afetado).
    setTimerStore.discardWhere((t) => t.sessionId === base.id && t.exerciseId === ex0.id && t.setId === set0.id);
    if (navigator.vibrate && settings.vibration) navigator.vibrate(20);
    if (following && following.exerciseId !== current.exerciseId) scrollTo(following.exerciseId);
    if (!following) {
      toast.success('Todas as séries concluídas!', { description: 'Finalize o treino para salvar no histórico.' });
      setFinishOpen(true);
    }
  };

  const describeTimer = (t: SetTimerTarget) => {
    const ex = session.exercises.find((e) => e.id === t.exerciseId);
    const set = ex?.sets.find((x) => x.id === t.setId);
    return ex && set ? `${ex.name} · ${setTitle(ex, set)}` : 'Série não encontrada';
  };
  const goToTimer = (t: SetTimerTarget) => {
    if (!session.exercises.some((e) => e.id === t.exerciseId && e.sets.some((x) => x.id === t.setId && x.status === 'pending'))) return;
    setFocusSet({ exerciseId: t.exerciseId, setId: t.setId });
    commit({ ...sessionRef.current, focusExerciseId: t.exerciseId });
    setExpanded((m) => ({ ...m, [t.exerciseId]: true }));
    scrollTo(t.exerciseId);
  };
  const { state: timerState } = useSetTimer();

  const endRest = useCallback(() => {
    const s = sessionRef.current;
    if (!s.rest) return;
    void closeRestNotifications();
    commit({ ...s, rest: null });
    setHighlight(true);
    setTimeout(() => setHighlight(false), 3000);
  }, [commit]);

  const patchCurrent = (p: Partial<SessionSet>) => {
    if (!current) return;
    commit(updateSet(sessionRef.current, current.exerciseId, current.setId, 'weight' in p || 'assistanceKg' in p ? { ...p, edited: true } : p));
  };

  const prog = sessionProgress(session);
  const pct = prog.total ? (prog.done / prog.total) * 100 : 0;
  const alertsMissing = !audioAvailable() && !vibrationAvailable() && notificationState() !== 'granted';
  const editingEx = editing ? session.exercises.find((e) => e.id === editing.exId) : undefined;
  const editingSet = editingEx?.sets.find((s) => s.id === editing?.setId);
  const lastForCurrent = currentEx ? history(currentEx.exerciseKey)[0] : undefined;
  const lastText = lastForCurrent && currentEx ? summarizeSets(lastForCurrent.sets, fmtW, currentEx).split(' · ').slice(0, 3).join(' · ') : undefined;

  return (
    <div className="min-h-dvh bg-background">
      {/* Cabeçalho */}
      <header className="sticky top-0 z-30 border-b bg-background/90 pt-safe backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" aria-label="Voltar ao início (treino continua salvo)" onClick={() => navigate('/')}>
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-base font-bold leading-tight">
              <span className="text-primary">Treino {session.workoutLabel}</span> · {session.workoutName}
            </p>
            <p className="text-xs text-muted-foreground tabular">
              <span data-testid="workout-clock">{fmtClock(effectiveDurationSec(session, now))}</span> · {prog.done}/{prog.total} séries · {fmtVol(sessionVolume(session))}
              {' · '}
              {saveState === 'error' ? (
                <button type="button" className="font-semibold text-destructive underline" onClick={() => void flush()} data-testid="save-status">
                  <AlertTriangle className="inline h-3 w-3" /> não salvo · tentar de novo
                </button>
              ) : (
                <span data-testid="save-status" data-state={saveState}>
                  {saveState === 'saving' ? 'salvando…' : 'salvo'}
                </span>
              )}
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Ajuda do exercício atual" onClick={() => setHelpOpen(true)} disabled={!currentEx && !session.exercises.length} data-testid="workout-help-open">
            <HelpCircle />
          </Button>
          <Button size="sm" variant={current ? 'secondary' : 'default'} onClick={() => setFinishOpen(true)} data-testid="open-finish">
            <Flag /> Finalizar
          </Button>
        </div>
        <div className="h-1 bg-secondary">
          <div className="h-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-3 px-3 pb-[calc(30rem+env(safe-area-inset-bottom))] pt-3">
        {session.exercises.map((ex, i) => {
          const isCur = ex.id === current?.exerciseId;
          const open = expanded[ex.id] ?? isCur;
          return (
            <ExerciseCard
              key={ex.id}
              ex={ex}
              index={i}
              settings={settings}
              history={history(ex.exerciseKey)}
              expanded={open}
              currentSetId={current?.setId ?? null}
              onToggle={() => setExpanded((m) => ({ ...m, [ex.id]: !open }))}
              onSelectSet={(s) => {
                if (s.status === 'pending') {
                  setFocusSet({ exerciseId: ex.id, setId: s.id });
                  commit({ ...sessionRef.current, focusExerciseId: ex.id });
                } else setEditing({ exId: ex.id, setId: s.id });
              }}
              onAddSet={(type) => {
                commit(addSet(sessionRef.current, ex.id, type));
                setExpanded((m) => ({ ...m, [ex.id]: true }));
              }}
              onApplyWeight={(kg) => {
                let next = sessionRef.current;
                for (const s of ex.sets) if (s.status === 'pending' && s.type === 'normal') next = updateSet(next, ex.id, s.id, { weight: kg });
                commit(next);
                toast.success(`Carga ajustada para ${fmtW(kg)}`);
              }}
              onSubstitute={() => setBrowser({ mode: 'swap', exId: ex.id })}
              onSkipExercise={() => commit(skipExercise(sessionRef.current, ex.id))}
            />
          );
        })}

        <Button variant="outline" className="w-full" onClick={() => setBrowser({ mode: 'add' })} data-testid="add-exercise">
          <Plus /> Adicionar exercício
        </Button>

        {!current && (
          <div className="rounded-3xl border border-primary/40 bg-primary/10 p-5 text-center">
            <Trophy className="mx-auto h-8 w-8 text-primary" />
            <p className="mt-2 font-display text-lg font-bold">Treino completo!</p>
            <p className="text-sm text-muted-foreground">Finalize para salvar no histórico.</p>
            <Button size="lg" className="mt-4 w-full" onClick={() => setFinishOpen(true)}>
              <Flag /> FINALIZAR TREINO
            </Button>
          </div>
        )}
      </main>

      {/* Painel inferior: série atual ou descanso */}
      <div className="fixed inset-x-0 bottom-0 z-30 pb-safe">
        <div className="pointer-events-none h-6 bg-gradient-to-t from-background to-transparent" />
        <div className="mx-auto max-w-3xl space-y-2 bg-background px-3 pb-3">
          {timerState && timerState.sessionId === session.id && (session.rest || timerState.setId !== currentSet?.id) && (
            <SetTimerChip state={timerState} label={describeTimer(timerState)} onGoTo={session.rest ? undefined : () => goToTimer(timerState)} />
          )}
          {session.rest && (
            <RestPanel
              rest={session.rest}
              alertsMissing={alertsMissing || (!settings.sound && !settings.vibration)}
              onAdjust={(d) => commit({ ...sessionRef.current, rest: adjustRest(sessionRef.current.rest!, d, Date.now()) })}
              onPause={() => commit({ ...sessionRef.current, rest: pauseRest(sessionRef.current.rest!, Date.now()) })}
              onResume={() => commit({ ...sessionRef.current, rest: resumeRest(sessionRef.current.rest!, Date.now()) })}
              onSkip={endRest}
            />
          )}
          {!session.rest && currentEx && currentSet && (
            <SetEditor
              key={currentSet.id}
              ex={currentEx}
              set={currentSet}
              settings={settings}
              lastText={lastText}
              highlight={highlight}
              onPatch={patchCurrent}
              onComplete={doComplete}
              sessionId={session.id}
              onGoToTimer={goToTimer}
              describeTimer={describeTimer}
              onSkip={() => {
                const next = skipSet(sessionRef.current, currentEx.id, currentSet.id);
                const following = nextPending(next, currentEx.id);
                commit({ ...next, focusExerciseId: following?.exerciseId ?? currentEx.id });
                setFocusSet(null);
                toast('Série pulada', { action: { label: 'Desfazer', onClick: () => commit(undoSet(sessionRef.current, currentEx.id, currentSet.id)) } });
              }}
            />
          )}
        </div>
      </div>

      {/* Editar série concluída */}
      <Dialog open={!!editingSet} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          {editingEx && editingSet && (
            <>
              <DialogHeader>
                <DialogTitle>{setLabel(session, { exerciseId: editingEx.id, setId: editingSet.id })}</DialogTitle>
                <DialogDescription>{editingSet.status === 'done' ? 'Série concluída — ajuste os valores se precisar.' : 'Série pulada.'}</DialogDescription>
              </DialogHeader>
              <SetFields compact ex={editingEx} set={editingSet} settings={settings} onPatch={(p) => commit(updateSet(sessionRef.current, editingEx.id, editingSet.id, p))} />
              {editingSet.status === 'done' && setCompletionErrors(editingEx, editingSet).length > 0 && (
                <p role="status" className="text-xs text-warn" data-testid="edit-set-errors">
                  {setCompletionErrors(editingEx, editingSet).join(' ')} Valores inválidos ficam fora do histórico e das análises.
                </p>
              )}
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    commit(removeSet(sessionRef.current, editingEx.id, editingSet.id));
                    setEditing(null);
                  }}
                >
                  <Trash2 /> Remover série
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    commit(undoSet(sessionRef.current, editingEx.id, editingSet.id));
                    setFocusSet({ exerciseId: editingEx.id, setId: editingSet.id });
                    setEditing(null);
                  }}
                  data-testid="undo-set"
                >
                  <Undo2 /> {editingSet.status === 'done' ? 'Desfazer conclusão' : 'Voltar a pendente'}
                </Button>
                <Button onClick={() => setEditing(null)}>Salvar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {helpOpen && (
        <Suspense fallback={null}>
          <WorkoutHelpSheet exercise={helpEx} onClose={() => setHelpOpen(false)} />
        </Suspense>
      )}

      {browser && (
        <Suspense fallback={null}>
          <LibraryBrowser
            open
            onOpenChange={(o) => !o && setBrowser(null)}
            title={browser.mode === 'swap' ? `Trocar ${session.exercises.find((e) => e.id === browser.exId)?.name ?? 'exercício'}` : 'Adicionar exercício'}
            description={browser.mode === 'swap' ? 'Escolha o novo exercício. Você vê a prévia antes de confirmar; a ficha não muda.' : 'Entra no fim deste treino, só nesta sessão. A ficha não muda.'}
            chooseLabel={browser.mode === 'swap' ? 'Usar no lugar' : 'Adicionar ao treino'}
            exclude={keysIn(session)}
            onPick={(item: LibraryItem) => {
              const candidate = sessionCandidate(item, settings, completed ?? []);
              if (browser.mode === 'add') {
                commit(appendExercise(sessionRef.current, candidate));
                setBrowser(null);
                setExpanded((m) => ({ ...m, [candidate.id]: true }));
                scrollTo(candidate.id);
                toast.success(`${item.name} adicionado ao treino`);
                return;
              }
              const preview = swapPreview(sessionRef.current, browser.exId, candidate);
              if (!preview) {
                toast.error('Este exercício não está mais no treino.');
                setBrowser(null);
                return;
              }
              setSwap({ preview, candidate, exId: browser.exId });
              setBrowser(null);
            }}
          />
        </Suspense>
      )}

      <SwapPreviewDialog
        preview={swap?.preview ?? null}
        setTimerOnThis={!!swap && !!timerState && timerState.sessionId === session.id && timerState.exerciseId === swap.exId}
        onCancel={() => setSwap(null)}
        onConfirm={() => {
          if (!swap) return;
          const r = applySwap(sessionRef.current, swap.exId, swap.candidate, uid);
          setSwap(null);
          if (!r) {
            toast.error('Este exercício não está mais no treino. Nada foi trocado.');
            return;
          }
          // O cronômetro de execução de uma série que saiu do treino não tem mais a que se referir.
          setTimerStore.discardWhere((t) => t.sessionId === r.session.id && !r.session.exercises.some((e) => e.id === t.exerciseId && e.sets.some((x) => x.id === t.setId && x.status === 'pending')));
          setFocusSet(null);
          commit(r.session);
          setExpanded((m) => ({ ...m, [r.nextId]: true }));
          scrollTo(r.nextId);
          toast.success(`Trocado por ${swap.candidate.name}`);
        }}
      />

      <FinishDialog
        open={finishOpen}
        onOpenChange={setFinishOpen}
        session={session}
        previous={completed ?? []}
        onDiscard={() => {
          setFinishOpen(false);
          setDiscardOpen(true);
        }}
        onFinish={async (notes) => {
          // Grava o que estiver pendente antes; a conclusão é idempotente (outra aba pode ter finalizado antes).
          await flush();
          if (closedRef.current) {
            navigate('/', { replace: true });
            return;
          }
          const done = await completeSession(sessionRef.current, notes);
          closedRef.current = true;
          toast.success('Treino concluído e salvo!', {
            description: done.advancedRotation ? 'A rotação avançou para o próximo treino.' : 'A rotação não avançou (política de conclusão).',
          });
          navigate(`/historico/${done.id}`, { replace: true });
        }}
      />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        destructive
        title="Descartar este treino?"
        description="As séries registradas nesta sessão serão apagadas e a rotação não muda."
        confirmLabel="Descartar"
        onConfirm={async () => {
          await discardSession(session.id);
          toast('Treino descartado');
          navigate('/', { replace: true });
        }}
      />
    </div>
  );
}

function FinishDialog({
  open,
  onOpenChange,
  session,
  previous,
  onFinish,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  session: WorkoutSession;
  previous: WorkoutSession[];
  onFinish: (notes: string) => Promise<void>;
  onDiscard: () => void;
}) {
  const settings = useSettings();
  const { fmtVol } = useUnits();
  const [notes, setNotes] = useState(session.notes ?? '');
  const [busy, setBusy] = useState(false);
  const dur = effectiveDurationSec(session, Date.now());
  const resumed = (session.timing?.resumes.length ?? 0) > 0;
  const prs = useMemo(() => (open ? sessionPRs(session, previous) : []), [open, session, previous]);
  const pending = sessionProgress(session);
  const willAdvance = shouldAdvance(session, settings.rotationPolicy, settings.rotationThreshold);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Finalizar treino {session.workoutLabel}</DialogTitle>
          <DialogDescription>
            {pending.done < pending.total ? `Ainda há ${pending.total - pending.done} série(s) pendente(s); elas não serão contadas.` : 'Tudo pronto. Bom trabalho!'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            ['Duração', fmtDuration(dur)],
            ['Volume', fmtVol(sessionVolume(session))],
            ['Séries', String(validSetCount(session))],
          ].map(([k, v]) => (
            <div key={k} className="rounded-2xl bg-secondary/60 p-3">
              <p className="font-display text-lg font-bold tabular">{v}</p>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{k}</p>
            </div>
          ))}
        </div>
        {prs.length > 0 && (
          <div className="flex items-start gap-2 rounded-2xl bg-primary/10 p-3 text-sm">
            <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>
              <strong>Recorde pessoal:</strong> {prs.join(', ')}
            </p>
          </div>
        )}
        <p className={cn('text-xs', willAdvance || resumed ? 'text-muted-foreground' : 'text-warn')}>
          {resumed
            ? 'Treino retomado: a rotação não avança de novo ao concluir.'
            : willAdvance
            ? 'Ao concluir, a rotação avança para o próximo treino.'
            : settings.rotationPolicy === 'threshold'
              ? `Concluído ${completionPct(session)}% (mínimo ${settings.rotationThreshold}%): a rotação não vai avançar.`
              : 'Nenhuma série válida: a rotação não vai avançar.'}
        </p>
        <Textarea placeholder="Observações do treino (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <DialogFooter>
          <Button variant="ghost" className="text-destructive" onClick={onDiscard}>
            <Trash2 /> Descartar
          </Button>
          <Button
            size="lg"
            disabled={busy}
            data-testid="confirm-finish"
            onClick={async () => {
              setBusy(true);
              try {
                await onFinish(notes);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Flag /> Concluir treino
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
