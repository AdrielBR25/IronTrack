import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, CalendarCheck, ChevronDown, Dumbbell, Info, Layers, LineChart, Minus, Repeat, Trophy, TrendingUp, Weight } from 'lucide-react';
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
import { fmtDurationSec } from '@/modules/training';
import {
  buildInsights,
  createTrainingAnalytics,
  E1RM_METHOD,
  exerciseAnalyses,
  INDICATOR_GUIDE,
  LOAD_KIND_LABEL,
  MIN_PRIOR_SESSIONS_FOR_RECORD,
  supportsLoadMetrics,
  UNAVAILABLE_ANALYSIS_TEXT,
  type MuscleDistribution,
  TREND_MIN_POINTS,
  TREND_MIN_SPAN_DAYS,
  type ExercisePoint,
  type ExerciseSummary,
  type ModalityMetrics,
  type SideStats,
  type Insight,
  type InsightEvidence,
  type PeriodKey,
  type TrainingReport,
  type Trend,
} from '@/modules/analytics';

// Análise de desempenho (IronTrack 2.0 F01/P08): tudo calculado no aparelho pelo motor local
// (src/modules/analytics), só com leitura das sessões concluídas. Nada é gravado nem enviado.
// P09: grupos musculares normalizados, métricas conforme o tipo de exercício, método de 1RM identificado,
// explicações dos indicadores e estados indisponíveis para análises que os registros ainda não sustentam.

type ExMetric = 'e1rm' | 'topLoad' | 'bestReps' | 'volume' | 'duration' | 'distance';

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
  duracao: 'maior duração por sessão',
  distancia: 'distância por sessão',
};

const CONFIDENCE_LABEL = { alta: 'confiança alta', media: 'confiança média', baixa: 'confiança baixa' } as const;

const PICK: Record<ExMetric, (p: ExercisePoint) => number | null> = {
  e1rm: (p) => p.e1rm,
  topLoad: (p) => p.topLoad,
  bestReps: (p) => p.bestReps,
  volume: (p) => (p.loadedSets ? p.volume : null),
  // P10: tempo (maior duração da sessão) e cardio (duração e distância somadas na sessão).
  duration: (p) => p.bestDurationSec ?? p.cardio?.durationSec ?? null,
  distance: (p) => p.cardio?.distanceM ?? null,
};

const fmtKm = (m: number) => `${fmtNum(m / 1000, 2)} km`;
const fmtPace = (secPerKm: number) => `${fmtDurationSec(secPerKm)} /km`;

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
      {t.longGap && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="trend-long-gap">
          Houve uma pausa de {t.maxGapDays} dias entre duas sessões deste exercício. Os dias sem treino não entram no cálculo e não contam como queda.
        </p>
      )}
    </div>
  );
}

