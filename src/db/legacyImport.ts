// Persistência da importação assistida da agenda anterior (IronTrack 2.0 F01/P15, docs/CONSOLIDACAO_AGENDAS.md §6–7).
// Lê a agenda anterior (dias de treino das Configurações + reagendamentos da rotina ativa) e o planejamento, e GRAVA
// SÓ no planejamento (`planEntries`) e no registro da última importação. Nunca grava `overrides`, `trainingDays`,
// rotação, sessões ou fichas.
//
// Tudo numa única transação de escrita (serializada pelo navegador entre abas): a prévia é recalculada com os dados
// atuais, a impressão digital é comparada com a que a pessoa viu e só então as mudanças são aplicadas — tudo ou nada.
//
// Registro da última importação (para o desfazer): um documento por perfil na tabela `settings` (chave-valor), com a
// chave `planImport.last.<perfil>`. Não é uma tabela nova (Dexie continua v4), não entra no backup (o backup lê só a
// chave `settings`), é apagado por "apagar tudo" e por "substituir" na restauração, e é gravado na MESMA transação da
// importação — por isso o desfazer continua disponível depois de reiniciar o app.
import { db, mergeSettings } from './db';
import { todayISO } from '@/lib/dates';
import { uid } from '@/lib/utils';
import type { DayOverride, PlanEntry, Routine } from '@/lib/types';
import {
  importFingerprint,
  planUndoImport,
  previewLegacyImport,
  previewUndoImport,
  type ConflictDecision,
  type ImportMode,
  type ImportPreview,
  type LegacyImportInput,
  type PlanContext,
  type PlanImportRecord,
  type UndoPlan,
  type UndoPreview,
} from '@/modules/planner';

export const IMPORT_RECORD_PREFIX = 'planImport.last.';

interface StoredImportRecord {
  id: string;
  kind: 'planImport';
  record: PlanImportRecord;
}

export type LegacyImportErrorKind = 'changed' | 'nothing' | 'no_profile' | 'view_only' | 'undo_blocked' | 'undo_missing' | 'undo_changed' | 'undo_nothing';

const MESSAGES: Record<LegacyImportErrorKind, string> = {
  changed: 'O planejamento ou a agenda anterior mudaram desde a prévia (talvez em outra aba). Nada foi gravado: confira a prévia atualizada.',
  nothing: 'Não há nada para importar. Nada foi gravado.',
  no_profile: 'Perfil local não inicializado. Recarregue o app; nada foi gravado.',
  view_only: 'No modo "Apenas visualizar" nada é gravado.',
  undo_blocked: 'Não foi possível desfazer: houve alterações depois da importação. Nada foi revertido.',
  undo_missing: 'Não há importação para desfazer.',
  undo_changed: 'A importação ou o planejamento mudaram desde a prévia do desfazer (talvez em outra aba). Nada foi revertido: confira a prévia atualizada.',
  undo_nothing: 'Nenhum item pode ser desfeito com segurança agora. Nada foi revertido.',
};

export class LegacyImportError extends Error {
  constructor(
    readonly kind: LegacyImportErrorKind,
    readonly details: string[] = [],
  ) {
    super(MESSAGES[kind]);
    this.name = 'LegacyImportError';
  }
}

export interface ImportClock {
  today?: string;
  now?: number;
  newId?: () => string;
}

const ctxOf = (c: ImportClock = {}): PlanContext => ({ today: c.today ?? todayISO(), now: c.now ?? Date.now(), newId: c.newId ?? uid });

const settingsTable = () => db.table<StoredImportRecord | { id: string }, string>('settings');
const recordKey = (profileId: string) => `${IMPORT_RECORD_PREFIX}${profileId}`;

/** Tabelas lidas pela importação (a escrita é só em `planEntries` e no registro em `settings`). */
const importTables = () => [db.planEntries, db.settings, db.routines, db.overrides];

