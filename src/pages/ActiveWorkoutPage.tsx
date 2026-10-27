import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Flag, Trash2, Trophy, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useActiveSession, useCompletedSessions, useNow, useSettings } from '@/hooks/data';
import { completeSession, discardSession, getRoutine, saveSession } from '@/db/repo';
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
  substituteExercise,
  substituteOptions,
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
} from '@/modules/training';
import { audioAvailable, closeRestNotifications, notificationState, unlockAudio, vibrationAvailable } from '@/lib/alerts';
import type { SessionSet, WorkoutSession } from '@/lib/types';
import { ExerciseCard, summarizeSets } from '@/features/workout/ExerciseCard';
import { SetEditor, SetFields } from '@/features/workout/SetEditor';
import { RestPanel } from '@/features/workout/RestPanel';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm';
import { useUnits } from '@/hooks/useUnits';
import { fmtClock, fmtDuration } from '@/lib/utils';
import { cn } from '@/lib/utils';

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
  const [substituting, setSubstituting] = useState<string | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const now = useNow(1000);
  useWakeLock(true);

  // Sincroniza mudanças vindas do banco (ex.: aviso de descanso marcado pelo RestWatcher).
  useEffect(() => {
    if (live && live.id === session.id && live.updatedAt > sessionRef.current.updatedAt) setSession(live);
  }, [live, session.id]);

  const commit = useCallback((next: WorkoutSession) => {
    const stamped = { ...next, updatedAt: Date.now() };
    sessionRef.current = stamped;
    setSession(stamped);
    void saveSession(stamped);
  }, []);

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

  const scrollTo = (exId: string) => {
    requestAnimationFrame(() => document.getElementById(`ex-${exId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const doComplete = () => {
    if (!current || !currentSet) return;
    unlockAudio();
    void closeRestNotifications();
    let next = carryForwardWeight(completeSet(session, current.exerciseId, current.setId), current.exerciseId, current.setId);
    const following = nextPending(next, current.exerciseId);
    const secs = restAfter(next, current, following, settings);
    next = {
      ...next,
      focusExerciseId: following?.exerciseId ?? current.exerciseId,
      rest: following && secs > 0 ? startRest(secs, Date.now(), { nextLabel: setLabel(next, following), exerciseId: following.exerciseId, setId: following.setId }) : null,
    };
    setFocusSet(null);
    commit(next);
    if (navigator.vibrate && settings.vibration) navigator.vibrate(20);
    if (following && following.exerciseId !== current.exerciseId) scrollTo(following.exerciseId);
    if (!following) {
      toast.success('Todas as séries concluídas!', { description: 'Finalize o treino para salvar no histórico.' });
      setFinishOpen(true);
    }
  };

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
    commit(updateSet(session, current.exerciseId, current.setId, 'weight' in p ? { ...p, edited: true } : p));
  };

  const prog = sessionProgress(session);
  const pct = prog.total ? (prog.done / prog.total) * 100 : 0;
  const alertsMissing = !audioAvailable() && !vibrationAvailable() && notificationState() !== 'granted';
  const editingEx = editing ? session.exercises.find((e) => e.id === editing.exId) : undefined;
  const editingSet = editingEx?.sets.find((s) => s.id === editing?.setId);
  const lastForCurrent = currentEx ? history(currentEx.exerciseKey)[0] : undefined;
  const lastText = lastForCurrent ? summarizeSets(lastForCurrent.sets, fmtW).split(' · ').slice(0, 3).join(' · ') : undefined;

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
              {fmtClock((now - session.startedAt) / 1000)} · {prog.done}/{prog.total} séries · {fmtVol(sessionVolume(session))}
            </p>
          </div>
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
                  commit({ ...session, focusExerciseId: ex.id });
                } else setEditing({ exId: ex.id, setId: s.id });
              }}
              onAddSet={(type) => {
                commit(addSet(session, ex.id, type));
                setExpanded((m) => ({ ...m, [ex.id]: true }));
              }}
              onApplyWeight={(kg) => {
                let next = session;
                for (const s of ex.sets) if (s.status === 'pending' && s.type === 'normal') next = updateSet(next, ex.id, s.id, { weight: kg });
                commit(next);
                toast.success(`Carga ajustada para ${fmtW(kg)}`);
              }}
              onSubstitute={() => setSubstituting(ex.id)}
              onSkipExercise={() => commit(skipExercise(session, ex.id))}
            />
          );
        })}

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
          {session.rest && (
            <RestPanel
              rest={session.rest}
              alertsMissing={alertsMissing || (!settings.sound && !settings.vibration)}
              onAdjust={(d) => commit({ ...session, rest: adjustRest(session.rest!, d, Date.now()) })}
              onPause={() => commit({ ...session, rest: pauseRest(session.rest!, Date.now()) })}
              onResume={() => commit({ ...session, rest: resumeRest(session.rest!, Date.now()) })}
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
              onSkip={() => {
                const next = skipSet(session, currentEx.id, currentSet.id);
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
              <SetFields compact ex={editingEx} set={editingSet} settings={settings} onPatch={(p) => commit(updateSet(session, editingEx.id, editingSet.id, p))} />
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    commit(removeSet(session, editingEx.id, editingSet.id));
                    setEditing(null);
                  }}
                >
                  <Trash2 /> Remover série
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    commit(undoSet(session, editingEx.id, editingSet.id));
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

      <SubstituteDialog
        session={session}
        exId={substituting}
        onClose={() => setSubstituting(null)}
        onPick={(name) => {
          if (!substituting) return;
          commit(substituteExercise(session, substituting, name, completed ?? []));
          setSubstituting(null);
          toast.success(`Substituído por ${name}`);
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
          const done = await completeSession(sessionRef.current, notes);
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

function SubstituteDialog({ session, exId, onClose, onPick }: { session: WorkoutSession; exId: string | null; onClose: () => void; onPick: (name: string) => void }) {
  const [name, setName] = useState('');
  const [options, setOptions] = useState<string[]>([]);
  const ex = session.exercises.find((e) => e.id === exId);
  useEffect(() => {
    if (!ex) return;
    setName('');
    void (async () => {
      setOptions(substituteOptions(await getRoutine(session.routineId), ex));
    })();
  }, [ex?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={!!ex} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Substituir exercício</DialogTitle>
          <DialogDescription>
            Substitui <strong>{ex?.name}</strong> só neste treino. As séries já concluídas são mantidas.
          </DialogDescription>
        </DialogHeader>
        {options.length > 0 && (
          <div className="grid gap-2">
            {options.map((o) => (
              <Button key={o} variant="secondary" className="justify-start" onClick={() => onPick(o)}>
                {o}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onPick(name.trim());
          }}
        >
          <Input placeholder="Outro exercício…" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={!name.trim()}>
            Usar
          </Button>
        </form>
      </DialogContent>
    </Dialog>
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
  const dur = (Date.now() - session.startedAt) / 1000;
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
        <p className={cn('text-xs', willAdvance ? 'text-muted-foreground' : 'text-warn')}>
          {willAdvance
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
