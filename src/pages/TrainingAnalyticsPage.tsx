import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarCheck, Dumbbell, Info, Layers, LineChart, Minus, Repeat, Trophy, TrendingUp, Weight } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { BarsChart, ChartCard, Empty, TrendChart } from '@/components/charts';
import { useCompletedSessions, useToday } from '@/hooks/data';
import { useUnits } from '@/hooks/useUnits';
import { fmtDateShort } from '@/lib/dates';
import { cn, fmtNum } from '@/lib/utils';
import {
  buildInsights,
  createTrainingAnalytics,
  E1RM_MAX_REPS,
  MIN_PRIOR_SESSIONS_FOR_RECORD,
  TREND_MIN_POINTS,
  TREND_MIN_SPAN_DAYS,
  type ExercisePoint,
  type ExerciseSummary,
  type Insight,
  type InsightEvidence,
  type PeriodKey,
  type TrainingReport,
  type Trend,
} from '@/modules/analytics';

// Análise de desempenho (IronTrack 2.0 F01/P08): tudo calculado no aparelho pelo motor local
// (src/modules/analytics), só com leitura das sessões concluídas. Nada é gravado nem enviado.

type ExMetric = 'e1rm' | 'topLoad' | 'bestReps' | 'volume';

const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: '60d', label: '60 dias' },
  { value: '90d', label: '90 dias' },
  { value: 'all', label: 'Tudo' },
];

const TREND_LABEL: Record<Trend['direction'], string> = {
  positiva: 'Evolução positiva',
  estavel: 'Estável',
  queda: 'Abaixo do início do período',
  insuficiente: 'Dados insuficientes',
};

const TREND_REASON: Record<NonNullable<Trend['reason']>, string> = {
  poucas_sessoes: `São necessárias pelo menos ${TREND_MIN_POINTS} sessões com séries comparáveis no período.`,
  intervalo_curto: `As sessões precisam cobrir pelo menos ${TREND_MIN_SPAN_DAYS} dias.`,
  sem_metrica: 'Não há séries comparáveis para este exercício no período.',
};

const TREND_METRIC_LABEL: Record<Trend['metric'], string> = {
  e1rm: '1RM estimado',
  carga_13: 'carga em séries de 13+ repetições',
  reps: 'repetições sem carga',
};

const CONFIDENCE_LABEL = { alta: 'confiança alta', media: 'confiança média', baixa: 'confiança baixa' } as const;

const PICK: Record<ExMetric, (p: ExercisePoint) => number | null> = {
  e1rm: (p) => p.e1rm,
  topLoad: (p) => p.topLoad,
  bestReps: (p) => p.bestReps,
  volume: (p) => (p.loadedSets ? p.volume : null),
};

const signedPct = (v: number) => `${v > 0 ? '+' : ''}${fmtNum(v, 1)}%`;
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'short', year: '2-digit' });
const fmtMonth = (iso: string) => monthFmt.format(new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, 1)).replace('.', '');

function StatCard({ icon: Icon, label, value, hint, testId }: { icon: typeof Dumbbell; label: string; value: string; hint?: string; testId: string }) {
  return (
    <Card className="min-w-0 p-3.5" data-testid={testId}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-1.5 font-display text-2xl font-bold tabular">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function Overview({ report }: { report: TrainingReport }) {
  const { fmtVol } = useUnits();
  const { totals, frequency, comparison, exercises } = report;
  const measurable = exercises.filter((e) => e.trend.direction !== 'insuficiente');
  const improving = measurable.filter((e) => e.trend.direction === 'positiva');
  const vs = (d: { diff: number; pct: number | null } | null) =>
    comparison.available && d ? `${d.diff > 0 ? '+' : ''}${fmtNum(d.diff, 0)} vs. período anterior` : 'sem comparação equivalente';
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <StatCard testId="stat-sessions" icon={CalendarCheck} label="Sessões" value={fmtNum(totals.sessions, 0)} hint={vs(comparison.sessions)} />
      <StatCard
        testId="stat-frequency"
        icon={Repeat}
        label="Por semana"
        value={frequency.weeklyAverage === null ? '—' : fmtNum(frequency.weeklyAverage, 1)}
        hint={frequency.weeklyAverage === null ? 'menos de 7 dias de histórico' : `${frequency.activeWeeks} de ${frequency.weeks} semanas com treino`}
      />
      <StatCard
        testId="stat-volume"
        icon={Weight}
        label="Volume"
        value={fmtVol(totals.volume)}
        hint={totals.unloadedSets ? `+ ${totals.unloadedSets} séries sem carga` : 'carga × repetições'}
      />
      <StatCard testId="stat-sets" icon={Layers} label="Séries" value={fmtNum(totals.sets, 0)} hint={`${fmtNum(totals.reps, 0)} repetições`} />
      <StatCard
        testId="stat-improving"
        icon={TrendingUp}
        label="Com evolução"
        value={measurable.length ? `${improving.length}/${measurable.length}` : '—'}
        hint={measurable.length ? 'exercícios com tendência mensurável' : 'nenhum exercício com dados suficientes'}
      />
      <StatCard testId="stat-days" icon={Dumbbell} label="Dias treinados" value={fmtNum(frequency.distinctDays, 0)} hint={`em ${report.covered?.days ?? 0} dias com histórico`} />
    </div>
  );
}

