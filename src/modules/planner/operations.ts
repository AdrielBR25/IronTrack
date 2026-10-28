// Regras de edição do planejamento (IronTrack 2.0 F01/P13, docs/PLANEJAMENTO_SEMANAL.md §2–3 e §9).
// Funções puras: recebem TODAS as entradas do perfil (lidas na mesma transação de escrita) e devolvem o conjunto de
// mudanças. A persistência (src/db/planner.ts) só aplica. Nenhuma regra aqui toca sessões, rotação ou rotinas.
//
// Política de edição:
//  - Dias passados nunca mudam: exceções só para hoje em diante; o modelo recorrente é versionado por vigência
//    (alterar ou remover uma entrada que já valia antes de hoje encerra a versão antiga ontem e cria outra a partir de
//    hoje), então semanas anteriores continuam mostrando o que estava planejado nelas.
//  - Exceção substitui o dia inteiro. "Só neste dia" copia as entradas recorrentes da data (`sourceEntryId`) e altera
//    a cópia; o modelo não muda. Um dia de exceção nunca fica vazio: sem atividades, vira "dia livre".
//  - Toda alteração confere a versão que a tela mostrava (revisão da entrada ou impressão digital do dia):
//    nada é sobrescrito em silêncio por outra aba.
import { isPlanDate, planAddDays, planWeekday } from './calendar';
import { planEntryIssues } from './validation';
import type { PlanActivityInput, PlanEntry, PlanKind, PlanSlot } from './types';

export type PlanConflictKind = 'changed' | 'deleted' | 'duplicate' | 'exists' | 'past' | 'invalid';

export class PlanConflictError extends Error {
  constructor(
    readonly kind: PlanConflictKind,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'PlanConflictError';
  }
}

const MESSAGES: Record<PlanConflictKind, string> = {
  changed: 'Este dia foi alterado em outra aba. Nada foi gravado: confira a versão atual e tente de novo.',
  deleted: 'Esta atividade foi removida (talvez em outra aba). Nada foi gravado.',
  duplicate: 'Esta atividade já está planejada neste dia. Nada foi gravado.',
  exists: 'Já existe outra entrada com este identificador. Nada foi gravado.',
  past: 'Dias passados não são alterados pelo planejamento. Nada foi gravado.',
  invalid: 'O planejamento tem dados inválidos e não foi gravado.',
};

const conflict = (kind: PlanConflictKind, details: string[] = []) => new PlanConflictError(kind, MESSAGES[kind], details);

export interface PlanContext {
  /** Dia local de hoje (yyyy-mm-dd). */
  today: string;
  now: number;
  /** Gerador de IDs para as entradas criadas pela regra (cópias de exceção e novas versões do modelo). */
  newId: () => string;
}

export interface PlanChanges {
  put: PlanEntry[];
  delete: string[];
  /** Entrada resultante da operação, quando houver. */
  result: PlanEntry | null;
}

// ---------------------------------------------------------------------------------------------
// Leitura: o que vale em cada data e em cada lugar da agenda

const byOrder = (a: PlanEntry, b: PlanEntry) =>
  (a.kind === 'workout' ? 0 : 1) - (b.kind === 'workout' ? 0 : 1) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** Entrada recorrente vigente na data (ativa ou pausada). */
const weeklyValidOn = (e: PlanEntry, date: string) =>
  e.scope === 'weekly' && e.weekday === planWeekday(date) && !!e.validFrom && e.validFrom <= date && (e.validUntil === null || e.validUntil >= date);

export interface DatePlan {
  /** `exception`: a data tem exceções (substituem o modelo) · `recurring`: modelo semanal · `none`: nada planejado. */
  source: 'exception' | 'recurring' | 'none';
  /** Entradas que valem na data (pausadas ficam de fora), na ordem de exibição. */
  entries: PlanEntry[];
}

export function planForDate(all: readonly PlanEntry[], date: string): DatePlan {
  const exceptions = all.filter((e) => e.scope === 'date' && e.date === date).sort(byOrder);
  if (exceptions.length) return { source: 'exception', entries: exceptions };
  const weekly = all.filter((e) => e.enabled && weeklyValidOn(e, date)).sort(byOrder);
  return { source: weekly.length ? 'recurring' : 'none', entries: weekly };
}

