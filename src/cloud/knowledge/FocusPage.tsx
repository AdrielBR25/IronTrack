// Modo foco (Fase 04): escolher o que fazer (livro, matéria/tópico ou atividade), o modo (cronômetro livre,
// temporizador ou pomodoro) e começar. A tela em andamento é mínima: relógio, fase, pausar/retomar e encerrar.
// O tempo que conta vem do servidor (ver timer.ts e docs/CONHECIMENTO.md §3): pausas não contam e tempo sem presença
// além do limite também não.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, Coffee, Loader2, Pause, Play, SkipForward, Square, Trash2, WifiOff } from 'lucide-react';
import { DEFAULT_POMODORO, SESSION_KIND_LABEL, TIMER_MODE_LABEL, TIMER_RULES, type PomodoroConfig, type SessionKind, type SessionView, type TimerMode, type TimerView } from '@shared/knowledge/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { Ring } from '../life/ui';
import { knowledgeApi, newId } from './api';
import { fmtClock, liveActive, timerActions, useKnowledgeTimer, useNow } from './timer';
import { fmtMin, intOrNull } from './ui';

const PREFS = 'irontrack.knowledge.focusPrefs.v1';
interface Prefs {
  kind: SessionKind;
  mode: TimerMode;
  plannedMin: number;
  pomodoro: PomodoroConfig;
  sound: boolean;
}
const loadPrefs = (): Prefs => {
  const d: Prefs = { kind: 'reading', mode: 'stopwatch', plannedMin: 30, pomodoro: { ...DEFAULT_POMODORO }, sound: true };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>) };
  } catch {
    return d;
  }
};
const savePrefs = (p: Prefs) => {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    /* ignora */
  }
};

