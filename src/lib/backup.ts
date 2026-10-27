import { z } from 'zod';
import { db, mergeSettings } from '@/db/db';
import type { CollectionName, DataSnapshot } from './types';
import { formatZodError, parseJsonText, type ParseResult } from './routineSchema';
import { checkIntegrity, snapshotFingerprint, type IntegrityIssue, type IntegrityReport } from './integrity';
import { applyPlan, planMerge, type CollectionCounts, type MergeItem } from './merge';

export const BACKUP_APP = 'irontrack';
export const BACKUP_SCHEMA_VERSION = 1;

// Versão do formato JSON do backup. Independente da versão do esquema IndexedDB (DB_SCHEMA_VERSION).
export type BackupData = DataSnapshot;

export interface BackupFile {
  app: typeof BACKUP_APP;
  kind: 'backup';
  schemaVersion: number;
  exportedAt: string;
  data: BackupData;
}

// Validação estrutural: campos essenciais conferidos, demais preservados.
const setSchema = z
  .object({
    id: z.string(),
    type: z.enum(['warmup', 'normal', 'drop']),
    status: z.enum(['pending', 'done', 'skipped']),
    weight: z.number().nullable(),
    reps: z.number().nullable(),
  })
  .passthrough();

const sessionSchema = z
  .object({
    id: z.string(),
    routineId: z.string(),
    workoutId: z.string(),
    workoutName: z.string(),
    status: z.enum(['active', 'completed', 'discarded']),
    startedAt: z.number(),
    exercises: z.array(
      z.object({ id: z.string(), exerciseKey: z.string(), name: z.string(), sets: z.array(setSchema) }).passthrough(),
    ),
  })
  .passthrough();

const routineSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    workouts: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          name: z.string(),
          exercises: z.array(z.object({ id: z.string(), name: z.string(), sets: z.number(), repMin: z.number(), repMax: z.number() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const backupSchema = z.object({
  app: z.literal(BACKUP_APP, { errorMap: () => ({ message: 'este arquivo não é um backup do IronTrack' }) }),
  kind: z.literal('backup', { errorMap: () => ({ message: 'este arquivo não é um backup completo (talvez seja uma ficha de treino?)' }) }),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  data: z.object({
    settings: z.object({ id: z.literal('settings') }).passthrough().nullable(),
    routines: z.array(routineSchema),
    sessions: z.array(sessionSchema),
    rotations: z.array(z.object({ routineId: z.string(), nextIndex: z.number().int() }).passthrough()),
    overrides: z.array(z.object({ routineId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(['rest', 'workout']) }).passthrough()),
    bodyEntries: z.array(z.object({ id: z.string(), date: z.string() }).passthrough()),
    photos: z.array(z.object({ id: z.string(), entryId: z.string(), dataUrl: z.string() }).passthrough()),
  }),
});

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrações de backup: chave = versão de origem. Cada uma leva à versão seguinte.
 * v0 era o formato preliminar com as tabelas na raiz do arquivo.
 */
const MIGRATIONS: Record<number, Migration> = {
  0: (raw) => ({
    app: BACKUP_APP,
    kind: 'backup',
    schemaVersion: 1,
    exportedAt: (raw.exportedAt as string) ?? new Date().toISOString(),
    data: {
      settings: raw.settings ?? null,
      routines: raw.routines ?? [],
      sessions: raw.sessions ?? [],
      rotations: raw.rotations ?? [],
      overrides: raw.overrides ?? [],
      bodyEntries: raw.bodyEntries ?? [],
      photos: raw.photos ?? [],
    },
  }),
};

export function migrateBackup(raw: unknown): ParseResult<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['O arquivo não contém um objeto JSON de backup.'] };
  let obj = raw as Record<string, unknown>;
  if (obj.app !== BACKUP_APP) {
    if ((obj as { formato?: string }).formato === 'irontrack.ficha')
      return { ok: false, errors: ['Este arquivo é uma ficha de treino. Importe-o em Treinos › Importar ficha.'] };
    return { ok: false, errors: ['Este arquivo não é um backup do IronTrack.'] };
  }
  let v = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;
  if (v > BACKUP_SCHEMA_VERSION)
    return { ok: false, errors: [`Backup criado por uma versão mais nova do app (esquema ${v}). Atualize o IronTrack antes de importar.`] };
  while (v < BACKUP_SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) return { ok: false, errors: [`Não há migração disponível da versão ${v}.`] };
    obj = m(obj);
    v = obj.schemaVersion as number;
  }
  return { ok: true, value: obj };
}

