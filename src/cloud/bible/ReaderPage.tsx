// Leitor da Bíblia (Fase 05): livro/capítulo, versículos numerados, anterior/próximo, busca por referência, favoritos,
// destaques, notas, copiar/compartilhar com a referência e a tradução, preferências de leitura e o cronômetro da
// Fase 04 (o mesmo, não um segundo): "Iniciar leitura" começa no capítulo aberto e, ao encerrar, os capítulos do início
// até o atual ficam registrados. Capítulo e versículo nunca são tratados como "página".
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, Heart, Highlighter, Loader2, MessageCircle, NotebookPen, Pause, Play, Search, Share2, Square, Type, X } from 'lucide-react';
import { TRANSLATION, bookById, chapterKey, formatKey, formatRef, nextChapter, parseKey, parseQuery, passageKey, prevChapter, type ChapterRef } from '@shared/bible/canon.ts';
import { HIGHLIGHT_COLORS, READING_THEME_LABEL, SPACING_LABEL, type BiblePrefsView, type HighlightColor, type MarkView, type ReadingTheme, type Spacing } from '@shared/bible/protocol.ts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { fmtClock, liveActive, timerActions, useKnowledgeTimer, useNow } from '../knowledge/timer';
import { newId } from '../knowledge/api';
import { bibleApi } from './api';
import { useBook } from './text';
import { ChapterPicker, askAiLink } from './ui';

const LAST = 'irontrack.bible.last.v1';
const HL: Record<HighlightColor, string> = { lime: 'bg-lime-400/25', amber: 'bg-amber-400/25', sky: 'bg-sky-400/25', rose: 'bg-rose-400/25', violet: 'bg-violet-400/25' };
const HL_DOT: Record<HighlightColor, string> = { lime: 'bg-lime-400', amber: 'bg-amber-400', sky: 'bg-sky-400', rose: 'bg-rose-400', violet: 'bg-violet-400' };
const THEME: Record<ReadingTheme, string> = { dark: 'bg-card text-foreground', sepia: 'bg-[#f4ecd8] text-[#3b2f1e]', light: 'bg-white text-neutral-900' };
const LEADING: Record<Spacing, string> = { compact: 'leading-normal', normal: 'leading-relaxed', relaxed: 'leading-loose' };

function startRef(params: URLSearchParams): { ch: ChapterRef; v1?: number; v2?: number } {
  const r = parseKey(params.get('ref'));
  if (r) return { ch: { b: r.b, c: r.c }, v1: r.v1, v2: r.v2 };
  try {
    const last = parseKey(localStorage.getItem(LAST));
    if (last) return { ch: { b: last.b, c: last.c } };
  } catch {
    /* sem armazenamento */
  }
  return { ch: { b: 'JHN', c: 1 } as ChapterRef };
}