/** Entradas recorrentes ainda vigentes (de hoje em diante) num dia da semana, inclusive pausadas. */
export function currentWeekly(all: readonly PlanEntry[], weekday: number, today: string): PlanEntry[] {
  return all.filter((e) => e.scope === 'weekly' && e.weekday === weekday && (e.validUntil === null || e.validUntil >= today)).sort(byOrder);
}

/** Entradas que uma alteração no lugar levaria em conta (as que a tela mostra para editar). */
export function slotEntries(all: readonly PlanEntry[], slot: PlanSlot, today: string): PlanEntry[] {
  if (slot.scope === 'weekly') return currentWeekly(all, slot.weekday, today);
  const ex = all.filter((e) => e.scope === 'date' && e.date === slot.date);
  // Para uma data sem exceção, a versão relevante é a do modelo que vale nela (inclusive pausadas: mudam a cópia).
  return (ex.length ? ex : all.filter((e) => weeklyValidOn(e, slot.date))).sort(byOrder);
}

/** Impressão digital do lugar: muda a cada criação, alteração ou remoção que afete o que a tela mostra. */
export function slotFingerprint(all: readonly PlanEntry[], slot: PlanSlot, today: string): string {
  return slotEntries(all, slot, today)
    .map((e) => `${e.id}:${e.revision}`)
    .sort()
    .join('|');
}

/** Duas entradas de treino representam a mesma atividade (mesma rotina e mesmo treino, ou ambas "próximo da rotação"). */
export const sameActivity = (a: Pick<PlanEntry, 'routineId' | 'workoutId'>, b: Pick<PlanEntry, 'routineId' | 'workoutId'>) =>
  a.routineId === b.routineId && (a.workoutId ?? null) === (b.workoutId ?? null);

// ---------------------------------------------------------------------------------------------
// Construção e conferência

function build(id: string, slot: PlanSlot, kind: PlanKind, activity: PlanActivityInput | null, ctx: PlanContext, extra: Partial<PlanEntry> = {}): PlanEntry {
  const entry: PlanEntry = {
    id,
    scope: slot.scope,
    weekday: slot.scope === 'weekly' ? slot.weekday : null,
    date: slot.scope === 'date' ? slot.date : null,
    kind,
    routineId: kind === 'workout' ? (activity?.routineId ?? null) : null,
    workoutId: kind === 'workout' ? (activity?.workoutId ?? null) : null,
    enabled: true,
    validFrom: slot.scope === 'weekly' ? ctx.today : null,
    validUntil: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    revision: 1,
    ...extra,
  };
  return entry;
}

function assertValid(entries: PlanEntry[]) {
  for (const e of entries) {
    const issues = planEntryIssues(e);
    if (issues.length) throw conflict('invalid', issues.map((i) => i.message));
  }
}

function assertSlotEditable(slot: PlanSlot, ctx: PlanContext) {
  if (slot.scope === 'date') {
    if (!isPlanDate(slot.date)) throw conflict('invalid', ['Data inválida.']);
    if (slot.date < ctx.today) throw conflict('past');
  } else if (!Number.isInteger(slot.weekday) || slot.weekday < 0 || slot.weekday > 6) throw conflict('invalid', ['Dia da semana inválido.']);
}

function assertFresh(all: readonly PlanEntry[], slot: PlanSlot, expected: string | undefined, ctx: PlanContext) {
  if (expected !== undefined && slotFingerprint(all, slot, ctx.today) !== expected) throw conflict('changed');
}

/** Mutável durante a construção de um conjunto de mudanças (aplica em memória para as regras seguintes). */
class Draft {
  private map: Map<string, PlanEntry>;
  readonly put = new Map<string, PlanEntry>();
  readonly del = new Set<string>();
  constructor(all: readonly PlanEntry[]) {
    this.map = new Map(all.map((e) => [e.id, e]));
  }
  get list() {
    return [...this.map.values()];
  }
  get(id: string) {
    return this.map.get(id);
  }
  set(e: PlanEntry) {
    this.map.set(e.id, e);
    this.put.set(e.id, e);
    this.del.delete(e.id);
  }
  remove(id: string) {
    this.map.delete(id);
    this.put.delete(id);
    this.del.add(id);
  }
  changes(result: PlanEntry | null): PlanChanges {
    const put = [...this.put.values()];
    assertValid(put);
    return { put, delete: [...this.del], result };
  }
}