/** Lê as fontes da importação (chamada dentro de uma transação). Mesma rotina ativa que a Início e a Treinos usam. */
async function readInput(today: string): Promise<LegacyImportInput> {
  const pid = db.currentProfileId;
  if (!pid) throw new LegacyImportError('no_profile');
  const settings = mergeSettings(await db.settings.get('settings'));
  const routines: Routine[] = await db.routines.where('profileId').equals(pid).toArray();
  const active = (settings.activeRoutineId && routines.find((r) => r.id === settings.activeRoutineId)) || (await db.routines.toCollection().first()) || null;
  const routine = active && active.profileId === pid ? active : null;
  const routineIds = new Set(routines.map((r) => r.id));
  const overrides: DayOverride[] = (await db.overrides.toArray()).filter((o) => routineIds.has(o.routineId));
  const entries: PlanEntry[] = await db.planEntries.where('profileId').equals(pid).toArray();
  return { today, entries, routines, source: { routine, trainingDays: settings.trainingDays, overrides } };
}

/** Fontes da importação, para consultas ao vivo (`useLiveQuery`): outra aba atualiza a prévia sozinha. */
export const readImportInput = (today: string = todayISO()) => readInput(today);

/** Prévia da importação (somente leitura). Os três modos usam este mesmo cálculo. */
export async function previewImport(opts: { mode: ImportMode; decisions?: Record<string, ConflictDecision> }, clock?: ImportClock): Promise<ImportPreview> {
  const ctx = ctxOf(clock);
  return db.transaction('r', importTables(), async () => previewLegacyImport(await readInput(ctx.today), opts, ctx));
}

/** Último registro de importação do perfil local (null se não houver). */
export async function readLastImport(): Promise<PlanImportRecord | null> {
  const pid = db.currentProfileId;
  if (!pid) return null;
  const s = (await settingsTable().get(recordKey(pid))) as StoredImportRecord | undefined;
  return s?.kind === 'planImport' ? s.record : null;
}

export interface ApplyImportInput {
  /** ID gerado uma vez por prévia: confirmar duas vezes (toque duplo, outra aba) não aplica duas vezes. */
  operationId: string;
  mode: Exclude<ImportMode, 'view'>;
  decisions?: Record<string, ConflictDecision>;
  /** Impressão digital da prévia que a pessoa confirmou. */
  expectedFingerprint: string;
}

export interface ApplyImportResult {
  record: PlanImportRecord;
  preview: ImportPreview;
  /** A mesma operação já tinha sido aplicada (nada foi gravado de novo). */
  repeated: boolean;
}

/**
 * Aplica a importação: tudo ou nada. Recalcula a prévia dentro da transação e recusa se algo mudou desde a prévia
 * confirmada (planejamento, agenda anterior, rotina). Grava as entradas e o registro para o desfazer juntos.
 */
export async function applyImport(input: ApplyImportInput, clock?: ImportClock): Promise<ApplyImportResult> {
  if ((input.mode as ImportMode) === 'view') throw new LegacyImportError('view_only');
  const ctx = ctxOf(clock);
  return db.transaction('rw', importTables(), async () => {
    const pid = db.currentProfileId;
    if (!pid) throw new LegacyImportError('no_profile');
    const last = await readLastImport();
    const source = await readInput(ctx.today);
    if (last && last.id === input.operationId && last.status === 'applied') {
      return { record: last, preview: previewLegacyImport(source, { mode: input.mode, decisions: input.decisions }, ctx), repeated: true };
    }
    if (importFingerprint(source) !== input.expectedFingerprint) throw new LegacyImportError('changed');
    const preview = previewLegacyImport(source, { mode: input.mode, decisions: input.decisions }, ctx);
    if (!preview.put.length && !preview.delete.length) throw new LegacyImportError('nothing');
    // Referências: toda entrada gravada aponta para uma rotina (e treino) deste perfil.
    const routines = new Map(source.routines.map((r) => [r.id, r]));
    for (const e of preview.put) {
      if (e.kind !== 'workout') continue;
      const r = routines.get(e.routineId!);
      if (!r || (e.workoutId !== null && !r.workouts.some((w) => w.id === e.workoutId))) throw new LegacyImportError('changed');
    }
    if (preview.delete.length) await db.planEntries.bulkDelete(preview.delete);
    if (preview.put.length) await db.planEntries.bulkPut(preview.put);
    const record: PlanImportRecord = {
      id: input.operationId,
      profileId: pid,
      createdAt: ctx.now,
      day: ctx.today,
      mode: input.mode,
      routineId: preview.overview.routineId!,
      routineName: preview.overview.routineName!,
      counts: preview.counts,
      changes: preview.log,
      slotsAfter: preview.slotsAfter,
      status: 'applied',
      undoneAt: null,
    };
    await settingsTable().put({ id: recordKey(pid), kind: 'planImport', record } satisfies StoredImportRecord);
    return { record, preview, repeated: false };
  });
}