/** Detalhe expansível acessível por teclado (summary nativo), no estilo dos cartões do app. */
function Disclosure({ title, children, testId, icon: Icon = Info }: { title: string; children: ReactNode; testId?: string; icon?: typeof Info }) {
  return (
    <details className="group rounded-xl border" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-3 pb-3 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

function ExerciseAnalyses({ ex }: { ex: ExerciseSummary }) {
  const list = exerciseAnalyses(ex);
  const unavailable = list.filter((a) => !a.available);
  return (
    <div className="mt-3" data-testid="exercise-analyses">
      <Disclosure title={`Análises por tipo de exercício (${list.length - unavailable.length} de ${list.length} disponíveis)`}>
        <ul className="space-y-2">
          {list.map((a) => (
            <li key={a.kind} data-testid={`analysis-${a.kind}`} data-available={a.available}>
              <p className="flex items-center gap-2 font-medium text-foreground">
                {a.title}
                <Badge variant={a.available ? 'default' : 'outline'}>{a.available ? 'disponível' : 'indisponível'}</Badge>
              </p>
              {!a.available && (
                <p className="mt-0.5">
                  {UNAVAILABLE_ANALYSIS_TEXT} {a.reason}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Disclosure>
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
  // Métricas de carga (1RM, carga, volume) só com carga externa; peso corporal mede repetições e, quando
  // registrada, a carga adicional (sem somar o peso do corpo).
  const loadMetrics = !!ex && supportsLoadMetrics(ex.classification) && ex.loadedSets > 0;
  const bodyweight = !!ex && ex.classification.modalities.includes('bodyweight');
  const addedLoad = bodyweight && !!ex && ex.loadedSets > 0;
  const timed = !!ex?.modality.timed;
  const cardio = ex?.modality.cardio ?? null;
  const options: { value: ExMetric; label: string }[] = timed
    ? [{ value: 'duration', label: 'Duração' }]
    : cardio
      ? [
          ...(cardio.sessionsWithDistance ? [{ value: 'distance' as const, label: 'Distância' }] : []),
          ...(cardio.sessionsWithDuration ? [{ value: 'duration' as const, label: 'Duração' }] : []),
        ]
      : loadMetrics
    ? [
        { value: 'e1rm', label: '1RM est.' },
        { value: 'topLoad', label: 'Carga' },
        { value: 'bestReps', label: 'Reps' },
        { value: 'volume', label: 'Volume' },
      ]
    : addedLoad
      ? [
          { value: 'bestReps', label: 'Repetições' },
          { value: 'topLoad', label: 'Carga adicional' },
        ]
      : [{ value: 'bestReps', label: 'Repetições' }];
  const effective: ExMetric = options.some((o) => o.value === metric) ? metric : (options[0]?.value ?? 'bestReps');
  const data = useMemo(() => {
    if (!ex) return [];
    return analytics.series(ex.key, report.range, PICK[effective]).map((p) => {
      const v = PICK[effective](p) ?? 0;
      const raw = effective === 'bestReps' || effective === 'duration' || effective === 'distance';
      return { ts: p.ts, v: raw ? v : Math.round((show(v) ?? 0) * 10) / 10 };
    });
  }, [analytics, ex, report.range, effective, show]);

  if (!ex) return null;
  const fmt = (v: number) =>
    effective === 'bestReps'
      ? `${fmtNum(v, 0)} reps`
      : effective === 'duration'
        ? fmtDurationSec(v)
        : effective === 'distance'
          ? fmtKm(v)
          : `${fmtNum(v, effective === 'volume' ? 0 : 1)} ${unit}`;
  const modal = timed || !!cardio;
  const rec = ex.records;
  const history = rec.loadRecordHistory;
  const muscle = ex.muscle.label || 'sem grupo';
  return (
    <ChartCard
      title="Evolução por exercício"
      description={loadMetrics ? `1RM estimado: ${E1RM_METHOD.name}; carga = maior carga válida da sessão.` : 'Métricas conforme o tipo do exercício e os dados registrados.'}
    >
      <div className="space-y-2">
        <NativeSelect aria-label="Exercício" data-testid="exercise-select" value={ex.key} onChange={(e) => setKey(e.target.value)}>
          {report.exercises.map((e) => (
            <option key={e.key} value={e.key}>
              {e.name} ({e.sessions})
            </option>
          ))}
        </NativeSelect>
        <div className="flex flex-wrap gap-1.5" data-testid="exercise-type">
          <Badge variant="secondary">{LOAD_KIND_LABEL[ex.classification.load]}</Badge>
          <Badge variant="outline" title={ex.muscleGroup && ex.muscleGroup.trim() !== ex.muscle.label ? `Na ficha: ${ex.muscleGroup.trim()}` : undefined}>
            {muscle}
          </Badge>
        </div>
        <Segmented size="sm" aria-label="Métrica do exercício" value={effective} onChange={setMetric} options={options} />
      </div>
      <div className="mt-3" data-testid="exercise-chart">
        <TrendChart data={data} x="ts" y="v" fmt={fmt} xFmt={(t) => fmtDateShort(Number(t))} />
      </div>
      {!loadMetrics && !bodyweight && !modal && (
        <p className="mt-2 text-xs text-muted-foreground">Exercício sem carga registrada: a evolução é medida em repetições, sem converter em quilos.</p>
      )}
      {modal && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="modality-note">
          {timed
            ? 'Exercício por tempo: a evolução é medida pela maior duração de cada sessão. Repetições e carga não entram.'
            : 'Cardio: duração e distância registradas, sem calorias nem frequência cardíaca. Ritmo só com os dois campos.'}
        </p>
      )}
      {bodyweight && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="bodyweight-note">
          {addedLoad
            ? 'Exercício de peso corporal com carga adicional: repetições e carga adicional aparecem separadas. O peso do corpo não é somado e não há 1RM estimado.'
            : 'Exercício sem carga registrada: a evolução é medida em repetições, sem converter em quilos.'}
        </p>
      )}
      {loadMetrics && effective === 'e1rm' && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="e1rm-method">
          Método: {E1RM_METHOD.name}. {E1RM_METHOD.formula}. Estimativa, não medida.
        </p>
      )}
      <TrendExplanation ex={ex} />

      <ModalityPanel m={ex.modality} />
      {!modal && (
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm" data-testid="exercise-records">
        {loadMetrics || !bodyweight ? (
          <>
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
          </>
        ) : (
          <>
            <div className="min-w-0 rounded-xl border p-2.5">
              <dt className="text-xs text-muted-foreground">Mais repetições sem carga</dt>
              <dd className="font-semibold tabular">{rec.maxUnloadedReps ? `${rec.maxUnloadedReps.value} reps` : '—'}</dd>
              {rec.maxUnloadedReps && <dd className="text-xs text-muted-foreground">{fmtDateShort(rec.maxUnloadedReps.date)}</dd>}
            </div>
            {rec.maxLoad && (
              <div className="min-w-0 rounded-xl border p-2.5">
                <dt className="text-xs text-muted-foreground">Maior carga adicional</dt>
                <dd className="font-semibold tabular">{`+${fmtW(rec.maxLoad.value)} × ${rec.maxLoad.reps}`}</dd>
                <dd className="text-xs text-muted-foreground">{fmtDateShort(rec.maxLoad.date)}</dd>
              </div>
            )}
          </>
        )}
      </dl>
      )}

      {(loadMetrics || addedLoad) && (
        <div className="mt-3" data-testid="record-history">
          <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
            <Trophy className="h-4 w-4 text-primary" /> {bodyweight ? 'Recordes de carga adicional' : 'Recordes de carga'}
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
      )}
      <ExerciseAnalyses ex={ex} />
    </ChartCard>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border p-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

const SIDE_ROWS: { key: 'direito' | 'esquerdo' | 'ambos' | 'desconhecido'; label: string }[] = [
  { key: 'direito', label: 'Direito' },
  { key: 'esquerdo', label: 'Esquerdo' },
  { key: 'ambos', label: 'Ambos' },
  { key: 'desconhecido', label: 'Não informado' },
];

/**
 * Métricas por modalidade (P10), dos contratos do P09: tempo, cardio, lados e peso corporal. Só aparece o que se
 * aplica ao exercício; sem dados suficientes, o motivo aparece no lugar do número.
 */
function ModalityPanel({ m }: { m: ModalityMetrics }) {
  const { fmtW } = useUnits();
  if (!m.timed && !m.cardio && !m.sides && !m.bodyweight) return null;
  const sideCell = (st: SideStats) => (st.sets ? `${st.sets} × · ${st.reps} reps${st.topLoad !== null ? ` · ${fmtW(st.topLoad)}` : ''}` : '—');
  return (
    <div className="mt-3 space-y-3" data-testid="modality-metrics">
      {m.timed && (
        <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="timed-metrics">
          {m.timed.available ? (
            <>
              <Stat label="Maior duração" value={fmtDurationSec(m.timed.longestSec!)} />
              <Stat label="Tempo total" value={fmtDurationSec(m.timed.totalSec!)} hint={`${m.timed.sets} séries em ${m.timed.sessions} sessões`} />
            </>
          ) : (
            <p className="col-span-2 text-sm text-muted-foreground">{UNAVAILABLE_ANALYSIS_TEXT} Nenhuma série com duração registrada no período.</p>
          )}
        </dl>
      )}
      {m.cardio && (
        <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="cardio-metrics">
          {m.cardio.available ? (
            <>
              <Stat label="Duração total" value={m.cardio.totalDurationSec !== null ? fmtDurationSec(m.cardio.totalDurationSec) : '—'} hint={`${m.cardio.sessionsWithDuration} sessões com duração`} />
              <Stat label="Distância total" value={m.cardio.totalDistanceM !== null ? fmtKm(m.cardio.totalDistanceM) : '—'} hint={`${m.cardio.sessionsWithDistance} sessões com distância`} />
              <Stat label="Ritmo médio" value={m.cardio.averagePaceSecPerKm !== null ? fmtPace(m.cardio.averagePaceSecPerKm) : '—'} hint="só sessões com duração e distância" />
              <Stat label="Velocidade média" value={m.cardio.averageSpeedKmh !== null ? `${fmtNum(m.cardio.averageSpeedKmh, 1)} km/h` : '—'} />
            </>
          ) : (
            <p className="col-span-2 text-sm text-muted-foreground">{UNAVAILABLE_ANALYSIS_TEXT} Nenhum registro de duração ou distância no período.</p>
          )}
        </dl>
      )}
      {m.sides && (
        <div className="text-sm" data-testid="side-metrics">
          <p className="mb-1 font-medium">Comparação entre lados</p>
          <table className="w-full tabular">
            <tbody>
              {SIDE_ROWS.filter((r) => r.key === 'direito' || r.key === 'esquerdo' || m.sides![r.key].sets > 0).map((r) => (
                <tr key={r.key} className="border-t">
                  <td className="py-1 pr-2 text-muted-foreground">{r.label}</td>
                  <td className="py-1 text-right">{sideCell(m.sides![r.key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted-foreground">
            {m.sides.available && m.sides.differences
              ? `Diferença registrada (direito − esquerdo): ${m.sides.differences.reps.diff > 0 ? '+' : ''}${m.sides.differences.reps.diff} repetições${m.sides.differences.reps.pct !== null ? ` (${signedPct(m.sides.differences.reps.pct)})` : ''}. É só o que foi registrado, não um diagnóstico de desequilíbrio.`
              : m.sides.reason === 'um_lado_so'
                ? 'Só um dos lados tem séries no período: não há comparação.'
                : 'Nenhuma série com lado registrado no período. Séries sem lado não são atribuídas a nenhum lado.'}
          </p>
        </div>
      )}
      {m.bodyweight && m.bodyweight.sets > 0 && (
        <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="bodyweight-metrics">
          <Stat label="Só peso corporal" value={m.bodyweight.bestRepsBodyOnly !== null ? `${m.bodyweight.bestRepsBodyOnly} reps` : '—'} hint={`${m.bodyweight.bySetKind.somente_corporal} séries`} />
          {m.bodyweight.bySetKind.com_carga_adicional > 0 && (
            <Stat label="Melhor com carga adicional" value={m.bodyweight.bestAddedLoad ? `+${fmtW(m.bodyweight.bestAddedLoad.load)} × ${m.bodyweight.bestAddedLoad.reps}` : '—'} />
          )}
          {m.bodyweight.bySetKind.com_assistencia > 0 && (
            <Stat
              label="Menor assistência"
              value={m.bodyweight.bestAssisted ? `${fmtW(m.bodyweight.bestAssisted.assistanceKg)} × ${m.bodyweight.bestAssisted.reps}` : '—'}
              hint="menos assistência = mais difícil"
            />
          )}
          {m.bodyweight.bySetKind.incompativel > 0 && (
            <p className="col-span-2 text-xs text-muted-foreground">{m.bodyweight.bySetKind.incompativel} série(s) com carga adicional e assistência ao mesmo tempo ficaram fora.</p>
          )}
        </dl>
      )}
    </div>
  );
}

function MuscleGroupsCard({ dist, unclassified }: { dist: MuscleDistribution; unclassified: number }) {
  // Linhas em que a ficha usou outro texto (ex.: "Peito" → Peitoral) mostram os originais.
  const merged = dist.groups.filter((g) => g.originals.some((o) => o !== g.group));
  const others = [...dist.unrecognized, ...dist.ambiguous];
  return (
    <ChartCard title="Séries por grupo muscular" description="séries realizadas no período, com nomes de grupo normalizados">
      <div data-testid="chart-muscles">
        {dist.groups.length ? (
          <BarsChart horizontal data={dist.groups} x="group" y="sets" fmt={(v) => `${v} séries`} />
        ) : (
          <p className="text-sm text-muted-foreground">Nenhum exercício do período tem um grupo muscular reconhecido.</p>
        )}
      </div>
      {merged.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="muscle-synonyms">
          Nomes na ficha: {merged.map((g) => `${g.group} (${g.originals.join(', ')})`).join(' · ')}. A ficha não é alterada.
        </p>
      )}
      {others.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="muscle-unclassified">
          Fora do gráfico, sem classificação segura: {others.map((g) => `${g.group} (${g.sets} ${g.sets === 1 ? 'série' : 'séries'})`).join(', ')}.
        </p>
      )}
      {unclassified > 0 && <p className="mt-2 text-xs text-muted-foreground">{unclassified} séries de exercícios sem grupo muscular informado não aparecem aqui.</p>}
      <p className="mt-2 text-xs text-muted-foreground">Cada série conta uma vez, no grupo principal do exercício; músculos auxiliares não recebem séries.</p>
    </ChartCard>
  );
}

function IndicatorGuideCard() {
  return (
    <Card className="p-4" data-testid="indicator-guide">
      <div className="mb-3 flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-primary" />
        <h2 className="font-display font-semibold">Como ler os indicadores</h2>
      </div>
      <div className="space-y-2">
        {INDICATOR_GUIDE.map((g) => (
          <Disclosure key={g.id} title={g.title} testId={`guide-${g.id}`}>
            <dl className="space-y-1.5">
              <div>
                <dt className="font-medium text-foreground">O que mede</dt>
                <dd>{g.measures}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Como é calculado</dt>
                <dd>{g.calculation}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Quando comparar</dt>
                <dd>{g.comparable}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Limitações</dt>
                <dd>{g.limitations}</dd>
              </div>
            </dl>
          </Disclosure>
        ))}
      </div>
    </Card>
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

          <MuscleGroupsCard dist={report.muscleDistribution} unclassified={report.unclassifiedSets} />

          <ExerciseSection report={report} analytics={analytics} />

          <IndicatorGuideCard />
        </>
      )}
    </div>
  );
}
