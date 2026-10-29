import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, GitCompare, Info, Lightbulb, LineChart, ListOrdered, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { usePerformanceIndex } from '@/hooks/usePerformance';
import { useCompletedSessions, useSettings, useToday } from '@/hooks/data';
import { useGoals } from '@/hooks/useGoals';
import { RelatedGoals } from '@/features/goals/RelatedGoals';
import { evaluateGoals } from '@/modules/goals';
import {
  AGGREGATE_NOTICE,
  CHART_METRIC_LABEL,
  IDENTITY_KIND_LABEL,
  ISSUE_LABEL,
  PACE_BAND_LABEL,
  RECORD_LABEL,
  SUGGESTION_NOTICE,
  availableMetrics,
  buildSeries,
  compareSessions,
  identityPath,
  inPerfRange,
  observationsFor,
  parseIdentityKey,
  perfRange,
  stabilityOf,
  suggestionsFor,
  type ChartMetric,
  type ComparedMetric,
  type IdentityHistory,
  type PerfObservation,
  type PerfPeriodKey,
  type PerfSet,
  type SessionComparison,
} from '@/modules/performance';
import { PerformanceChart } from '@/features/performance/PerformanceChart';
import { E1RM_NOTE, FAMILY_LABEL, PeriodPicker, levelText, originLabel, periodFrom } from '@/features/performance/parts';
import { fmtDiff, fmtIsoDate, fmtPerf, signedPct, type FmtCtx } from '@/features/performance/format';
import { cn } from '@/lib/utils';

// Detalhe de desempenho de uma identidade (IronTrack 2.0 F01/P19). A rota traz só a chave codificada da identidade
// (`i:`, `h:`, `c:`, `p:`), nunca o nome. Tudo é derivado das sessões; nada é gravado.

function Block({ id, title, icon: Icon, children, testId }: { id: string; title: string; icon: typeof Trophy; children: React.ReactNode; testId: string }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-2" data-testid={testId} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="flex items-center gap-2 font-display text-lg font-semibold">
        <Icon className="h-4 w-4 text-primary" aria-hidden /> {title}
      </h2>
      {children}
    </section>
  );
}

const METRIC_SHORT: Record<ChartMetric, string> = {
  carga: 'Carga',
  repeticoes: 'Reps',
  volume: 'Volume',
  e1rm: '1RM',
  repeticoes_corporal: 'Reps',
  carga_adicional: 'Adicional',
  assistencia: 'Assist.',
  duracao: 'Duração',
  distancia: 'Distância',
  duracao_cardio: 'Duração',
  ritmo: 'Ritmo',
};

const SET_KIND_LABEL: Record<PerfSet['kind'], string> = { trabalho: 'válida', drop: 'drop', aquecimento: 'aquecimento', incompleta: 'incompleta', pulada: 'pulada' };

function setText(s: PerfSet | null, ctx: FmtCtx): string {
  if (!s) return 'ausente';
  if (s.kind === 'pulada') return 'pulada';
  const parts: string[] = [];
  if (s.loadKg !== null) parts.push(fmtPerf(s.loadKg, 'kg', ctx));
  if (s.assistanceKg !== null) parts.push(`assist. ${fmtPerf(s.assistanceKg, 'kg', ctx)}`);
  if (s.reps !== null) parts.push(`${s.reps} rep.`);
  if (s.durationSec !== null) parts.push(fmtPerf(s.durationSec, 'segundos', ctx));
  const txt = parts.join(' × ') || '—';
  return s.kind === 'trabalho' ? txt : `${txt} (${SET_KIND_LABEL[s.kind]})`;
}

function sessionLabel(o: PerfObservation) {
  return `${fmtIsoDate(o.date)} · Treino ${o.workoutLabel || '?'}`;
}

