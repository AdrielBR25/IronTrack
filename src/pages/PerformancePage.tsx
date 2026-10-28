import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, CalendarCheck, ChevronRight, Dumbbell, Info, Layers, LineChart, Minus, Trophy, TrendingUp } from 'lucide-react';
import { PageHeader } from '@/components/AppLayout';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { usePerformanceIndex } from '@/hooks/usePerformance';
import { useSettings, useToday } from '@/hooks/data';
import {
  AGGREGATE_NOTICE,
  RECORD_LABEL,
  identityPath,
  performanceOverview,
  perfRange,
  PACE_BAND_LABEL,
  type PerfPeriodKey,
  type TrackedRow,
} from '@/modules/performance';
import { E1RM_NOTE, FAMILY_LABEL, PeriodPicker, StatusBadge, periodFrom } from '@/features/performance/parts';
import { fmtIsoDate, fmtPerf } from '@/features/performance/format';
import { cn, fmtNum } from '@/lib/utils';

// Desempenho por exercício (IronTrack 2.0 F01/P19): recordes, evolução recente e exercícios acompanhados, calculados
// só no aparelho a partir das sessões concluídas. Nada é gravado, nada é enviado. Ver docs/DESEMPENHO_EXERCICIOS.md.

function Stat({ icon: Icon, label, value, hint, testId }: { icon: typeof Dumbbell; label: string; value: string; hint?: string; testId: string }) {
  return (
    <Card className="min-w-0 p-3.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1.5 font-display text-2xl font-bold tabular">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function Section({ title, icon: Icon, children, testId, description }: { title: string; icon: typeof Dumbbell; children: React.ReactNode; testId: string; description?: string }) {
  return (
    <section className="space-y-2" data-testid={testId} aria-labelledby={`${testId}-title`}>
      <h2 id={`${testId}-title`} className="flex items-center gap-2 font-display text-lg font-semibold">
        <Icon className="h-4 w-4 text-primary" aria-hidden /> {title}
      </h2>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

function ExerciseRow({ row, period }: { row: TrackedRow; period: PerfPeriodKey }) {
  const h = row.history;
  return (
    <li>
      <Link to={`${identityPath(row.key)}?periodo=${period}`} className="block" data-testid="perf-exercise">
        <Card className="flex min-h-14 items-center gap-3 p-3 transition-colors hover:bg-accent/40">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{h.name}</p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{FAMILY_LABEL[h.family]}</span>
              {h.identity.kind === 'historico' && <span>· sem vínculo</span>}
              {h.workoutLabel && h.identity.kind !== 'catalogo' && h.identity.kind !== 'personalizado' && <span>· Treino {h.workoutLabel}</span>}
              <span>
                · {row.sessionsInPeriod} {row.sessionsInPeriod === 1 ? 'sessão' : 'sessões'}
              </span>
            </p>
            <div className="mt-1">
              <StatusBadge status={row.status} />
            </div>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        </Card>
      </Link>
    </li>
  );
}

export default function PerformancePage() {
  const index = usePerformanceIndex();
  const today = useToday();
  const { weightUnit } = useSettings();
  const [params, setParams] = useSearchParams();
  const period = periodFrom(params);
  const [showStable, setShowStable] = useState(true);
  const [allRecords, setAllRecords] = useState(false);
  const overview = useMemo(() => (index ? performanceOverview(index, perfRange(period, today, index.firstDate)) : null), [index, period, today]);
  const setPeriod = (p: PerfPeriodKey) => setParams((prev) => (prev.set('periodo', p), prev), { replace: true });

  if (!index || !overview) return <div className="h-40 animate-pulse rounded-2xl bg-card" />;
  const noData = index.sessions.length === 0;
  const stable = overview.tracked.filter((r) => r.status === 'estavel');
  const records = allRecords ? overview.records : overview.records.slice(0, 5);

  return (
    <div className="space-y-6">
      <PageHeader title="Desempenho e recordes" subtitle="Evolução por exercício, calculada neste aparelho" />
      {noData ? (
        <Card className="flex flex-col items-center gap-2 p-8 text-center" data-testid="perf-empty">
          <LineChart className="h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="font-semibold">Conclua seu primeiro treino para acompanhar o desempenho.</p>
          <p className="text-sm text-muted-foreground">Só treinos concluídos contam. Treinos planejados ou em andamento não entram.</p>
          <Link to="/treinos" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            Ir para Treinos
          </Link>
        </Card>
      ) : (
        <>
          <PeriodPicker value={period} onChange={setPeriod} />

          <section aria-label="Resumo do período" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat testId="perf-stat-sessions" icon={CalendarCheck} label="Sessões" value={fmtNum(overview.sessions, 0)} hint="concluídas no período" />
            <Stat testId="perf-stat-exercises" icon={Dumbbell} label="Exercícios" value={fmtNum(overview.exercisesWithRecords, 0)} hint="com registros válidos" />
            <Stat testId="perf-stat-records" icon={Trophy} label="Recordes" value={fmtNum(overview.records.length, 0)} hint="novos no período" />
            <Stat
              testId="perf-stat-evolution"
              icon={TrendingUp}
              label="Com evolução"
              value={fmtNum(overview.withEvolution, 0)}
              hint={`${overview.withoutComparison} sem comparação suficiente`}
            />
          </section>

          <Section title="Sua evolução recente" icon={TrendingUp} testId="perf-recent" description="Comparações da sessão mais recente com as anteriores do mesmo exercício, nas mesmas condições.">
            {overview.recent.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                Nenhuma comparação favorável e mensurável no período. Isso não indica regressão: pode faltar sessões comparáveis.
              </p>
            ) : (
              <ul className="space-y-2">
                {overview.recent.slice(0, 6).map((r, i) => (
                  <li key={`${r.key}-${i}`}>
                    <Card className="p-3">
                      <Link to={`${identityPath(r.key)}?periodo=${period}`} className="font-semibold text-primary underline-offset-2 hover:underline">
                        {r.name}
                      </Link>
                      <p className="text-sm">{r.text}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">Critério: {r.criterion}</p>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Recordes recentes" icon={Trophy} testId="perf-records" description="Um recorde só conta depois de duas sessões anteriores com a mesma medida. Empates não criam recorde novo; aquecimentos nunca entram.">
            {overview.records.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Nenhum recorde novo no período.</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {records.map((e) => (
                    <li key={`${e.identityKey}-${e.type}-${e.band ?? ''}-${e.sessionId}`}>
                      <Card className="p-3" data-testid="perf-record">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                          <Link to={`${identityPath(e.identityKey)}?periodo=${period}&ver=recordes`} className="min-w-0 break-words font-semibold underline-offset-2 hover:underline">
                            {e.name}
                          </Link>
                          <span className="font-display font-bold tabular">{fmtPerf(e.value, e.unit, { weightUnit, distanceUnit: null })}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {RECORD_LABEL[e.type]}
                          {e.band ? ` (${PACE_BAND_LABEL[e.band]})` : ''}
                          {e.reps && e.type === 'carga_maxima' ? ` · ${e.reps} rep.` : ''} · {FAMILY_LABEL[e.family]} · {fmtIsoDate(e.date)}
                          {e.previous !== null ? ` · anterior ${fmtPerf(e.previous, e.unit, { weightUnit, distanceUnit: null })}` : ''}
                        </p>
                        <Link to={`/historico/${e.sessionId}`} className="mt-1 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline" data-testid="perf-record-session">
                          Abrir sessão de origem
                        </Link>
                      </Card>
                    </li>
                  ))}
                </ul>
                {overview.records.length > 5 && (
                  <button className="text-sm font-medium text-primary" onClick={() => setAllRecords((v) => !v)} aria-expanded={allRecords}>
                    {allRecords ? 'Mostrar menos' : `Ver todos (${overview.records.length})`}
                  </button>
                )}
              </>
            )}
          </Section>

          <Section title="Exercícios acompanhados" icon={Activity} testId="perf-tracked" description="Cada exercício da ficha é analisado separadamente. Exercícios antigos sem vínculo ficam à parte; nada é juntado pelo nome.">
            {overview.tracked.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Nenhum exercício com registros válidos no período.</p>
            ) : (
              <ul className="space-y-2">
                {overview.tracked.map((r) => (
                  <ExerciseRow key={r.key} row={r} period={period} />
                ))}
              </ul>
            )}
          </Section>

          {overview.aggregates.length > 0 && (
            <Section title="Por exercício da biblioteca" icon={Layers} testId="perf-aggregates" description={AGGREGATE_NOTICE}>
              <ul className="space-y-2">
                {overview.aggregates.map((r) => (
                  <ExerciseRow key={r.key} row={r} period={period} />
                ))}
              </ul>
            </Section>
          )}

          <Section title="Estabilidade" icon={Minus} testId="perf-stability" description="Opcional. Desempenho estável não é um problema: manter cargas e repetições também é um resultado.">
            <label className="flex min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
              <span>Mostrar observações de estabilidade</span>
              <Switch checked={showStable} onCheckedChange={setShowStable} aria-label="Mostrar observações de estabilidade" data-testid="perf-stability-toggle" />
            </label>
            {showStable &&
              (stable.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="perf-stability-list">
                  Nenhum exercício com desempenho estável no período (é preciso pelo menos 4 sessões comparáveis em 21 dias ou mais).
                </p>
              ) : (
                <ul className="space-y-1 text-sm" data-testid="perf-stability-list">
                  {stable.map((r) => (
                    <li key={r.key}>
                      <Link to={`${identityPath(r.key)}?periodo=${period}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {r.history.name}
                      </Link>
                      : desempenho estável no período.
                    </li>
                  ))}
                </ul>
              ))}
          </Section>

          <p className={cn('flex items-start gap-2 rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground')}>
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Calculado só neste aparelho com os treinos concluídos; nada é enviado à IA nem a servidores. {E1RM_NOTE}{' '}
              <Link to="/evolucao/desempenho" className="text-primary underline-offset-2 hover:underline">
                Análise geral de treino
              </Link>
            </span>
          </p>
        </>
      )}
    </div>
  );
}