// ---------- Limites de tamanho e complexidade ----------
// Fotos são data URLs (JPEG ~1080 px, normalmente 100–400 KB cada); os limites
// cabem com folga em vários anos de uso e evitam travar o navegador com arquivos absurdos.

export const BACKUP_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxRecords: { routines: 1_000, sessions: 50_000, rotations: 1_000, overrides: 20_000, bodyEntries: 10_000, photos: 2_000 } as Record<Exclude<CollectionName, 'settings'>, number>,
  maxPhotoChars: 15 * 1024 * 1024,
  maxWorkoutsPerRoutine: 100,
  maxExercisesPerItem: 300,
  maxSetsPerExercise: 200,
};

const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Confere o tamanho do arquivo antes de lê-lo. */
export function checkBackupSize(bytes: number): string | null {
  if (bytes > BACKUP_LIMITS.maxBytes) return `Arquivo muito grande (${fmtMB(bytes)}). O limite para restaurar é ${fmtMB(BACKUP_LIMITS.maxBytes)}.`;
  return null;
}

function checkComplexity(d: BackupData): string[] {
  const errors: string[] = [];
  const L = BACKUP_LIMITS;
  for (const [c, max] of Object.entries(L.maxRecords) as [Exclude<CollectionName, 'settings'>, number][])
    if (d[c].length > max) errors.push(`"${c}" tem ${d[c].length} registros; o limite é ${max}.`);
  d.photos.forEach((p, i) => {
    if (p.dataUrl.length > L.maxPhotoChars) errors.push(`Foto ${i + 1} (${p.id}) tem ${fmtMB(p.dataUrl.length)}; o limite por foto é ${fmtMB(L.maxPhotoChars)}.`);
  });
  for (const r of d.routines) {
    if (r.workouts.length > L.maxWorkoutsPerRoutine) errors.push(`Rotina ${r.id} tem ${r.workouts.length} treinos; o limite é ${L.maxWorkoutsPerRoutine}.`);
    for (const w of r.workouts) if (w.exercises.length > L.maxExercisesPerItem) errors.push(`Rotina ${r.id} tem um treino com ${w.exercises.length} exercícios; o limite é ${L.maxExercisesPerItem}.`);
  }
  for (const s of d.sessions) {
    if (s.exercises.length > L.maxExercisesPerItem) errors.push(`Treino ${s.id} tem ${s.exercises.length} exercícios; o limite é ${L.maxExercisesPerItem}.`);
    for (const e of s.exercises) if (e.sets.length > L.maxSetsPerExercise) errors.push(`Treino ${s.id} tem um exercício com ${e.sets.length} séries; o limite é ${L.maxSetsPerExercise}.`);
  }
  return errors.slice(0, 12);
}

export function parseBackup(text: string): ParseResult<BackupFile> {
  const sizeError = checkBackupSize(text.length);
  if (sizeError) return { ok: false, errors: [sizeError] };
  const raw = parseJsonText(text);
  if (!raw.ok) return raw;
  const mig = migrateBackup(raw.value);
  if (!mig.ok) return mig;
  const res = backupSchema.safeParse(mig.value);
  if (!res.success) return { ok: false, errors: formatZodError(res.error) };
  const value = res.data as unknown as BackupFile;
  const tooBig = checkComplexity(value.data);
  if (tooBig.length) return { ok: false, errors: tooBig };
  return { ok: true, value };
}

const ALL_TABLES = () => [db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos];

/**
 * Lê todas as tabelas numa única transação de leitura: o retrato é consistente
 * mesmo com gravações simultâneas (ex.: concluir um treino durante a exportação).
 */
export async function readSnapshot(): Promise<BackupData> {
  return db.transaction('r', ALL_TABLES(), async () => {
    const [settings, routines, sessions, rotations, overrides, bodyEntries, photos] = await Promise.all([
      db.settings.get('settings'),
      db.routines.toArray(),
      db.sessions.toArray(),
      db.rotations.toArray(),
      db.overrides.toArray(),
      db.bodyEntries.toArray(),
      db.photos.toArray(),
    ]);
    return { settings: settings ?? null, routines, sessions, rotations, overrides, bodyEntries, photos };
  });
}

