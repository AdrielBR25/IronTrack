// Recordes pessoais por modalidade (P19). Ver docs/DESEMPENHO_EXERCICIOS.md §4.
// Recalculados das observações a cada leitura: nenhum recorde é gravado. Empate não renova o recorde (fica a primeira
// data e o empate é listado). Aquecimento, séries incompletas e puladas nunca entram (já ficam fora das medidas).
import { MIN_PRIOR_SESSIONS_FOR_RECORD } from '@/modules/analytics';
import { greater, same } from './observations';
import type { MeasureFamily, PaceBand, PerfObservation, PerfRecord, RecordEvent, RecordType, RecordUnit } from './types';

export { MIN_PRIOR_SESSIONS_FOR_RECORD };

/** Faixas de distância em que ritmos são comparáveis (um ritmo de 1 km não se compara com um de 10 km). */
export const PACE_BANDS: { band: PaceBand; maxM: number; label: string }[] = [
  { band: 'ate_1km', maxM: 1000, label: 'até 1 km' },
  { band: '1_3km', maxM: 3000, label: '1 a 3 km' },
  { band: '3_5km', maxM: 5000, label: '3 a 5 km' },
  { band: '5_10km', maxM: 10000, label: '5 a 10 km' },
  { band: '10_21km', maxM: 21097.5, label: '10 a 21,1 km' },
  { band: 'acima_21km', maxM: Infinity, label: 'acima de 21,1 km' },
];

export const PACE_BAND_LABEL = Object.fromEntries(PACE_BANDS.map((b) => [b.band, b.label])) as Record<PaceBand, string>;

export function paceBand(distanceM: number): PaceBand {
  return PACE_BANDS.find((b) => distanceM <= b.maxM)!.band;
}

interface RecordSpec {
  type: RecordType;
  unit: RecordUnit;
  lowerIsBetter?: boolean;
  value: (o: PerfObservation) => number | null;
  extra?: (o: PerfObservation) => Partial<RecordEvent>;
}

export const RECORD_LABEL: Record<RecordType, string> = {
  carga_maxima: 'Maior carga',
  repeticoes: 'Mais repetições numa série',
  volume_sessao: 'Maior volume numa sessão',
  e1rm: 'Melhor 1RM estimado',
  repeticoes_corporal: 'Mais repetições só com o corpo',
  carga_adicional: 'Maior carga adicional',
  menor_assistencia: 'Menor assistência',
  duracao: 'Maior duração sustentada',
  distancia: 'Maior distância numa sessão',
  duracao_cardio: 'Maior duração numa sessão',
  ritmo: 'Melhor ritmo',
};

export const RECORD_SPECS: Record<MeasureFamily, RecordSpec[]> = {
  carga: [
    { type: 'carga_maxima', unit: 'kg', value: (o) => o.metrics.topLoadKg, extra: (o) => ({ reps: o.metrics.topLoadReps ?? undefined }) },
    { type: 'repeticoes', unit: 'repeticoes', value: (o) => o.metrics.bestReps, extra: (o) => ({ loadKg: o.metrics.bestRepsLoadKg ?? undefined }) },
    { type: 'volume_sessao', unit: 'kg', value: (o) => o.metrics.volumeKg },
    { type: 'e1rm', unit: 'kg', value: (o) => o.metrics.e1rm?.valueKg ?? null, extra: (o) => ({ e1rmKind: o.metrics.e1rm?.kind, reps: o.metrics.e1rm?.reps, loadKg: o.metrics.e1rm?.loadKg }) },
  ],
  corporal: [
    { type: 'repeticoes_corporal', unit: 'repeticoes', value: (o) => o.metrics.bodyOnlyBestReps },
    { type: 'carga_adicional', unit: 'kg', value: (o) => o.metrics.addedLoadKg, extra: (o) => ({ reps: o.metrics.addedLoadReps ?? undefined }) },
    { type: 'menor_assistencia', unit: 'kg', lowerIsBetter: true, value: (o) => o.metrics.minAssistanceKg, extra: (o) => ({ reps: o.metrics.minAssistanceReps ?? undefined }) },
    { type: 'duracao', unit: 'segundos', value: (o) => o.metrics.bestDurationSec },
  ],
  tempo: [{ type: 'duracao', unit: 'segundos', value: (o) => o.metrics.bestDurationSec }],
  cardio: [
    { type: 'distancia', unit: 'metros', value: (o) => o.metrics.distanceM },
    { type: 'duracao_cardio', unit: 'segundos', value: (o) => o.metrics.cardioDurationSec },
  ],
};

/**
 * Percorre as observações em ordem e devolve o recorde atual e os eventos de recorde. Um evento ("novo recorde") só
 * conta depois de MIN_PRIOR_SESSIONS_FOR_RECORD sessões anteriores com a medida (a primeira sessão é só a primeira
 * marca), a mesma regra do analytics (P08).
 */
function scan(obs: readonly PerfObservation[], spec: RecordSpec, band?: PaceBand): { record: PerfRecord | null; events: RecordEvent[] } {
  let record: PerfRecord | null = null;
  let prior = 0;
  const events: RecordEvent[] = [];
  for (const o of obs) {
    const v = spec.value(o);
    if (v === null || !Number.isFinite(v)) continue;
    const better = record === null || (spec.lowerIsBetter ? greater(record.value, v) : greater(v, record.value));
    if (better) {
      const ev: RecordEvent = { type: spec.type, value: v, unit: spec.unit, date: o.date, ts: o.ts, sessionId: o.sessionId, previous: record?.value ?? null, ...(spec.extra?.(o) ?? {}) };
      if (band) ev.band = band;
      if (record && prior >= MIN_PRIOR_SESSIONS_FOR_RECORD) events.push(ev);
      record = { ...ev, ties: [] };
    } else if (record && same(v, record.value)) record.ties.push({ date: o.date, sessionId: o.sessionId });
    prior++;
  }
  return { record, events };
}

/** Recordes e eventos de uma identidade (observações compatíveis, em ordem cronológica). */
export function computeRecords(family: MeasureFamily, obs: readonly PerfObservation[]): { records: PerfRecord[]; events: RecordEvent[] } {
  const records: PerfRecord[] = [];
  const events: RecordEvent[] = [];
  for (const spec of RECORD_SPECS[family]) {
    const r = scan(obs, spec);
    if (r.record) records.push(r.record);
    events.push(...r.events);
  }
  if (family === 'cardio') {
    // Ritmo: um recorde por faixa de distância, só entre sessões com duração e distância nas mesmas séries.
    for (const { band } of PACE_BANDS) {
      const inBand = obs.filter((o) => o.metrics.paceSecPerKm !== null && paceBand(o.metrics.pacedDistanceM!) === band);
      const r = scan(inBand, { type: 'ritmo', unit: 'seg_por_km', lowerIsBetter: true, value: (o) => o.metrics.paceSecPerKm }, band);
      if (r.record) records.push(r.record);
      events.push(...r.events);
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { records, events };
}
