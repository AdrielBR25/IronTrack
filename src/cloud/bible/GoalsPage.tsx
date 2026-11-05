// Metas e sessões da Bíblia (Fase 05). Metas opcionais: capítulos, minutos, dias, sessões ou concluir um plano; podem
// contar para um hábito ou missão (aí o XP vem de lá, sem duplicar). Sessões: as do cronômetro e registros manuais.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { BOOKS } from '@shared/bible/canon.ts';
import { BIBLE_GOAL_METRICS, type BibleGoalMetric } from '@shared/bible/protocol.ts';
import type { GoalView, SessionView } from '@shared/knowledge/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, NativeSelect } from '@/components/ui/input';
import { lifeApi, useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { Section } from '../knowledge/parts';
import { GoalRow, SessionRow, localToday } from '../knowledge/ui';
import { bibleApi } from './api';

const METRIC_LABEL: Record<BibleGoalMetric, string> = { chapters: 'Capítulos', minutes: 'Minutos', days: 'Dias com leitura', sessions: 'Sessões', plan_finish: 'Concluir um plano' };
const PRESETS: { label: string; g: Record<string, unknown> }[] = [
  { label: 'Ler um capítulo por dia', g: { metric: 'chapters', period: 'daily', target: 1 } },
  { label: 'Ler 15 minutos por dia', g: { metric: 'minutes', period: 'daily', target: 15 } },
  { label: 'Ler Provérbios durante a semana', g: { metric: 'chapters', period: 'weekly', target: 7, book: 'PRO' } },
  { label: 'Ler em 5 dias por semana', g: { metric: 'days', period: 'weekly', target: 5 } },
];

export default function BibleGoalsPage() {
  const goals = useLifeQuery(() => bibleApi.goals().then((r) => r.goals));
  const sessions = useLifeQuery(() => bibleApi.sessions().then((r) => r.sessions));
  const [create, setCreate] = useState(false);
  const [manual, setManual] = useState(false);
  const [del, setDel] = useState<GoalView | null>(null);
  const [delS, setDelS] = useState<SessionView | null>(null);
  const quick = async (g: Record<string, unknown>) => {
    try {
      await bibleApi.createGoal(g);
      toast.success('Meta criada.');
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  return (
    <div className="space-y-4 pb-10" data-testid="bible-goals">
      <PageHeader
        title="Metas e sessões"
        subtitle="Opcionais: leia no seu ritmo"
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <Section title="Metas" action={<button type="button" className="text-xs text-primary" onClick={() => setCreate(true)}>Nova meta</button>}>
        {(goals.data ?? []).map((g) => (
          <div key={g.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <GoalRow g={g} />
            </div>
            <button type="button" onClick={() => setDel(g)} className="rounded-full p-1 text-muted-foreground" aria-label={`Excluir meta ${g.title}`}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        {goals.data && !goals.data.length && (
          <div className="space-y-1 py-2">
            <p className="text-xs text-muted-foreground">Sugestões (toque para criar):</p>
            {PRESETS.map((p) => (
              <button key={p.label} type="button" onClick={() => void quick(p.g)} className="block w-full rounded-lg py-1.5 text-left text-sm active:bg-accent">
                + {p.label}
              </button>
            ))}
          </div>
        )}
      </Section>
      <p className="px-1 text-[11px] text-muted-foreground">XP vem da leitura registrada (Espiritualidade), com limites diários. Reflexões e orações não valem XP: não medimos fé.</p>

      <Section title="Sessões de leitura" action={<button type="button" className="flex items-center gap-1 text-xs text-primary" onClick={() => setManual(true)}><Plus className="h-3.5 w-3.5" />Registrar</button>}>
        {(sessions.data ?? []).map((s) => (
          <SessionRow key={s.id} s={s} onClick={() => setDelS(s)} />
        ))}
        {sessions.data && !sessions.data.length && <p className="py-3 text-sm text-muted-foreground">Sem sessões nos últimos 30 dias. Use “Iniciar leitura” no leitor.</p>}
      </Section>

      <GoalDialog open={create} onOpenChange={setCreate} />
      <ManualDialog open={manual} onOpenChange={setManual} />
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Excluir meta?" destructive confirmLabel="Excluir" onConfirm={async () => {
          if (del) await bibleApi.deleteGoal(del.id).catch((e) => toast.error(lifeError(e)));
        }} />
      <ConfirmDialog
        open={!!delS}
        onOpenChange={(o) => !o && setDelS(null)}
        title="Excluir esta sessão?"
        description="Os minutos, os capítulos registrados por ela e o XP dela saem do histórico."
        destructive
        confirmLabel="Excluir"
        onConfirm={async () => {
          if (delS) await bibleApi.deleteSession(delS.id).catch((e) => toast.error(lifeError(e)));
        }}
      />
    </div>
  );
}

function GoalDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [metric, setMetric] = useState<BibleGoalMetric>('chapters');
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'by_date'>('daily');
  const [target, setTarget] = useState('1');
  const [book, setBook] = useState('');
  const [planId, setPlanId] = useState('');
  const [due, setDue] = useState('');
  const [habitId, setHabitId] = useState('');
  const [busy, setBusy] = useState(false);
  const plans = useLifeQuery(() => (open ? bibleApi.plans().then((r) => r.plans.filter((p) => p.status === 'active' || p.status === 'paused')) : Promise.resolve([])), [open]);
  const habits = useLifeQuery(() => (open ? lifeApi.habits().then((r) => r.habits) : Promise.resolve([])), [open]);
  const save = async () => {
    setBusy(true);
    try {
      await bibleApi.createGoal({
        metric,
        period: metric === 'plan_finish' ? 'by_date' : period,
        target: Number(target) || 1,
        book: book || null,
        planId: metric === 'plan_finish' ? planId || null : null,
        dueDate: metric === 'plan_finish' || period === 'by_date' ? due || null : null,
        habitId: habitId && period === 'daily' ? habitId : null,
      });
      toast.success('Meta criada.');
      onOpenChange(false);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nova meta</DialogTitle>
          <DialogDescription>Metas são opcionais e nunca medem a fé de ninguém.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>O quê</Label>
              <NativeSelect value={metric} onChange={(e) => setMetric(e.target.value as BibleGoalMetric)}>
                {BIBLE_GOAL_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {metric !== 'plan_finish' && (
              <div className="space-y-1">
                <Label>Quando</Label>
                <NativeSelect value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>
                  {metric !== 'days' && <option value="daily">Por dia</option>}
                  <option value="weekly">Por semana</option>
                  <option value="by_date">Até uma data</option>
                </NativeSelect>
              </div>
            )}
          </div>
          {metric !== 'plan_finish' ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>Quantidade</Label>
                <Input inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, '').slice(0, 4))} />
              </div>
              <div className="space-y-1">
                <Label>Livro (opcional)</Label>
                <NativeSelect value={book} onChange={(e) => setBook(e.target.value)}>
                  <option value="">Qualquer</option>
                  {BOOKS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label>Plano</Label>
              <NativeSelect value={planId} onChange={(e) => setPlanId(e.target.value)}>
                <option value="">Escolha…</option>
                {(plans.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {(metric === 'plan_finish' || period === 'by_date') && (
            <div className="space-y-1">
              <Label>Prazo</Label>
              <Input type="date" value={due} min={localToday()} onChange={(e) => setDue(e.target.value)} />
            </div>
          )}
          {period === 'daily' && metric !== 'plan_finish' && (habits.data ?? []).length > 0 && (
            <div className="space-y-1">
              <Label>Conta para um hábito (opcional)</Label>
              <NativeSelect value={habitId} onChange={(e) => setHabitId(e.target.value)}>
                <option value="">Nenhum</option>
                {(habits.data ?? []).map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={() => void save()} data-testid="bible-goal-save">
            Criar meta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManualDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [from, setFrom] = useState('JHN.1');
  const [to, setTo] = useState('JHN.1');
  const [minutes, setMinutes] = useState('15');
  const [date, setDate] = useState(localToday());
  const [busy, setBusy] = useState(false);
  const chapters = BOOKS.flatMap((b) => Array.from({ length: b.chapters }, (_, i) => ({ k: `${b.id}.${i + 1}`, l: `${b.name} ${i + 1}` })));
  const save = async () => {
    setBusy(true);
    try {
      await bibleApi.logSession({ date, minutes: Number(minutes) || 1, span: from === to ? from : `${from}-${to}` });
      toast.success('Leitura registrada.');
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
          <DialogTitle>Registrar leitura</DialogTitle>
          <DialogDescription>Sem cronômetro: o XP é menor (regras da Fase 04) e só vale para hoje ou ontem.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>De</Label>
              <NativeSelect value={from} onChange={(e) => setFrom(e.target.value)}>
                {chapters.map((c) => (
                  <option key={c.k} value={c.k}>
                    {c.l}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>Até</Label>
              <NativeSelect value={to} onChange={(e) => setTo(e.target.value)}>
                {chapters.map((c) => (
                  <option key={c.k} value={c.k}>
                    {c.l}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Minutos</Label>
              <Input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, '').slice(0, 3))} />
            </div>
            <div className="space-y-1">
              <Label>Data</Label>
              <Input type="date" value={date} max={localToday()} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={() => void save()}>
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