export async function exportBackup(): Promise<BackupFile> {
  const data = await readSnapshot();
  return {
    app: BACKUP_APP,
    kind: 'backup',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/** Diagnóstico de integridade dos dados deste aparelho (somente leitura). */
export async function checkLocalIntegrity(): Promise<IntegrityReport> {
  return checkIntegrity(await readSnapshot());
}

export interface ImportSummary {
  routines: number;
  sessions: number;
  bodyEntries: number;
  photos: number;
  /** Registros do backup não aplicados (duplicatas + conflitos + ignorados). */
  skipped: number;
  duplicates: number;
  conflicts: number;
  /** Registros do backup não restaurados (conflitos + ignorados); 0 na substituição. */
  notRestored: number;
}

export class BackupRestoreError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'BackupRestoreError';
  }
}

export interface RestorePreview {
  exportedAt: string;
  /** Integridade do conteúdo do backup. Erros impedem qualquer restauração. */
  integrity: IntegrityReport;
  blocked: boolean;
  incoming: Record<CollectionName, number>;
  local: Record<CollectionName, number>;
  merge: {
    counts: Record<CollectionName, CollectionCounts>;
    totals: CollectionCounts;
    items: MergeItem[];
    /** Registros do backup que não serão restaurados na mesclagem (conflitos + ignorados). */
    notRestored: number;
    /** Erros de integridade que a mesclagem criaria no resultado (bloqueiam a mesclagem). */
    newErrors: IntegrityIssue[];
  };
  /**
   * Impressão digital dos dados locais no momento da prévia. A restauração a confere
   * dentro da própria transação e é cancelada se qualquer registro local tiver mudado.
   */
  localFingerprint: string;
}

/** Confirmação dada pelo usuário sobre uma prévia específica. */
export interface RestoreConfirmation {
  /** `localFingerprint` da prévia exibida. */
  expectedLocalFingerprint?: string;
  /** Obrigatório quando parte do backup não será restaurada (conflitos ou ignorados). */
  acceptPartial?: boolean;
}

export const STALE_PREVIEW_MESSAGE = 'Os dados deste aparelho mudaram desde a prévia. Nada foi gravado; abra o backup novamente para ver a prévia atualizada.';

function assertFresh(local: BackupData, opts: RestoreConfirmation) {
  if (opts.expectedLocalFingerprint !== undefined && snapshotFingerprint(local) !== opts.expectedLocalFingerprint) throw new BackupRestoreError(STALE_PREVIEW_MESSAGE);
}

/** Erros de integridade presentes no resultado da mesclagem e ausentes nos dados locais. */
function newMergeErrors(local: BackupData, merged: BackupData): IntegrityIssue[] {
  const key = (i: IntegrityIssue) => `${i.code}|${i.collection}|${i.id ?? ''}`;
  const before = new Set(checkIntegrity(local).issues.filter((i) => i.severity === 'error').map(key));
  return checkIntegrity(merged).issues.filter((i) => i.severity === 'error' && !before.has(key(i)));
}

const countOf = (d: BackupData): Record<CollectionName, number> => ({
  settings: d.settings ? 1 : 0,
  routines: d.routines.length,
  sessions: d.sessions.length,
  rotations: d.rotations.length,
  overrides: d.overrides.length,
  bodyEntries: d.bodyEntries.length,
  photos: d.photos.length,
});

/** Analisa o backup contra os dados atuais sem gravar nada. */
export async function previewRestore(b: BackupFile): Promise<RestorePreview> {
  const integrity = checkIntegrity(b.data);
  const local = await readSnapshot();
  const plan = planMerge(local, b.data);
  return {
    exportedAt: b.exportedAt,
    integrity,
    blocked: !integrity.ok,
    incoming: countOf(b.data),
    local: countOf(local),
    merge: { counts: plan.counts, totals: plan.totals, items: plan.items, notRestored: plan.notRestored, newErrors: integrity.ok ? newMergeErrors(local, applyPlan(local, plan)) : [] },
    localFingerprint: snapshotFingerprint(local),
  };
}