const bump = (e: PlanEntry, patch: Partial<PlanEntry>, ctx: PlanContext): PlanEntry => ({
  ...e,
  ...patch,
  updatedAt: Math.max(ctx.now, e.updatedAt + 1),
  revision: e.revision + 1,
});

/** Tira uma entrada recorrente da agenda de hoje em diante sem mudar o passado. */
function retireWeekly(d: Draft, e: PlanEntry, ctx: PlanContext) {
  if (!e.validFrom || e.validFrom >= ctx.today) d.remove(e.id);
  else if (e.validUntil === null || e.validUntil >= ctx.today) d.set(bump(e, { validUntil: planAddDays(ctx.today, -1) }, ctx));
}

/** Nova versão de uma entrada recorrente a partir de hoje (ou alteração no lugar, se ela nunca valeu no passado). */
function reviseWeekly(d: Draft, e: PlanEntry, patch: Partial<Pick<PlanEntry, 'weekday' | 'routineId' | 'workoutId' | 'enabled'>>, ctx: PlanContext): PlanEntry {
  if (!e.validFrom || e.validFrom >= ctx.today) {
    const next = bump(e, patch, ctx);
    d.set(next);
    return next;
  }
  retireWeekly(d, e, ctx);
  const next: PlanEntry = { ...e, ...patch, id: ctx.newId(), validFrom: ctx.today, validUntil: null, createdAt: ctx.now, updatedAt: ctx.now, revision: 1 };
  d.set(next);
  return next;
}

/**
 * Garante que a data tem exceções próprias (copiando o modelo que vale nela) e devolve as entradas da data.
 * Pausadas não são copiadas (não valiam no dia). A cópia mantém o `createdAt` da origem (mesma ordem de exibição).
 * Sem nada para copiar, o dia fica sem entradas até a regra seguinte.
 */
function materialize(d: Draft, date: string, ctx: PlanContext): PlanEntry[] {
  const existing = d.list.filter((e) => e.scope === 'date' && e.date === date);
  if (existing.length) return existing;
  const copies = planForDate(d.list, date).entries.map((w) =>
    build(ctx.newId(), { scope: 'date', date }, w.kind, w.kind === 'workout' ? { routineId: w.routineId!, workoutId: w.workoutId } : null, ctx, { sourceEntryId: w.id, createdAt: w.createdAt }),
  );
  copies.forEach((c) => d.set(c));
  return copies;
}

/** Entradas que hoje valem no lugar (para conferir duplicidade e marcadores). */
function liveInSlot(d: Draft, slot: PlanSlot, ctx: PlanContext): PlanEntry[] {
  return slot.scope === 'weekly' ? currentWeekly(d.list, slot.weekday, ctx.today) : d.list.filter((e) => e.scope === 'date' && e.date === slot.date);
}

/** Um dia de exceção nunca fica vazio (voltaria ao modelo sem a pessoa pedir): vira "dia livre". */
function keepExceptionDay(d: Draft, date: string, ctx: PlanContext) {
  if (!d.list.some((e) => e.scope === 'date' && e.date === date)) d.set(build(ctx.newId(), { scope: 'date', date }, 'free', null, ctx));
}

/** Coloca uma atividade no lugar: remove descanso/dia livre dali e recusa a mesma atividade repetida. */
function placeActivity(d: Draft, slot: PlanSlot, entry: PlanEntry, ctx: PlanContext) {
  const live = liveInSlot(d, slot, ctx).filter((e) => e.id !== entry.id);
  if (live.some((e) => e.kind === 'workout' && e.enabled && entry.enabled && sameActivity(e, entry))) throw conflict('duplicate');
  for (const m of live.filter((e) => e.kind !== 'workout')) {
    if (m.scope === 'weekly') retireWeekly(d, m, ctx);
    else d.remove(m.id);
  }
}

