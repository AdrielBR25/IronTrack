// Observações de tendência, estabilidade e sugestões locais (P19). Ver docs/DESEMPENHO_EXERCICIOS.md §9–11.
// Determinísticas e explicáveis: cada texto traz o critério e as sessões que o motivaram. Sem IA, sem rede, sem
// diagnóstico, sem prescrever cargas e sem alterar fichas ou metas. Estabilidade nunca é apresentada como fracasso.
import { TREND_BASE_THRESHOLD_PCT, TREND_MIN_POINTS, TREND_MIN_SPAN_DAYS, computeTrend, type DateRange, type TrendMetric } from '@/modules/analytics';
import { greater, same } from './observations';
import { PACE_BAND_LABEL, paceBand } from './records';
import { dayNum, inPerfRange } from './periods';
import { metricValue } from './series';
import type { ChartMetric, IdentityHistory, PerfObservation, PerfObservationNote, PerfTrend, StabilityResult, Suggestion } from './types';

/** Sessões comparáveis anteriores consideradas nas comparações recentes. */
export const RECENT_WINDOW = 3;
/** Estabilidade: mínimo de sessões comparáveis e de dias cobertos dentro do período. */
export const STABILITY_MIN_SESSIONS = 4;
export const STABILITY_MIN_SPAN_DAYS = 21;
/** Sugestão de progressão gradual: sessões seguidas no topo da faixa planejada com a mesma carga. */
export const PROGRESSION_STREAK = 3;

export const SUGGESTION_NOTICE = 'Sugestões locais e opcionais, baseadas só nos seus registros. Não são prescrição profissional e nada é alterado na sua ficha.';

/** Limiar de cada métrica, emprestado do analytics (P08) para manter um critério só. */
const TREND_BASE: Record<ChartMetric, TrendMetric> = {
  carga: 'carga_13',
  repeticoes: 'reps',
  volume: 'reps',
  e1rm: 'e1rm',
  repeticoes_corporal: 'reps',
  carga_adicional: 'carga_13',
  assistencia: 'carga_13',
  duracao: 'duracao',
  distancia: 'distancia',
  duracao_cardio: 'duracao',
  ritmo: 'distancia',
};

/** Métrica principal da tendência por família (a que tem mais pontos entre as candidatas). */
export function trendMetricFor(h: Pick<IdentityHistory, 'family'>, obs: readonly PerfObservation[]): ChartMetric {
  const candidates: ChartMetric[] =
    h.family === 'carga' ? ['e1rm', 'carga'] : h.family === 'corporal' ? ['repeticoes_corporal', 'carga_adicional', 'duracao'] : h.family === 'tempo' ? ['duracao'] : ['distancia', 'ritmo'];
  const count = (m: ChartMetric) => obs.filter((o) => metricValue(o, m) !== null).length;
  return candidates.reduce((best, m) => (count(m) > count(best) ? m : best), candidates[0]);
}

/**
 * Tendência pelo motor do analytics (`computeTrend`: médias das metades contra o maior entre o limiar da métrica e o
 * ruído). Ritmo entra como velocidade (maior = mais rápido) e só na faixa de distância da sessão mais recente.
 */
export function perfTrend(h: Pick<IdentityHistory, 'family'>, obs: readonly PerfObservation[], metric = trendMetricFor(h, obs)): PerfTrend {
  let list = obs.filter((o) => metricValue(o, metric) !== null);
  if (metric === 'ritmo' && list.length) {
    const band = paceBand(list[list.length - 1].metrics.pacedDistanceM!);
    list = list.filter((o) => paceBand(o.metrics.pacedDistanceM!) === band);
  }
  const series = list.map((o) => ({ date: o.date, value: metric === 'ritmo' ? 3600 / metricValue(o, metric)! : metricValue(o, metric)! }));
  const t = computeTrend(series, TREND_BASE[metric]);
  return { metric, direction: t.direction, points: t.points, spanDays: t.spanDays, changePct: t.changePct, thresholdPct: t.thresholdPct, reason: t.reason ?? null, longGap: t.longGap };
}

