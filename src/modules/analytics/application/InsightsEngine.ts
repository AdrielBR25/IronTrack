// Motor de insights locais e determinísticos (ver docs/ANALYTICS_TREINAMENTO.md, seção 9).
// Cada insight nasce de uma regra fixa sobre o relatório e carrega a métrica de origem e a evidência
// numérica. Sem diagnósticos, sem prescrição de treino ou dieta e sem linguagem de culpa.
// Os textos não trazem pesos (a unidade kg/lb é escolha da interface): as cargas vão na evidência, em kg.
import { fmtDateShort } from '@/lib/dates';
import type { Insight, InsightEvidence, TrainingReport, ExerciseSummary, Trend } from '../domain/types';
import { TREND_MIN_POINTS, TREND_MIN_SPAN_DAYS } from '../domain/trends';

/** Variação de volume (%) abaixo da qual os períodos são tratados como semelhantes. */
export const VOLUME_SIMILAR_PCT = 5;
/** Máximo de insights por tipo de tendência e de recordes (evita listas longas). */
export const MAX_PER_KIND = 3;

const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const pct = (v: number) => `${nf1.format(Math.abs(v))}%`;
const plural = (n: number, one: string, many: string) => `${nf0.format(n)} ${n === 1 ? one : many}`;

const METRIC_TEXT: Record<Trend['metric'], string> = {
  e1rm: 'O 1RM estimado',
  carga_13: 'A maior carga nas séries de 13 ou mais repetições',
  reps: 'O máximo de repetições sem carga',
};