function assertRestorable(b: BackupFile) {
  const integrity = checkIntegrity(b.data);
  if (!integrity.ok) {
    const errors = integrity.issues.filter((i) => i.severity === 'error');
    throw new BackupRestoreError(
      `O backup tem ${errors.length} problema(s) de integridade e não foi aplicado. Nenhum dado foi alterado.`,
      errors.slice(0, 12).map((i) => `${i.collection}${i.id ? ` (${i.id})` : ''}: ${i.message}`),
    );
  }
}

/**
 * Substitui todos os dados locais pelo backup. Valida antes de gravar e roda numa
 * única transação: qualquer falha desfaz tudo e os dados anteriores ficam intactos.
 */
export async function restoreBackupReplace(b: BackupFile, opts: RestoreConfirmation = {}): Promise<ImportSummary> {
  assertRestorable(b);
  const d = b.data;
  await db.transaction('rw', ALL_TABLES(), async () => {
    // Não apagar dados que o usuário não viu na prévia (ex.: treino concluído em outra aba).
    assertFresh(await readSnapshot(), opts);
    await Promise.all(ALL_TABLES().map((t) => t.clear()));
    if (d.settings) await db.settings.put(mergeSettings(d.settings));
    // bulkPut: cópias idênticas repetidas no arquivo (aviso DUPLICATE_ID_IDENTICAL) viram um registro;
    // IDs repetidos com conteúdo diferente já foram barrados por assertRestorable.
    await db.routines.bulkPut(d.routines);
    await db.sessions.bulkPut(d.sessions);
    await db.rotations.bulkPut(d.rotations);
    await db.overrides.bulkPut(d.overrides);
    await db.bodyEntries.bulkPut(d.bodyEntries);
    await db.photos.bulkPut(d.photos);
  });
  return { routines: d.routines.length, sessions: d.sessions.length, bodyEntries: d.bodyEntries.length, photos: d.photos.length, skipped: 0, duplicates: 0, conflicts: 0, notRestored: 0 };
}

/**
 * Mescla o backup com os dados atuais (política em src/lib/merge.ts). Dentro da transação:
 * 1. confere a impressão digital dos dados locais da prévia (qualquer mudança cancela);
 * 2. refaz o plano; se parte do backup não será restaurada, exige `acceptPartial`;
 * 3. confere que o resultado não cria erros de integridade (referências);
 * 4. só insere: nunca sobrescreve um registro existente.
 * Qualquer falha desfaz tudo.
 */
export async function restoreBackupMerge(b: BackupFile, opts: RestoreConfirmation = {}): Promise<ImportSummary> {
  assertRestorable(b);
  return db.transaction('rw', ALL_TABLES(), async () => {
    const local = await readSnapshot();
    assertFresh(local, opts);
    const plan = planMerge(local, b.data);
    if (plan.notRestored > 0 && !opts.acceptPartial)
      throw new BackupRestoreError(
        `${plan.notRestored} registro(s) do backup não serão restaurados (conflitos ou ignorados). Confirme explicitamente para continuar. Nada foi gravado.`,
        plan.items.filter((i) => i.kind === 'conflict' || i.kind === 'kept-local' || i.kind === 'skipped').slice(0, 12).map((i) => `${i.collection} (${i.id}): ${i.message}`),
      );
    const broken = newMergeErrors(local, applyPlan(local, plan));
    if (broken.length)
      throw new BackupRestoreError(
        'A mesclagem deixaria referências inconsistentes e foi cancelada. Nada foi gravado.',
        broken.slice(0, 12).map((i) => `${i.collection}${i.id ? ` (${i.id})` : ''}: ${i.message}`),
      );
    const a = plan.toAdd;
    if (a.settings) await db.settings.add(mergeSettings(a.settings));
    await db.routines.bulkAdd(a.routines);
    await db.sessions.bulkAdd(a.sessions);
    await db.rotations.bulkAdd(a.rotations);
    await db.overrides.bulkAdd(a.overrides);
    await db.bodyEntries.bulkAdd(a.bodyEntries);
    await db.photos.bulkAdd(a.photos);
    const t = plan.totals;
    return {
      routines: a.routines.length,
      sessions: a.sessions.length,
      bodyEntries: a.bodyEntries.length,
      photos: a.photos.length,
      skipped: t.duplicate + t.conflict + t.skipped,
      duplicates: t.duplicate,
      conflicts: t.conflict,
      notRestored: plan.notRestored,
    };
  });
}
