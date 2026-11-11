// Histórico e gráficos da alimentação (Fase 02). Médias e gráficos usam só dias COM registro: um dia em branco não é
// um dia de jejum. Mostra calorias por dia, médias semanais, proteína ao longo do tempo, distribuição de macros,
// frequência de registro e planejado × consumido.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { BarsChart, ChartCard, Empty, TrendChart } from '@/components/charts';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { nutritionApi } from './api';
import { MACRO_TONE, MacroLine, addDays, grams, kcal, localToday, shortDate } from './ui';

const RANGES = [
  { days: 14, label: '2 semanas' },
  { days: 28, label: '4 semanas' },
  { days: 84, label: '12 semanas' },
] as const;

export default function AnalysisPage() {
  const [range, setRange] = useState<number>(28);
  const to = localToday();
  const from = addDays(to, -(range - 1));
  const q = useLifeQuery(() => nutritionApi.stats(from, to).then((r) => r.stats), [from, to]);
  const s = q.data;
  const daily = useMemo(() => (s?.days ?? []).map((d) => ({ t: d.date, kcal: d.consumed.kcal, protein: d.consumed.protein })), [s]);
  const weekly = useMemo(() => (s?.weeks ?? []).map((w) => ({ t: w.start, kcal: w.average?.kcal ?? 0, days: w.loggedDays })), [s]);
  const g = s?.goals;
  const xFmt = (v: string | number) => shortDate(String(v));

  return (
    <div className="space-y-4 pb-10" data-testid="nutrition-analysis">
      <PageHeader
        title="Histórico e gráficos"
        subtitle="Só dias com registro entram nas médias"
        action={
          <Link to="/alimentacao" className="rounded-full p-2 text-muted-foreground active:bg-accent" aria-label="Voltar para Alimentação">
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
            <Stat label="Dias registrados" value={`${s.loggedDays}/${s.totalDays}`} />
            <Stat label="Média kcal" value={s.average ? kcal(s.average.kcal) : '—'} />
            <Stat label="Média proteína" value={s.average ? `${grams(s.average.protein)} g` : '—'} />
          </div>

          <ChartCard title="Calorias por dia" description="Dias sem registro ficam de fora, não contam como zero.">
            <BarsChart data={daily} x="t" y="kcal" fmt={(v) => `${kcal(v)} kcal`} xFmt={xFmt} goals={g?.kcal ? [{ value: g.kcal, label: 'meta' }] : undefined} />
          </ChartCard>

          <ChartCard title="Média semanal" description="Média de kcal nos dias registrados de cada semana.">
            <BarsChart data={weekly.filter((w) => w.days > 0)} x="t" y="kcal" fmt={(v) => `${kcal(v)} kcal`} xFmt={(v) => `sem. ${shortDate(String(v))}`} />
          </ChartCard>

          <ChartCard title="Proteína ao longo do tempo">
            {daily.length < 2 ? <Empty text="Registre pelo menos 2 dias para ver a linha da proteína." /> : <TrendChart data={daily} x="t" y="protein" fmt={(v) => `${grams(v)} g`} xFmt={xFmt} goals={g?.protein ? [{ value: g.protein, label: 'meta' }] : undefined} />}
          </ChartCard>

          <ChartCard title="Distribuição de macronutrientes" description="Percentual das calorias no período.">
            {s.split ? (
              <div className="space-y-3">
                <div className="flex h-4 overflow-hidden rounded-full">
                  {(['protein', 'carbs', 'fat'] as const).map((k) => (
                    <div key={k} className={MACRO_TONE[k].bar} style={{ width: `${s.split![k]}%` }} />
                  ))}
                </div>
                <div className="grid grid-cols-3 text-center text-xs">
                  {(['protein', 'carbs', 'fat'] as const).map((k) => (
                    <span key={k}>
                      <span className={cn('block text-lg font-bold tabular-nums', MACRO_TONE[k].text)}>{s.split![k]}%</span>
                      <span className="text-muted-foreground">{MACRO_TONE[k].label}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <Empty />
            )}
          </ChartCard>

          <ChartCard title="Frequência de registro" description="Dias com refeições consumidas em cada semana.">
            <BarsChart data={weekly} x="t" y="days" fmt={(v) => `${v} dia(s)`} xFmt={(v) => `sem. ${shortDate(String(v))}`} />
          </ChartCard>

          <ChartCard title="Planejado × consumido" description="Dias que tinham planejamento.">
            {s.planVsActual.length ? (
              <div className="divide-y divide-border/60">
                {s.planVsActual
                  .slice()
                  .reverse()
                  .slice(0, 14)
                  .map((p) => {
                    const diff = p.consumed.kcal - p.planned.kcal;
                    return (
                      <div key={p.date} className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span className="w-12 tabular-nums text-muted-foreground">{shortDate(p.date)}</span>
                        <span className="flex-1 tabular-nums">
                          {kcal(p.consumed.kcal)} <span className="text-muted-foreground">/ {kcal(p.planned.kcal)} kcal</span>
                        </span>
                        <span className={cn('text-xs tabular-nums', Math.abs(diff) <= p.planned.kcal * 0.1 ? 'text-primary' : 'text-muted-foreground')}>
                          {diff > 0 ? '+' : ''}
                          {kcal(diff)}
                        </span>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <Empty text="Planeje refeições para comparar com o que foi consumido." />
            )}
          </ChartCard>

          <section className="space-y-2">
            <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dias registrados</h2>
            <Card className="divide-y divide-border/60">
              {s.days.length === 0 && <CardContent className="p-4 text-sm text-muted-foreground">Nenhum dia registrado no período.</CardContent>}
              {s.days
                .slice()
                .reverse()
                .map((d) => (
                  <Link key={d.date} to={`/alimentacao?dia=${d.date}`} className="flex items-center gap-3 px-4 py-2.5 active:bg-accent">
                    <span className="w-12 text-sm tabular-nums text-muted-foreground">{shortDate(d.date)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium tabular-nums">
                        {kcal(d.consumed.kcal)} kcal · {d.consumedMeals} refeição(ões)
                      </span>
                      <MacroLine m={d.consumed} />
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                ))}
            </Card>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="font-display text-lg font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
