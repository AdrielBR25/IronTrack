// Importação assistida da agenda anterior para o planejamento (IronTrack 2.0 F01/P15, docs/CONSOLIDACAO_AGENDAS.md).
// Motor PURO e determinístico, o mesmo para os três modos (só adicionar onde está vazio, revisar conflitos, só
// visualizar): recebe o planejamento do perfil, a agenda anterior da rotina ativa e as decisões da pessoa e devolve a
// prévia (o que acontece com cada dia) e o conjunto de mudanças. Nada aqui grava; a persistência
// (src/db/legacyImport.ts) só aplica, dentro de uma transação, depois de recalcular a prévia com os dados atuais.
//
// Significado real da agenda anterior (auditoria, §1 do documento):
//  - `Settings.trainingDays` diz em QUAIS dias da semana se treina; o treino de cada dia é o próximo da rotação da
//    rotina ativa (`projectSchedule`). Não existe "segunda = Treino A". A conversão segura é uma entrada semanal
//    "próximo da rotação" (`workoutId: null`) dessa rotina: o treino continua sendo previsão, nunca compromisso fixo.
//  - Dia fora de `trainingDays` não é um descanso escolhido: não vira descanso (fica sem registro).
//  - `overrides` são escolhas para UMA data (reagendar um treino ou marcar descanso): viram exceções daquela data,
//    nunca recorrência. Datas passadas não mudam (o planejamento não altera o passado).
//  - Só a rotina ativa tem agenda anterior (é a única que a Início e a Treinos projetam).
// Regras de segurança: nada substitui o planejamento existente sem decisão explícita; reimportar não duplica (o que já
// está igual é preservado); nenhum treino é inferido por nome; a rotação, as sessões e as fichas não são lidas para
// gravar nem alteradas.
import type { DayOverride, Routine } from '@/modules/training';
import { isPlanDate, planWeekday, WEEKDAY_ORDER } from './calendar';
import { Draft, assertSlotEditable, build, currentWeekly, planForDate, retireWeekly, sameActivity, slotFingerprint, type PlanContext } from './operations';
import type { PlanEntry, PlanSlot } from './types';

export type ImportRoutine = Pick<Routine, 'id' | 'name' | 'workouts' | 'profileId'>;

export interface LegacyImportSource {
  /** Rotina ativa (a única com agenda anterior). null: sem rotina ativa com treinos. */
  routine: ImportRoutine | null;
  trainingDays: readonly number[];
  /** Reagendamentos de TODAS as rotinas (os de outras rotinas são só contados como ignorados). */
  overrides: readonly DayOverride[];
}

export interface LegacyImportInput {
  today: string;
  /** Todas as entradas do planejamento do perfil (todas as vigências). */
  entries: readonly PlanEntry[];
  source: LegacyImportSource;
  /** Rotinas do perfil (para descrever o planejamento existente). */
  routines: readonly ImportRoutine[];
}

/**
 * `empty_only` (modo A, padrão): adiciona só onde não há planejamento; conflitos ficam como estão.
 * `review` (modo B): cada conflito recebe uma decisão explícita (padrão: manter o planejamento atual).
 * `view` (modo C): só visualizar; a mesma prévia, sem gravar.
 */
export type ImportMode = 'empty_only' | 'review' | 'view';

/** Decisão para um conflito (modo B): manter o planejamento atual, usar a agenda anterior ou não importar o dia. */
export type ConflictDecision = 'keep' | 'legacy' | 'skip';

/** Classificação do item ANTES das decisões. */
export type ImportAction = 'create' | 'preserve' | 'ignore' | 'conflict' | 'manual';

/** O que vai acontecer com o item (depois das decisões). */
export type ImportOutcome = 'create' | 'replace' | 'keep' | 'skip' | 'preserve' | 'ignore' | 'manual';

export interface ImportProposal {
  kind: 'workout' | 'rest';
  routineId: string | null;
  workoutId: string | null;
}