/**
 * Confere (sem gravar) se a última importação pode ser desfeita agora e o que mudaria: o plano "desfazer tudo"
 * (contrato do P15) e, desde o P16, a prévia item a item (seguros, alterados, excluídos, passados, já revertidos).
 */
export async function checkUndoImport(clock?: ImportClock): Promise<{ record: PlanImportRecord | null; plan: UndoPlan | null; preview: UndoPreview | null }> {
  const ctx = ctxOf(clock);
  return db.transaction('r', [db.planEntries, db.settings, db.routines], async () => {
    const record = await readLastImport();
    if (!record) return { record: null, plan: null, preview: null };
    const entries = await db.planEntries.where('profileId').equals(record.profileId).toArray();
    const routines = await db.routines.where('profileId').equals(record.profileId).toArray();
    return { record, plan: planUndoImport(record, entries, ctx), preview: previewUndoImport(record, entries, ctx, routines) };
  });
}

export interface UndoImportInput {
  recordId: string;
  /** `all` (padrão, contrato do P15): só se TODOS os itens forem seguros · `safe` (P16): só os itens seguros. */
  mode?: 'all' | 'safe';
  /** Impressão digital da prévia que a pessoa confirmou: qualquer mudança desde então cancela (nada revertido). */
  expectedFingerprint?: string;
}

/**
 * Desfaz a última importação, inteira ou só os itens seguros. Na mesma transação: confere que o registro é o que a
 * tela mostrava, recalcula a prévia com o planejamento atual (revisões e impressões digitais), recusa se ela mudou
 * desde a confirmação e só então reverte. O modo parcial nunca toca um lugar alterado depois; o registro guarda o que
 * foi revertido e fica "desfeito em parte" enquanto houver itens pendentes (para revisão). Sessões, rotação, agenda
 * anterior e fichas nunca são tocadas.
 */
export async function undoLastImport(input: UndoImportInput, clock?: ImportClock): Promise<UndoPlan> {
  const ctx = ctxOf(clock);
  const mode = input.mode ?? 'all';
  return db.transaction('rw', [db.planEntries, db.settings], async () => {
    const pid = db.currentProfileId;
    if (!pid) throw new LegacyImportError('no_profile');
    const record = await readLastImport();
    if (!record || record.status === 'undone') throw new LegacyImportError(record ? 'undo_changed' : 'undo_missing');
    if (record.id !== input.recordId) throw new LegacyImportError('undo_changed');
    const entries = await db.planEntries.where('profileId').equals(pid).toArray();
    const preview = previewUndoImport(record, entries, ctx);
    if (input.expectedFingerprint !== undefined && preview.fingerprint !== input.expectedFingerprint) throw new LegacyImportError('undo_changed');
    let changes: { put: PlanEntry[]; delete: string[] };
    let reverted: string[];
    if (mode === 'all') {
      if (!preview.allSafe) throw new LegacyImportError('undo_blocked', [...new Set(preview.items.flatMap((i) => i.problems))]);
      changes = preview.all;
      reverted = preview.revertsAll;
    } else {
      if (!preview.safeCount) throw new LegacyImportError('undo_nothing');
      changes = preview.safe;
      reverted = preview.revertsSafe;
    }
    if (changes.delete.length) await db.planEntries.bulkDelete(changes.delete);
    if (changes.put.length) await db.planEntries.bulkPut(changes.put);
    const done = new Set([...(record.reverted ?? []), ...reverted]);
    // "Desfeita" só quando não resta nenhum item pendente; senão, "desfeita em parte" (os pendentes ficam para revisão).
    const pending = preview.items.filter((i) => !done.has(i.key) && i.status !== 'past');
    const status: PlanImportRecord['status'] = pending.length ? 'partial' : 'undone';
    await settingsTable().put({ id: recordKey(pid), kind: 'planImport', record: { ...record, status, reverted: [...done].sort(), undoneAt: ctx.now } } satisfies StoredImportRecord);
    return { ok: true, problems: [], put: changes.put, delete: changes.delete, keptPast: preview.keptPast };
  });
}
