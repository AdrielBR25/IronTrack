// "Minha Evolução" (Fase 06): indicadores de treinos, alimentação, hábitos, XP, leitura, estudos e Bíblia por período,
// com comparação ao período anterior. Tudo calculado pelo servidor a partir dos registros, sem IA (nenhuma chamada
// paga automática). "Sem dados" nunca aparece como desempenho ruim; coincidências não são apresentadas como causa.
// A interpretação pela IA só acontece se a pessoa tocar em "Pedir interpretação".
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Info, Minus, Sparkles, Trophy } from 'lucide-react';
import type { EvolutionMetric, EvolutionPeriod } from '@shared/planner/protocol.ts';
import { PageHeader } from '@/components/AppLayout';
import { BarsChart, ChartCard } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useLifeQuery } from '../life/api';
import { lifeError } from '../life/forms';
import { plannerApi } from './api';

const MODULE_LABEL: Record<EvolutionMetric['module'], string> = { training: 'Treinos', nutrition: 'Alimentação', life: 'Hábitos e RPG', knowledge: 'Leitura e estudos', bible: 'Bíblia' };
const MODULE_LINK: Record<EvolutionMetric['module'], string> = { training: '/evolucao', nutrition: '/alimentacao/analise', life: '/jornada', knowledge: '/conhecimento/estatisticas', bible: '/biblia/progresso' };
const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString('pt-BR') : v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
const dm = (d: string) => d.split('-').reverse().slice(0, 2).join('/');

function Delta({ m }: { m: EvolutionMetric }) {
  if (m.delta == null) return <span className="text-[11px] text-muted-foreground">{m.previous == null ? 'sem comparação' : ''}</span>;
  const Icon = m.delta > 0 ? ArrowUpRight : m.delta < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums', m.delta > 0 ? 'text-primary' : 'text-muted-foreground')}>
      <Icon className="h-3 w-3" />
      {m.delta > 0 ? '+' : ''}
      {fmt(m.delta)} vs. anterior
    </span>
  );
}

export default function EvolutionPage() {
  const [period, setPeriod] = useState<EvolutionPeriod>('week');
  const [offset, setOffset] = useState(0);
  const q = useLifeQuery(() => plannerApi.evolution(period, offset), [period, offset]);
  const v = q.data;
  const groups = useMemo(() => {
    const g = new Map<EvolutionMetric['module'], EvolutionMetric[]>();
    for (const m of v?.metrics ?? []) g.set(m.module, [...(g.get(m.module) ?? []), m]);
    return [...g.entries()];
  }, [v]);
  const daily = useMemo(() => (v?.daily ?? []).map((d) => ({ t: d.date, min: d.knowledgeMin + d.bibleMin, treinos: d.workouts, habitos: d.habitsDone })), [v]);
  const prompt = v ? `Interprete minha evolução (${v.period.label.toLowerCase()}, ${dm(v.period.from)} a ${dm(v.period.to)}) em treinos, alimentação, hábitos, estudos e leitura. Separe o que é registrado, o que está sem dados e o que é sugestão.` : '';

  return (
    <div className="space-y-4 pb-10" data-testid="evolution-page">
      <PageHeader title="Minha Evolução" subtitle={v ? `${v.period.label} · ${dm(v.period.from)} a ${dm(v.period.to)}` : 'Indicadores de todas as áreas'} />
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Período anterior" onClick={() => setOffset((o) => Math.min(24, o + 1))}>
          <ChevronLeft />
        </Button>
        <Segmented
          className="flex-1"
          size="sm"
          aria-label="Período"
          value={period}
          onChange={(p) => (setPeriod(p), setOffset(0))}
          options={[
            { value: 'week', label: 'Semana' },
            { value: 'month', label: 'Mês' },
            { value: 'last7', label: '7 dias' },
            { value: 'last30', label: '30 dias' },
          ]}
        />
        <Button variant="ghost" size="icon-sm" aria-label="Próximo período" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 1))}>
          <ChevronRight />
        </Button>
      </div>

      {!v ? (
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
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-card" />
            ))}
          </div>
        )
      ) : (
        <>
          {v.insights.length > 0 && (
            <Card data-testid="evolution-insights">
              <CardContent className="space-y-2 p-4">
                {v.insights.map((i, k) => (
                  <div key={k} className="flex gap-2 text-sm">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', i.tone === 'positive' ? 'bg-primary' : i.tone === 'attention' ? 'bg-warn' : 'bg-muted-foreground/50')} aria-hidden />
                    <span>
                      {i.text} <span className="text-xs text-muted-foreground">({i.basis})</span>
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {groups.map(([mod, ms]) => (
            <section key={mod} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{MODULE_LABEL[mod]}</h2>
                <Link to={MODULE_LINK[mod]} className="text-xs font-medium text-primary">
                  Detalhes
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {ms.map((m) => (
                  <Card key={m.id} data-testid="evolution-metric" data-metric={m.id}>
                    <CardContent className="space-y-1 p-3">
                      <p className="text-[11px] leading-tight text-muted-foreground">{m.label}</p>
                      {m.value == null ? (
                        <p className="text-sm font-medium text-muted-foreground">Sem dados</p>
                      ) : (
                        <p className="font-display text-xl font-bold tabular-nums">
                          {fmt(m.value)} <span className="text-xs font-normal text-muted-foreground">{m.unit}</span>
                        </p>
                      )}
                      <Delta m={m} />
                      {m.detail && <p className="text-[11px] leading-tight text-muted-foreground">{m.detail}</p>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}

          {v.loads.length > 0 && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-sm font-semibold">Evolução das cargas</p>
                <ul className="divide-y divide-border/60">
                  {v.loads.map((l) => (
                    <li key={l.exercise} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0 truncate">{l.exercise}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {fmt(l.first)} → <span className={cn('font-semibold', l.last > l.first ? 'text-primary' : 'text-foreground')}>{fmt(l.last)} kg</span> · {l.sessions}×
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-muted-foreground">Maior carga de trabalho na primeira e na última sessão do período.</p>
              </CardContent>
            </Card>
          )}

          {daily.some((d) => d.min > 0) && (
            <ChartCard title="Minutos de leitura e estudo por dia" description="Só dias com registro têm barra">
              <BarsChart data={daily} x="t" y="min" fmt={(n) => `${n} min`} xFmt={(t) => dm(String(t))} height={160} />
            </ChartCard>
          )}

          {v.missing.length > 0 && (
            <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Sem registros neste período: {v.missing.join(', ')}. Isso é ausência de dados, não desempenho ruim.
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button asChild variant="outline">
              <Link to={`/assistente?q=${encodeURIComponent(prompt)}`} data-testid="evolution-ask-ai">
                <Sparkles /> Pedir interpretação
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/jornada">
                <Trophy /> Jornada e conquistas
              </Link>
            </Button>
          </div>
          <ul className="space-y-0.5 px-1 text-[11px] text-muted-foreground">
            {v.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