export interface ImportItem {
  /** Chave estável (`weekday:1`, `date:2026-11-03`, `past`, `other-routines`). */
  key: string;
  /** `weekday`: dia de treino das Configurações · `date`: reagendamento · `summary`: linhas agregadas. */
  kind: 'weekday' | 'date' | 'summary';
  weekday: number | null;
  date: string | null;
  /** O que a agenda anterior diz. */
  legacyText: string;
  legacyKind: 'rotation_day' | 'off_day' | 'override_workout' | 'override_rest' | 'override_invalid' | 'aggregate';
  /** O que o planejamento diz hoje (para o lugar equivalente). */
  currentText: string;
  action: ImportAction;
  outcome: ImportOutcome;
  /** Resultado proposto, em texto ("Adicionar Treino C só em 03/11", "Manter Treino C e solicitar decisão"…). */
  proposal: string;
  /** Por que (limitação, equivalência, segurança). */
  reason: string;
  proposed: ImportProposal | null;
  /** Decisão aplicada (só conflitos). */
  decision: ConflictDecision | null;
  /** Agregados: quantos registros a linha representa. */
  count?: number;
}

export interface ImportCounts {
  create: number;
  replace: number;
  keep: number;
  skip: number;
  preserve: number;
  ignore: number;
  manual: number;
  conflicts: number;
}

export interface ImportOverview {
  routineId: string | null;
  routineName: string | null;
  /** Dias da semana de treino encontrados (0 = domingo). */
  trainingDays: number[];
  /** Treinos da rotina ativa (a rotação), na ordem. */
  workouts: { id: string; label: string; name: string }[];
  /** Reagendamentos de hoje em diante (treino) e descansos explícitos de hoje em diante. */
  futureWorkoutOverrides: number;
  futureRestOverrides: number;
  pastOverrides: number;
  otherRoutineOverrides: number;
  /** Dias da semana com planejamento semanal vigente e datas futuras com exceção. */
  plannedWeekdays: number;
  plannedExceptionDates: number;
}

/** Uma mudança registrada para o desfazer: criada, alterada (antes → depois) ou apagada (antes). */
export interface ImportChangeLog {
  created: PlanEntry[];
  updated: { before: PlanEntry; after: PlanEntry }[];
  deleted: PlanEntry[];
}

export interface ImportPreview {
  today: string;
  mode: ImportMode;
  overview: ImportOverview;
  items: ImportItem[];
  counts: ImportCounts;
  /** Impressão digital de tudo que a prévia leu (planejamento, agenda anterior, rotina). Muda → prévia desatualizada. */
  fingerprint: string;
  /** Mudanças no planejamento (vazias no modo "só visualizar"). */
  put: PlanEntry[];
  delete: string[];
  log: ImportChangeLog;
  /** Lugares afetados e a impressão digital deles DEPOIS de aplicar (o desfazer confere que ninguém mexeu). */
  slotsAfter: Record<string, string>;
}

export interface LegacyImportOptions {
  mode: ImportMode;
  /** Decisões do modo B, por chave do item. Ausente = manter o planejamento atual. */
  decisions?: Readonly<Record<string, ConflictDecision>>;
}

// ------------------------------------------------------------------------------------------------ textos

const WEEKDAY_LONG = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const importWeekdayName = (w: number) => WEEKDAY_LONG[w] ?? '';
const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function workoutText(routines: readonly ImportRoutine[], routineId: string | null, workoutId: string | null): string {
  const r = routines.find((x) => x.id === routineId);
  if (!r) return 'treino de uma rotina excluída';
  if (workoutId === null) return `${r.name}: próximo da rotação`;
  const w = r.workouts.find((x) => x.id === workoutId);
  return w ? `Treino ${w.label} (${w.name})` : `${r.name}: treino removido da rotina`;
}

function entriesText(list: readonly PlanEntry[], routines: readonly ImportRoutine[]): string {
  if (!list.length) return 'sem atividade';
  return list
    .map((e) => {
      const t = e.kind === 'rest' ? 'descanso' : e.kind === 'free' ? 'dia livre' : workoutText(routines, e.routineId, e.workoutId);
      return e.scope === 'weekly' && !e.enabled ? `${t} (pausada)` : t;
    })
    .join(' + ');
}

