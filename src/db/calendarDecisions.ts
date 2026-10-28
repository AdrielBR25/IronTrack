// Persistência das decisões lembradas do calendário (IronTrack 2.0 F01/P16, docs/DECISOES_CALENDARIO.md §8).
// Tabela `calendarDecisions` (Dexie v5): um registro por decisão, com dono (`profileId`), identidade determinística
// (`<perfil>~<conflito>`), revisão e validação Zod na leitura e na gravação. Entra no backup (v6) e é apagada por
// "apagar tudo" e por "substituir" na restauração, como as demais coleções.
//
// Gravações: SEMPRE numa transação de escrita (serializada pelo navegador entre abas) que relê as fontes do calendário
// (planejamento, sessões, rotinas, rotação, agenda anterior) e as decisões atuais e chama a regra pura recebida
// (`fn`), que recalcula o dia e decide o que gravar. A regra vem do calendário (src/features/calendar/decisionActions.ts):
// esta camada não conhece o cálculo do calendário, só garante leitura consistente, validação, limites e atomicidade.
// Nunca grava em planejamento, sessões, rotinas, rotação, agenda anterior ou configurações.
import { db, mergeSettings } from './db';
import { DECISION_LIMITS, CalendarDecisionError, calendarDecisionIssues, isValidCalendarDecision, type CalendarDecision } from '@/modules/planner';
import type { DayOverride, PlanEntry, Routine, RotationState, WorkoutSession } from '@/lib/types';

/** Fontes do calendário lidas dentro da transação (mesmas regras do hook `useCalendarInput`). */
export interface DecisionSources {
  profileId: string;
  entries: PlanEntry[];
  sessions: WorkoutSession[];
  routines: Routine[];
  rotations: RotationState[];
  /** Agenda anterior da rotina ativa (null sem rotina ativa com treinos). */
  legacy: { routineId: string; trainingDays: number[]; overrides: DayOverride[] } | null;
}

export interface StoredDecisions {
  /** Decisões válidas do perfil local. */
  decisions: CalendarDecision[];
  /** Registros do perfil que não passam na validação (ignorados; podem ser removidos em "Decisões lembradas"). */
  invalidIds: string[];
}

const sourceTables = () => [db.planEntries, db.sessions, db.routines, db.rotations, db.settings, db.overrides, db.calendarDecisions];

/** Decisões do perfil local, validadas (registros corrompidos não valem e são informados à parte). */
export async function listCalendarDecisions(): Promise<StoredDecisions> {
  const pid = db.currentProfileId;
  if (!pid) return { decisions: [], invalidIds: [] };
  const raw = (await db.calendarDecisions.where('profileId').equals(pid).toArray()) as unknown[];
  const decisions: CalendarDecision[] = [];
  const invalidIds: string[] = [];
  for (const r of raw) {
    // Um registro só vale se for válido E pertencer a este perfil pelo ID também (nada de associação por nome).
    if (isValidCalendarDecision(r) && r.profileId === pid) decisions.push(r);
    else invalidIds.push(String((r as { id?: unknown })?.id ?? ''));
  }
  return { decisions, invalidIds };
}

export async function readDecisionSources(pid: string): Promise<DecisionSources> {
  const settings = mergeSettings(await db.settings.get('settings'));
  const [entries, sessions, routines, rotations] = await Promise.all([
    db.planEntries.where('profileId').equals(pid).toArray(),
    db.sessions.where('status').anyOf('completed', 'active').toArray(),
    db.routines.toArray(),
    db.rotations.toArray(),
  ]);
  const active = (settings.activeRoutineId && routines.find((r) => r.id === settings.activeRoutineId)) || (await db.routines.toCollection().first()) || null;
  const legacy = active && active.workouts.length ? { routineId: active.id, trainingDays: settings.trainingDays, overrides: await db.overrides.where('routineId').equals(active.id).toArray() } : null;
  return { profileId: pid, entries, sessions, routines, rotations, legacy };
}

export interface DecisionMutation {
  put: CalendarDecision[];
  delete: string[];
}

/**
 * Executa uma alteração de decisões numa única transação: lê fontes e decisões atuais, chama `fn` (pura, síncrona) e
 * aplica o resultado — tudo ou nada. Valida cada decisão gravada (formato, dono = perfil local) e o limite por perfil.
 */
export async function mutateCalendarDecisions(fn: (ctx: { sources: DecisionSources; stored: StoredDecisions }) => DecisionMutation): Promise<DecisionMutation> {
  return db.transaction('rw', sourceTables(), async () => {
    const pid = db.currentProfileId;
    if (!pid) throw new CalendarDecisionError('no_profile');
    const [sources, stored] = await Promise.all([readDecisionSources(pid), listCalendarDecisions()]);
    const m = fn({ sources, stored });
    for (const d of m.put) {
      const issues = calendarDecisionIssues(d);
      if (issues.length) throw new CalendarDecisionError('invalid', issues);
      if (d.profileId !== pid) throw new CalendarDecisionError('invalid', ['A decisão pertence a outro perfil.']);
    }
    const ids = new Set(stored.decisions.map((d) => d.id));
    for (const id of m.delete) ids.delete(id);
    for (const d of m.put) ids.add(d.id);
    if (ids.size > DECISION_LIMITS.maxPerProfile && m.put.some((d) => !stored.decisions.some((x) => x.id === d.id))) throw new CalendarDecisionError('limit');
    if (m.delete.length) await db.calendarDecisions.bulkDelete(m.delete);
    if (m.put.length) await db.calendarDecisions.bulkPut(m.put);
    return m;
  });
}

/** Remove os registros ilegíveis do perfil local (reconferidos dentro da transação). Devolve quantos saíram. */
export async function removeInvalidDecisions(): Promise<number> {
  return db.transaction('rw', db.calendarDecisions, async () => {
    const pid = db.currentProfileId;
    if (!pid) throw new CalendarDecisionError('no_profile');
    const keys = await db.calendarDecisions.where('profileId').equals(pid).primaryKeys();
    const bad = [];
    for (const k of keys) {
      const r = await db.calendarDecisions.get(k);
      if (!(isValidCalendarDecision(r) && r.profileId === pid)) bad.push(k);
    }
    if (bad.length) await db.calendarDecisions.bulkDelete(bad);
    return bad.length;
  });
}