function EvidenceChip({ e }: { e: InsightEvidence }) {
  const { fmtW } = useUnits();
  const v =
    e.unit === 'kg'
      ? fmtW(e.value)
      : e.unit === 'pct'
        ? signedPct(e.value)
        : `${fmtNum(e.value, Number.isInteger(e.value) ? 0 : 1)}${e.unit === 'reps' ? ' reps' : ''}`;
  return (
    <span className="inline-flex max-w-full items-baseline gap-1 rounded-lg bg-secondary px-2 py-1 text-xs">
      <span className="truncate text-muted-foreground">{e.label}</span>
      <b className="shrink-0 tabular">{v}</b>
    </span>
  );
}

function InsightItem({ insight }: { insight: Insight }) {
  const Icon = insight.tone === 'positivo' ? TrendingUp : insight.tone === 'neutro' ? Minus : Info;
  return (
    <li className="flex gap-3 border-t py-3 first:border-t-0 first:pt-0" data-testid="insight" data-insight-id={insight.id}>
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          insight.tone === 'positivo' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-snug">{insight.title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{insight.description}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {insight.evidence.map((e) => (
            <EvidenceChip key={e.label} e={e} />
          ))}
          {insight.confidence && <Badge variant="outline">{CONFIDENCE_LABEL[insight.confidence]}</Badge>}
        </div>
      </div>
    </li>
  );
}

function TrendExplanation({ ex }: { ex: ExerciseSummary }) {
  const t = ex.trend;
  return (
    <div className="mt-3 rounded-xl bg-secondary/60 p-3 text-sm" data-testid="exercise-trend">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={t.direction === 'positiva' ? 'default' : 'secondary'}>{TREND_LABEL[t.direction]}</Badge>
        {t.confidence && <Badge variant="outline">{CONFIDENCE_LABEL[t.confidence]}</Badge>}
      </div>
      <p className="mt-2 text-muted-foreground">
        {t.direction === 'insuficiente'
          ? TREND_REASON[t.reason ?? 'poucas_sessoes']
          : `Média de ${TREND_METRIC_LABEL[t.metric]} na segunda metade das sessões: ${signedPct(t.changePct!)} em relação à primeira (${t.points} sessões em ${t.spanDays} dias; variações de até ${fmtNum(t.thresholdPct!, 1)}% são tratadas como oscilação natural).`}
      </p>
    </div>
  );
}