const proposalText = (p: ImportProposal, routines: readonly ImportRoutine[]) => (p.kind === 'rest' ? 'descanso' : workoutText(routines, p.routineId, p.workoutId));

// ------------------------------------------------------------------------------------------------ impressão digital

/** Hash curto e estável (FNV-1a 32 bits) de um texto. Só para comparar estados; não é segurança. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Impressão digital de tudo o que a prévia leu. Qualquer alteração em outra aba muda o valor. */
export function importFingerprint(input: LegacyImportInput): string {
  const r = input.source.routine;
  const parts = [
    input.today,
    r ? `${r.id}:${r.workouts.map((w) => w.id).join(',')}` : '-',
    [...input.source.trainingDays].sort().join(','),
    input.source.overrides
      .filter((o) => r && o.routineId === r.id)
      .map((o) => `${o.date}:${o.kind}:${o.workoutId ?? ''}`)
      .sort()
      .join('|'),
    input.entries
      .map((e) => `${e.id}:${e.revision}`)
      .sort()
      .join('|'),
    input.routines
      .map((x) => `${x.id}:${x.workouts.map((w) => w.id).join(',')}`)
      .sort()
      .join('|'),
  ];
  return shortHash(parts.join('#'));
}

// ------------------------------------------------------------------------------------------------ motor

const slotKey = (slot: PlanSlot) => (slot.scope === 'weekly' ? `weekly:${slot.weekday}` : `date:${slot.date}`);

/** Conteúdo comparável de uma lista de entradas que valem num lugar (pausadas contam: são planejamento existente). */
const contentOf = (list: readonly PlanEntry[]) =>
  list
    .map((e) => `${e.kind}|${e.routineId ?? ''}|${e.workoutId ?? ''}|${e.scope === 'weekly' && !e.enabled ? 'off' : 'on'}`)
    .sort()
    .join('#');

/**
 * Prévia da importação (e as mudanças que ela aplicaria). Determinística: as mesmas entradas e decisões produzem a
 * mesma prévia (só os IDs das entradas novas vêm de `ctx.newId`). No modo `view`, nada é proposto para gravar.
 */
