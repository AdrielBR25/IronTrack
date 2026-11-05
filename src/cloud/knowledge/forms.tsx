// Formulários do Conhecimento (Fase 04): livro, matéria, registro manual e meta. O servidor valida tudo de novo.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ImagePlus, Loader2, X } from 'lucide-react';
import {
  BOOK_CATEGORIES,
  BOOK_STATUS,
  BOOK_STATUS_LABEL,
  GOAL_SCOPES,
  KNOWLEDGE_REWARD,
  SUBJECT_CATEGORIES,
  SUBJECT_COLORS,
  type BookStatus,
  type BookView,
  type GoalMetric,
  type GoalPeriod,
  type GoalScope,
  type GoalView,
  type SessionKind,
  type SubjectColor,
  type SubjectView,
} from '@shared/knowledge/protocol.ts';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { lifeApi, useLifeQuery } from '../life/api';
import { DaysPicker, lifeError } from '../life/forms';
import { knowledgeApi } from './api';
import { BookCover, COLOR, addDays, coverFromFile, intOrNull, localToday } from './ui';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ livro

export function BookDialog({ open, onOpenChange, book, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; book?: BookView | null; onSaved?: (id: string) => void }) {
  const [f, setF] = useState({ title: '', author: '', totalPages: '', currentPage: '', category: '', startedOn: '', targetDate: '', status: 'want' as BookStatus });
  const [cover, setCover] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setF({
      title: book?.title ?? '',
      author: book?.author ?? '',
      totalPages: book?.totalPages?.toString() ?? '',
      currentPage: book ? String(book.currentPage) : '',
      category: book?.category ?? '',
      startedOn: book?.startedOn ?? '',
      targetDate: book?.targetDate ?? '',
      status: book?.status ?? 'want',
    });
    setCover(book?.cover ?? null);
  }, [open, book]);

  const pick = async (fl: File | undefined) => {
    if (!fl) return;
    try {
      setCover(await coverFromFile(fl));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Imagem inválida.');
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        title: f.title,
        author: f.author || null,
        cover,
        totalPages: intOrNull(f.totalPages),
        currentPage: intOrNull(f.currentPage) ?? 0,
        category: f.category || null,
        startedOn: f.startedOn || null,
        targetDate: f.targetDate || null,
        status: f.status,
      };
      if (book) {
        await knowledgeApi.updateBook(book.id, book.version, body);
        onSaved?.(book.id);
      } else {
        const r = await knowledgeApi.createBook(body);
        onSaved?.(r.book.id);
      }
      toast.success(book ? 'Livro atualizado.' : 'Livro adicionado à biblioteca.');
      onOpenChange(false);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{book ? 'Editar livro' : 'Adicionar livro'}</DialogTitle>
          <DialogDescription>Os dados ficam só na sua conta. A capa é opcional.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-3">
            <button type="button" onClick={() => file.current?.click()} className="relative w-20 shrink-0" aria-label="Escolher capa">
              {cover ? <img src={cover} alt="" className="aspect-[2/3] w-full rounded-lg object-cover" /> : f.title ? <BookCover book={{ title: f.title, author: f.author, cover: null, hue: 95 }} /> : <span className="flex aspect-[2/3] w-full items-center justify-center rounded-lg border border-dashed text-muted-foreground"><ImagePlus className="h-5 w-5" /></span>}
              {cover && (
                <span role="button" tabIndex={0} aria-label="Remover capa" onClick={(e) => (e.stopPropagation(), setCover(null))} className="absolute -right-1 -top-1 rounded-full bg-background p-0.5 shadow">
                  <X className="h-3.5 w-3.5" />
                </span>
              )}
            </button>
            <input ref={file} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
            <div className="flex-1 space-y-3">
              <Field label="Título">
                <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} data-testid="book-title" />
              </Field>
              <Field label="Autor">
                <Input value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} maxLength={120} />
              </Field>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Páginas">
              <Input inputMode="numeric" value={f.totalPages} onChange={(e) => setF({ ...f, totalPages: e.target.value })} data-testid="book-pages" />
            </Field>
            <Field label="Página atual">
              <Input inputMode="numeric" value={f.currentPage} onChange={(e) => setF({ ...f, currentPage: e.target.value })} placeholder="0" />
            </Field>
            <Field label="Início">
              <Input type="date" value={f.startedOn} onChange={(e) => setF({ ...f, startedOn: e.target.value })} />
            </Field>
            <Field label="Meta de conclusão">
              <Input type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />
            </Field>
          </div>
          <Field label="Categoria">
            <NativeSelect value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">Sem categoria</option>
              {BOOK_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Status">
            <div className="grid grid-cols-4 gap-1.5">
              {BOOK_STATUS.map((s) => (
                <button key={s} type="button" onClick={() => setF({ ...f, status: s })} className={cn('rounded-lg border px-1 py-2 text-[11px]', f.status === s ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground')}>
                  {BOOK_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || !f.title.trim()} data-testid="book-save">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ matéria

export function SubjectDialog({ open, onOpenChange, subject, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; subject?: SubjectView | null; onSaved?: (id: string) => void }) {
  const [f, setF] = useState({ name: '', description: '', category: '', color: 'lime' as SubjectColor, weeklyGoal: '', topics: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setF({ name: subject?.name ?? '', description: subject?.description ?? '', category: subject?.category ?? '', color: subject?.color ?? 'lime', weeklyGoal: subject?.weeklyGoalMin ? String(subject.weeklyGoalMin) : '', topics: '' });
  }, [open, subject]);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: f.name, description: f.description || null, category: f.category || null, color: f.color, weeklyGoalMin: intOrNull(f.weeklyGoal) };
      if (subject) {
        await knowledgeApi.updateSubject(subject.id, subject.version, body);
        onSaved?.(subject.id);
      } else {
        const topics = f.topics
          .split('\n')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 50)
          .map((title) => ({ title }));
        const r = await knowledgeApi.createSubject({ ...body, ...(topics.length ? { topics } : {}) });
        onSaved?.(String(r.id ?? ''));
      }
      toast.success(subject ? 'Matéria atualizada.' : 'Matéria criada.');
      onOpenChange(false);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{subject ? 'Editar matéria' : 'Nova matéria'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Nome">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} placeholder="Ex.: Programação, Inglês" data-testid="subject-name" />
          </Field>
          <Field label="Descrição">
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={300} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Categoria">
              <NativeSelect value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                <option value="">Sem categoria</option>
                {SUBJECT_CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Meta semanal (min)">
              <Input inputMode="numeric" value={f.weeklyGoal} onChange={(e) => setF({ ...f, weeklyGoal: e.target.value })} placeholder="Ex.: 180" />
            </Field>
          </div>
          <Field label="Cor">
            <div className="flex gap-2">
              {SUBJECT_COLORS.map((c) => (
                <button key={c} type="button" aria-label={c} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} className={cn('h-7 w-7 rounded-full', COLOR[c].bar, f.color === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'opacity-70')} />
              ))}
            </div>
          </Field>
          {!subject && (
            <Field label="Tópicos (opcional)" hint="Um por linha. Você pode adicionar mais depois.">
              <Textarea rows={3} value={f.topics} onChange={(e) => setF({ ...f, topics: e.target.value })} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || !f.name.trim()} data-testid="subject-save">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ registro manual

export function ManualSessionDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  preset?: { kind?: SessionKind; bookId?: string | null; subjectId?: string | null };
}) {
  const today = localToday();
  const books = useLifeQuery(() => (open ? knowledgeApi.books().then((r) => r.books) : Promise.resolve([] as BookView[])), [open]);
  const subjects = useLifeQuery(() => (open ? knowledgeApi.subjects().then((r) => r.subjects) : Promise.resolve([] as SubjectView[])), [open]);
  const [f, setF] = useState({ kind: 'reading' as SessionKind, bookId: '', subjectId: '', label: '', date: today, minutes: '', pageEnd: '', note: '', finishBook: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF({ kind: preset?.kind ?? (preset?.subjectId ? 'study' : 'reading'), bookId: preset?.bookId ?? '', subjectId: preset?.subjectId ?? '', label: '', date: localToday(), minutes: '', pageEnd: '', note: '', finishBook: false });
  }, [open, preset?.kind, preset?.bookId, preset?.subjectId]);
  const book = books.data?.find((b) => b.id === f.bookId);
  const save = async () => {
    setBusy(true);
    try {
      const r = await knowledgeApi.logSession({
        kind: f.kind,
        bookId: f.kind === 'reading' ? f.bookId || null : null,
        subjectId: f.kind !== 'reading' ? f.subjectId || null : null,
        label: f.label || null,
        date: f.date,
        minutes: intOrNull(f.minutes) ?? 0,
        pageEnd: f.kind === 'reading' && f.bookId ? intOrNull(f.pageEnd) : null,
        finishBook: f.finishBook,
        note: f.note || null,
      });
      toast.success(r.existed ? 'Esse registro já estava salvo.' : 'Sessão registrada.');
      onOpenChange(false);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Registrar sessão</DialogTitle>
          <DialogDescription>Para o que você já fez sem o cronômetro. Registros manuais valem metade do XP (até {KNOWLEDGE_REWARD.manualMax} XP, só hoje ou ontem).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Segmented
            aria-label="Tipo"
            value={f.kind}
            onChange={(k) => setF({ ...f, kind: k })}
            options={[
              { value: 'reading', label: 'Leitura' },
              { value: 'study', label: 'Estudo' },
              { value: 'focus', label: 'Foco' },
            ]}
          />
          {f.kind === 'reading' ? (
            <Field label="Livro">
              <NativeSelect value={f.bookId} onChange={(e) => setF({ ...f, bookId: e.target.value })}>
                <option value="">Sem livro (artigo, texto avulso)</option>
                {books.data?.filter((b) => b.status !== 'done' || b.id === f.bookId).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : (
            <Field label="Matéria">
              <NativeSelect value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })}>
                <option value="">Sem matéria</option>
                {subjects.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          {((f.kind === 'reading' && !f.bookId) || (f.kind !== 'reading' && !f.subjectId)) && (
            <Field label="O que foi">
              <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={80} placeholder="Ex.: artigo sobre memória" />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Data">
              <Input type="date" value={f.date} min={addDays(today, -30)} max={today} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </Field>
            <Field label="Minutos">
              <Input inputMode="numeric" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} data-testid="manual-minutes" />
            </Field>
          </div>
          {f.kind === 'reading' && book && (
            <Field label="Parei na página" hint={`Antes: pág. ${book.currentPage}${book.totalPages ? ` de ${book.totalPages}` : ''}`}>
              <Input inputMode="numeric" value={f.pageEnd} onChange={(e) => setF({ ...f, pageEnd: e.target.value })} />
            </Field>
          )}
          {f.kind === 'reading' && book && book.status !== 'done' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.finishBook} onChange={(e) => setF({ ...f, finishBook: e.target.checked })} className="accent-[hsl(var(--primary))]" />
              Terminei o livro
            </label>
          )}
          <Field label="Nota (opcional)">
            <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={2000} />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy} data-testid="manual-save">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ meta

const PRESETS: { label: string; metric: GoalMetric; period: GoalPeriod; scope: GoalScope; target: number; days?: number[] }[] = [
  { label: 'Ler 30 min por dia', metric: 'minutes', period: 'daily', scope: 'reading', target: 30 },
  { label: 'Ler 20 páginas por dia', metric: 'pages', period: 'daily', scope: 'reading', target: 20 },
  { label: 'Estudar 60 min por dia', metric: 'minutes', period: 'daily', scope: 'study', target: 60, days: [1, 2, 3, 4, 5] },
  { label: 'Estudar 3× por semana', metric: 'days', period: 'weekly', scope: 'study', target: 3 },
  { label: '5 sessões de foco por semana', metric: 'sessions', period: 'weekly', scope: 'focus', target: 5 },
];
const SCOPE_LABEL: Record<GoalScope, string> = { reading: 'Leitura', study: 'Estudo', focus: 'Foco', any: 'Qualquer' };
const METRIC_LABEL: Record<GoalMetric, string> = { minutes: 'Minutos', pages: 'Páginas', sessions: 'Sessões', days: 'Dias', book_finish: 'Terminar livro' };

export function GoalDialog({ open, onOpenChange, goal }: { open: boolean; onOpenChange: (o: boolean) => void; goal?: GoalView | null }) {
  const books = useLifeQuery(() => (open ? knowledgeApi.books().then((r) => r.books) : Promise.resolve([] as BookView[])), [open]);
  const subjects = useLifeQuery(() => (open ? knowledgeApi.subjects().then((r) => r.subjects) : Promise.resolve([] as SubjectView[])), [open]);
  const habits = useLifeQuery(() => (open ? lifeApi.habits().then((r) => r.habits) : Promise.resolve([])), [open]);
  const missions = useLifeQuery(() => (open ? lifeApi.missions().then((r) => r.missions.filter((m) => m.status === 'active')) : Promise.resolve([])), [open]);
  const blank = { title: '', metric: 'minutes' as GoalMetric, period: 'daily' as GoalPeriod, scope: 'reading' as GoalScope, target: '30', days: [0, 1, 2, 3, 4, 5, 6], dueDate: '', bookId: '', subjectId: '', preferredTime: '', link: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (goal)
      setF({
        title: goal.title,
        metric: goal.metric,
        period: goal.period,
        scope: goal.scope,
        target: String(goal.target),
        days: goal.days,
        dueDate: goal.dueDate ?? '',
        bookId: goal.bookId ?? '',
        subjectId: goal.subjectId ?? '',
        preferredTime: goal.preferredTime ?? '',
        link: goal.habitId ? `h:${goal.habitId}` : goal.missionId ? `m:${goal.missionId}` : '',
      });
    else setF(blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goal]);
  const link = { habitId: f.link.startsWith('h:') ? f.link.slice(2) : null, missionId: f.link.startsWith('m:') ? f.link.slice(2) : null };
  const save = async () => {
    setBusy(true);
    try {
      if (goal) {
        await knowledgeApi.updateGoal(goal.id, goal.version, { title: f.title || null, target: intOrNull(f.target) ?? goal.target, days: f.days, dueDate: f.dueDate || null, preferredTime: f.preferredTime || null, ...link });
      } else {
        await knowledgeApi.createGoal({
          title: f.title || null,
          metric: f.metric,
          period: f.metric === 'book_finish' ? 'by_date' : f.period,
          scope: f.scope,
          target: intOrNull(f.target) ?? 1,
          days: f.days,
          dueDate: f.dueDate || null,
          bookId: f.bookId || null,
          subjectId: f.subjectId || null,
          preferredTime: f.preferredTime || null,
          ...link,
        });
      }
      toast.success(goal ? 'Meta atualizada.' : 'Meta criada.');
      onOpenChange(false);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const isBook = f.metric === 'book_finish';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{goal ? 'Editar meta' : 'Nova meta'}</DialogTitle>
          <DialogDescription>O progresso vem das suas sessões reais. Vinculada a um hábito ou missão, a meta alimenta esse registro e não dá XP em dobro.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!goal && (
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => setF({ ...f, metric: p.metric, period: p.period, scope: p.scope, target: String(p.target), days: p.days ?? [0, 1, 2, 3, 4, 5, 6], title: '' })} className="rounded-full bg-secondary px-3 py-1 text-xs">
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {!goal && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Medir">
                <NativeSelect value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value as GoalMetric, period: e.target.value === 'book_finish' ? 'by_date' : e.target.value === 'days' && f.period === 'daily' ? 'weekly' : f.period })} data-testid="goal-metric">
                  {(Object.keys(METRIC_LABEL) as GoalMetric[]).map((m) => (
                    <option key={m} value={m}>
                      {METRIC_LABEL[m]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {!isBook && (
                <Field label="Período">
                  <NativeSelect value={f.period} onChange={(e) => setF({ ...f, period: e.target.value as GoalPeriod })}>
                    {f.metric !== 'days' && <option value="daily">Por dia</option>}
                    <option value="weekly">Por semana</option>
                    <option value="by_date">Até uma data</option>
                  </NativeSelect>
                </Field>
              )}
            </div>
          )}
          {!goal && !isBook && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tipo">
                <NativeSelect value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as GoalScope, bookId: '', subjectId: '' })}>
                  {GOAL_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_LABEL[s]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {f.scope === 'study' && (
                <Field label="Matéria">
                  <NativeSelect value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })}>
                    <option value="">Todas</option>
                    {subjects.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              {f.scope === 'reading' && (
                <Field label="Livro">
                  <NativeSelect value={f.bookId} onChange={(e) => setF({ ...f, bookId: e.target.value })}>
                    <option value="">Qualquer leitura</option>
                    {books.data?.filter((b) => b.status !== 'done').map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.title}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
            </div>
          )}
          {!goal && isBook && (
            <Field label="Livro">
              <NativeSelect value={f.bookId} onChange={(e) => setF({ ...f, bookId: e.target.value })}>
                <option value="">Escolha…</option>
                {books.data?.filter((b) => b.status !== 'done').map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            {!isBook && (
              <Field label="Alvo">
                <Input inputMode="numeric" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} data-testid="goal-target" />
              </Field>
            )}
            {(f.period === 'by_date' || isBook) && (
              <Field label="Prazo">
                <Input type="date" value={f.dueDate} min={localToday()} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
              </Field>
            )}
            <Field label="Horário preferido">
              <Input type="time" value={f.preferredTime} onChange={(e) => setF({ ...f, preferredTime: e.target.value })} />
            </Field>
          </div>
          {f.period === 'daily' && !isBook && (
            <Field label="Dias">
              <DaysPicker value={f.days} onChange={(d) => setF({ ...f, days: d })} />
            </Field>
          )}
          <Field label="Nome (opcional)">
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={80} placeholder="Gerado automaticamente" />
          </Field>
          <Field label="Conta para" hint="Ao cumprir, registra o hábito ou avança a missão escolhida (o XP vem só de lá).">
            <NativeSelect value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })}>
              <option value="">Nada (a meta dá o próprio XP)</option>
              {habits.data && habits.data.length > 0 && (
                <optgroup label="Hábitos">
                  {habits.data.map((h) => (
                    <option key={h.id} value={`h:${h.id}`}>
                      {h.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {missions.data && missions.data.length > 0 && (
                <optgroup label="Missões">
                  {missions.data.map((m) => (
                    <option key={m.id} value={`m:${m.id}`}>
                      {m.title}
                    </option>
                  ))}
                </optgroup>
              )}
            </NativeSelect>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || (isBook && (!f.bookId || !f.dueDate))} data-testid="goal-save">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
