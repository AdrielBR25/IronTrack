// Planos de leitura (Fase 05): modelos prontos e plano personalizado (livros ou trecho, por duração ou capítulos por
// dia), com prévia calculada pelo servidor a partir dos capítulos que existem na tradução.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Plus } from 'lucide-react';
import { BOOKS, formatKey } from '@shared/bible/canon.ts';
import { PLAN_TEMPLATES, TEMPLATES, templateSchedule, type PlanTemplate } from '@shared/bible/plans.ts';
import { PageHeader } from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { Section } from '../knowledge/parts';
import { localToday } from '../knowledge/ui';
import { bibleApi, type PlanPreview } from './api';
import { PlanRow } from './ui';

const TEMPLATE_DAYS = Object.fromEntries(PLAN_TEMPLATES.map((t) => [t, TEMPLATES[t].days || templateSchedule(t).length])) as Record<PlanTemplate, number>;

export default function PlansPage() {
  const q = useLifeQuery(() => bibleApi.plans(true).then((r) => r.plans));
  const [tpl, setTpl] = useState<PlanTemplate | null>(null);
  const [custom, setCustom] = useState(false);
  const plans = q.data ?? [];
  const current = plans.filter((p) => p.status === 'active' || p.status === 'paused');
  const done = plans.filter((p) => p.status === 'completed' || p.status === 'archived');
  return (
    <div className="space-y-4 pb-10" data-testid="bible-plans">
      <PageHeader
        title="Planos de leitura"
        subtitle="Pause, retome e reorganize sem perder o histórico"
        action={
          <Link to="/biblia" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      {current.length > 0 && (
        <Section title="Seus planos">
          {current.map((p) => (
            <PlanRow key={p.id} p={p} />
          ))}
        </Section>
      )}
      <section className="space-y-2">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Começar um plano</h2>
        <div className="grid gap-2">
          {PLAN_TEMPLATES.map((t) => (
            <button key={t} type="button" onClick={() => setTpl(t)} className="rounded-2xl bg-card p-3 text-left active:scale-[0.99]" data-testid={`bible-template-${t}`}>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{TEMPLATES[t].title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{TEMPLATE_DAYS[t]} dias</span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{TEMPLATES[t].description}</span>
            </button>
          ))}
          <Button variant="secondary" onClick={() => setCustom(true)} data-testid="bible-plan-custom">
            <Plus className="h-4 w-4" /> Plano personalizado
          </Button>
        </div>
      </section>
      {done.length > 0 && (
        <Section title="Concluídos e arquivados">
          {done.map((p) => (
            <PlanRow key={p.id} p={p} />
          ))}
        </Section>
      )}
      <CreatePlanDialog open={!!tpl || custom} onOpenChange={(o) => !o && (setTpl(null), setCustom(false))} template={tpl} />
    </div>
  );
}

function CreatePlanDialog({ open, onOpenChange, template }: { open: boolean; onOpenChange: (o: boolean) => void; template: PlanTemplate | null }) {
  const nav = useNavigate();
  const [books, setBooks] = useState<string[]>([]);
  const [by, setBy] = useState<'days' | 'perDay'>('days');
  const [n, setN] = useState('');
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(localToday());
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => {
    const num = Number(n) || null;
    return template
      ? { template, days: num, startDate: start, title: title || null }
      : { books, ...(by === 'days' ? { days: num ?? 30 } : { perDay: num ?? 1 }), startDate: start, title: title || null };
  };
  const doPreview = async () => {
    try {
      setPreview(await bibleApi.previewPlan(body()));
    } catch (e) {
      toast.error(lifeError(e));
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await bibleApi.createPlan(body());
      toast.success('Plano criado.');
      onOpenChange(false);
      nav(`/biblia/planos/${r.plan.id}`);
    } catch (e) {
      toast.error(lifeError(e));
    } finally {
      setBusy(false);
    }
  };
  const toggleBook = (id: string) => {
    setPreview(null);
    setBooks((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), setPreview(null))}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? TEMPLATES[template].title : 'Plano personalizado'}</DialogTitle>
          <DialogDescription>{template ? TEMPLATES[template].description : 'Escolha os livros na ordem em que quer ler.'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!template && (
            <>
              <div className="grid max-h-48 grid-cols-3 gap-1 overflow-y-auto">
                {BOOKS.map((b) => (
                  <button key={b.id} type="button" onClick={() => toggleBook(b.id)} className={cn('rounded-lg px-2 py-1.5 text-left text-xs', books.includes(b.id) ? 'bg-primary text-primary-foreground' : 'bg-secondary/60')}>
                    {books.includes(b.id) ? `${books.indexOf(b.id) + 1}. ` : ''}
                    {b.name}
                  </button>
                ))}
              </div>
              <Segmented
                aria-label="Ritmo"
                value={by}
                onChange={(v) => (setBy(v), setPreview(null))}
                size="sm"
                options={[
                  { value: 'days', label: 'Em N dias' },
                  { value: 'perDay', label: 'Capítulos por dia' },
                ]}
              />
            </>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>{template ? 'Duração (dias)' : by === 'days' ? 'Dias' : 'Capítulos/dia'}</Label>
              <Input inputMode="numeric" value={n} onChange={(e) => (setN(e.target.value.replace(/\D/g, '').slice(0, 3)), setPreview(null))} placeholder={template ? String(TEMPLATE_DAYS[template]) : by === 'days' ? '30' : '1'} />
            </div>
            <div className="space-y-1">
              <Label>Início</Label>
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Nome (opcional)</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
          </div>
          {preview && (
            <Card>
              <CardContent className="space-y-1 p-3 text-xs" data-testid="bible-plan-preview">
                <p className="font-semibold">
                  {preview.days} dias · {preview.chapters} capítulos
                </p>
                {preview.first.map((d, i) => (
                  <p key={i} className="text-muted-foreground">
                    Dia {i + 1}: {d.map(formatKey).join(', ')}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => void doPreview()} disabled={!template && !books.length}>
            Prévia
          </Button>
          <Button onClick={() => void create()} disabled={busy || (!template && !books.length)} data-testid="bible-plan-create">
            Criar plano
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
