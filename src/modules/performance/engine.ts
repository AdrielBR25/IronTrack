// Índice de desempenho (P19): uma passada pelas sessões concluídas do perfil monta as observações por identidade,
// os recordes e os eventos de recorde. Puro e determinístico; a interface memoriza o resultado por lista de sessões.
// Custo O(séries); períodos, gráficos e comparações reaproveitam o índice sem voltar ao banco.
import type { DateRange } from '@/modules/analytics';
import type { SessionExercise, WorkoutSession } from '@/modules/training';
import { resolveIdentity, type ResolvedIdentity } from './identity';
import { observationOf } from './observations';
import { computeRecords } from './records';
import { inPerfRange, localDate } from './periods';
import { observationsFor, stabilityOf } from './insights';
import type { IdentityHistory, PerformanceIdentity, PerformanceIndex, PerfObservation, RecordEvent } from './types';

export interface BuildOptions {
  /** Perfil atual: sessões de outro perfil ficam de fora (sem dono = legado do perfil principal). */
  profileId?: string | null;
}

/** Sessão concluída, com data válida e do perfil. Planejadas, em andamento e descartadas nunca contam. */
export function isCountedSession(s: WorkoutSession | null | undefined, profileId?: string | null): s is WorkoutSession {
  if (!s || s.status !== 'completed' || typeof s.id !== 'string' || !Number.isFinite(s.startedAt)) return false;
  if (profileId && s.profileId && s.profileId !== profileId) return false;
  return Array.isArray(s.exercises);
}

function blank(identity: PerformanceIdentity, o: PerfObservation, r: ResolvedIdentity | null): IdentityHistory {
  return {
    identity,
    name: o.name,
    family: o.family,
    loadMode: o.loadMode,
    laterality: o.laterality,
    equipment: o.equipment,
    observations: [],
    otherFamily: [],
    historicReason: r?.historicReason ?? null,
    routineId: null,
    workoutLabel: null,
    workoutName: null,
    members: [],
    aggregates: [],
    templateIds: [],
    catalogId: identity.kind === 'catalogo' ? identity.id : null,
    customExerciseId: identity.kind === 'personalizado' ? identity.id : null,
    records: [],
    recordEvents: [],
  };
}

export function buildPerformanceIndex(sessions: readonly WorkoutSession[], opts: BuildOptions = {}): PerformanceIndex {
  const counted = sessions.filter((s) => isCountedSession(s, opts.profileId)).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const identities = new Map<string, IdentityHistory>();
  const all = new Map<string, PerfObservation[]>();
  const aggregatesOf = new Map<string, Set<string>>();
  const resolvedOf = new Map<string, ResolvedIdentity>();
  for (const s of counted) {
    const byPrimary = new Map<string, { ex: SessionExercise; primaryKey: string }[]>();
    const byAggregate = new Map<string, { ex: SessionExercise; primaryKey: string }[]>();
    const identityOf = new Map<string, PerformanceIdentity>();
    for (const ex of s.exercises) {
      if (!ex || !Array.isArray(ex.sets)) continue;
      const r = resolveIdentity(s, ex);
      const copy = { ex, primaryKey: r.primary.key };
      identityOf.set(r.primary.key, r.primary);
      if (!resolvedOf.has(r.primary.key)) resolvedOf.set(r.primary.key, r);
      (byPrimary.get(r.primary.key) ?? byPrimary.set(r.primary.key, []).get(r.primary.key)!).push(copy);
      if (r.aggregate) {
        identityOf.set(r.aggregate.key, r.aggregate);
        (byAggregate.get(r.aggregate.key) ?? byAggregate.set(r.aggregate.key, []).get(r.aggregate.key)!).push(copy);
        (aggregatesOf.get(r.primary.key) ?? aggregatesOf.set(r.primary.key, new Set()).get(r.primary.key)!).add(r.aggregate.key);
      }
    }
    for (const [key, copies] of [...byPrimary, ...byAggregate]) {
      const o = observationOf(s, copies);
      if (!o) continue;
      if (!identities.has(key)) identities.set(key, blank(identityOf.get(key)!, o, resolvedOf.get(key) ?? null));
      (all.get(key) ?? all.set(key, []).get(key)!).push(o);
    }
  }
  for (const [key, h] of identities) {
    const obs = all.get(key) ?? [];
    const last = obs[obs.length - 1];
    h.name = last.name;
    h.family = last.family;
    h.loadMode = last.loadMode;
    h.laterality = last.laterality;
    h.equipment = last.equipment;
    h.observations = obs.filter((o) => o.family === h.family);
    h.otherFamily = obs.filter((o) => o.family !== h.family);
    const aggregate = h.identity.kind === 'catalogo' || h.identity.kind === 'personalizado';
    if (aggregate) {
      h.members = [...new Set(obs.flatMap((o) => o.primaryKeys))];
      h.templateIds = h.members.filter((k) => k.startsWith('i:')).map((k) => k.slice(2));
    } else {
      h.aggregates = [...(aggregatesOf.get(key) ?? [])].sort();
      h.routineId = last.routineId || null;
      h.workoutLabel = last.workoutLabel || null;
      h.workoutName = last.workoutName || null;
      if (h.identity.kind === 'instancia') h.templateIds = [h.identity.id];
    }
    const { records, events } = computeRecords(h.family, h.observations);
    h.records = records;
    h.recordEvents = events;
  }
  const firstDate = counted.length ? observationDate(counted[0]) : null;
  return {
    identities,
    sessions: counted.map((s) => ({ id: s.id, ts: s.startedAt, date: observationDate(s) })),
    firstDate,
    ignoredSessions: sessions.length - counted.length,
  };
}