const pctText = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}%`;
const n = (v: number, digits = 1) => (Number.isInteger(v) ? String(v) : v.toFixed(digits).replace('.', ','));
const kg = (v: number) => `${n(v)} kg`;
const dateBR = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const sessions = (k: number) => `${k} ${k === 1 ? 'sessão' : 'sessões'}`;

function maxOf(obs: readonly PerfObservation[], pick: (o: PerfObservation) => number | null): number | null {
  let best: number | null = null;
  for (const o of obs) {
    const v = pick(o);
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

/** Comparações entre a sessão mais recente do período e as anteriores comparáveis (no máximo RECENT_WINDOW). */
function recentComparisons(h: IdentityHistory, obs: readonly PerfObservation[]): PerfObservationNote[] {
  const out: PerfObservationNote[] = [];
  if (obs.length < 2) return out;
  const last = obs[obs.length - 1];
  const prior = obs.slice(Math.max(0, obs.length - 1 - RECENT_WINDOW), -1);
  const ids = (list: readonly PerfObservation[]) => [...list.map((o) => o.sessionId), last.sessionId];
  const push = (kind: PerfObservationNote['kind'], text: string, criterion: string, basis: readonly PerfObservation[]) =>
    out.push({ kind, text, criterion, sessionIds: ids(basis), recentProgress: true });
  const m = last.metrics;
  if (h.family === 'carga') {
    const withLoad = prior.filter((o) => o.metrics.topLoadKg !== null);
    const prevMax = maxOf(withLoad, (o) => o.metrics.topLoadKg);
    if (m.topLoadKg !== null && prevMax !== null && greater(m.topLoadKg, prevMax))
      push(
        'carga_maior',
        'Sua carga máxima registrada aumentou nas últimas sessões comparáveis.',
        `Maior carga em ${dateBR(last.date)} (${kg(m.topLoadKg)}) acima da maior carga das ${sessions(withLoad.length)} anteriores no período (${kg(prevMax)}).`,
        withLoad,
      );
    const prev = [...withLoad].pop();
    if (prev && m.topLoadKg !== null && same(m.topLoadKg, prev.metrics.topLoadKg!) && (m.topLoadReps ?? 0) > (prev.metrics.topLoadReps ?? 0))
      push(
        'mais_repeticoes_mesma_carga',
        'Você manteve a mesma carga e registrou mais repetições.',
        `Na carga máxima (${kg(m.topLoadKg)}): ${m.topLoadReps} repetições em ${dateBR(last.date)} contra ${prev.metrics.topLoadReps} em ${dateBR(prev.date)}.`,
        [prev],
      );
    const prevVol = [...prior].reverse().find((o) => o.metrics.volumeKg !== null);
    if (prevVol && m.volumeKg !== null && prevVol.metrics.normalSets === m.normalSets && prevVol.metrics.workSets === m.workSets && greater(m.volumeKg, prevVol.metrics.volumeKg!))
      push(
        'volume_maior',
        'O volume foi maior que na sessão comparável anterior.',
        `Mesmo número de séries de trabalho (${m.workSets}); volume de ${kg(m.volumeKg)} em ${dateBR(last.date)} contra ${kg(prevVol.metrics.volumeKg!)} em ${dateBR(prevVol.date)}. Volume é carga × repetições e não mede hipertrofia.`,
        [prevVol],
      );
  } else if (h.family === 'corporal') {
    const withReps = prior.filter((o) => o.metrics.bodyOnlyBestReps !== null);
    const prevReps = maxOf(withReps, (o) => o.metrics.bodyOnlyBestReps);
    if (m.bodyOnlyBestReps !== null && prevReps !== null && m.bodyOnlyBestReps > prevReps)
      push(
        'repeticoes_maior',
        'Você registrou mais repetições só com o peso do corpo do que nas sessões comparáveis anteriores.',
        `Melhor série em ${dateBR(last.date)}: ${m.bodyOnlyBestReps} repetições; melhor das ${sessions(withReps.length)} anteriores no período: ${prevReps}.`,
        withReps,
      );
    const withAdded = prior.filter((o) => o.metrics.addedLoadKg !== null);
    const prevAdded = maxOf(withAdded, (o) => o.metrics.addedLoadKg);
    if (m.addedLoadKg !== null && prevAdded !== null && greater(m.addedLoadKg, prevAdded))
      push(
        'carga_maior',
        'Sua carga adicional máxima aumentou nas últimas sessões comparáveis.',
        `Carga adicional em ${dateBR(last.date)}: ${kg(m.addedLoadKg)}; maior das ${sessions(withAdded.length)} anteriores: ${kg(prevAdded)}.`,
        withAdded,
      );
  } else if (h.family === 'tempo') {
    const withDur = prior.filter((o) => o.metrics.bestDurationSec !== null);
    const prevDur = maxOf(withDur, (o) => o.metrics.bestDurationSec);
    if (m.bestDurationSec !== null && prevDur !== null && m.bestDurationSec > prevDur)
      push(
        'duracao_maior',
        'Você sustentou o exercício por mais tempo do que nas sessões comparáveis anteriores.',
        `Melhor série em ${dateBR(last.date)}: ${m.bestDurationSec} s; melhor das ${sessions(withDur.length)} anteriores no período: ${prevDur} s.`,
        withDur,
      );
  } else {
    const withDist = prior.filter((o) => o.metrics.distanceM !== null);
    const prevDist = maxOf(withDist, (o) => o.metrics.distanceM);
    if (m.distanceM !== null && prevDist !== null && greater(m.distanceM, prevDist))
      push(
        'distancia_maior',
        'Você percorreu uma distância maior do que nas sessões comparáveis anteriores.',
        `Distância em ${dateBR(last.date)}: ${n(m.distanceM / 1000, 2)} km; maior das ${sessions(withDist.length)} anteriores no período: ${n(prevDist / 1000, 2)} km.`,
        withDist,
      );
    if (m.paceSecPerKm !== null) {
      const band = paceBand(m.pacedDistanceM!);
      const sameBand = prior.filter((o) => o.metrics.paceSecPerKm !== null && paceBand(o.metrics.pacedDistanceM!) === band);
      const prevBest = sameBand.length ? Math.min(...sameBand.map((o) => o.metrics.paceSecPerKm!)) : null;
      if (prevBest !== null && greater(prevBest, m.paceSecPerKm))
        push(
          'ritmo_melhor',
          'Seu ritmo foi mais rápido do que nas sessões anteriores com distância semelhante.',
          `Faixa de distância ${PACE_BAND_LABEL[band]}: ${Math.round(m.paceSecPerKm)} s/km em ${dateBR(last.date)} contra o melhor de ${Math.round(prevBest)} s/km nas ${sessions(sameBand.length)} anteriores. Ritmo mais rápido não é melhora em qualquer contexto.`,
          sameBand,
        );
    }
  }
  return out;
}

/** Observações de uma identidade dentro do período. */
export function observationsFor(h: IdentityHistory, range: DateRange): PerfObservationNote[] {
  const obs = h.observations.filter((o) => inPerfRange(o.date, range));
  const other = h.otherFamily.filter((o) => inPerfRange(o.date, range));
  const notes: PerfObservationNote[] = [];
  if (obs.length) {
    notes.push(...recentComparisons(h, obs));
    const t = perfTrend(h, obs);
    const all = obs.map((o) => o.sessionId);
    if (t.direction === 'insuficiente')
      notes.push({
        kind: 'insuficiente',
        text: 'Ainda não há sessões suficientes para avaliar uma tendência.',
        criterion: `A tendência exige pelo menos ${TREND_MIN_POINTS} sessões comparáveis cobrindo ${TREND_MIN_SPAN_DAYS} dias no período; há ${sessions(t.points)} em ${t.spanDays} ${t.spanDays === 1 ? 'dia' : 'dias'}.`,
        sessionIds: all,
        recentProgress: false,
      });
    else {
      const base = `Média da metade mais recente contra a metade inicial das ${sessions(t.points)} comparáveis do período: ${pctText(t.changePct!)} (limiar ${pctText(t.thresholdPct!).replace('+', '')}).`;
      const gap = t.longGap ? ' Há uma pausa longa entre as sessões, o que reduz a confiança.' : '';
      const noisy = t.thresholdPct! > TREND_BASE_THRESHOLD_PCT[TREND_BASE[t.metric]] + 1e-9;
      if (t.direction === 'positiva') notes.push({ kind: 'tendencia_positiva', text: 'A média das sessões mais recentes ficou acima da média do início do período.', criterion: base + gap, sessionIds: all, recentProgress: true });
      else if (t.direction === 'queda') notes.push({ kind: 'abaixo_do_inicio', text: 'Os registros mais recentes ficaram abaixo dos do início do período.', criterion: base + gap, sessionIds: all, recentProgress: false });
      else if (noisy) notes.push({ kind: 'variacao', text: 'Os registros recentes apresentam variação.', criterion: `${base} O limiar subiu porque os valores oscilam entre as sessões.${gap}`, sessionIds: all, recentProgress: false });
      else notes.push({ kind: 'estavel', text: 'Desempenho estável no período.', criterion: base + gap, sessionIds: all, recentProgress: false });
    }
  }
  if (other.length)
    notes.push({
      kind: 'outra_modalidade',
      text: `${sessions(other.length)} com outra modalidade registrada não ${other.length === 1 ? 'foi comparada' : 'foram comparadas'}.`,
      criterion: 'Só se comparam sessões com a mesma forma de medir (ex.: carga × repetições não se compara com duração).',
      sessionIds: other.map((o) => o.sessionId),
      recentProgress: false,
    });
  return notes;
}

/**
 * Estabilidade opcional: pelo menos STABILITY_MIN_SESSIONS sessões comparáveis cobrindo STABILITY_MIN_SPAN_DAYS dias
 * dentro do período, tendência "estável" e nenhum recorde novo no período. Diferencia ausência de registros, poucas
 * sessões e sessões incompatíveis.
 */
export function stabilityOf(h: IdentityHistory, range: DateRange): StabilityResult {
  const obs = h.observations.filter((o) => inPerfRange(o.date, range));
  const other = h.otherFamily.filter((o) => inPerfRange(o.date, range)).length;
  const span = obs.length ? dayNum(obs[obs.length - 1].date) - dayNum(obs[0].date) : 0;
  const criterion = `Pelo menos ${STABILITY_MIN_SESSIONS} sessões comparáveis em ${STABILITY_MIN_SPAN_DAYS} dias ou mais dentro do período, sem mudança acima do limiar da tendência e sem recorde novo no período.`;
  if (!obs.length) return { state: other ? 'incompativel' : 'sem_registros', comparableSessions: 0, spanDays: 0, criterion };
  if (obs.length < STABILITY_MIN_SESSIONS || span < STABILITY_MIN_SPAN_DAYS)
    return { state: other && obs.length < STABILITY_MIN_SESSIONS ? 'incompativel' : 'poucas_sessoes', comparableSessions: obs.length, spanDays: span, criterion };
  const t = perfTrend(h, obs);
  const record = h.recordEvents.some((e) => inPerfRange(e.date, range));
  return { state: t.direction === 'estavel' && !record ? 'estavel' : 'variando', comparableSessions: obs.length, spanDays: span, criterion };
}

/** Sugestões conservadoras. Nunca calculam carga, nunca alteram ficha ou meta. */
export function suggestionsFor(h: IdentityHistory, range: DateRange): Suggestion[] {
  const out: Suggestion[] = [];
  const obs = h.observations.filter((o) => inPerfRange(o.date, range));
  if (h.family === 'carga' && obs.length >= PROGRESSION_STREAK) {
    const streak = obs.slice(-PROGRESSION_STREAK);
    const load = streak[0].metrics.topLoadKg;
    const ok =
      load !== null &&
      streak.every((o) => {
        const normal = o.sets.filter((s) => s.kind === 'trabalho');
        return (
          o.repMax !== null &&
          normal.length > 0 &&
          o.metrics.topLoadKg !== null &&
          same(o.metrics.topLoadKg, load) &&
          o.metrics.incompleteSets === 0 &&
          o.metrics.skippedSets === 0 &&
          normal.every((s) => s.loadKg !== null && same(s.loadKg, load) && (s.reps ?? 0) >= o.repMax!)
        );
      });
    if (ok)
      out.push({
        id: 'progressao_gradual',
        text: 'Se a execução estiver confortável e consistente, avalie uma progressão gradual com orientação adequada.',
        basis: `Nas ${PROGRESSION_STREAK} sessões comparáveis mais recentes (${streak.map((o) => dateBR(o.date)).join(', ')}), todas as séries de trabalho com ${kg(load!)} chegaram ao topo da faixa de repetições planejada, sem séries incompletas ou puladas.`,
        sessionIds: streak.map((o) => o.sessionId),
      });
  }
  const st = stabilityOf(h, range);
  if (st.state === 'estavel' && (h.family === 'carga' || h.family === 'corporal'))
    out.push({
      id: 'revisar_meta_repeticoes',
      text: 'Você pode revisar sua meta de repetições.',
      basis: `Desempenho estável em ${sessions(st.comparableSessions)} comparáveis ao longo de ${st.spanDays} dias. ${st.criterion}`,
      sessionIds: obs.map((o) => o.sessionId),
    });
  const notes = observationsFor(h, range);
  const varying = notes.find((x) => x.kind === 'variacao' || x.kind === 'abaixo_do_inicio');
  if (varying && (h.family === 'carga' || h.family === 'corporal'))
    out.push({ id: 'comparar_antes_de_mudar', text: 'Considere comparar suas últimas sessões antes de alterar a carga.', basis: `${varying.text} ${varying.criterion}`, sessionIds: varying.sessionIds });
  return out;
}
