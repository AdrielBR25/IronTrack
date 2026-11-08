// "Minha Semana" (Fase 06): agenda unificada dos próximos dias com treinos, refeições, hábitos, missões, estudos,
// leitura, planos bíblicos, rotinas, atividades personalizadas e descansos. Cada item vem do registro do módulo de
// origem (nada é copiado); aqui só se criam atividades personalizadas e ajustes de horário/ordem/situação.
// Nada vira "concluído" porque o horário passou: só o registro real (ou a pessoa, nas atividades personalizadas).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDown, ArrowUp, BedDouble, ChevronLeft, ChevronRight, Clock, ExternalLink, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { AGENDA_CATEGORIES, CATEGORY_LABEL, CUSTOM_CATEGORIES, STATUS_LABEL, addMinutes, type AgendaCategory, type AgendaDay, type AgendaItem, type AgendaStatus } from '@shared/planner/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError, toastLifeError } from '../life/forms';
import { plannerApi } from './api';

const WEEKDAY = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WEEKDAY_LONG = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const CATEGORY_COLOR: Record<AgendaCategory, string> = {
  workout: 'bg-rose-500',
  meal: 'bg-amber-500',
  habit: 'bg-emerald-500',
  mission: 'bg-violet-500',
  study: 'bg-sky-500',
  reading: 'bg-indigo-500',
  bible: 'bg-yellow-600',
  routine: 'bg-teal-500',
  custom: 'bg-slate-500',
  rest: 'bg-slate-400',
  free: 'bg-slate-300',
};
export const STATUS_STYLE: Record<AgendaStatus, string> = {
  planned: 'border text-muted-foreground',
  in_progress: 'bg-warn/15 text-warn',
  done: 'bg-primary/15 text-primary',
  missed: 'bg-destructive/15 text-destructive',
  paused: 'bg-secondary text-muted-foreground',
};

const FILTER_KEY = 'irontrack.week.filters.v1';
const readFilters = (): AgendaCategory[] => {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => (AGENDA_CATEGORIES as readonly string[]).includes(x)) : [];
  } catch {
    return [];
  }
};
const saveFilters = (v: AgendaCategory[]) => {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(v));
  } catch {
    /* preferência do aparelho; sem armazenamento, só não lembra */
  }
};

const addDays = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
};
const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const dm = (d: string) => d.split('-').reverse().slice(0, 2).join('/');
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);

export function StatusBadge({ s }: { s: AgendaStatus }) {
  return <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_STYLE[s])}>{STATUS_LABEL[s]}</span>;
}