function ExerciseSection({ report, analytics }: { report: TrainingReport; analytics: ReturnType<typeof createTrainingAnalytics> }) {
  const { show, unit, fmtW } = useUnits();
  const [key, setKey] = useState('');
  const [metric, setMetric] = useState<ExMetric>('e1rm');
  const ex = report.exercises.find((e) => e.key === key) ?? report.exercises[0];
  useEffect(() => {
    if (ex && ex.key !== key) setKey(ex.key);
  }, [ex, key]);
  const unloadedOnly = !!ex && ex.loadedSets === 0;
  const effective: ExMetric = unloadedOnly && (metric === 'e1rm' || metric === 'topLoad' || metric === 'volume') ? 'bestReps' : metric;
  const data = useMemo(() => {
    if (!ex) return [];
    return analytics.series(ex.key, report.range, PICK[effective]).map((p) => {
      const v = PICK[effective](p) ?? 0;
      return { ts: p.ts, v: effective === 'bestReps' ? v : Math.round((show(v) ?? 0) * 10) / 10 };
    });
  }, [analytics, ex, report.range, effective, show]);

  if (!ex) return null;
  const fmt = (v: number) => (effective === 'bestReps' ? `${fmtNum(v, 0)} reps` : `${fmtNum(v, effective === 'volume' ? 0 : 1)} ${unit}`);
  const rec = ex.records;
  const history = rec.loadRecordHistory;
  return (
    <ChartCard
      title="Evolução por exercício"
      description={`1RM estimado por Epley só em séries de 1 a ${E1RM_MAX_REPS} repetições; carga = maior carga válida da sessão.`}
    >
      <div className="space-y-2">
        <NativeSelect aria-label="Exercício" data-testid="exercise-select" value={ex.key} onChange={(e) => setKey(e.target.value)}>
          {report.exercises.map((e) => (
            <option key={e.key} value={e.key}>
              {e.name} ({e.sessions})
            </option>
          ))}
        </NativeSelect>
        <Segmented
          size="sm"
          aria-label="Métrica do exercício"
          value={effective}
          onChange={setMetric}
          options={
            unloadedOnly
              ? [{ value: 'bestReps', label: 'Repetições' }]
              : [
                  { value: 'e1rm', label: '1RM est.' },
                  { value: 'topLoad', label: 'Carga' },
                  { value: 'bestReps', label: 'Reps' },
                  { value: 'volume', label: 'Volume' },
                ]
          }
        />
      </div>
      <div className="mt-3" data-testid="exercise-chart">
        <TrendChart data={data} x="ts" y="v" fmt={fmt} xFmt={(t) => fmtDateShort(Number(t))} />
      </div>
      {unloadedOnly && <p className="mt-2 text-xs text-muted-foreground">Exercício sem carga registrada: a evolução é medida em repetições, sem converter em quilos.</p>}
      <TrendExplanation ex={ex} />

      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm" data-testid="exercise-records">
        <div className="min-w-0 rounded-xl border p-2.5">
          <dt className="text-xs text-muted-foreground">Maior carga (histórico)</dt>
          <dd className="font-semibold tabular">{rec.maxLoad ? `${fmtW(rec.maxLoad.value)} × ${rec.maxLoad.reps}` : '—'}</dd>
          {rec.maxLoad && <dd className="text-xs text-muted-foreground">{fmtDateShort(rec.maxLoad.date)}</dd>}
        </div>
        <div className="min-w-0 rounded-xl border p-2.5">
          <dt className="text-xs text-muted-foreground">Melhor no período</dt>
          <dd className="font-semibold tabular">
            {ex.periodBest.maxLoad ? `${fmtW(ex.periodBest.maxLoad.value)} × ${ex.periodBest.maxLoad.reps}` : ex.periodBest.maxUnloadedReps ? `${ex.periodBest.maxUnloadedReps.value} reps` : '—'}
          </dd>
        </div>
        <div className="min-w-0 rounded-xl border p-2.5">
          <dt className="text-xs text-muted-foreground">1RM estimado (histórico)</dt>
          <dd className="font-semibold tabular">{rec.bestE1rm ? `${fmtW(rec.bestE1rm.value)}` : '—'}</dd>
          {rec.bestE1rm && <dd className="text-xs text-muted-foreground">estimativa, não medido</dd>}
        </div>
        <div className="min-w-0 rounded-xl border p-2.5">
          <dt className="text-xs text-muted-foreground">Maior volume numa série</dt>
          <dd className="font-semibold tabular">{rec.maxSetVolume ? fmtW(rec.maxSetVolume.value) : '—'}</dd>
        </div>
      </dl>

      <div className="mt-3" data-testid="record-history">
        <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Trophy className="h-4 w-4 text-primary" /> Recordes de carga
        </p>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {rec.sessions <= MIN_PRIOR_SESSIONS_FOR_RECORD
              ? `Recordes aparecem a partir da ${MIN_PRIOR_SESSIONS_FOR_RECORD + 1}ª sessão com carga (antes não há base de comparação).` : 'Nenhuma carga acima da melhor marca anterior até agora.'}
          </p>
        ) : (
          <ol className="space-y-1 text-sm">
            {[...history].reverse().slice(0, 6).map((r) => (
              <li key={r.ts} className="flex justify-between gap-2 tabular">
                <span className="text-muted-foreground">{fmtDateShort(r.date)}</span>
                <span>
                  {fmtW(r.value)} × {r.reps} {r.previous !== undefined && <span className="text-xs text-muted-foreground">(antes {fmtW(r.previous)})</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </ChartCard>
  );
}

export default function TrainingAnalyticsPage() {
  const sessions = useCompletedSessions();
  const today = useToday();
  const { show, unit } = useUnits();
  const [period, setPeriod] = useState<PeriodKey>('30d');
  // O índice é montado uma vez por versão do histórico; trocar o período só reagrega a janela.
  const analytics = useMemo(() => createTrainingAnalytics(sessions ?? []), [sessions]);
  const report = useMemo(() => analytics.report(period, today), [analytics, period, today]);
  const insights = useMemo(() => buildInsights(report), [report]);

  const buckets = useMemo(
    () => report.buckets.map((b) => ({ start: b.start, sessions: b.sessions, sets: b.sets, volume: Math.round(show(b.volume) ?? 0) })),
    [report.buckets, show],
  );
  const monthly = report.buckets[0]?.kind === 'month';
  const bucketFmt = (v: string | number) => (monthly ? fmtMonth(String(v)) : fmtDateShort(String(v)));
  const per = monthly ? 'mês' : 'semana';

  const header = (
    <>
      <Link to="/evolucao" data-testid="analytics-back" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Evolução
      </Link>
      <PageHeader title="Desempenho" subtitle="Análise local dos seus treinos, sem internet e sem IA" />
    </>
  );

  if (!sessions) return header;
  if (analytics.quality.completedSessions === 0)
    return (
      <div data-testid="analytics-page">
        {header}
        <Empty text="Conclua seu primeiro treino para ver a análise de desempenho." />
      </div>
    );

  return (
    <div className="space-y-4" data-testid="analytics-page">
      {header}
      <div className="space-y-1.5">
        <Segmented size="sm" className="[&>button]:h-9 [&>button]:whitespace-nowrap" aria-label="Período" value={period} onChange={setPeriod} options={PERIOD_OPTIONS} />
        <p className="text-xs text-muted-foreground" data-testid="period-range">
          {fmtDateShort(report.range.from)} – {fmtDateShort(report.range.to)} · {report.range.days} {report.range.days === 1 ? 'dia' : 'dias'}
          {report.covered && report.covered.from !== report.range.from && ` · histórico desde ${fmtDateShort(report.covered.from)}`}
        </p>
      </div>

      {!report.hasData ? (
        <Empty text="Nenhum treino concluído neste período. Escolha um período maior." />
      ) : (
        <>
          <Overview report={report} />

          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <LineChart className="h-5 w-5 text-primary" />
              <h2 className="font-display font-semibold">Insights</h2>
            </div>
            <ul data-testid="insights">
              {insights.map((i) => (
                <InsightItem key={i.id} insight={i} />
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">Calculados no aparelho a partir dos seus registros. Não são diagnóstico nem prescrição.</p>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <ChartCard title={`Frequência por ${per}`} description={`sessões concluídas por ${per} (segunda a domingo)`}>
              <div data-testid="chart-frequency">
                <BarsChart data={buckets} x="start" y="sessions" fmt={(v) => `${v} ${v === 1 ? 'sessão' : 'sessões'}`} xFmt={bucketFmt} />
              </div>
            </ChartCard>
            <ChartCard title={`Volume por ${per}`} description="carga × repetições, só séries com carga">
              <div data-testid="chart-volume">
                <BarsChart data={buckets} x="start" y="volume" fmt={(v) => `${fmtNum(v, 0)} ${unit}`} xFmt={bucketFmt} />
              </div>
            </ChartCard>
          </div>

          <ChartCard title="Séries por grupo muscular" description="séries realizadas no período, pela classificação da ficha">
            <BarsChart horizontal data={report.muscleGroups} x="group" y="sets" fmt={(v) => `${v} séries`} />
            {report.unclassifiedSets > 0 && <p className="mt-2 text-xs text-muted-foreground">{report.unclassifiedSets} séries de exercícios sem grupo muscular informado não aparecem aqui.</p>}
          </ChartCard>

          <ExerciseSection report={report} analytics={analytics} />
        </>
      )}
    </div>
  );
}
