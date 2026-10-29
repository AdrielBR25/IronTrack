// Comparação entre duas sessões e entre séries (P19). Ver docs/DESEMPENHO_EXERCICIOS.md §6–7.
// Só compara o que foi registrado: valor ausente fica ausente (nunca zero), séries sem correspondência aparecem como
// ausentes e nenhuma melhora é afirmada quando as condições não são equivalentes.
import { greater, same } from './observations';
import { paceBand } from './records';
import type { CompatibilityIssue, ComparedMetric, IdentityHistory, PerfObservation, PerfSet, RecordUnit, SessionComparison, SetComparison, SetPairRow } from './types';

export const ISSUE_LABEL: Record<CompatibilityIssue, string> = {
  familia_diferente: 'as sessões medem de formas diferentes (modalidade alterada)',
  modo_de_carga_diferente: 'o tipo de carga registrado é diferente',
  lateralidade_diferente: 'a execução (unilateral/bilateral) é diferente',
  instancias_diferentes: 'as sessões vêm de instâncias diferentes da ficha (visão agregada)',
  faixa_de_distancia_diferente: 'as distâncias estão em faixas diferentes, então o ritmo não é comparado',
  mesma_sessao: 'é a mesma sessão',
};

interface MetricSpec {
  key: string;
  label: string;
  unit: RecordUnit;
  value: (o: PerfObservation) => number | null;
  lowerIsBetter?: boolean;
  /** Contagens não têm variação percentual. */
  noPct?: boolean;
}

const SPECS: Record<PerfObservation['family'], MetricSpec[]> = {
  carga: [
    { key: 'carga', label: 'Carga máxima', unit: 'kg', value: (o) => o.metrics.topLoadKg },
    { key: 'reps_carga', label: 'Repetições na carga máxima', unit: 'repeticoes', value: (o) => o.metrics.topLoadReps },
    { key: 'series', label: 'Séries de trabalho', unit: 'repeticoes', value: (o) => o.metrics.workSets || null, noPct: true },
    { key: 'reps_total', label: 'Repetições totais', unit: 'repeticoes', value: (o) => o.metrics.totalReps },
    { key: 'volume', label: 'Volume (carga × repetições)', unit: 'kg', value: (o) => o.metrics.volumeKg },
    { key: 'e1rm', label: '1RM estimado', unit: 'kg', value: (o) => o.metrics.e1rm?.valueKg ?? null },
  ],
  corporal: [
    { key: 'reps_corporal', label: 'Repetições só com o corpo', unit: 'repeticoes', value: (o) => o.metrics.bodyOnlyBestReps },
    { key: 'carga_adicional', label: 'Carga adicional', unit: 'kg', value: (o) => o.metrics.addedLoadKg },
    { key: 'assistencia', label: 'Menor assistência', unit: 'kg', value: (o) => o.metrics.minAssistanceKg, lowerIsBetter: true },
    { key: 'duracao', label: 'Maior duração', unit: 'segundos', value: (o) => o.metrics.bestDurationSec },
    { key: 'series', label: 'Séries de trabalho', unit: 'repeticoes', value: (o) => o.metrics.workSets || null, noPct: true },
  ],
  tempo: [
    { key: 'duracao', label: 'Maior duração', unit: 'segundos', value: (o) => o.metrics.bestDurationSec },
    { key: 'duracao_total', label: 'Duração total', unit: 'segundos', value: (o) => o.metrics.totalDurationSec },
    { key: 'series', label: 'Séries de trabalho', unit: 'repeticoes', value: (o) => o.metrics.workSets || null, noPct: true },
  ],
  cardio: [
    { key: 'distancia', label: 'Distância', unit: 'metros', value: (o) => o.metrics.distanceM },
    { key: 'duracao', label: 'Duração', unit: 'segundos', value: (o) => o.metrics.cardioDurationSec },
    { key: 'ritmo', label: 'Ritmo', unit: 'seg_por_km', value: (o) => o.metrics.paceSecPerKm, lowerIsBetter: true },
  ],
};

export function compatibilityIssues(h: Pick<IdentityHistory, 'identity'>, a: PerfObservation, b: PerfObservation): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (a.sessionId === b.sessionId) issues.push('mesma_sessao');
  if (a.family !== b.family) issues.push('familia_diferente');
  if (a.loadMode && b.loadMode && a.loadMode !== b.loadMode) issues.push('modo_de_carga_diferente');
  if (a.laterality && b.laterality && a.laterality !== b.laterality) issues.push('lateralidade_diferente');
  const aggregate = h.identity.kind === 'catalogo' || h.identity.kind === 'personalizado';
  if (aggregate && (a.primaryKeys.length !== 1 || b.primaryKeys.length !== 1 || a.primaryKeys[0] !== b.primaryKeys[0])) issues.push('instancias_diferentes');
  return issues;
}