// ---------------------------------------------------------------------------------------------
// Operações

export interface AddActivityInput {
  /** ID gerado pela tela uma vez por formulário (repetir o envio não duplica). */
  id: string;
  slot: PlanSlot;
  activity: PlanActivityInput;
  /** Impressão digital do lugar que a tela mostrava. */
  expected?: string;
}

export function addActivity(all: readonly PlanEntry[], input: AddActivityInput, ctx: PlanContext): PlanChanges {
  const existing = all.find((e) => e.id === input.id);
  if (existing) {
    const same =
      existing.kind === 'workout' &&
      existing.scope === input.slot.scope &&
      (input.slot.scope === 'weekly' ? existing.weekday === input.slot.weekday : existing.date === input.slot.date) &&
      sameActivity(existing, input.activity);
    if (same) return { put: [], delete: [], result: existing };
    throw conflict('exists');
  }
  assertSlotEditable(input.slot, ctx);
  assertFresh(all, input.slot, input.expected, ctx);
  const d = new Draft(all);
  if (input.slot.scope === 'date') materialize(d, input.slot.date, ctx);
  const entry = build(input.id, input.slot, 'workout', input.activity, ctx);
  placeActivity(d, input.slot, entry, ctx);
  d.set(entry);
  return d.changes(entry);
}

export interface SetMarkerInput {
  id: string;
  slot: PlanSlot;
  kind: Exclude<PlanKind, 'workout'>;
  expected?: string;
}

/** Define descanso ou dia livre: as atividades do lugar saem (a tela confirma antes) e fica só o marcador. */
export function setMarker(all: readonly PlanEntry[], input: SetMarkerInput, ctx: PlanContext): PlanChanges {
  assertSlotEditable(input.slot, ctx);
  const d = new Draft(all);
  const live = liveInSlot(d, input.slot, ctx);
  if (live.length === 1 && live[0].kind === input.kind && live[0].enabled) return { put: [], delete: [], result: live[0] };
  if (all.some((e) => e.id === input.id)) throw conflict('exists');
  assertFresh(all, input.slot, input.expected, ctx);
  for (const e of live) {
    if (e.scope === 'weekly') retireWeekly(d, e, ctx);
    else d.remove(e.id);
  }
  const marker = build(input.id, input.slot, input.kind, null, ctx);
  d.set(marker);
  return d.changes(marker);
}

export interface UpdateActivityInput {
  id: string;
  /** Revisão que a tela mostrava (alterações no modelo ou numa exceção existente). */
  expectedRevision: number;
  /** Alterar só nesta data (cria a exceção a partir do modelo, se preciso). */
  onDate?: string;
  /** Impressão digital da data (com `onDate`). */
  expected?: string;
  activity?: PlanActivityInput;
  enabled?: boolean;
  /** Mudar de dia: outro dia da semana (modelo) ou outra data (exceção). */
  moveTo?: PlanSlot;
}

function resolveTarget(d: Draft, all: readonly PlanEntry[], input: { id: string; expectedRevision: number; onDate?: string; expected?: string }, ctx: PlanContext): PlanEntry {
  if (input.onDate !== undefined) {
    const slot: PlanSlot = { scope: 'date', date: input.onDate };
    assertSlotEditable(slot, ctx);
    assertFresh(all, slot, input.expected, ctx);
    const items = materialize(d, input.onDate, ctx);
    const hit = items.find((e) => e.id === input.id || e.sourceEntryId === input.id);
    if (!hit) throw conflict('deleted');
    return hit;
  }
  const cur = d.get(input.id);
  if (!cur || (cur.scope === 'weekly' && cur.validUntil !== null && cur.validUntil < ctx.today)) throw conflict('deleted');
  if (cur.revision !== input.expectedRevision) throw conflict('changed');
  if (cur.scope === 'date') assertSlotEditable({ scope: 'date', date: cur.date! }, ctx);
  return cur;
}

