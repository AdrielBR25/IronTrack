// Estatísticas do Conhecimento (Fase 04): minutos por dia, horas por semana, evolução da leitura, livros concluídos,
// tempo por matéria, metas cumpridas e constância mensal. Só dias COM registro entram: dia em branco não é "zero".
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookCheck } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { BarsChart, ChartCard, Empty, TrendChart } from '@/components/charts';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { Bar } from '../life/ui';
import { knowledgeApi } from './api';
import { COLOR, addDays, fmtMin, localToday, shortDate } from './ui';

const RANGES = [
  { days: 28, label: '4 semanas' },
  { days: 90, label: '3 meses' },
  { days: 365, label: '12 meses' },
] as const;

const monthLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace('.', '');

export default function StatsPage() {
  const [range, setRange] = useState<number>(28);
  const to = localToday();
  const from = addDays(to, -(range - 1));
  const q = useLifeQuery(() => knowledgeApi.stats(from, to).then((r) => r.stats), [from, to]);
  const s = q.data;
  const daily = useMemo(() => (s?.days ?? []).map((d) => ({ t: d.date, min: d.reading + d.study + d.focus, pages: d.pages })), [s]);
  const pagesCum = useMemo(() => {
    let acc = 0;
    return (s?.days ?? []).filter((d) => d.pages > 0).map((d) => ({ t: d.date, pages: (acc += d.pages) }));
  }, [s]);
  const weekly = useMemo(() => (s?.weeks ?? []).filter((w) => w.daysWithRecords > 0).map((w) => ({ t: w.start, h: Math.round((w.minutes / 60) * 10) / 10 })), [s]);
  const xFmt = (v: string | number) => shortDate(String(v));

  return (
    <div className="space-y-4 pb-10" data-testid="knowledge-stats">
      <PageHeader
        title="Gráficos"
        subtitle="Só dias com registro entram nas médias"
        action={
          <Link to="/conhecimento" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Conhecimento">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        }
      />
      <div className="flex gap-1 rounded-xl bg-secondary p-1">
        {RANGES.map((r) => (
          <button key={r.days} type="button" onClick={() => setRange(r.days)} className={cn('flex-1 rounded-lg py-1.5 text-xs font-medium', range === r.days ? 'bg-background shadow' : 'text-muted-foreground')}>
            {r.label}
          </button>
        ))}
      </div>
      {q.error && !s ? (
        <Card>
          <CardContent className="p-4 text-sm">{lifeError(q.error)}</CardContent>
        </Card>
      ) : !s ? (
        <div className="h-64 animate-pulse rounded-3xl bg-card" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Tempo total" value={fmtMin(s.totals.minutes)} />
            <Stat label="Dias com registro" value={`${s.totals.daysWithRecords}/${s.totals.daysInRange}`} />
            <Stat label="Média nesses dias" value={s.totals.daysWithRecords ? fmtMin(s.totals.avgPerRecordedDay) : '—'} />
            <Stat label="Sessões" value={String(s.totals.sessions)} />
            <Stat label="Páginas" value={String(s.totals.pages)} />
            <Stat label="Melhor sequência" value={`${s.totals.bestStreak} dia(s)`} />
          </div>
          {s.totals.daysWithRecords > 0 && <p className="px-1 text-center text-xs text-muted-foreground">{encourage(s.totals.daysWithRecords, s.totals.daysInRange)}</p>}

          <ChartCard title="Minutos por dia" description="Leitura, estudo e foco somados. Dias em branco ficam de fora.">
            <BarsChart data={daily} x="t" y="min" fmt={(v) => fmtMin(v)} xFmt={xFmt} />
          </ChartCard>

          <ChartCard title="Horas por semana">
            <BarsChart data={weekly} x="t" y="h" fmt={(v) => `${String(v).replace('.', ',')} h`} xFmt={(v) => `sem. ${shortDate(String(v))}`} />
          </ChartCard>

          <ChartCard title="Evolução da leitura" description="Páginas acumuladas no período.">
            {pagesCum.length < 2 ? <Empty text="Registre páginas em pelo menos 2 dias para ver a curva." /> : <TrendChart data={pagesCum} x="t" y="pages" fmt={(v) => `${v} pág.`} xFmt={xFmt} />}
          </ChartCard>

          <ChartCard title="Tempo por matéria">
            {s.bySubject.length ? (
              <div className="space-y-2.5">
                {s.bySubject.map((b) => (
                  <div key={b.id ?? b.name} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>{b.name}</span>
                      <span className="tabular-nums text-muted-foreground">{fmtMin(b.minutes)}</span>
                    </div>
                    <Bar value={b.minutes / Math.max(1, s.bySubject[0].minutes)} tone={b.color ? COLOR[b.color].bar : 'bg-muted-foreground'} className="h-1.5" label={b.name} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty text="Nenhum estudo registrado no período." />
            )}
          </ChartCard>

          <ChartCard title="Constância mensal" description={`Dias com registro em cada mês · ${s.goalsMet} meta(s) cumprida(s) no período.`}>
            <div className="space-y-2.5">
              {s.months.map((m) => (
                <div key={m.month} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="capitalize">{monthLabel(m.month)}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {m.daysWithRecords}/{m.daysInRange} dias · {fmtMin(m.minutes)}
                      {m.goalsMet ? ` · ${m.goalsMet} meta(s)` : ''}
                      {m.booksFinished ? ` · ${m.booksFinished} livro(s)` : ''}
                    </span>
                  </div>
                  <Bar value={m.daysWithRecords / Math.max(1, m.daysInRange)} className="h-1.5" label={monthLabel(m.month)} />
                </div>
              ))}
            </div>
          </ChartCard>

          <ChartCard title="Livros concluídos">
            {s.booksFinished.length ? (
              <div className="divide-y divide-border/60">
                {s.booksFinished.map((b) => (
                  <Link key={b.id} to={`/conhecimento/livro/${b.id}`} className="flex items-center gap-2 py-2 text-sm">
                    <BookCheck className="h-4 w-4 text-primary" />
                    <span className="flex-1 truncate">{b.title}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{shortDate(b.finishedOn)}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <Empty text="Nenhum livro concluído neste período. O próximo pode ser o seu!" />
            )}
          </ChartCard>

          <ChartCard title="Horários em que você mais estuda">
            <BarsChart data={s.byHour.filter((h) => h.minutes > 0).map((h) => ({ t: `${h.hour}h`, min: h.minutes }))} x="t" y="min" fmt={(v) => fmtMin(v)} />
          </ChartCard>
        </>
      )}
    </div>
  );
}

function encourage(days: number, total: number): string {
  const r = days / Math.max(1, total);
  if (r >= 0.7) return 'Constância impressionante. Continue assim!';
  if (r >= 0.4) return 'Bom ritmo: você aparece na maioria das semanas.';
  return 'Cada sessão conta. Pequenos blocos frequentes rendem mais que maratonas.';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-card p-3 text-center">
      <p className="font-display text-lg font-bold tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}