/** Diferenças série a série: séries normais pela ordem (por lado em unilaterais), nunca preenchendo ausências. */
export function compareSets(a: PerfObservation, b: PerfObservation): SetComparison {
  const excluded = { a: a.sets.filter((s) => s.kind === 'aquecimento' || s.kind === 'drop').length, b: b.sets.filter((s) => s.kind === 'aquecimento' || s.kind === 'drop').length };
  const none = (reason: SetComparison['reason']): SetComparison => ({ available: false, reason, rows: [], excluded });
  if (a.family !== b.family) return none('familia_diferente');
  if (a.family === 'cardio') return none('cardio');
  const normal = (o: PerfObservation) => o.sets.filter((s) => s.ordinal !== null);
  const na = normal(a);
  const nb = normal(b);
  if (!na.some((s) => s.kind === 'trabalho') || !nb.some((s) => s.kind === 'trabalho')) return none('sem_series_normais');
  const unilateral = a.laterality === 'unilateral' || b.laterality === 'unilateral';
  const sided = (s: PerfSet) => s.side === 'direito' || s.side === 'esquerdo';
  if (unilateral && (!na.every(sided) || !nb.every(sided))) return none('lados_nao_registrados');
  const key = (s: PerfSet) => `${s.side ?? '-'}#${s.ordinal}`;
  const ma = new Map(na.map((s) => [key(s), s]));
  const mb = new Map(nb.map((s) => [key(s), s]));
  const keys = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => {
    const [sx, ox] = x.split('#');
    const [sy, oy] = y.split('#');
    return sx.localeCompare(sy) || Number(ox) - Number(oy);
  });
  const rows: SetPairRow[] = keys.map((k) => {
    const sa = ma.get(k) ?? null;
    const sb = mb.get(k) ?? null;
    const ref = (sa ?? sb)!;
    const base = { ordinal: ref.ordinal!, side: ref.side, a: sa, b: sb, loadDiffKg: null, repsDiff: null, durationDiffSec: null };
    if (!sa) return { ...base, state: 'ausente_a' };
    if (!sb) return { ...base, state: 'ausente_b' };
    if (sa.kind !== 'trabalho' || sb.kind !== 'trabalho') return { ...base, state: 'incompleta' };
    return {
      ...base,
      state: 'comparavel',
      loadDiffKg: sa.loadKg !== null && sb.loadKg !== null ? sb.loadKg - sa.loadKg : null,
      repsDiff: sa.reps !== null && sb.reps !== null ? sb.reps - sa.reps : null,
      durationDiffSec: sa.durationSec !== null && sb.durationSec !== null ? sb.durationSec - sa.durationSec : null,
    };
  });
  return { available: true, reason: null, rows, excluded };
}

/**
 * Compara a sessão `a` (anterior) com `b` (posterior). Diferenças absolutas sempre que os dois valores existem;
 * percentuais só para medidas de razão com base positiva. O resumo só aponta diferença favorável quando as condições
 * são equivalentes e a comparação é direta (mesma carga ou carga maior com repetições iguais ou maiores).
 */
export function compareSessions(h: Pick<IdentityHistory, 'identity'>, first: PerfObservation, second: PerfObservation): SessionComparison {
  const [a, b] = first.ts <= second.ts ? [first, second] : [second, first];
  const issues = compatibilityIssues(h, a, b);
  const family = b.family;
  const paceComparable = a.metrics.pacedDistanceM !== null && b.metrics.pacedDistanceM !== null && paceBand(a.metrics.pacedDistanceM) === paceBand(b.metrics.pacedDistanceM);
  if (family === 'cardio' && a.family === 'cardio' && a.metrics.pacedDistanceM !== null && b.metrics.pacedDistanceM !== null && !paceComparable) issues.push('faixa_de_distancia_diferente');
  const specs = a.family === b.family ? SPECS[family] : [];
  const metrics: ComparedMetric[] = specs.map((s) => {
    const va = s.value(a);
    const vb = s.value(b);
    const both = va !== null && vb !== null;
    const ritmoBlocked = s.key === 'ritmo' && !paceComparable;
    return {
      key: s.key,
      label: s.label,
      unit: s.unit,
      a: va,
      b: vb,
      diff: both && !ritmoBlocked ? vb! - va! : null,
      pct: both && !ritmoBlocked && !s.noPct && va! > 0 ? ((vb! - va!) / va!) * 100 : null,
      lowerIsBetter: !!s.lowerIsBetter,
      missing: va === null && vb === null ? 'ambos' : va === null ? 'a' : vb === null ? 'b' : null,
    };
  });
  const blocking = issues.filter((i) => i !== 'faixa_de_distancia_diferente');
  const compatible = blocking.length === 0;
  let summary: string;
  if (!compatible) summary = `As condições não são equivalentes: ${blocking.map((i) => ISSUE_LABEL[i]).join('; ')}. As diferenças aparecem só como registro.`;
  else if (family === 'carga') {
    const la = a.metrics.topLoadKg;
    const lb = b.metrics.topLoadKg;
    const ra = a.metrics.topLoadReps ?? 0;
    const rb = b.metrics.topLoadReps ?? 0;
    if (la === null || lb === null) summary = 'Uma das sessões não tem carga registrada; compare os valores disponíveis abaixo.';
    else if (greater(lb, la) && rb >= ra) summary = 'Carga máxima maior na sessão mais recente, com repetições iguais ou maiores na série mais pesada.';
    else if (same(la, lb) && rb > ra) summary = 'Mesma carga máxima, com mais repetições na sessão mais recente.';
    else if (same(la, lb) && rb === ra) summary = 'Mesma carga máxima e as mesmas repetições na série mais pesada.';
    else summary = 'As sessões têm valores diferentes; compare os números abaixo antes de tirar conclusões.';
  } else summary = 'Diferenças registradas entre as sessões; valores ausentes não são tratados como zero.';
  return { a, b, compatible, issues, metrics, sets: compareSets(a, b), summary };
}