export function buildInsights(report: TrainingReport): Insight[] {
  const out: Insight[] = [];
  const base = { period: report.period, range: report.range };
  const add = (i: Omit<Insight, 'period' | 'range' | 'confidence'> & { confidence?: Insight['confidence'] }) =>
    out.push({ ...base, confidence: null, ...i });

  if (!report.hasData) {
    if (report.quality.completedSessions === 0)
      add({
        id: 'dados.sem_treinos',
        type: 'dados',
        tone: 'informativo',
        title: 'Ainda não há treinos concluídos',
        description: 'Os indicadores aparecem depois do primeiro treino concluído.',
        metric: 'quality.completedSessions',
        evidence: [{ label: 'Sessões concluídas', value: 0, unit: 'sessoes' }],
      });
    else
      add({
        id: 'dados.periodo_vazio',
        type: 'dados',
        tone: 'informativo',
        title: 'Nenhum treino concluído neste período',
        description: `Há ${plural(report.quality.completedSessions, 'sessão concluída', 'sessões concluídas')} em outros períodos do histórico.`,
        metric: 'totals.sessions',
        evidence: [
          { label: 'Sessões no período', value: 0, unit: 'sessoes' },
          { label: 'Sessões no histórico', value: report.quality.completedSessions, unit: 'sessoes' },
        ],
      });
    return out;
  }

  const { comparison: cmp, frequency: freq, consistency: cons } = report;

  // Frequência
  if (cmp.available && cmp.sessions) {
    const { current, previous, diff } = cmp.sessions;
    const evidence: InsightEvidence[] = [
      { label: 'Sessões no período', value: current, unit: 'sessoes' },
      { label: 'Sessões no período anterior', value: previous, unit: 'sessoes' },
    ];
    if (cmp.sessions.pct !== null) evidence.push({ label: 'Variação', value: cmp.sessions.pct, unit: 'pct' });
    add({
      id: 'frequencia.comparacao',
      type: 'frequencia',
      tone: diff > 0 ? 'positivo' : 'neutro',
      title: diff > 0 ? 'Mais sessões que no período anterior' : diff < 0 ? 'Menos sessões que no período anterior' : 'Mesmo número de sessões do período anterior',
      description:
        diff === 0
          ? `Você concluiu ${plural(current, 'sessão', 'sessões')}, o mesmo que nos ${report.range.days} dias anteriores.`
          : `Você concluiu ${plural(current, 'sessão', 'sessões')} neste período, contra ${nf0.format(previous)} nos ${report.range.days} dias anteriores.`,
      metric: 'comparison.sessions',
      evidence,
    });
  } else if (cmp.reason === 'historico_insuficiente') {
    add({
      id: 'frequencia.comparacao_indisponivel',
      type: 'dados',
      tone: 'informativo',
      title: 'Comparação com o período anterior indisponível',
      description: `O histórico ainda não cobre os ${report.range.days} dias anteriores a este período, então os dois não seriam equivalentes.`,
      metric: 'comparison',
      evidence: [{ label: 'Dias do período', value: report.range.days, unit: 'dias' }],
    });
  }

  if (freq.weeklyAverage !== null && report.covered) {
    add({
      id: 'frequencia.media_semanal',
      type: 'frequencia',
      tone: 'informativo',
      title: `${nf1.format(freq.weeklyAverage)} ${freq.weeklyAverage === 1 ? 'sessão' : 'sessões'} por semana em média`,
      description: `${plural(freq.sessions, 'sessão', 'sessões')} em ${plural(report.covered.days, 'dia', 'dias')} com histórico; houve treino em ${freq.activeWeeks} de ${plural(freq.weeks, 'semana', 'semanas')}.`,
      metric: 'frequency.weeklyAverage',
      evidence: [
        { label: 'Média semanal', value: freq.weeklyAverage, unit: 'sessoes' },
        { label: 'Semanas com treino', value: freq.activeWeeks, unit: 'semanas' },
        { label: 'Semanas no período', value: freq.weeks, unit: 'semanas' },
      ],
    });
  }

  // Volume
  if (cmp.available && cmp.volume && cmp.volume.pct !== null) {
    const p = cmp.volume.pct;
    const similar = Math.abs(p) < VOLUME_SIMILAR_PCT;
    add({
      id: 'volume.comparacao',
      type: 'volume',
      tone: !similar && p > 0 ? 'positivo' : 'neutro',
      title: similar ? 'Volume de carga semelhante ao período anterior' : p > 0 ? 'Seu volume de carga aumentou' : 'Seu volume de carga diminuiu',
      description: similar
        ? `A diferença foi de ${pct(p)}, abaixo de ${VOLUME_SIMILAR_PCT}%.`
        : p > 0
          ? `O volume (carga × repetições) ficou ${pct(p)} acima dos ${report.range.days} dias anteriores.`
          : `O volume (carga × repetições) ficou ${pct(p)} abaixo dos ${report.range.days} dias anteriores. Volume menor não indica, por si só, perda de desempenho.`,
      metric: 'comparison.volume',
      evidence: [
        { label: 'Volume no período', value: cmp.volume.current, unit: 'kg' },
        { label: 'Volume no período anterior', value: cmp.volume.previous, unit: 'kg' },
        { label: 'Variação', value: p, unit: 'pct' },
      ],
    });
  }

  if (report.totals.unloadedSets > 0) {
    add({
      id: 'volume.series_sem_carga',
      type: 'volume',
      tone: 'informativo',
      title: `${plural(report.totals.unloadedSets, 'série sem carga', 'séries sem carga')} no período`,
      description: 'Séries sem carga registrada (como as de peso corporal) contam nas séries e repetições, mas não no volume em quilos.',
      metric: 'totals.unloadedSets',
      evidence: [
        { label: 'Séries sem carga', value: report.totals.unloadedSets, unit: 'series' },
        { label: 'Séries com carga', value: report.totals.loadedSets, unit: 'series' },
      ],
    });
  }

  // Consistência
  if (cons.variation !== null) {
    const stable = cons.regularity === 'estavel';
    add({
      id: 'consistencia.regularidade',
      type: 'consistencia',
      tone: stable ? 'positivo' : 'neutro',
      title: stable ? 'Frequência semanal estável' : 'A frequência de treinos variou nas últimas semanas',
      description: `Nas ${cons.completeWeeks} semanas completas do período, o coeficiente de variação das sessões por semana foi de ${pct(cons.variation * 100)}. Semanas sem treino entram como zero, sem penalidade.`,
      metric: 'consistency.variation',
      evidence: [
        { label: 'Coeficiente de variação', value: cons.variation * 100, unit: 'pct' },
        { label: 'Semanas completas', value: cons.completeWeeks, unit: 'semanas' },
        { label: 'Semanas completas com treino', value: cons.activeCompleteWeeks, unit: 'semanas' },
      ],
    });
  }

  // Recordes
  const records = report.exercises
    .filter((e): e is ExerciseSummary & { newLoadRecordInPeriod: NonNullable<ExerciseSummary['newLoadRecordInPeriod']> } => e.newLoadRecordInPeriod !== null)
    .sort((a, b) => b.newLoadRecordInPeriod.ts - a.newLoadRecordInPeriod.ts || a.name.localeCompare(b.name, 'pt-BR'))
    .slice(0, MAX_PER_KIND);
  for (const e of records) {
    const r = e.newLoadRecordInPeriod;
    const evidence: InsightEvidence[] = [{ label: 'Nova maior carga', value: r.value, unit: 'kg' }];
    if (r.previous !== undefined) evidence.push({ label: 'Maior carga anterior', value: r.previous, unit: 'kg' });
    if (r.reps !== undefined) evidence.push({ label: 'Repetições', value: r.reps, unit: 'reps' });
    add({
      id: `recorde.carga.${e.key}`,
      type: 'recorde',
      tone: 'positivo',
      title: `Novo recorde de carga em ${e.name}`,
      description: `Em ${fmtDateShort(r.date)} você registrou a maior carga do seu histórico neste exercício.`,
      metric: `exercises.${e.key}.records.maxLoad`,
      evidence,
    });
  }

  // Tendências por exercício
  const withTrend = (dir: Trend['direction']) => report.exercises.filter((e) => e.trend.direction === dir);
  const byChange = (a: ExerciseSummary, b: ExerciseSummary) => Math.abs(b.trend.changePct ?? 0) - Math.abs(a.trend.changePct ?? 0) || a.name.localeCompare(b.name, 'pt-BR');
  const trendEvidence = (t: Trend): InsightEvidence[] => {
    const unit = t.metric === 'reps' ? 'reps' : 'kg';
    return [
      { label: 'Média na primeira metade', value: t.firstMean ?? 0, unit },
      { label: 'Média na segunda metade', value: t.lastMean ?? 0, unit },
      { label: 'Variação', value: t.changePct ?? 0, unit: 'pct' },
      { label: 'Limiar de variação', value: t.thresholdPct ?? 0, unit: 'pct' },
      { label: 'Sessões analisadas', value: t.points, unit: 'sessoes' },
    ];
  };
  for (const e of withTrend('positiva').sort(byChange).slice(0, MAX_PER_KIND))
    add({
      id: `carga.tendencia.${e.key}`,
      type: 'carga',
      tone: 'positivo',
      title: `Evolução em ${e.name}`,
      description: `${METRIC_TEXT[e.trend.metric]} subiu ${pct(e.trend.changePct!)} da primeira para a segunda metade das sessões do período (média), acima do limiar de ${pct(e.trend.thresholdPct!)} que cobre a oscilação natural entre sessões.`,
      metric: `exercises.${e.key}.trend`,
      evidence: trendEvidence(e.trend),
      confidence: e.trend.confidence,
    });
  for (const e of withTrend('estavel').sort(byChange).slice(0, MAX_PER_KIND))
    add({
      id: `carga.tendencia.${e.key}`,
      type: 'carga',
      tone: 'neutro',
      title: `Desempenho estável em ${e.name}`,
      description: `${METRIC_TEXT[e.trend.metric]} variou ${pct(e.trend.changePct!)} entre as duas metades do período, dentro do limiar de ${pct(e.trend.thresholdPct!)} que cobre a oscilação natural entre sessões.`,
      metric: `exercises.${e.key}.trend`,
      evidence: trendEvidence(e.trend),
      confidence: e.trend.confidence,
    });
  for (const e of withTrend('queda').sort(byChange).slice(0, MAX_PER_KIND))
    add({
      id: `carga.tendencia.${e.key}`,
      type: 'carga',
      tone: 'neutro',
      title: `Desempenho registrado menor em ${e.name}`,
      description: `${METRIC_TEXT[e.trend.metric]} ficou ${pct(e.trend.changePct!)} abaixo da primeira metade do período (média). Isso, sozinho, não indica perda de força: técnica, faixa de repetições, cansaço do dia ou uma fase mais leve também mudam a carga registrada.`,
      metric: `exercises.${e.key}.trend`,
      evidence: trendEvidence(e.trend),
      confidence: e.trend.confidence,
    });
  const insufficient = withTrend('insuficiente');
  if (insufficient.length)
    add({
      id: 'carga.tendencia.insuficiente',
      type: 'dados',
      tone: 'informativo',
      title: 'Ainda não há histórico suficiente para avaliar a tendência',
      description: `${insufficient.length === 1 ? '1 exercício tem' : `${insufficient.length} exercícios têm`} menos de ${TREND_MIN_POINTS} sessões ou menos de ${TREND_MIN_SPAN_DAYS} dias de registro neste período.`,
      metric: 'exercises.trend',
      evidence: [
        { label: 'Exercícios sem tendência', value: insufficient.length, unit: 'exercicios' },
        { label: 'Exercícios no período', value: report.exercises.length, unit: 'exercicios' },
      ],
    });

  // Qualidade dos dados (histórico inteiro)
  const ignored = report.quality.invalidRepSets + report.quality.invalidLoadSets;
  if (ignored > 0)
    add({
      id: 'dados.valores_invalidos',
      type: 'dados',
      tone: 'informativo',
      title: `${plural(ignored, 'série com valor inválido', 'séries com valores inválidos')} no histórico`,
      description: 'Séries concluídas sem repetições válidas ficam fora das métricas; cargas inválidas ficam fora do volume em quilos. Nenhum registro foi alterado.',
      metric: 'quality',
      evidence: [
        { label: 'Séries sem repetições válidas', value: report.quality.invalidRepSets, unit: 'series' },
        { label: 'Séries com carga inválida', value: report.quality.invalidLoadSets, unit: 'series' },
      ],
    });

  return out;
}