export function updateActivity(all: readonly PlanEntry[], input: UpdateActivityInput, ctx: PlanContext): PlanChanges {
  const d = new Draft(all);
  const cur = resolveTarget(d, all, input, ctx);
  if (cur.kind !== 'workout') throw conflict('invalid', ['Descanso e dia livre não têm treino para alterar.']);
  const activity = input.activity ?? { routineId: cur.routineId!, workoutId: cur.workoutId };
  const enabled = cur.scope === 'weekly' ? (input.enabled ?? cur.enabled) : true;
  const move = input.moveTo;
  if (move) assertSlotEditable(move, ctx);

  if (cur.scope === 'weekly') {
    if (move && move.scope === 'date') throw conflict('invalid', ['Para mudar só uma data, altere a atividade naquele dia.']);
    const weekday = move?.scope === 'weekly' ? move.weekday : cur.weekday!;
    const unchanged = weekday === cur.weekday && enabled === cur.enabled && sameActivity(cur, activity);
    if (unchanged) return { put: [], delete: [], result: cur };
    const probe = { ...cur, weekday, enabled, routineId: activity.routineId, workoutId: activity.workoutId };
    placeActivity(d, { scope: 'weekly', weekday }, probe, ctx);
    const next = reviseWeekly(d, cur, { weekday, enabled, routineId: activity.routineId, workoutId: activity.workoutId }, ctx);
    return d.changes(next);
  }

  // Exceção de data.
  if (move && move.scope === 'weekly') throw conflict('invalid', ['Uma exceção de data não vira recorrente; crie a atividade no modelo semanal.']);
  const date = move?.scope === 'date' ? move.date : cur.date!;
  if (date === cur.date && sameActivity(cur, activity)) return { put: [], delete: [], result: cur };
  if (date !== cur.date) {
    d.remove(cur.id);
    keepExceptionDay(d, cur.date!, ctx);
    materialize(d, date, ctx);
    const moved = build(cur.id, { scope: 'date', date }, 'workout', activity, ctx, { createdAt: cur.createdAt, revision: cur.revision + 1, updatedAt: Math.max(ctx.now, cur.updatedAt + 1) });
    placeActivity(d, { scope: 'date', date }, moved, ctx);
    d.set(moved);
    return d.changes(moved);
  }
  const next = bump(cur, { routineId: activity.routineId, workoutId: activity.workoutId, sourceEntryId: null }, ctx);
  placeActivity(d, { scope: 'date', date }, next, ctx);
  d.set(next);
  return d.changes(next);
}

export interface RemoveEntryInput {
  id: string;
  expectedRevision: number;
  onDate?: string;
  expected?: string;
}

/**
 * Remove a atividade (ou o marcador). No modelo, remove de hoje em diante; numa data, só naquela data.
 * Remover algo que já não existe (outra aba) não é erro: devolve `result: null` sem mudanças.
 */
export function removeEntry(all: readonly PlanEntry[], input: RemoveEntryInput, ctx: PlanContext): PlanChanges {
  const d = new Draft(all);
  if (input.onDate === undefined) {
    const cur = d.get(input.id);
    if (!cur || (cur.scope === 'weekly' && cur.validUntil !== null && cur.validUntil < ctx.today)) return { put: [], delete: [], result: null };
  }
  const cur = resolveTarget(d, all, input, ctx);
  if (cur.scope === 'weekly') retireWeekly(d, cur, ctx);
  else {
    d.remove(cur.id);
    keepExceptionDay(d, cur.date!, ctx);
  }
  return d.changes(null);
}

/** "Voltar ao planejamento recorrente" numa data de hoje em diante: apaga as exceções da data. */
export function clearException(all: readonly PlanEntry[], input: { date: string; expected?: string }, ctx: PlanContext): PlanChanges {
  const slot: PlanSlot = { scope: 'date', date: input.date };
  assertSlotEditable(slot, ctx);
  const ex = all.filter((e) => e.scope === 'date' && e.date === input.date);
  if (!ex.length) return { put: [], delete: [], result: null };
  assertFresh(all, slot, input.expected, ctx);
  return { put: [], delete: ex.map((e) => e.id), result: null };
}