export default function FocusPage() {
  const st = useKnowledgeTimer();
  const [summary, setSummary] = useState<{ session: SessionView | null; xp: number; excludedSec: number } | null>(null);
  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-focus">
      <PageHeader
        title={st.timer ? SESSION_KIND_LABEL[st.timer.kind] : summary ? 'Sessão salva' : 'Nova sessão'}
        subtitle={st.timer ? TIMER_MODE_LABEL[st.timer.mode] : undefined}
        action={
          <Link to="/conhecimento" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Conhecimento">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      {st.offline && (
        <p className="flex items-center gap-2 rounded-xl bg-amber-500/15 px-3 py-2 text-xs text-amber-300">
          <WifiOff className="h-4 w-4" />
          Sem conexão. O cronômetro continua; {st.pendingCount ? `${st.pendingCount} evento(s) serão enviados` : 'tudo será sincronizado'} quando a conexão voltar.
        </p>
      )}
      {!st.loaded && !st.timer ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Carregando…</p>
      ) : st.timer ? (
        <Running t={st.timer} waiting={st.waiting} onSaved={setSummary} />
      ) : summary ? (
        <Summary s={summary} onAgain={() => setSummary(null)} />
      ) : (
        <Setup />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ configuração

function Setup() {
  const [params] = useSearchParams();
  const [p, setP] = useState<Prefs>(loadPrefs);
  const [bookId, setBookId] = useState(params.get('livro') ?? '');
  const [subjectId, setSubjectId] = useState(params.get('materia') ?? '');
  const [topicId, setTopicId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const books = useLifeQuery(() => knowledgeApi.books().then((r) => r.books.filter((b) => b.status !== 'done')));
  const subjects = useLifeQuery(() => knowledgeApi.subjects().then((r) => r.subjects));
  const subject = useLifeQuery(() => (subjectId ? knowledgeApi.subject(subjectId).then((r) => r.subject) : Promise.resolve(null)), [subjectId]);
  useEffect(() => {
    if (params.get('livro')) setP((x) => ({ ...x, kind: 'reading' }));
    else if (params.get('materia')) setP((x) => ({ ...x, kind: 'study' }));
  }, [params]);
  const book = books.data?.find((b) => b.id === bookId);
  const pom = p.pomodoro;
  const setPom = (k: keyof PomodoroConfig, v: number | boolean) => setP({ ...p, pomodoro: { ...pom, [k]: v } });

  const start = async () => {
    setBusy(true);
    savePrefs(p);
    try {
      await timerActions.start({
        id: newId(),
        kind: p.kind,
        bookId: p.kind === 'reading' ? bookId || null : null,
        subjectId: p.kind !== 'reading' ? subjectId || null : null,
        topicId: p.kind !== 'reading' && subjectId ? topicId || null : null,
        label: label || null,
        mode: p.mode,
        plannedMin: p.mode === 'countdown' ? p.plannedMin : null,
        pomodoro: p.mode === 'pomodoro' ? pom : null,
        sound: p.sound,
      });
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };

  const num = (v: number, set: (n: number) => void, [min, max]: readonly [number, number], aria: string) => (
    <Input inputMode="numeric" aria-label={aria} value={String(v)} onChange={(e) => set(Math.max(0, Math.min(max, intOrNull(e.target.value) ?? 0)))} onBlur={() => set(Math.max(min, v))} className="text-center tabular-nums" />
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <Label>O que você vai fazer?</Label>
          <Segmented
            aria-label="Tipo de sessão"
            value={p.kind}
            onChange={(k) => setP({ ...p, kind: k })}
            options={[
              { value: 'reading', label: 'Ler' },
              { value: 'study', label: 'Estudar' },
              { value: 'focus', label: 'Focar' },
            ]}
          />
          {p.kind === 'reading' ? (
            <NativeSelect value={bookId} onChange={(e) => setBookId(e.target.value)} aria-label="Livro" data-testid="focus-book">
              <option value="">Sem livro (artigo, texto avulso)</option>
              {books.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <>
              <NativeSelect value={subjectId} onChange={(e) => (setSubjectId(e.target.value), setTopicId(''))} aria-label="Matéria" data-testid="focus-subject">
                <option value="">{p.kind === 'focus' ? 'Atividade livre' : 'Sem matéria'}</option>
                {subjects.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
              {subjectId && subject.data?.topicList && subject.data.topicList.length > 0 && (
                <NativeSelect value={topicId} onChange={(e) => setTopicId(e.target.value)} aria-label="Tópico">
                  <option value="">Sem tópico específico</option>
                  {subject.data.topicList
                    .filter((t) => t.status !== 'done' || t.id === topicId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                </NativeSelect>
              )}
            </>
          )}
          {((p.kind === 'reading' && !bookId) || (p.kind !== 'reading' && !subjectId)) && <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder={p.kind === 'reading' ? 'O que vai ler? (opcional)' : 'Qual atividade? (opcional)'} aria-label="Descrição" />}
          {book && <p className="text-xs text-muted-foreground">Começando da página {book.currentPage}{book.totalPages ? ` de ${book.totalPages}` : ''}.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <Label>Modo</Label>
          <Segmented
            aria-label="Modo"
            value={p.mode}
            onChange={(m) => setP({ ...p, mode: m })}
            options={[
              { value: 'stopwatch', label: 'Livre' },
              { value: 'countdown', label: 'Tempo' },
              { value: 'pomodoro', label: 'Pomodoro' },
            ]}
          />
          {p.mode === 'stopwatch' && <p className="text-xs text-muted-foreground">Conta até você encerrar. Pausas não contam.</p>}
          {p.mode === 'countdown' && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {[15, 25, 30, 45, 60, 90].map((m) => (
                  <button key={m} type="button" onClick={() => setP({ ...p, plannedMin: m })} className={cn('rounded-full px-3 py-1 text-xs', p.plannedMin === m ? 'bg-primary font-semibold text-primary-foreground' : 'bg-secondary')}>
                    {m} min
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="w-20">{num(p.plannedMin, (n) => setP({ ...p, plannedMin: n }), [1, TIMER_RULES.countdownMaxMin], 'Minutos')}</span>
                minutos
              </div>
            </div>
          )}
          {p.mode === 'pomodoro' && (
            <div className="grid grid-cols-2 gap-3 text-xs">
              <label className="space-y-1">
                <span className="text-muted-foreground">Foco (min)</span>
                {num(pom.focusMin, (n) => setPom('focusMin', n), TIMER_RULES.pomodoro.focusMin, 'Minutos de foco')}
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Pausa curta</span>
                {num(pom.shortBreakMin, (n) => setPom('shortBreakMin', n), TIMER_RULES.pomodoro.shortMin, 'Pausa curta')}
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Pausa longa</span>
                {num(pom.longBreakMin, (n) => setPom('longBreakMin', n), TIMER_RULES.pomodoro.longMin, 'Pausa longa')}
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground">Ciclos até a longa</span>
                {num(pom.cyclesBeforeLong, (n) => setPom('cyclesBeforeLong', n), TIMER_RULES.pomodoro.cycles, 'Ciclos')}
              </label>
              <label className="col-span-2 flex items-center justify-between text-sm">
                Continuar sozinho após a pausa
                <Switch checked={pom.autoContinue} onCheckedChange={(v) => setPom('autoContinue', v)} />
              </label>
            </div>
          )}
          <label className="flex items-center justify-between text-sm">
            Som ao terminar
            <Switch checked={p.sound} onCheckedChange={(v) => setP({ ...p, sound: v })} />
          </label>
        </CardContent>
      </Card>

      <Button size="xl" className="w-full" onClick={start} disabled={busy} data-testid="focus-start">
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Play className="h-5 w-5" />}
        Começar
      </Button>
      <p className="text-center text-[11px] text-muted-foreground">Pode bloquear a tela ou trocar de app. Tempo sem o app aberto conta até {TIMER_RULES.unattendedMaxSec / 60} min por trecho; depois disso, só volta a contar quando você retorna.</p>
    </div>
  );
}

// ------------------------------------------------------------------ em andamento

function Running({ t, waiting, onSaved }: { t: TimerView; waiting: 'break_over' | 'countdown_done' | null; onSaved: (s: { session: SessionView | null; xp: number; excludedSec: number }) => void }) {
  const now = useNow();
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  const a = liveActive(t, now, visible && !t.stale);
  const [finish, setFinish] = useState(false);
  const [discard, setDiscard] = useState(false);
  const inBreak = t.phase === 'short_break' || t.phase === 'long_break';
  const remaining = t.phaseEndsAt ? Math.max(0, (t.phaseEndsAt - now) / 1000) : null;
  const big = t.mode === 'stopwatch' || t.phase === 'paused' ? a.activeSec : (remaining ?? a.activeSec);
  const ring = useMemo(() => {
    if (t.phaseEndsAt && remaining != null) return 1 - remaining / Math.max(1, (t.phaseEndsAt - t.phaseStartedAt) / 1000);
    if (t.mode === 'countdown' && t.plannedSec) return a.activeSec / t.plannedSec;
    return (a.activeSec % 3600) / 3600;
  }, [t, remaining, a.activeSec]);

  return (
    <div className="space-y-5">
      {t.stale && (
        <Card className="border-amber-500/40">
          <CardContent className="space-y-1 p-4 text-sm">
            <p className="font-medium">Sessão interrompida</p>
            <p className="text-xs text-muted-foreground">
              Ficou muito tempo sem sinal do app. Contam {fmtMin(a.activeSec / 60)}
              {a.excludedSec > 60 ? `; ${fmtMin(a.excludedSec / 60)} sem presença não contam` : ''}. Você pode retomar, salvar ou descartar.
            </p>
          </CardContent>
        </Card>
      )}
      <div className="flex flex-col items-center gap-3 py-4">
        <p className="max-w-full truncate text-sm text-muted-foreground" data-testid="focus-title">
          {t.title}
        </p>
        <Ring value={ring} size={240}>
          <div className="text-center">
            <p className={cn('font-display text-5xl font-bold tabular-nums', inBreak && 'text-sky-400')} data-testid="focus-clock">
              {fmtClock(big)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t.phase === 'paused' ? 'Pausado' : inBreak ? (t.phase === 'long_break' ? 'Pausa longa' : 'Pausa') : t.mode === 'stopwatch' ? 'Tempo ativo' : 'Restante'}
            </p>
          </div>
        </Ring>
        <p className="text-xs tabular-nums text-muted-foreground" data-testid="focus-active">
          {fmtMin(a.activeSec / 60)} contando
          {t.mode === 'pomodoro' ? ` · ${t.focusDone} ciclo(s)` : ''}
        </p>
        {waiting === 'break_over' && <p className="text-sm font-medium text-primary">A pausa terminou. Pronto para o próximo ciclo?</p>}
        {waiting === 'countdown_done' && <p className="text-sm font-medium text-primary">Tempo concluído! Salve a sessão ou continue.</p>}
      </div>

      <div className="flex items-center justify-center gap-4">
        <Button variant="ghost" size="icon" className="h-12 w-12 rounded-full" onClick={() => setDiscard(true)} aria-label="Descartar sessão">
          <Trash2 className="h-5 w-5" />
        </Button>
        {t.phase === 'focus' ? (
          <Button size="icon" className="h-20 w-20 rounded-full" onClick={() => void timerActions.pause()} aria-label="Pausar" data-testid="focus-pause">
            <Pause className="h-8 w-8" />
          </Button>
        ) : inBreak ? (
          <Button size="icon" className="h-20 w-20 rounded-full" onClick={() => void timerActions.skipBreak()} aria-label="Pular pausa">
            <SkipForward className="h-8 w-8" />
          </Button>
        ) : (
          <Button size="icon" className="h-20 w-20 rounded-full" onClick={() => void timerActions.resume()} aria-label="Retomar" data-testid="focus-resume">
            <Play className="h-8 w-8" />
          </Button>
        )}
        <Button variant="secondary" size="icon" className="h-12 w-12 rounded-full" onClick={() => setFinish(true)} aria-label="Encerrar e salvar" data-testid="focus-finish">
          <Square className="h-5 w-5" />
        </Button>
      </div>
      {inBreak && (
        <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <Coffee className="h-3.5 w-3.5" />
          Pausas não contam como estudo. Levante, beba água.
        </p>
      )}

      <FinishDialog open={finish} onOpenChange={setFinish} t={t} activeSec={a.activeSec} excludedSec={a.excludedSec} onSaved={onSaved} />
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        destructive
        title="Descartar sessão?"
        description="Nada desta sessão será salvo."
        confirmLabel="Descartar"
        onConfirm={async () => {
          try {
            await timerActions.discard();
          } catch (e) {
            toast.error(lifeError(e));
          }
        }}
      />
    </div>
  );
}

function FinishDialog({ open, onOpenChange, t, activeSec, excludedSec, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; t: TimerView; activeSec: number; excludedSec: number; onSaved: (s: { session: SessionView | null; xp: number; excludedSec: number }) => void }) {
  const computedMin = Math.floor(activeSec / 60);
  const [min, setMin] = useState('');
  const [pageEnd, setPageEnd] = useState('');
  const [finishBook, setFinishBook] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  useEffect(() => {
    if (open) {
      setMin('');
      setPageEnd('');
      setFinishBook(false);
      setNote('');
    }
  }, [open]);
  const save = async () => {
    setBusy(true);
    try {
      const m = intOrNull(min);
      const r = await timerActions.finish({
        activeMin: m != null && m < computedMin ? m : null,
        pageEnd: t.bookId ? intOrNull(pageEnd) : null,
        finishBook,
        note: note || null,
      });
      onOpenChange(false);
      onSaved({ session: r.session, xp: r.outcome.xpGained, excludedSec: r.excludedSec ?? 0 });
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const tooShort = activeSec < TIMER_RULES.minSaveSec && !(t.bookId && intOrNull(pageEnd) != null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Encerrar sessão</DialogTitle>
          <DialogDescription>
            {fmtMin(activeSec / 60)} de tempo ativo{excludedSec > 60 ? ` (${fmtMin(excludedSec / 60)} sem presença não contam)` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {t.bookId && (
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">Parei na página {t.startPage != null ? `(comecei na ${t.startPage})` : ''}</span>
              <Input inputMode="numeric" value={pageEnd} onChange={(e) => setPageEnd(e.target.value)} autoFocus data-testid="finish-page" />
            </label>
          )}
          {t.bookId && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={finishBook} onChange={(e) => setFinishBook(e.target.checked)} className="accent-[hsl(var(--primary))]" />
              Terminei o livro
            </label>
          )}
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">Parei antes? Corrija os minutos (só para menos)</span>
            <Input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} placeholder={String(computedMin)} />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">Nota rápida (opcional)</span>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </label>
          {tooShort && <p className="text-xs text-amber-400">Menos de 1 minuto: continue ou descarte.</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={() => (onOpenChange(false), nav('/conhecimento'))}>
            Continuar depois
          </Button>
          <Button onClick={save} disabled={busy || tooShort} data-testid="finish-save">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar sessão
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Summary({ s, onAgain }: { s: { session: SessionView | null; xp: number; excludedSec: number }; onAgain: () => void }) {
  const x = s.session;
  return (
    <Card data-testid="focus-summary">
      <CardContent className="space-y-4 p-6 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-primary" />
        <div>
          <p className="font-display text-3xl font-bold tabular-nums">{x ? fmtMin(x.activeMin) : '–'}</p>
          <p className="text-sm text-muted-foreground">{x?.title}</p>
        </div>
        <div className="flex justify-center gap-6 text-sm">
          {x && x.pagesRead > 0 && (
            <span>
              <b className="tabular-nums">{x.pagesRead}</b> páginas
            </span>
          )}
          {x && x.focusBlocks > 0 && (
            <span>
              <b className="tabular-nums">{x.focusBlocks}</b> ciclo(s)
            </span>
          )}
          <span className="font-semibold text-primary">+{s.xp} XP</span>
        </div>
        {s.excludedSec > 60 && <p className="text-xs text-muted-foreground">{fmtMin(s.excludedSec / 60)} sem presença não foram contados.</p>}
        {s.xp === 0 && x && x.activeMin < 10 && <p className="text-xs text-muted-foreground">Sessões a partir de 10 minutos rendem XP. Todo minuto conta para as metas.</p>}
        <p className="text-sm">Mais um passo no seu conhecimento. Bom trabalho!</p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onAgain}>
            Nova sessão
          </Button>
          <Button asChild>
            <Link to="/conhecimento">Concluir</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