function ItemRow({ i, onOpen, compact, onMove }: { i: AgendaItem; onOpen: () => void; compact?: boolean; onMove?: (dir: -1 | 1) => void }) {
  return (
    <div className="flex items-center gap-2 py-2" data-testid="week-item" data-key={i.key} data-status={i.status}>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left active:opacity-70">
        <span className="w-11 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{i.startTime ?? '—'}</span>
        <span className={cn('h-8 w-1 shrink-0 rounded-full', CATEGORY_COLOR[i.category])} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm font-medium', (i.status === 'done' || i.status === 'missed') && 'text-muted-foreground', i.status === 'missed' && 'line-through')}>{i.title}</span>
          {!compact && (
            <span className="block truncate text-xs text-muted-foreground">
              {CATEGORY_LABEL[i.category]}
              {i.subtitle ? ` · ${i.subtitle}` : ''}
              {i.adjusted ? ' · ajustado' : ''}
            </span>
          )}
        </span>
        <StatusBadge s={i.status} />
      </button>
      {onMove && (
        <div className="flex shrink-0 flex-col">
          <button type="button" aria-label={`Subir ${i.title}`} onClick={() => onMove(-1)} className="rounded p-0.5 text-muted-foreground active:bg-accent">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label={`Descer ${i.title}`} onClick={() => onMove(1)} className="rounded p-0.5 text-muted-foreground active:bg-accent">
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function DayHeader({ d }: { d: AgendaDay }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <h2 className={cn('text-sm font-semibold capitalize', d.isToday && 'text-primary')}>
        {d.isToday ? 'Hoje' : WEEKDAY_LONG[d.weekday]} <span className="font-normal text-muted-foreground">{dm(d.date)}</span>
      </h2>
      <div className="flex items-center gap-1.5">
        {d.rest && (
          <Badge variant="secondary">
            <BedDouble /> Descanso
          </Badge>
        )}
        {d.conflicts.length > 0 && (
          <Badge variant="warn" data-testid="week-conflict">
            <AlertTriangle /> {d.conflicts.length === 1 ? '1 conflito' : `${d.conflicts.length} conflitos`}
          </Badge>
        )}
        {d.load.overloaded && <Badge variant="destructive">Carregado</Badge>}
        {d.load.plannedMin > 0 && !d.load.overloaded && <span className="text-[11px] text-muted-foreground">{Math.round((d.load.plannedMin / 60) * 10) / 10} h</span>}
      </div>
    </div>
  );
}

function ItemDialog({ item, onClose }: { item: AgendaItem | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [time, setTime] = useState('');
  const [dur, setDur] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTime(item?.startTime ?? '');
    setDur(item?.durationMin ? String(item.durationMin) : '');
  }, [item]);
  if (!item) return null;
  const custom = item.source.module === 'planner';
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      onClose();
    } catch (e) {
      toastLifeError(e);
    } finally {
      setBusy(false);
    }
  };
  const saveTime = () =>
    run(
      () =>
        custom
          ? plannerApi.patchItem(item.source.id, { startTime: time || null, durationMin: dur ? Number(dur) : null }, item.version)
          : plannerApi.override({ key: item.key, date: item.date, startTime: time || null, durationMin: dur ? Number(dur) : null }),
      'Horário ajustado na agenda.',
    );
  const mark = (s: AgendaStatus) =>
    run(() => (custom ? plannerApi.patchItem(item.source.id, { status: s }, item.version) : plannerApi.override({ key: item.key, date: item.date, status: s === 'planned' ? null : (s as 'missed' | 'paused') })), `Marcado como ${STATUS_LABEL[s].toLowerCase()}.`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="week-item-dialog">
        <DialogHeader>
          <DialogTitle>{item.title}</DialogTitle>
          <DialogDescription>
            {CATEGORY_LABEL[item.category]} · {WEEKDAY_LONG[new Date(`${item.date}T00:00:00Z`).getUTCDay()]}, {dm(item.date)}
            {item.subtitle ? ` · ${item.subtitle}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge s={item.status} />
          <span className="text-xs text-muted-foreground">{item.statusSource === 'record' ? 'Situação vinda do registro' : item.statusSource === 'user' ? 'Marcado por você' : 'Ainda não há registro'}</span>
        </div>
        {item.notes && <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">{item.notes}</p>}
        {item.can.move && (
          <div className="space-y-2">
            <p className="text-xs font-semibold">Horário na agenda</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="wk-time">Início</Label>
                <Input id="wk-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="wk-dur">Duração (min)</Label>
                <Input id="wk-dur" type="number" inputMode="numeric" min={5} max={720} value={dur} onChange={(e) => setDur(e.target.value)} />
              </div>
            </div>
            {!custom && <p className="text-[11px] text-muted-foreground">Muda só a agenda; o registro original (hábito, refeição, rotina…) fica como está.</p>}
            <Button variant="outline" className="w-full" disabled={busy} onClick={() => void saveTime()} data-testid="week-save-time">
              <Clock /> Salvar horário
            </Button>
          </div>
        )}
        {item.can.mark.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Situação">
            {item.can.mark
              .filter((s) => s !== item.status)
              .map((s) => (
                <Button key={s} size="sm" variant={s === 'done' ? 'default' : 'secondary'} disabled={busy} onClick={() => void mark(s)} data-testid={`week-mark-${s}`}>
                  {s === 'planned' ? 'Voltar a planejado' : STATUS_LABEL[s]}
                </Button>
              ))}
          </div>
        )}
        {!custom && item.status !== 'done' && <p className="text-[11px] text-muted-foreground">Para concluir, registre a atividade no módulo dela: a agenda nunca marca como feito sozinha.</p>}
        <DialogFooter className="flex-row gap-2">
          {item.link && (
            <Button variant="outline" className="flex-1" onClick={() => navigate(item.link!)}>
              <ExternalLink /> Abrir
            </Button>
          )}
          {item.can.remove && (
            <Button variant="ghost" className="flex-1 text-destructive" disabled={busy} onClick={() => void run(() => plannerApi.removeItem(item.source.id), 'Atividade removida.')}>
              <Trash2 /> Remover
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({ open, date, onClose }: { open: boolean; date: string; onClose: () => void }) {
  const [f, setF] = useState({ title: '', category: 'custom', date, startTime: '', durationMin: '30', notes: '' });
  const [clientId, setClientId] = useState(newId);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF((x) => ({ ...x, title: '', notes: '', date }));
      setClientId(newId());
    }
  }, [open, date]);
  const save = async () => {
    setBusy(true);
    try {
      await plannerApi.addItem({ clientId, date: f.date, title: f.title.trim(), category: f.category, startTime: f.startTime || null, durationMin: f.durationMin ? Number(f.durationMin) : null, notes: f.notes.trim() || null });
      toast.success('Atividade adicionada.');
      onClose();
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="week-add-dialog">
        <DialogHeader>
          <DialogTitle>Nova atividade</DialogTitle>
          <DialogDescription>Fica na sua agenda. Não gera XP: o XP vem dos hábitos, missões e registros.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="wk-title">Título</Label>
            <Input id="wk-title" value={f.title} maxLength={80} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex.: Estudar inglês" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="wk-cat">Tipo</Label>
              <NativeSelect id="wk-cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                {CUSTOM_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="wk-date">Data</Label>
              <Input id="wk-date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="wk-start">Início</Label>
              <Input id="wk-start" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="wk-len">Duração (min)</Label>
              <Input id="wk-len" type="number" inputMode="numeric" min={5} max={720} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} />
            </div>
          </div>
          <div>
            <Label htmlFor="wk-notes">Observação (opcional)</Label>
            <Textarea id="wk-notes" rows={2} maxLength={300} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
          {f.startTime && f.durationMin && <p className="text-xs text-muted-foreground">Termina às {addMinutes(f.startTime, Number(f.durationMin))}.</p>}
        </div>
        <DialogFooter>
          <Button className="w-full" disabled={busy || !f.title.trim() || !f.date} onClick={() => void save()} data-testid="week-add-save">
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function WeekPage() {
  const [start, setStart] = useState<string | null>(null);
  const [view, setView] = useState<'day' | 'week'>('week');
  const [filters, setFilters] = useState<AgendaCategory[]>(readFilters);
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<AgendaItem | null>(null);
  const [adding, setAdding] = useState(false);
  // Fase 08: "Registrar → Atividade" chega com ?nova=1 e abre o formulário de nova atividade.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('nova')) {
      setAdding(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  const q = useLifeQuery(() => plannerApi.week(start ?? undefined), [start]);
  const w = q.data;
  const today = w?.today ?? null;
  const selDay = w?.days.find((d) => d.date === sel) ?? w?.days.find((d) => d.isToday) ?? w?.days[0];
  const visible = (d: AgendaDay) => d.items.filter((i) => !filters.length || filters.includes(i.category));
  const toggle = (c: AgendaCategory) => {
    const next = filters.includes(c) ? filters.filter((x) => x !== c) : [...filters, c];
    setFilters(next);
    saveFilters(next);
  };
  const present = useMemo(() => {
    const s = new Set<AgendaCategory>();
    w?.days.forEach((d) => d.items.forEach((i) => s.add(i.category)));
    return AGENDA_CATEGORIES.filter((c) => s.has(c));
  }, [w]);
  const move = async (d: AgendaDay, idx: number, dir: -1 | 1) => {
    const keys = d.items.map((i) => i.key);
    const j = idx + dir;
    if (j < 0 || j >= keys.length) return;
    [keys[idx], keys[j]] = [keys[j], keys[idx]];
    try {
      await plannerApi.reorder(d.date, keys);
    } catch (e) {
      toastLifeError(e);
    }
  };
  const shift = (n: number) => setStart(addDays(w?.start ?? mondayOf(today ?? new Date().toISOString().slice(0, 10)), n));

  return (
    <div className="space-y-4 pb-10" data-testid="week-page">
      <PageHeader
        title="Minha Semana"
        subtitle={w ? `${dm(w.days[0].date)} a ${dm(w.days[w.days.length - 1].date)}` : 'Treinos, refeições, hábitos, estudos e mais'}
        action={
          <Button size="icon" aria-label="Nova atividade" onClick={() => setAdding(true)} data-testid="week-add">
            <Plus />
          </Button>
        }
      />
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Semana anterior" onClick={() => shift(-7)}>
          <ChevronLeft />
        </Button>
        <Segmented
          className="flex-1"
          size="sm"
          aria-label="Visualização"
          value={view}
          onChange={setView}
          options={[
            { value: 'day', label: 'Dia' },
            { value: 'week', label: 'Semana' },
          ]}
        />
        <Button variant="ghost" size="icon-sm" aria-label="Próxima semana" onClick={() => shift(7)}>
          <ChevronRight />
        </Button>
        {w && !w.days.some((d) => d.isToday) && (
          <Button variant="outline" size="sm" onClick={() => setStart(null)}>
            Hoje
          </Button>
        )}
      </div>
      {present.length > 1 && (
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1" role="group" aria-label="Filtrar categorias">
          {present.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={filters.includes(c)}
              onClick={() => toggle(c)}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs', filters.includes(c) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}
            >
              <span className={cn('h-2 w-2 rounded-full', CATEGORY_COLOR[c])} aria-hidden />
              {CATEGORY_LABEL[c]}
            </button>
          ))}
          {filters.length > 0 && (
            <button type="button" onClick={() => (setFilters([]), saveFilters([]))} className="shrink-0 px-2 text-xs font-medium text-primary">
              Limpar
            </button>
          )}
        </div>
      )}

      {!w ? (
        q.error ? (
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm">{lifeError(q.error)}</p>
              <Button size="sm" onClick={q.reload}>
                Tentar de novo
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            <div className="h-24 animate-pulse rounded-2xl bg-card" />
            <div className="h-24 animate-pulse rounded-2xl bg-card" />
          </div>
        )
      ) : view === 'week' ? (
        <div className="space-y-4">
          {w.days.map((d) => {
            const items = visible(d);
            return (
              <section key={d.date} className="space-y-1.5" data-testid="week-day" data-date={d.date}>
                <DayHeader d={d} />
                <Card className={cn(d.isPast && 'opacity-80')}>
                  <CardContent className="divide-y divide-border/60 px-3 py-1">
                    {items.length === 0 ? (
                      <p className="py-3 text-sm text-muted-foreground">{d.rest ? 'Dia de descanso.' : 'Nada planejado. Período livre.'}</p>
                    ) : (
                      items.map((i) => <ItemRow key={`${i.key}|${i.date}`} i={i} compact={false} onOpen={() => setOpen(i)} />)
                    )}
                    {d.conflicts.map((c) => (
                      <p key={`${c.a}|${c.b}`} className="flex items-start gap-1.5 py-2 text-xs text-warn">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {c.text}
                      </p>
                    ))}
                  </CardContent>
                </Card>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-7 gap-1" role="tablist" aria-label="Dia">
            {w.days.map((d) => (
              <button
                key={d.date}
                type="button"
                role="tab"
                aria-selected={selDay?.date === d.date}
                onClick={() => setSel(d.date)}
                className={cn('flex flex-col items-center rounded-xl py-1.5 text-xs', selDay?.date === d.date ? 'bg-primary text-primary-foreground' : d.isToday ? 'bg-primary/10 text-primary' : 'bg-secondary')}
              >
                <span>{WEEKDAY[d.weekday]}</span>
                <span className="font-semibold tabular-nums">{d.date.slice(8)}</span>
                <span className={cn('mt-0.5 h-1 w-1 rounded-full', d.conflicts.length ? 'bg-warn' : d.items.length ? 'bg-current opacity-60' : 'bg-transparent')} />
              </button>
            ))}
          </div>
          {selDay && (
            <section className="space-y-1.5">
              <DayHeader d={selDay} />
              <Card>
                <CardContent className="divide-y divide-border/60 px-3 py-1">
                  {visible(selDay).length === 0 ? (
                    <p className="py-3 text-sm text-muted-foreground">Nada planejado. Período livre.</p>
                  ) : (
                    visible(selDay).map((i) => <ItemRow key={i.key} i={i} onOpen={() => setOpen(i)} onMove={!filters.length && !selDay.isPast ? (dir) => void move(selDay, selDay.items.indexOf(i), dir) : undefined} />)
                  )}
                  {selDay.conflicts.map((c) => (
                    <p key={`${c.a}|${c.b}`} className="flex items-start gap-1.5 py-2 text-xs text-warn">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {c.text}
                    </p>
                  ))}
                </CardContent>
              </Card>
            </section>
          )}
        </div>
      )}

      <Link to="/assistente?q=Organize%20minha%20semana%20considerando%20meus%20treinos%2C%20refei%C3%A7%C3%B5es%20e%20hor%C3%A1rios%20de%20estudo." className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-sm active:scale-[0.99]">
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Organizar a semana com a IA</span>
          <span className="block text-xs text-muted-foreground">Ela propõe; nada muda sem a sua aprovação.</span>
        </span>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </Link>
      <p className="px-1 text-[11px] text-muted-foreground">Horários no fuso da sua conta ({w?.timezone ?? '—'}). Itens com horário passado continuam “Planejado” até haver registro.</p>

      <ItemDialog item={open} onClose={() => setOpen(null)} />
      <AddDialog open={adding} date={selDay?.date && selDay.date >= (today ?? '') ? selDay.date : (today ?? '')} onClose={() => setAdding(false)} />
    </div>
  );
}
