// Um plano de leitura (Fase 05): progresso, leitura de hoje, dias concluídos, histórico, pausar/retomar, reorganizar
// o que falta (os dias concluídos continuam) e arquivar/excluir. "Atrasado" é só informação, nunca cobrança.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, BookOpen, Check, Pause, Play, Shuffle, Trash2 } from 'lucide-react';
import { PLAN_STATUS_LABEL, type PlanDayView, type PlanView } from '@shared/bible/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { Bar } from '../life/ui';
import { bibleApi } from './api';
import { readerLink, shortDate } from './ui';

export default function PlanPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const q = useLifeQuery(() => bibleApi.plan(id).then((r) => r.plan), [id]);
  const p = q.data;
  const [resched, setResched] = useState(false);
  const [del, setDel] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  if (!p) return <p className="py-10 text-center text-sm text-muted-foreground">{q.error ? lifeError(q.error) : 'Carregando…'}</p>;
  const days = p.days ?? [];
  const visible = showAll ? days : days.filter((d) => !d.completedOn).slice(0, 7);
  return (
    <div className="space-y-4 pb-10" data-testid="bible-plan">
      <PageHeader
        title={p.title}
        subtitle={PLAN_STATUS_LABEL[p.status]}
        action={
          <Link to="/biblia/planos" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Card>
        <CardContent className="space-y-3 p-4">
          {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
          <div className="flex items-baseline justify-between text-sm">
            <span>
              {p.doneDays} de {p.totalDays} dias
            </span>
            <span className="font-display text-xl font-bold tabular-nums">{p.percent}%</span>
          </div>
          <Bar value={p.percent / 100} className="h-2" label="Progresso do plano" />
          <p className="text-[11px] text-muted-foreground">
            {p.totalChapters} capítulos · começou em {shortDate(p.startDate)}
            {p.behind > 0 && p.status === 'active' ? ` · ${p.behind} dia(s) atrás do ritmo sugerido (tudo bem; dá para reorganizar)` : ''}
          </p>
          {p.next && p.status === 'active' && (
            <div className="rounded-xl bg-primary/10 p-3">
              <p className="text-[11px] uppercase tracking-wider text-primary">Leitura de hoje · dia {p.next.day + 1}</p>
              <p className="text-sm font-medium">{p.next.label}</p>
              <p className="text-[11px] text-muted-foreground">~{p.next.minutes} min</p>
              <Button asChild className="mt-2 w-full" data-testid="bible-plan-read">
                <Link to={`${readerLink(p.next.chapters[0])}&plano=${p.id}&dia=${p.next.day}`}>
                  <BookOpen className="h-4 w-4" /> Ler agora
                </Link>
              </Button>
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            {p.status === 'active' ? (
              <Button variant="secondary" size="sm" onClick={() => void run(() => bibleApi.updatePlan(p.id, p.version, { status: 'paused' }), 'Plano pausado. O histórico fica guardado.')}>
                <Pause className="h-4 w-4" /> Pausar
              </Button>
            ) : p.status !== 'completed' ? (
              <Button variant="secondary" size="sm" onClick={() => void run(() => bibleApi.updatePlan(p.id, p.version, { status: 'active' }), 'Plano retomado.')} data-testid="bible-plan-resume">
                <Play className="h-4 w-4" /> Retomar
              </Button>
            ) : (
              <span />
            )}
            <Button variant="secondary" size="sm" disabled={p.status === 'completed'} onClick={() => setResched(true)}>
              <Shuffle className="h-4 w-4" /> Reorganizar
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDel(true)}>
              <Trash2 className="h-4 w-4" /> Excluir
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{showAll ? 'Todos os dias' : 'Próximos dias'}</h2>
          <button type="button" className="text-xs text-primary" onClick={() => setShowAll((x) => !x)}>
            {showAll ? 'Só os próximos' : 'Ver todos e histórico'}
          </button>
        </div>
        <Card>
          <CardContent className="divide-y divide-border/60 px-4 py-1">
            {visible.map((d) => (
              <DayRow key={d.day} p={p} d={d} onToggle={() => void run(() => (d.completedOn ? bibleApi.uncompleteDay(p.id, d.day) : bibleApi.completeDay(p.id, d.day)))} />
            ))}
            {!visible.length && <p className="py-3 text-sm text-muted-foreground">Todos os dias lidos.</p>}
          </CardContent>
        </Card>
      </section>
      <RescheduleDialog open={resched} onOpenChange={setResched} p={p} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Excluir este plano?"
        description="Os capítulos já registrados continuam no seu histórico de leitura; o XP do plano é estornado."
        destructive
        confirmLabel="Excluir"
        onConfirm={async () => {
          await run(() => bibleApi.deletePlan(p.id), 'Plano excluído.');
          nav('/biblia/planos');
        }}
      />
    </div>
  );
}

function DayRow({ p, d, onToggle }: { p: PlanView; d: PlanDayView; onToggle: () => void }) {
  return (
    <div className="flex items-center gap-3 py-2.5" data-testid="bible-plan-day">
      <button
        type="button"
        onClick={onToggle}
        disabled={p.status !== 'active' && !d.completedOn}
        className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border', d.completedOn ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}
        aria-label={d.completedOn ? `Desmarcar dia ${d.day + 1}` : `Concluir dia ${d.day + 1}`}
      >
        {d.completedOn && <Check className="h-4 w-4" />}
      </button>
      <Link to={`${readerLink(d.chapters[0])}&plano=${p.id}&dia=${d.day}`} className="min-w-0 flex-1">
        <span className="block text-[11px] text-muted-foreground">
          Dia {d.day + 1}
          {d.completedOn ? ` · lido em ${shortDate(d.completedOn)}` : ` · ~${d.minutes} min`}
        </span>
        <span className="block truncate text-sm">{d.label}</span>
      </Link>
    </div>
  );
}

function RescheduleDialog({ open, onOpenChange, p }: { open: boolean; onOpenChange: (o: boolean) => void; p: PlanView }) {
  const left = p.totalDays - p.doneDays;
  const [n, setN] = useState(String(left));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await bibleApi.updatePlan(p.id, p.version, { remainingDays: Number(n), ...(p.status === 'paused' ? { status: 'active' } : {}) });
      toast.success('Plano reorganizado.');
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
          <DialogTitle>Reorganizar o que falta</DialogTitle>
          <DialogDescription>
            Faltam {left} dia(s) de leitura. Os {p.doneDays} dia(s) concluídos continuam no histórico; a leitura restante é redistribuída a partir de hoje.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label>Terminar em quantos dias?</Label>
          <Input inputMode="numeric" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, '').slice(0, 3))} />
        </div>
        <DialogFooter>
          <Button disabled={busy || !Number(n)} onClick={() => void save()}>
            Reorganizar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