export default function ReaderPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const s = useMemo(() => startRef(params), [params]);
  const ch = s.ch;
  const key = chapterKey(ch);
  const book = bookById(ch.b)!;
  const text = useBook(ch.b);
  const prefsQ = useLifeQuery(() => bibleApi.prefs().then((r) => r.prefs));
  const [prefs, setPrefs] = useState<BiblePrefsView | null>(null);
  useEffect(() => setPrefs(prefsQ.data ?? null), [prefsQ.data]);
  const marksQ = useLifeQuery(() => bibleApi.marks({ book: ch.b, chapter: ch.c }).then((r) => r.marks), [key]);
  const progQ = useLifeQuery(() => bibleApi.progress().then((r) => r.progress));
  const planId = params.get('plano');
  const planDay = params.get('dia') != null ? Number(params.get('dia')) : null;
  const planQ = useLifeQuery(() => (planId ? bibleApi.plan(planId).then((r) => r.plan) : Promise.resolve(null)), [planId]);
  const [sel, setSel] = useState<number[]>([]);
  const [picker, setPicker] = useState(false);
  const [find, setFind] = useState(false);
  const [settings, setSettings] = useState(false);
  const [note, setNote] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  // Posição: lembra o capítulo (no aparelho e na conta, para continuar em outro aparelho).
  useEffect(() => {
    setSel([]);
    try {
      localStorage.setItem(LAST, key);
    } catch {
      /* ignora */
    }
    const t = setTimeout(() => void bibleApi.position(key).catch(() => undefined), 800);
    return () => clearTimeout(t);
  }, [key]);
  useEffect(() => {
    if (!text.data) return;
    if (s.v1) document.getElementById(`v${s.v1}`)?.scrollIntoView({ block: 'center' });
    else topRef.current?.scrollIntoView({ block: 'start' });
  }, [text.data, key, s.v1]);

  const go = (r: ChapterRef | null) => {
    if (!r) return;
    const p = new URLSearchParams(params);
    p.set('ref', chapterKey(r));
    setParams(p);
  };
  const verses = text.data?.c[ch.c - 1] ?? [];
  const heads = (text.data?.h ?? []).filter((h) => h.c === ch.c);
  const marks = marksQ.data ?? [];
  const hlOf = (v: number) => marks.find((m) => m.kind === 'highlight' && inMark(m, v));
  const favOf = (v: number) => marks.some((m) => m.kind === 'favorite' && inMark(m, v));
  const read = progQ.data?.readKeys.includes(key) ?? false;
  const bookRead = progQ.data?.books.find((b) => b.id === ch.b)?.read ?? 0;
  const fs = prefs?.fontSize ?? 18;

  const selRef = sel.length ? passageKey({ b: ch.b, c: ch.c, v1: Math.min(...sel), v2: Math.max(...sel) }) : null;
  const selLabel = selRef ? formatKey(selRef) : '';
  const selText = () =>
    verses
      .filter((v) => sel.includes(v.v) && !v.o)
      .map((v) => v.t)
      .join(' ');
  const toggle = (v: number) =>
    setSel((x) => {
      if (x.includes(v)) return x.filter((y) => y !== v);
      const all = [...x, v];
      // Seleção contínua (uma passagem): do menor ao maior.
      const lo = Math.min(...all);
      const hi = Math.max(...all);
      return hi - lo > 60 ? [v] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    });

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  const favorite = () => run(() => bibleApi.addMark({ kind: 'favorite', ref: selRef! }).then(() => setSel([])), `${selLabel} nos favoritos.`);
  const highlight = (color: HighlightColor) => run(() => bibleApi.addMark({ kind: 'highlight', ref: selRef!, color }).then(() => setSel([])));
  const unmark = (m: MarkView) => run(() => bibleApi.deleteMark(m.id));
  const quote = () => `“${selText()}” — ${selLabel} (${TRANSLATION.short}, domínio público)`;
  const copy = () =>
    run(async () => {
      await navigator.clipboard.writeText(quote());
      setSel([]);
    }, 'Copiado com a referência.');
  const share = () =>
    run(async () => {
      if (navigator.share) await navigator.share({ text: quote() }).catch(() => undefined);
      else await navigator.clipboard.writeText(quote());
      setSel([]);
    });
  const toggleRead = () => run(() => (read ? bibleApi.unmarkRead(key) : bibleApi.markRead([key], planId)), read ? undefined : `${formatRef(ch)} marcado como lido.`);

  return (
    <div className="space-y-3 pb-40" data-testid="bible-reader">
      <header className="sticky top-0 z-20 -mx-4 flex items-center gap-1 bg-background/90 px-2 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-xl">
        <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para a Bíblia">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <button type="button" onClick={() => setPicker(true)} className="flex min-w-0 flex-1 items-center gap-1 rounded-xl px-2 py-1.5 text-left active:bg-accent" data-testid="bible-reader-title">
          <span className="truncate font-display text-lg font-bold">{formatRef(ch)}</span>
          <ChevronRight className="h-4 w-4 rotate-90 text-muted-foreground" />
        </button>
        <span className="rounded-lg bg-secondary px-2 py-1 text-[11px] font-semibold text-muted-foreground" title={TRANSLATION.name}>
          {TRANSLATION.short}
        </span>
        <button type="button" onClick={() => setFind(true)} className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Buscar referência">
          <Search className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setSettings(true)} className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Preferências de leitura">
          <Type className="h-5 w-5" />
        </button>
      </header>

      {planQ.data && planDay != null && planQ.data.days?.[planDay] && <PlanBanner planTitle={planQ.data.title} planId={planQ.data.id} day={planQ.data.days[planDay]} current={key} onGo={(k) => go(parseKey(k))} />}
      <ReadingTimer ch={ch} planId={planId} />

      <div ref={topRef} className={cn('scroll-mt-24 rounded-2xl px-4 py-5', THEME[prefs?.readingTheme ?? 'dark'])}>
        <p className="mb-1 text-[11px] uppercase tracking-wider opacity-60">{book.long}</p>
        <h1 className="mb-4 font-display text-3xl font-bold">{ch.c}</h1>
        {text.loading && !text.data ? (
          <p className="flex items-center gap-2 py-10 text-sm opacity-70">
            <Loader2 className="h-4 w-4 animate-spin" /> Abrindo…
          </p>
        ) : text.error ? (
          <p className="py-6 text-sm">{text.error}</p>
        ) : (
          <div className={cn('font-serif', LEADING[prefs?.spacing ?? 'normal'])} style={{ fontSize: fs }} data-testid="bible-text">
            {verses.map((v) => {
              const head = heads.filter((h) => h.v === v.v);
              const hl = hlOf(v.v);
              const target = s.v1 && v.v >= s.v1 && v.v <= (s.v2 ?? s.v1);
              return (
                <span key={v.v}>
                  {head.map((h, i) => (
                    <span key={i} className="mb-2 mt-4 block font-sans text-sm font-semibold opacity-75">
                      {h.t}
                    </span>
                  ))}
                  {v.p && v.v > 1 && !head.length ? <span className="block h-3" /> : null}
                  <span
                    id={`v${v.v}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggle(v.v)}
                    onKeyDown={(e) => e.key === 'Enter' && toggle(v.v)}
                    className={cn('cursor-pointer rounded-sm transition-colors', v.q && 'block pl-4', hl?.color && HL[hl.color], target && !sel.length && 'bg-primary/15', sel.includes(v.v) && 'underline decoration-primary decoration-2 underline-offset-4')}
                    data-testid={`bible-v-${v.v}`}
                  >
                    <sup className="mr-0.5 select-none font-sans text-[0.6em] font-semibold opacity-60">{v.v}</sup>
                    {v.o ? <span className="font-sans text-xs italic opacity-60">{v.n ? `[${v.n}]` : '[versículo ausente no texto-base desta tradução]'}</span> : v.t}
                    {favOf(v.v) && <Heart className="ml-0.5 inline h-3 w-3 fill-primary text-primary" aria-label="favorito" />}{' '}
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <Button variant="secondary" size="icon" onClick={() => go(prevChapter(ch))} disabled={!prevChapter(ch)} aria-label="Capítulo anterior" data-testid="bible-prev">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <Button variant={read ? 'secondary' : 'default'} onClick={() => void toggleRead()} data-testid="bible-mark-read">
          <Check className="h-4 w-4" />
          {read ? 'Lido' : 'Marcar como lido'}
        </Button>
        <Button variant="secondary" size="icon" onClick={() => go(nextChapter(ch))} disabled={!nextChapter(ch)} aria-label="Próximo capítulo" data-testid="bible-next">
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>
      <p className="text-center text-[11px] text-muted-foreground">
        Capítulo {ch.c} de {book.chapters} · {bookRead}/{book.chapters} de {book.name} lidos · {TRANSLATION.name}
      </p>
      {marks.some((m) => m.kind === 'highlight') && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {marks
            .filter((m) => m.kind === 'highlight')
            .map((m) => (
              <button key={m.id} type="button" onClick={() => void unmark(m)} className="flex items-center gap-1 rounded-full bg-secondary px-2 py-1" aria-label={`Remover destaque ${m.label}`}>
                <span className={cn('h-2 w-2 rounded-full', m.color && HL_DOT[m.color])} />
                {m.label}
                <X className="h-3 w-3" />
              </button>
            ))}
        </div>
      )}

      {sel.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-30 mx-auto max-w-lg px-3" data-testid="bible-actions">
          <div className="space-y-2 rounded-2xl border border-border bg-popover p-3 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{selLabel}</span>
              <button type="button" onClick={() => setSel([])} className="rounded-full p-1 text-muted-foreground" aria-label="Limpar seleção">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Highlighter className="h-4 w-4 text-muted-foreground" />
              {HIGHLIGHT_COLORS.map((c) => (
                <button key={c} type="button" onClick={() => void highlight(c)} className={cn('h-7 w-7 rounded-full', HL_DOT[c])} aria-label={`Destacar em ${c}`} />
              ))}
            </div>
            <div className="grid grid-cols-5 gap-1 text-[10px]">
              <Action icon={Heart} label="Favoritar" onClick={() => void favorite()} testid="bible-act-fav" />
              <Action icon={NotebookPen} label="Nota" onClick={() => setNote(true)} testid="bible-act-note" />
              <Action icon={Copy} label="Copiar" onClick={() => void copy()} />
              <Action icon={Share2} label="Compartilhar" onClick={() => void share()} />
              <Action icon={MessageCircle} label="IA" onClick={() => nav(askAiLink(selLabel))} />
            </div>
          </div>
        </div>
      )}

      <ChapterPicker open={picker} onOpenChange={setPicker} current={ch.b} onPick={(b, c) => go({ b, c } as ChapterRef)} />
      <FindDialog open={find} onOpenChange={setFind} />
      {prefs && <SettingsDialog open={settings} onOpenChange={setSettings} prefs={prefs} onChange={setPrefs} />}
      {selRef && <NoteDialog open={note} onOpenChange={setNote} refKey={selRef} label={selLabel} onSaved={() => setSel([])} />}
    </div>
  );
}

const inMark = (m: MarkView, v: number) => {
  const r = parseKey(m.ref);
  return !!r && v >= (r.v1 ?? 1) && v <= (r.v2 ?? r.v1 ?? 1);
};

function Action({ icon: Icon, label, onClick, testid }: { icon: typeof Heart; label: string; onClick: () => void; testid?: string }) {
  return (
    <button type="button" onClick={onClick} className="flex flex-col items-center gap-1 rounded-xl py-2 active:bg-accent" data-testid={testid}>
      <Icon className="h-5 w-5 text-primary" />
      {label}
    </button>
  );
}

function PlanBanner({ planTitle, planId, day, current, onGo }: { planTitle: string; planId: string; day: { day: number; chapters: string[]; label: string; completedOn: string | null }; current: string; onGo: (k: string) => void }) {
  const [busy, setBusy] = useState(false);
  const idx = day.chapters.indexOf(current);
  const nextInDay = idx >= 0 ? day.chapters[idx + 1] : day.chapters[0];
  const done = async () => {
    setBusy(true);
    try {
      await bibleApi.completeDay(planId, day.day);
      toast.success(`Dia ${day.day + 1} concluído.`);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-2xl border border-primary/30 bg-primary/10 p-3 text-sm" data-testid="bible-plan-banner">
      <p className="text-xs text-muted-foreground">
        {planTitle} · dia {day.day + 1}
      </p>
      <p className="font-medium">{day.label}</p>
      <div className="flex gap-2">
        {nextInDay && (
          <Button size="sm" variant="secondary" onClick={() => onGo(nextInDay)}>
            {idx >= 0 ? 'Próximo do dia' : 'Ir para a leitura'}
          </Button>
        )}
        {day.completedOn ? (
          <span className="flex items-center gap-1 text-xs text-primary">
            <Check className="h-4 w-4" /> Dia concluído
          </span>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void done()} data-testid="bible-plan-day-done">
            <Check className="h-4 w-4" /> Concluir dia
          </Button>
        )}
      </div>
    </div>
  );
}

/** Cronômetro da Fase 04 aplicado à leitura bíblica (presença, pausas, recuperação e sincronização vêm de lá). */
function ReadingTimer({ ch, planId }: { ch: ChapterRef; planId: string | null }) {
  const st = useKnowledgeTimer();
  const now = useNow(!!st.timer);
  const [busy, setBusy] = useState(false);
  const [finish, setFinish] = useState(false);
  const t = st.timer;
  if (t && t.module !== 'bible')
    return (
      <p className="rounded-xl bg-secondary/60 p-2 text-center text-xs text-muted-foreground">
        Há outra sessão em andamento ({t.title}).{' '}
        <Link to="/conhecimento/foco" className="text-primary underline">
          Ver
        </Link>
      </p>
    );
  if (!t)
    return (
      <Button
        variant="secondary"
        className="w-full"
        disabled={busy}
        data-testid="bible-timer-start"
        onClick={async () => {
          setBusy(true);
          try {
            await timerActions.start({ id: newId(), ref: chapterKey(ch), mode: 'stopwatch', planId, sound: true }, bibleApi.startTimer);
          } catch (e) {
            toast.error(lifeError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Play className="h-4 w-4" /> Iniciar leitura com cronômetro
      </Button>
    );
  const a = liveActive(t, now);
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-2 pl-3" data-testid="bible-timer">
      <span className="min-w-0 flex-1">
        <span className="block font-display text-xl font-bold tabular-nums">{fmtClock(a.activeSec)}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {t.phase === 'paused' ? 'Pausada' : 'Lendo'} · desde {t.ref ? formatKey(t.ref) : ''}
          {st.offline ? ' · sem conexão' : ''}
        </span>
      </span>
      {t.phase === 'paused' ? (
        <Button size="icon" variant="secondary" onClick={() => void timerActions.resume()} aria-label="Retomar">
          <Play className="h-4 w-4" />
        </Button>
      ) : (
        <Button size="icon" variant="secondary" onClick={() => void timerActions.pause()} aria-label="Pausar">
          <Pause className="h-4 w-4" />
        </Button>
      )}
      <Button size="sm" onClick={() => setFinish(true)} data-testid="bible-timer-finish">
        <Square className="h-4 w-4" /> Encerrar
      </Button>
      <FinishDialog open={finish} onOpenChange={setFinish} startRef={t.ref} current={chapterKey(ch)} activeSec={a.activeSec} />
    </div>
  );
}

function FinishDialog({ open, onOpenChange, startRef, current, activeSec }: { open: boolean; onOpenChange: (o: boolean) => void; startRef: string | null; current: string; activeSec: number }) {
  const [reached, setReached] = useState<'current' | 'none'>('current');
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const start = parseKey(startRef);
  const cur = parseKey(current)!;
  const before = start && (cur.b === start.b ? cur.c < start.c : bookById(cur.b)!.order < bookById(start.b)!.order);
  const save = async () => {
    setBusy(true);
    try {
      const r = await timerActions.finish({ reached: reached === 'current' && !before ? current : null, note: noteText || null }, bibleApi.finishTimer);
      toast.success(r.session ? `Leitura salva: ${r.session.activeMin} min${r.outcome.xpGained ? ` · +${r.outcome.xpGained} XP` : ''}` : 'Sessão curta demais para salvar.');
      onOpenChange(false);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      await timerActions.discard();
      onOpenChange(false);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Encerrar leitura</DialogTitle>
          <DialogDescription>{fmtClock(activeSec)} de leitura ativa (pausas não contam).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label>Até onde você leu?</Label>
          <Segmented
            aria-label="Capítulo alcançado"
            value={reached}
            onChange={setReached}
            options={[
              { value: 'current', label: before ? 'Capítulo anterior ao início' : `Até ${formatKey(current)}` },
              { value: 'none', label: 'Não registrar capítulos' },
            ]}
          />
          {start && reached === 'current' && !before && <p className="text-xs text-muted-foreground">Ficam registrados os capítulos de {formatKey(chapterKey(start))} a {formatKey(current)}.</p>}
          <Textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Anotação da sessão (opcional, privada)" rows={2} maxLength={2000} />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => void discard()}>
            Descartar
          </Button>
          <Button disabled={busy || activeSec < 60} onClick={() => void save()} data-testid="bible-finish-save">
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FindDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const submit = () => {
    const p = parseQuery(q);
    if (p.kind === 'ref') {
      onOpenChange(false);
      nav(`/biblia/ler?ref=${passageKey(p.ref)}`);
    } else if (p.kind === 'book') {
      onOpenChange(false);
      nav(`/biblia/ler?ref=${p.book.id}.1`);
    } else if (p.kind === 'invalid') setMsg(p.message);
    else {
      onOpenChange(false);
      nav(`/biblia/buscar?q=${encodeURIComponent(q)}`);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ir para…</DialogTitle>
          <DialogDescription>Uma referência (João 3:16, Sl 23) ou palavras para buscar.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-2"
        >
          <Input autoFocus value={q} onChange={(e) => (setQ(e.target.value), setMsg(null))} placeholder="João 3:16" data-testid="bible-find-input" />
          {msg && <p className="text-xs text-destructive">{msg}</p>}
          <Button type="submit" className="w-full">
            Ir
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({ open, onOpenChange, prefs, onChange }: { open: boolean; onOpenChange: (o: boolean) => void; prefs: BiblePrefsView; onChange: (p: BiblePrefsView) => void }) {
  const save = async (patch: Partial<Pick<BiblePrefsView, 'fontSize' | 'spacing' | 'readingTheme'>>) => {
    onChange({ ...prefs, ...patch });
    try {
      onChange((await bibleApi.updatePrefs(patch)).prefs);
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leitura</DialogTitle>
          <DialogDescription>Tradução: {TRANSLATION.name} (única disponível, domínio público).</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Tamanho da letra: {prefs.fontSize}px</Label>
            <input type="range" min={14} max={30} value={prefs.fontSize} onChange={(e) => void save({ fontSize: Number(e.target.value) })} className="w-full accent-[hsl(var(--primary))]" aria-label="Tamanho da letra" />
          </div>
          <div className="space-y-2">
            <Label>Espaçamento</Label>
            <Segmented aria-label="Espaçamento" value={prefs.spacing} onChange={(v) => void save({ spacing: v })} options={(Object.keys(SPACING_LABEL) as Spacing[]).map((k) => ({ value: k, label: SPACING_LABEL[k] }))} />
          </div>
          <div className="space-y-2">
            <Label>Tema de leitura</Label>
            <Segmented aria-label="Tema de leitura" value={prefs.readingTheme} onChange={(v) => void save({ readingTheme: v })} options={(Object.keys(READING_THEME_LABEL) as ReadingTheme[]).map((k) => ({ value: k, label: READING_THEME_LABEL[k] }))} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NoteDialog({ open, onOpenChange, refKey, label, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; refKey: string; label: string; onSaved: () => void }) {
  const [kind, setKind] = useState<'reflection' | 'note' | 'gratitude'>('reflection');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await bibleApi.createReflection({ kind, content, ref: refKey });
      toast.success('Salvo no seu diário (privado).');
      setContent('');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>Fica no seu diário espiritual, visível só para você.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Segmented
            aria-label="Tipo"
            value={kind}
            onChange={setKind}
            size="sm"
            options={[
              { value: 'reflection', label: 'Reflexão' },
              { value: 'note', label: 'Anotação' },
              { value: 'gratitude', label: 'Gratidão' },
            ]}
          />
          <Textarea autoFocus value={content} onChange={(e) => setContent(e.target.value)} rows={5} maxLength={8000} placeholder="Escreva com suas palavras…" data-testid="bible-note-text" />
        </div>
        <DialogFooter>
          <Button disabled={busy || !content.trim()} onClick={() => void save()} data-testid="bible-note-save">
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