function Comparison({ h, obs, ctx, initialB }: { h: IdentityHistory; obs: PerfObservation[]; ctx: FmtCtx; initialB: string | null }) {
  const ids = obs.map((o) => o.sessionId);
  const defaultB = initialB && ids.includes(initialB) ? initialB : ids[ids.length - 1];
  const bIdx = ids.indexOf(defaultB);
  const [aId, setA] = useState<string | undefined>(ids[bIdx - 1] ?? ids[0]);
  const [bId, setB] = useState<string | undefined>(defaultB);
  // Se a lista mudar (sessão excluída em outra aba, troca de período), volta para um par válido.
  useEffect(() => {
    if (!aId || !ids.includes(aId)) setA(ids[Math.max(0, ids.length - 2)]);
    if (!bId || !ids.includes(bId)) setB(ids[ids.length - 1]);
  }, [ids.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = obs.find((o) => o.sessionId === aId);
  const b = obs.find((o) => o.sessionId === bId);
  const cmp: SessionComparison | null = a && b && a.sessionId !== b.sessionId ? compareSessions(h, a, b) : null;
  if (obs.length < 2) return <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">É preciso ao menos duas sessões compatíveis no período para comparar.</p>;
  const options = [...obs].reverse();
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Sessão anterior</span>
          <NativeSelect value={aId} onChange={(e) => setA(e.target.value)} data-testid="compare-a">
            {options.map((o) => (
              <option key={o.sessionId} value={o.sessionId}>
                {sessionLabel(o)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="space-y-1 text-sm">
          <span className="font-medium">Sessão comparada</span>
          <NativeSelect value={bId} onChange={(e) => setB(e.target.value)} data-testid="compare-b">
            {options.map((o) => (
              <option key={o.sessionId} value={o.sessionId}>
                {sessionLabel(o)}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      {!cmp ? (
        <p className="text-sm text-muted-foreground">Escolha duas sessões diferentes.</p>
      ) : (
        <div className="space-y-3" data-testid="compare-result">
          <p className={cn('rounded-xl p-3 text-sm', cmp.compatible ? 'bg-secondary/60' : 'border border-warn/40 bg-warn/10')} data-testid="compare-summary">
            {cmp.summary}
            {cmp.issues.includes('faixa_de_distancia_diferente') && ` Ritmo não comparado: ${ISSUE_LABEL.faixa_de_distancia_diferente}.`}
          </p>
          <p className="text-xs text-muted-foreground">
            Ordem cronológica: {sessionLabel(cmp.a)} → {sessionLabel(cmp.b)}. Diferença = comparada − anterior.
          </p>
          <table className="w-full table-fixed text-sm tabular" data-testid="compare-table">
            <caption className="sr-only">Diferenças entre as duas sessões</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="w-[34%] pb-1 font-medium">Medida</th>
                <th scope="col" className="pb-1 font-medium">{fmtIsoDate(cmp.a.date).slice(0, 5)}</th>
                <th scope="col" className="pb-1 font-medium">{fmtIsoDate(cmp.b.date).slice(0, 5)}</th>
                <th scope="col" className="pb-1 font-medium">Diferença</th>
              </tr>
            </thead>
            <tbody>
              {cmp.metrics.map((m: ComparedMetric) => (
                <tr key={m.key} className="border-t align-top" data-testid={`compare-row-${m.key}`}>
                  <th scope="row" className="break-words py-1.5 pr-1 text-left font-normal">
                    {m.label}
                    {m.lowerIsBetter && <span className="block text-[11px] text-muted-foreground">menor = mais difícil/rápido</span>}
                  </th>
                  <td className="py-1.5">{fmtPerf(m.a, m.unit, ctx)}</td>
                  <td className="py-1.5">{fmtPerf(m.b, m.unit, ctx)}</td>
                  <td className="py-1.5">
                    {m.missing ? (
                      <span className="text-xs text-muted-foreground">{m.missing === 'ambos' ? 'sem registro' : 'dado ausente'}</span>
                    ) : m.diff === null ? (
                      <span className="text-xs text-muted-foreground">não comparável</span>
                    ) : (
                      <>
                        {fmtDiff(m.diff, m.unit, ctx)}
                        {m.pct !== null && Math.abs(m.diff) > 1e-9 && <span className="block text-[11px] text-muted-foreground">{signedPct(m.pct)}</span>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-1.5" data-testid="compare-sets">
            <h3 className="text-sm font-semibold">Série a série</h3>
            {!cmp.sets.available ? (
              <p className="text-sm text-muted-foreground">
                {cmp.sets.reason === 'cardio'
                  ? 'Em cardio a comparação é pela sessão inteira.'
                  : cmp.sets.reason === 'lados_nao_registrados'
                    ? 'Exercício unilateral sem o lado registrado em todas as séries: não há correspondência segura.'
                    : cmp.sets.reason === 'familia_diferente'
                      ? 'As sessões medem de formas diferentes.'
                      : 'Sem séries de trabalho normais nas duas sessões.'}
              </p>
            ) : (
              <>
                <table className="w-full table-fixed text-sm tabular">
                  <caption className="sr-only">Séries de trabalho na mesma posição</caption>
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th scope="col" className="w-[18%] pb-1 font-medium">Série</th>
                      <th scope="col" className="pb-1 font-medium">Anterior</th>
                      <th scope="col" className="pb-1 font-medium">Comparada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cmp.sets.rows.map((r) => (
                      <tr key={`${r.side ?? '-'}-${r.ordinal}`} className="border-t align-top" data-testid="compare-set-row" data-state={r.state}>
                        <th scope="row" className="py-1.5 text-left font-normal">
                          {r.ordinal}
                          {r.side ? ` ${r.side === 'direito' ? 'D' : r.side === 'esquerdo' ? 'E' : ''}` : ''}
                        </th>
                        <td className={cn('py-1.5', !r.a && 'text-muted-foreground')}>{setText(r.a, ctx)}</td>
                        <td className={cn('py-1.5', !r.b && 'text-muted-foreground')}>
                          {setText(r.b, ctx)}
                          {r.state === 'comparavel' && (r.loadDiffKg || r.repsDiff || r.durationDiffSec) ? (
                            <span className="block text-[11px] text-muted-foreground">
                              {[r.loadDiffKg ? fmtDiff(r.loadDiffKg, 'kg', ctx) : null, r.repsDiff ? fmtDiff(r.repsDiff, 'repeticoes', ctx) : null, r.durationDiffSec ? fmtDiff(r.durationDiffSec, 'segundos', ctx) : null]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-muted-foreground">
                  Só séries normais, pela ordem{h.laterality === 'unilateral' ? ' e pelo lado' : ''}. Série ausente fica como “ausente” (nunca zero). Aquecimentos e drops ficam fora ({cmp.sets.excluded.a} na anterior, {cmp.sets.excluded.b} na comparada). A posição da série não garante a mesma finalidade.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExercisePerformancePage() {
  const { identidade } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const index = usePerformanceIndex();
  const today = useToday();
  const settings = useSettings();
  const goals = useGoals();
  const completed = useCompletedSessions();
  const period = periodFrom(params);
  const focus = params.get('ver');
  const sessionParam = params.get('sessao');
  const parsed = parseIdentityKey(identidade);
  const h = parsed && index ? (index.identities.get(parsed.key) ?? null) : null;
  const range = useMemo(() => (index ? perfRange(period, today, index.firstDate) : null), [index, period, today]);
  const obs = useMemo(() => (h && range ? h.observations.filter((o) => inPerfRange(o.date, range)) : []), [h, range]);
  const metrics = useMemo(() => (h ? availableMetrics(h.family, obs) : []), [h, obs]);
  const [metric, setMetric] = useState<ChartMetric | null>(null);
  const active = metric && metrics.includes(metric) ? metric : (metrics[0] ?? null);
  const [showStability, setShowStability] = useState(true);
  const lastObs = h?.observations[h.observations.length - 1];
  const ctx: FmtCtx = { weightUnit: settings.weightUnit, distanceUnit: lastObs?.distanceUnit ?? null };
  const notes = useMemo(() => (h && range ? observationsFor(h, range) : []), [h, range]);
  const stability = useMemo(() => (h && range ? stabilityOf(h, range) : null), [h, range]);
  const suggestions = useMemo(() => (h && range ? suggestionsFor(h, range) : []), [h, range]);
  const relatedGoals = useMemo(() => {
    if (!h || !goals || !completed || !h.templateIds.length) return [];
    // As metas só são lidas: o progresso vem do motor de metas e nada é alterado ou redirecionado.
    return evaluateGoals(goals, completed, today).filter((e) => e.goal.status !== 'archived' && e.goal.exercise?.templateIds.some((id) => h.templateIds.includes(id)));
  }, [h, goals, completed, today]);

  useEffect(() => {
    if (!focus || !h) return;
    const el = document.getElementById(focus === 'recordes' ? 'perf-records' : focus === 'sessoes' ? 'perf-sessions' : 'perf-chart-block');
    el?.scrollIntoView({ block: 'start' });
  }, [focus, !!h]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => navigate(`/desempenho?periodo=${period}`);
  const setPeriod = (p: PerfPeriodKey) => setParams((prev) => (prev.set('periodo', p), prev), { replace: true });

  if (!index) return <div className="h-40 animate-pulse rounded-2xl bg-card" />;
  if (!parsed || !h)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={back}>
          <ArrowLeft /> Desempenho
        </Button>
        <Card className="space-y-2 p-6 text-center" data-testid="perf-detail-empty">
          <LineChart className="mx-auto h-9 w-9 text-muted-foreground" aria-hidden />
          <p className="font-semibold">{parsed ? 'Ainda não há histórico compatível para este exercício.' : 'Endereço de exercício inválido.'}</p>
          <p className="text-sm text-muted-foreground">
            {parsed?.kind === 'catalogo' || parsed?.kind === 'personalizado'
              ? 'Só contam treinos concluídos em que o exercício foi executado com esta origem registrada. Sessões antigas não são associadas automaticamente.'
              : 'Só treinos concluídos contam. Se a sessão foi excluída, os dados dela deixam de aparecer aqui.'}
          </p>
        </Card>
      </div>
    );

  const aggregate = h.identity.kind === 'catalogo' || h.identity.kind === 'personalizado';
  const series = active ? buildSeries(obs, active) : null;
  const inRange = (d: string) => !!range && inPerfRange(d, range);
  const otherInPeriod = h.otherFamily.filter((o) => inRange(o.date));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon" aria-label="Voltar para Desempenho" onClick={back}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="break-words font-display text-xl font-bold" data-testid="perf-detail-title">
            {h.name}
          </h1>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge variant="secondary">{FAMILY_LABEL[h.family]}</Badge>
            <Badge variant="outline" data-testid="perf-identity-kind">
              {IDENTITY_KIND_LABEL[h.identity.kind]}
            </Badge>
            <Badge variant="outline">{originLabel(h)}</Badge>
          </div>
        </div>
      </div>

      {aggregate && (
        <p className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="perf-aggregate-notice">
          {AGGREGATE_NOTICE}
        </p>
      )}

      <PeriodPicker value={period} onChange={setPeriod} />

      <Block id="perf-chart-block" title="Evolução" icon={LineChart} testId="perf-evolution">
        {!obs.length ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="perf-no-period-data">
            Sem registros deste exercício no período. Isso não é regressão: escolha um período maior para ver o histórico.
          </p>
        ) : (
          <Card className="space-y-3 p-4">
            {metrics.length > 1 && (
              <Segmented
                aria-label="Medida do gráfico"
                size="sm"
                value={active!}
                onChange={(m) => setMetric(m)}
                options={metrics.map((m) => ({
                  value: m,
                  label: (
                    <>
                      <span aria-hidden>{METRIC_SHORT[m]}</span>
                      <span className="sr-only">{CHART_METRIC_LABEL[m]}</span>
                    </>
                  ),
                }))}
              />
            )}
            {series && active && <PerformanceChart series={series} label={CHART_METRIC_LABEL[active]} ctx={ctx} />}
            {active === 'e1rm' && <p className="text-xs text-muted-foreground">{E1RM_NOTE}</p>}
            {active === 'volume' && <p className="text-xs text-muted-foreground">Volume = carga × repetições nas séries de trabalho com carga (sem aquecimento). Não é medida direta de hipertrofia.</p>}
            {active === 'ritmo' && <p className="text-xs text-muted-foreground">Ritmo só aparece quando duração e distância foram registradas nas mesmas séries. Compare ritmos de distâncias semelhantes.</p>}
            {active === 'assistencia' && <p className="text-xs text-muted-foreground">Assistência menor significa menos ajuda da máquina ou elástico. Mais assistência não é tratada como melhora.</p>}
            {active === 'duracao_cardio' && <p className="text-xs text-muted-foreground">Duração maior não é, por si só, uma melhora.</p>}
          </Card>
        )}
      </Block>

      <Block id="perf-records" title="Recordes" icon={Trophy} testId="perf-detail-records">
        {!h.records.length ? (
          <p className="text-sm text-muted-foreground">Sem recordes calculáveis para este exercício.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {h.records.map((r) => (
              <li key={`${r.type}-${r.band ?? ''}`}>
                <Card className="h-full p-3" data-testid={`perf-record-${r.type}`}>
                  <p className="text-xs text-muted-foreground">
                    {RECORD_LABEL[r.type]}
                    {r.band ? ` (${PACE_BAND_LABEL[r.band]})` : ''}
                  </p>
                  <p className="font-display text-xl font-bold tabular">{fmtPerf(r.value, r.unit, ctx)}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.type === 'carga_maxima' && r.reps ? `${r.reps} rep. · ` : ''}
                    {r.type === 'carga_adicional' && r.reps ? `${r.reps} rep. · ` : ''}
                    {r.type === 'menor_assistencia' && r.reps ? `${r.reps} rep. · ` : ''}
                    {r.type === 'repeticoes' && r.loadKg ? `com ${fmtPerf(r.loadKg, 'kg', ctx)} · ` : ''}
                    {r.type === 'e1rm' ? `${r.e1rmKind === 'direta' ? 'série de 1 repetição (carga real)' : `estimado de ${fmtPerf(r.loadKg!, 'kg', ctx)} × ${r.reps}`} · ` : ''}
                    {fmtIsoDate(r.date)}
                    {inRange(r.date) ? ' · no período' : ''}
                  </p>
                  {r.ties.length > 0 && (
                    <p className="text-xs text-muted-foreground" data-testid="perf-record-tie">
                      Empate: igualado em {r.ties.map((t) => fmtIsoDate(t.date)).join(', ')} (não conta como recorde novo).
                    </p>
                  )}
                  <Link to={`/historico/${r.sessionId}`} className="mt-1 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline">
                    Abrir sessão de origem
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {h.family === 'carga' && <p className="text-xs text-muted-foreground">{E1RM_NOTE}</p>}
      </Block>

      <Block id="perf-notes" title="Observações" icon={Lightbulb} testId="perf-notes">
        <label className="flex min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm">
          <span>Mostrar observações de estabilidade</span>
          <Switch checked={showStability} onCheckedChange={setShowStability} aria-label="Mostrar observações de estabilidade" data-testid="perf-detail-stability-toggle" />
        </label>
        <ul className="space-y-2">
          {notes
            .filter((n) => showStability || n.kind !== 'estavel')
            .map((n, i) => (
              <li key={`${n.kind}-${i}`}>
                <Card className="p-3" data-testid="perf-note" data-kind={n.kind}>
                  <p className="text-sm">{n.text}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Critério: {n.criterion}</p>
                </Card>
              </li>
            ))}
          {!notes.length && <li className="text-sm text-muted-foreground">Sem registros no período.</li>}
        </ul>
        {showStability && stability && (
          <p className="text-xs text-muted-foreground" data-testid="perf-stability" data-state={stability.state}>
            {stability.state === 'estavel'
              ? 'Desempenho estável no período.'
              : stability.state === 'variando'
                ? 'Houve mudança no período (não é estabilidade).'
                : stability.state === 'sem_registros'
                  ? 'Sem registros no período: ausência de dados não é estabilidade nem regressão.'
                  : stability.state === 'incompativel'
                    ? 'As sessões do período usam outra forma de medir e não são comparáveis.'
                    : `Poucas sessões comparáveis para avaliar estabilidade (${stability.comparableSessions} em ${stability.spanDays} dias).`}{' '}
            Critério: {stability.criterion}
          </p>
        )}
        {suggestions.length > 0 && (
          <div className="space-y-2 rounded-xl border p-3" data-testid="perf-suggestions">
            <p className="text-sm font-semibold">Sugestões</p>
            <ul className="space-y-2">
              {suggestions.map((s) => (
                <li key={s.id} className="text-sm" data-testid="perf-suggestion">
                  {s.text}
                  <span className="block text-xs text-muted-foreground">Motivo: {s.basis}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{SUGGESTION_NOTICE}</p>
          </div>
        )}
      </Block>

      <Block id="perf-compare" title="Comparar sessões" icon={GitCompare} testId="perf-compare">
        <Comparison key={`${h.identity.key}-${period}`} h={h} obs={obs} ctx={ctx} initialB={sessionParam} />
      </Block>

      <Block id="perf-sessions" title="Sessões" icon={ListOrdered} testId="perf-sessions">
        {!obs.length ? (
          <p className="text-sm text-muted-foreground">Sem sessões no período.</p>
        ) : (
          <ul className="space-y-2">
            {[...obs].reverse().map((o) => (
              <li key={o.sessionId}>
                <Link to={`/historico/${o.sessionId}`} className="block" data-testid="perf-session">
                  <Card className={cn('flex min-h-12 items-center justify-between gap-2 p-3 hover:bg-accent/40', o.sessionId === sessionParam && 'border-primary/50')}>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{sessionLabel(o)}</span>
                      <span className="block text-xs text-muted-foreground tabular">
                        {o.metrics.workSets} {o.metrics.workSets === 1 ? 'série válida' : 'séries válidas'}
                        {o.metrics.warmupSets ? ` · ${o.metrics.warmupSets} aquec.` : ''}
                        {o.metrics.incompleteSets ? ` · ${o.metrics.incompleteSets} incompleta(s)` : ''}
                        {o.metrics.skippedSets ? ` · ${o.metrics.skippedSets} pulada(s)` : ''}
                        {o.copies > 1 ? ` · ${o.copies} cópias somadas` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs font-medium text-primary">Abrir</span>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {otherInPeriod.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="perf-other-family">
            {otherInPeriod.length} {otherInPeriod.length === 1 ? 'sessão' : 'sessões'} com outra modalidade ({otherInPeriod.map((o) => fmtIsoDate(o.date)).join(', ')}) não {otherInPeriod.length === 1 ? 'entra' : 'entram'} nos gráficos nem nos recordes.
          </p>
        )}
      </Block>

      {relatedGoals.length > 0 && <RelatedGoals items={relatedGoals} weightUnit={settings.weightUnit} title="Metas relacionadas" testId="perf-related-goals" />}

      <details className="rounded-xl border p-3 text-sm" data-testid="perf-identity">
        <summary className="flex cursor-pointer items-center gap-2 font-medium">
          <Info className="h-4 w-4 text-primary" aria-hidden /> Identidade analisada
        </summary>
        <div className="mt-2 space-y-2">
          <p>{levelText(h)}</p>
          <p className="break-all text-xs text-muted-foreground">
            Chave: <code>{h.identity.key}</code>
          </p>
          {aggregate && h.members.length > 0 && (
            <div>
              <p className="font-medium">Instâncias desta visão</p>
              <ul className="mt-1 space-y-1" data-testid="perf-members">
                {h.members.map((k) => {
                  const m = index.identities.get(k);
                  return (
                    <li key={k}>
                      <Link to={`${identityPath(k)}?periodo=${period}`} className="text-primary underline-offset-2 hover:underline">
                        {m ? `${m.name}${m.workoutLabel ? ` · Treino ${m.workoutLabel}` : ''}` : k}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {!aggregate && h.aggregates.length > 0 && (
            <ul className="space-y-1" data-testid="perf-aggregate-links">
              {h.aggregates.map((k) => (
                <li key={k}>
                  <Link to={`${identityPath(k)}?periodo=${period}`} className="text-primary underline-offset-2 hover:underline">
                    Abrir visão agregada da biblioteca
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">Nada é juntado pelo nome, nenhuma sessão é alterada e o vínculo feito depois na ficha não reclassifica sessões antigas.</p>
        </div>
      </details>
    </div>
  );
}