const observationDate = (s: WorkoutSession) => localDate(s.startedAt);

export const isAggregate = (h: Pick<IdentityHistory, 'identity'>) => h.identity.kind === 'catalogo' || h.identity.kind === 'personalizado';

export type TrackedStatus = 'evolucao' | 'estavel' | 'variacao' | 'sem_comparacao' | 'acompanhando';

export interface TrackedRow {
  key: string;
  history: IdentityHistory;
  sessionsInPeriod: number;
  lastDate: string;
  status: TrackedStatus;
}

export interface PeriodRecordEvent extends RecordEvent {
  identityKey: string;
  name: string;
  family: IdentityHistory['family'];
}

export interface PerformanceOverview {
  range: DateRange;
  /** Sessões concluídas no período. */
  sessions: number;
  /** Identidades seguras (instância/histórico) com registro válido no período. */
  exercisesWithRecords: number;
  /** Novos recordes (sem empates, sem primeira marca) no período, mais recentes primeiro. */
  records: PeriodRecordEvent[];
  withEvolution: number;
  withoutComparison: number;
  stable: number;
  /** Instâncias e históricos com registros no período. */
  tracked: TrackedRow[];
  /** Visões agregadas por origem com registros no período. */
  aggregates: TrackedRow[];
  /** Comparações favoráveis e mensuráveis ("Sua evolução recente"). */
  recent: { key: string; name: string; text: string; criterion: string; sessionIds: string[]; date: string }[];
}

function rowOf(h: IdentityHistory, range: DateRange): TrackedRow | null {
  const obs = h.observations.filter((o) => inPerfRange(o.date, range));
  if (!obs.length) return null;
  const notes = observationsFor(h, range);
  let status: TrackedStatus = 'acompanhando';
  if (obs.length < 2) status = 'sem_comparacao';
  else if (notes.some((n) => n.recentProgress)) status = 'evolucao';
  else if (stabilityOf(h, range).state === 'estavel') status = 'estavel';
  else if (notes.some((n) => n.kind === 'variacao' || n.kind === 'abaixo_do_inicio')) status = 'variacao';
  return { key: h.identity.key, history: h, sessionsInPeriod: obs.length, lastDate: obs[obs.length - 1].date, status };
}

export function performanceOverview(index: PerformanceIndex, range: DateRange): PerformanceOverview {
  const tracked: TrackedRow[] = [];
  const aggregates: TrackedRow[] = [];
  const records: PeriodRecordEvent[] = [];
  const recent: PerformanceOverview['recent'] = [];
  for (const h of index.identities.values()) {
    const row = rowOf(h, range);
    if (!row) continue;
    if (isAggregate(h)) {
      aggregates.push(row);
      continue;
    }
    tracked.push(row);
    for (const e of h.recordEvents) if (inPerfRange(e.date, range)) records.push({ ...e, identityKey: h.identity.key, name: h.name, family: h.family });
    for (const n of observationsFor(h, range))
      if (n.recentProgress && n.kind !== 'tendencia_positiva') recent.push({ key: h.identity.key, name: h.name, text: n.text, criterion: n.criterion, sessionIds: n.sessionIds, date: row.lastDate });
  }
  const byRecent = (a: TrackedRow, b: TrackedRow) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : a.history.name.localeCompare(b.history.name, 'pt-BR'));
  tracked.sort(byRecent);
  aggregates.sort(byRecent);
  records.sort((a, b) => b.ts - a.ts || a.name.localeCompare(b.name, 'pt-BR'));
  recent.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name, 'pt-BR')));
  return {
    range,
    sessions: index.sessions.filter((s) => inPerfRange(s.date, range)).length,
    exercisesWithRecords: tracked.length,
    records,
    withEvolution: tracked.filter((r) => r.status === 'evolucao').length,
    withoutComparison: tracked.filter((r) => r.status === 'sem_comparacao').length,
    stable: tracked.filter((r) => r.status === 'estavel').length,
    tracked,
    aggregates,
    recent,
  };
}

/** Identidade da cópia de uma sessão (para abrir o desempenho a partir do histórico). */
export function primaryKeyOf(session: WorkoutSession, ex: SessionExercise): string {
  return resolveIdentity(session, ex).primary.key;
}