export function previewLegacyImport(input: LegacyImportInput, opts: LegacyImportOptions, ctx: PlanContext): ImportPreview {
  const { today, routines } = input;
  if (!isPlanDate(today)) throw new Error(`Data inválida: ${today}`);
  const routine = input.source.routine && input.source.routine.workouts.length ? input.source.routine : null;
  const decisions = opts.mode === 'review' ? (opts.decisions ?? {}) : {};
  const items: ImportItem[] = [];
  const original = new Map(input.entries.map((e) => [e.id, e]));
  const d = new Draft(input.entries);
  const created = new Set<string>();
  const touched = new Set<string>();
  const trainingDays = [...new Set(input.source.trainingDays.filter((w) => Number.isInteger(w) && w >= 0 && w <= 6))];

  const routineOverrides = routine ? input.source.overrides.filter((o) => o.routineId === routine.id && isPlanDate(o.date)) : [];
  const future = routineOverrides.filter((o) => o.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const overview: ImportOverview = {
    routineId: routine?.id ?? null,
    routineName: routine?.name ?? null,
    trainingDays: WEEKDAY_ORDER.filter((w) => trainingDays.includes(w)),
    workouts: routine ? routine.workouts.map((w) => ({ id: w.id, label: w.label, name: w.name })) : [],
    futureWorkoutOverrides: future.filter((o) => o.kind === 'workout').length,
    futureRestOverrides: future.filter((o) => o.kind === 'rest').length,
    pastOverrides: routineOverrides.length - future.length,
    otherRoutineOverrides: routine ? input.source.overrides.filter((o) => o.routineId !== routine.id).length : input.source.overrides.length,
    plannedWeekdays: WEEKDAY_ORDER.filter((w) => currentWeekly(input.entries, w, today).length > 0).length,
    plannedExceptionDates: new Set(input.entries.filter((e) => e.scope === 'date' && e.date && e.date >= today).map((e) => e.date)).size,
  };

  const conflictOutcome = (key: string): { outcome: ImportOutcome; decision: ConflictDecision } => {
    const dec = decisions[key] ?? 'keep';
    return { outcome: dec === 'legacy' ? 'replace' : dec, decision: dec };
  };
  const write = opts.mode !== 'view';

  if (routine) {
    // 1. Dias de treino das Configurações → "toda <dia>: próximo da rotação" (a mesma intenção, sem fixar treino).
    const rotationActivity = { routineId: routine.id, workoutId: null };
    for (const w of WEEKDAY_ORDER) {
      const key = `weekday:${w}`;
      const slot: PlanSlot = { scope: 'weekly', weekday: w };
      const live = currentWeekly(input.entries, w, today);
      const currentText = live.length ? `Toda ${importWeekdayName(w)}: ${entriesText(live, routines)}` : 'Sem atividade';
      const legacyText = trainingDays.includes(w) ? `Dia de treino · segue a rotação de ${routine.name}` : 'Não é dia de treino';
      const base = { key, kind: 'weekday' as const, weekday: w, date: null, legacyText, currentText };
      if (!trainingDays.includes(w)) {
        items.push({
          ...base,
          legacyKind: 'off_day',
          action: live.length ? 'preserve' : 'ignore',
          outcome: live.length ? 'preserve' : 'ignore',
          proposal: live.length ? 'Manter o planejamento atual' : 'Nenhuma alteração',
          reason: live.length
            ? 'A agenda anterior não indica treino neste dia; o planejamento atual continua.'
            : 'Dia sem treino na agenda anterior. Ele não vira descanso automaticamente: planeje um descanso se quiser.',
          proposed: null,
          decision: null,
        });
        continue;
      }
      const proposed: ImportProposal = { kind: 'workout', ...rotationActivity };
      const proposalLabel = `Toda ${importWeekdayName(w)}: ${routine.name}, próximo da rotação`;
      const covered = live.some((e) => e.kind === 'workout' && e.enabled && sameActivity(e, rotationActivity));
      if (!live.length) {
        if (write) {
          const id = ctx.newId();
          d.set(build(id, slot, 'workout', rotationActivity, ctx));
          created.add(id);
          touched.add(slotKey(slot));
        }
        items.push({
          ...base,
          legacyKind: 'rotation_day',
          action: 'create',
          outcome: 'create',
          proposal: `Adicionar: ${proposalLabel}`,
          reason: 'O treino do dia continua sendo o próximo da rotação (previsão), como na agenda anterior. Nenhum treino fixo é criado.',
          proposed,
          decision: null,
        });
      } else if (covered) {
        items.push({
          ...base,
          legacyKind: 'rotation_day',
          action: 'preserve',
          outcome: 'preserve',
          proposal: 'Nenhuma alteração',
          reason: 'O planejamento já tem este dia de treino pela rotação desta rotina.',
          proposed,
          decision: null,
        });
      } else {
        const { outcome, decision } = conflictOutcome(key);
        if (write && outcome === 'replace') {
          for (const e of live) retireWeekly(d, e, ctx);
          const id = ctx.newId();
          d.set(build(id, slot, 'workout', rotationActivity, ctx));
          created.add(id);
          touched.add(slotKey(slot));
        }
        items.push({
          ...base,
          legacyKind: 'rotation_day',
          action: 'conflict',
          outcome,
          proposal:
            outcome === 'replace'
              ? `Usar a agenda anterior: ${proposalLabel} (o planejamento atual deste dia sai de hoje em diante)`
              : outcome === 'skip'
                ? 'Não importar este dia'
                : `Manter ${entriesText(live, routines)} e solicitar decisão`,
          reason: 'O planejamento já tem outra coisa neste dia. Nada é substituído sem a sua decisão.',
          proposed,
          decision,
        });
      }
    }

    // 2. Reagendamentos (de hoje em diante) → exceções daquela data. Comparados com o planejamento que já existia
    // (as entradas criadas por esta importação não contam como "planejamento existente").
    for (const o of future) {
      const key = `date:${o.date}`;
      const slot: PlanSlot = { scope: 'date', date: o.date };
      const valid = o.kind === 'rest' || (o.kind === 'workout' && !!o.workoutId && routine.workouts.some((w) => w.id === o.workoutId));
      const existing = planForDate(
        d.list.filter((e) => !created.has(e.id)),
        o.date,
      );
      const legacyText =
        o.kind === 'rest' ? `Descanso reagendado em ${fmtDate(o.date)}` : valid ? `${workoutText(routines, routine.id, o.workoutId ?? null)} reagendado em ${fmtDate(o.date)}` : `Reagendamento em ${fmtDate(o.date)} para um treino que não existe mais`;
      const currentText = existing.source === 'none' ? 'Sem atividade' : `${existing.source === 'exception' ? 'Só neste dia' : `Toda ${importWeekdayName(planWeekday(o.date))}`}: ${entriesText(existing.entries, routines)}`;
      const base = { key, kind: 'date' as const, weekday: planWeekday(o.date), date: o.date, legacyText, currentText };
      if (!valid) {
        items.push({
          ...base,
          legacyKind: 'override_invalid',
          action: 'manual',
          outcome: 'manual',
          proposal: 'Escolha manual',
          reason: 'Não dá para converter com segurança (o treino reagendado foi removido da rotina). Ajuste este dia no planejamento, se quiser.',
          proposed: null,
          decision: null,
        });
        continue;
      }
      const proposed: ImportProposal = o.kind === 'rest' ? { kind: 'rest', routineId: null, workoutId: null } : { kind: 'workout', routineId: routine.id, workoutId: o.workoutId! };
      const proposedEntry = { kind: proposed.kind, routineId: proposed.routineId, workoutId: proposed.workoutId, scope: 'date', enabled: true } as PlanEntry;
      const label = `Só em ${fmtDate(o.date)}: ${proposalText(proposed, routines)}`;
      const add = () => {
        assertSlotEditable(slot, ctx);
        const id = ctx.newId();
        const entry = build(id, slot, proposed.kind, proposed.kind === 'workout' ? { routineId: proposed.routineId!, workoutId: proposed.workoutId } : null, ctx);
        d.set(entry);
        created.add(id);
        touched.add(slotKey(slot));
      };
      if (existing.source === 'none') {
        if (write) add();
        items.push({
          ...base,
          legacyKind: o.kind === 'rest' ? 'override_rest' : 'override_workout',
          action: 'create',
          outcome: 'create',
          proposal: `Adicionar: ${label}`,
          reason: o.kind === 'rest' ? 'Descanso escolhido para esta data: vira uma exceção só deste dia.' : 'Treino escolhido para esta data: vira uma exceção só deste dia (não se repete nas outras semanas).',
          proposed,
          decision: null,
        });
        continue;
      }
      if (contentOf(existing.entries) === contentOf([proposedEntry])) {
        items.push({
          ...base,
          legacyKind: o.kind === 'rest' ? 'override_rest' : 'override_workout',
          action: 'preserve',
          outcome: 'preserve',
          proposal: 'Nenhuma alteração',
          reason: 'O planejamento já indica o mesmo para esta data.',
          proposed,
          decision: null,
        });
        continue;
      }
      const { outcome, decision } = conflictOutcome(key);
      if (write && outcome === 'replace') {
        if (existing.source === 'exception') for (const e of existing.entries) d.remove(e.id);
        add();
      }
      items.push({
        ...base,
        legacyKind: o.kind === 'rest' ? 'override_rest' : 'override_workout',
        action: 'conflict',
        outcome,
        proposal:
          outcome === 'replace'
            ? `Usar a agenda anterior: ${label}${existing.source === 'recurring' ? ' (o planejamento semanal não muda)' : ''}`
            : outcome === 'skip'
              ? 'Não importar esta data'
              : `Manter ${entriesText(existing.entries, routines)} e solicitar decisão`,
        reason: 'O planejamento já tem outra coisa nesta data. Nada é substituído sem a sua decisão.',
        proposed,
        decision,
      });
    }

    if (overview.pastOverrides > 0)
      items.push({
        key: 'past',
        kind: 'summary',
        weekday: null,
        date: null,
        legacyText: `${overview.pastOverrides} ${overview.pastOverrides === 1 ? 'reagendamento' : 'reagendamentos'} em datas passadas`,
        legacyKind: 'aggregate',
        currentText: '—',
        action: 'ignore',
        outcome: 'ignore',
        proposal: 'Nenhuma alteração',
        reason: 'Dias passados não são alterados pelo planejamento. Os registros continuam na agenda anterior.',
        proposed: null,
        decision: null,
        count: overview.pastOverrides,
      });
  }
  if (overview.otherRoutineOverrides > 0)
    items.push({
      key: 'other-routines',
      kind: 'summary',
      weekday: null,
      date: null,
      legacyText: `${overview.otherRoutineOverrides} ${overview.otherRoutineOverrides === 1 ? 'reagendamento' : 'reagendamentos'} de rotinas que não estão ativas`,
      legacyKind: 'aggregate',
      currentText: '—',
      action: 'ignore',
      outcome: 'ignore',
      proposal: 'Nenhuma alteração',
      reason: 'A agenda anterior só usa a rotina ativa. Esses registros ficam guardados, sem alteração.',
      proposed: null,
      decision: null,
      count: overview.otherRoutineOverrides,
    });

  const changes = d.changes(null);
  const log: ImportChangeLog = { created: [], updated: [], deleted: [] };
  for (const e of changes.put) {
    const before = original.get(e.id);
    if (before) log.updated.push({ before, after: e });
    else log.created.push(e);
  }
  for (const id of changes.delete) {
    const before = original.get(id);
    if (before) log.deleted.push(before);
  }
  // Lugares afetados: o dia da semana de cada entrada semanal e a data de cada exceção mexida.
  const slots = new Map<string, PlanSlot>();
  for (const e of [...log.created, ...log.updated.map((u) => u.after), ...log.deleted]) {
    const slot: PlanSlot = e.scope === 'weekly' ? { scope: 'weekly', weekday: e.weekday! } : { scope: 'date', date: e.date! };
    slots.set(slotKey(slot), slot);
  }
  const after = d.list;
  const slotsAfter: Record<string, string> = {};
  for (const [k, slot] of slots) slotsAfter[k] = slotFingerprint(after, slot, today);

  const counts: ImportCounts = { create: 0, replace: 0, keep: 0, skip: 0, preserve: 0, ignore: 0, manual: 0, conflicts: 0 };
  for (const it of items) {
    counts[it.outcome] += it.count ?? 1;
    if (it.action === 'conflict') counts.conflicts++;
  }
  return { today, mode: opts.mode, overview, items, counts, fingerprint: importFingerprint(input), put: changes.put, delete: changes.delete, log, slotsAfter };
}

// ------------------------------------------------------------------------------------------------ desfazer

/** Registro da última importação (guardado pela persistência; nunca vai para o backup). */
export interface PlanImportRecord {
  /** ID da operação (gerado uma vez por prévia confirmada: repetir a confirmação não aplica duas vezes). */
  id: string;
  profileId: string;
  createdAt: number;
  /** Dia local da importação. */
  day: string;
  mode: Exclude<ImportMode, 'view'>;
  routineId: string;
  routineName: string;
  counts: ImportCounts;
  changes: ImportChangeLog;
  slotsAfter: Record<string, string>;
  status: 'applied' | 'undone';
  undoneAt: number | null;
}

export interface UndoPlan {
  ok: boolean;
  /** Motivos que impedem o desfazer (alterações posteriores). Com problemas, nada é revertido. */
  problems: string[];
  put: PlanEntry[];
  delete: string[];
  /** Itens que ficam como estão por estarem no passado (o planejamento não altera dias passados). */
  keptPast: number;
}

const slotOfKey = (k: string): PlanSlot => (k.startsWith('weekly:') ? { scope: 'weekly', weekday: Number(k.slice(7)) } : { scope: 'date', date: k.slice(5) });
const slotLabel = (slot: PlanSlot) => (slot.scope === 'weekly' ? `toda ${importWeekdayName(slot.weekday)}` : `o dia ${fmtDate(slot.date)}`);

/**
 * Plano de reversão da última importação, conferido contra o planejamento ATUAL. Só reverte o que a importação criou
 * ou alterou, e só se nada foi mexido depois (impressão digital de cada lugar afetado + revisão de cada entrada).
 * Qualquer alteração posterior bloqueia o desfazer inteiro (nada é revertido pela metade).
 * Dias passados não mudam: se o desfazer acontece em outro dia, as entradas semanais criadas são encerradas ontem
 * (as semanas anteriores continuam mostrando o que estava planejado nelas).
 */
export function planUndoImport(record: PlanImportRecord, entries: readonly PlanEntry[], ctx: PlanContext): UndoPlan {
  const problems: string[] = [];
  if (record.status !== 'applied') return { ok: false, problems: ['Esta importação já foi desfeita.'], put: [], delete: [], keptPast: 0 };
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const [k, fp] of Object.entries(record.slotsAfter)) {
    const slot = slotOfKey(k);
    if (slotFingerprint(entries, slot, record.day) !== fp) problems.push(`O planejamento de ${slotLabel(slot)} foi alterado depois da importação.`);
  }
  for (const e of record.changes.created) {
    const cur = byId.get(e.id);
    if (cur && cur.revision !== e.revision) problems.push(`Uma atividade criada pela importação (${e.scope === 'weekly' ? `toda ${importWeekdayName(e.weekday!)}` : fmtDate(e.date!)}) foi alterada depois.`);
  }
  for (const u of record.changes.updated) {
    const cur = byId.get(u.after.id);
    if (!cur || cur.revision !== u.after.revision) problems.push('Uma atividade substituída pela importação foi alterada ou removida depois.');
  }
  for (const e of record.changes.deleted) if (byId.has(e.id)) problems.push('Uma atividade substituída pela importação voltou a existir (talvez por um backup).');
  const unique = [...new Set(problems)];
  if (unique.length) return { ok: false, problems: unique, put: [], delete: [], keptPast: 0 };

  const today = ctx.today;
  const sameDay = record.day === today;
  const d = new Draft(entries);
  let keptPast = 0;
  for (const e of record.changes.created) {
    const cur = byId.get(e.id);
    if (!cur) continue; // já removida (ex.: o dia foi limpo e voltou ao mesmo estado): nada a desfazer
    if (cur.scope === 'weekly') retireWeekly(d, cur, ctx);
    else if (cur.date! >= today) d.remove(cur.id);
    else keptPast++;
  }
  for (const u of record.changes.updated) {
    const cur = byId.get(u.after.id)!;
    if (sameDay) d.set({ ...u.before, updatedAt: Math.max(ctx.now, cur.updatedAt + 1), revision: cur.revision + 1 });
    else if (u.before.scope === 'weekly' && (u.before.validUntil === null || u.before.validUntil >= today)) {
      // Nova versão a partir de hoje (o intervalo entre a importação e hoje não é reescrito).
      d.set({ ...u.before, id: ctx.newId(), validFrom: today, createdAt: ctx.now, updatedAt: ctx.now, revision: 1 });
    } else keptPast++;
  }
  for (const e of record.changes.deleted) {
    if (e.scope === 'date') {
      if (e.date! >= today) d.set(e);
      else keptPast++;
    } else if (e.validUntil === null || e.validUntil >= today) d.set(sameDay || (e.validFrom ?? today) >= today ? e : { ...e, validFrom: today });
    else keptPast++;
  }
  const changes = d.changes(null);
  return { ok: true, problems: [], put: changes.put, delete: changes.delete, keptPast };
}
