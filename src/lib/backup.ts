import { z } from 'zod';
import { db, mergeSettings } from '@/db/db';
import type { BodyEntry, DayOverride, ProgressPhoto, Routine, RotationState, Settings, WorkoutSession } from './types';
import { formatZodError, parseJsonText, type ParseResult } from './routineSchema';

export const BACKUP_APP = 'irontrack';
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupData {
  settings: Settings | null;
  routines: Routine[];
  sessions: WorkoutSession[];
  rotations: RotationState[];
  overrides: DayOverride[];
  bodyEntries: BodyEntry[];
  photos: ProgressPhoto[];
}

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

export function parseBackup(text: string): ParseResult<BackupFile> {
  const raw = parseJsonText(text);
  if (!raw.ok) return raw;
  const mig = migrateBackup(raw.value);
  if (!mig.ok) return mig;
  const res = backupSchema.safeParse(mig.value);
  if (!res.success) return { ok: false, errors: formatZodError(res.error) };
  return { ok: true, value: res.data as unknown as BackupFile };
}

export async function exportBackup(): Promise<BackupFile> {
  const [settings, routines, sessions, rotations, overrides, bodyEntries, photos] = await Promise.all([
    db.settings.get('settings'),
    db.routines.toArray(),
    db.sessions.toArray(),
    db.rotations.toArray(),
    db.overrides.toArray(),
    db.bodyEntries.toArray(),
    db.photos.toArray(),
  ]);
  return {
    app: BACKUP_APP,
    kind: 'backup',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: { settings: settings ?? null, routines, sessions, rotations, overrides, bodyEntries, photos },
  };
}

export interface ImportSummary {
  routines: number;
  sessions: number;
  bodyEntries: number;
  photos: number;
  skipped: number;
}

const ALL_TABLES = () => [db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos];

/** Substitui todos os dados locais pelo backup. */
export async function restoreBackupReplace(b: BackupFile): Promise<ImportSummary> {
  const d = b.data;
  await db.transaction('rw', ALL_TABLES(), async () => {
    await Promise.all(ALL_TABLES().map((t) => t.clear()));
    if (d.settings) await db.settings.put(mergeSettings(d.settings));
    await db.routines.bulkPut(d.routines);
    await db.sessions.bulkPut(d.sessions);
    await db.rotations.bulkPut(d.rotations);
    await db.overrides.bulkPut(d.overrides);
    await db.bodyEntries.bulkPut(d.bodyEntries);
    await db.photos.bulkPut(d.photos);
  });
  return { routines: d.routines.length, sessions: d.sessions.length, bodyEntries: d.bodyEntries.length, photos: d.photos.length, skipped: 0 };
}

/** Mescla o backup com os dados atuais, sem duplicar registros. */
export async function restoreBackupMerge(b: BackupFile): Promise<ImportSummary> {
  const d = b.data;
  const sum: ImportSummary = { routines: 0, sessions: 0, bodyEntries: 0, photos: 0, skipped: 0 };
  await db.transaction('rw', ALL_TABLES(), async () => {
    const routineIds = new Set(await db.routines.toCollection().primaryKeys());
    for (const r of d.routines) {
      if (routineIds.has(r.id)) sum.skipped++;
      else {
        await db.routines.put(r);
        sum.routines++;
      }
    }
    const existing = await db.sessions.toArray();
    const ids = new Set(existing.map((s) => s.id));
    const fingerprints = new Set(existing.map((s) => `${s.startedAt}|${s.workoutName}`));
    const hasActive = existing.some((s) => s.status === 'active');
    for (const s of d.sessions) {
      const fp = `${s.startedAt}|${s.workoutName}`;
      if (ids.has(s.id) || fingerprints.has(fp) || (s.status === 'active' && hasActive)) {
        sum.skipped++;
        continue;
      }
      await db.sessions.put(s);
      fingerprints.add(fp);
      sum.sessions++;
    }
    for (const r of d.rotations) if (!(await db.rotations.get(r.routineId))) await db.rotations.put(r);
    for (const o of d.overrides) if (!(await db.overrides.get([o.routineId, o.date]))) await db.overrides.put(o);
    const bodies = await db.bodyEntries.toArray();
    const bodyIds = new Set(bodies.map((e) => e.id));
    const bodyFp = new Set(bodies.map((e) => `${e.date}|${e.weightKg ?? ''}|${e.waistCm ?? ''}`));
    for (const e of d.bodyEntries) {
      const fp = `${e.date}|${e.weightKg ?? ''}|${e.waistCm ?? ''}`;
      if (bodyIds.has(e.id) || bodyFp.has(fp)) {
        sum.skipped++;
        continue;
      }
      await db.bodyEntries.put(e);
      sum.bodyEntries++;
    }
    const photoIds = new Set(await db.photos.toCollection().primaryKeys());
    for (const p of d.photos) {
      if (photoIds.has(p.id)) continue;
      await db.photos.put(p);
      sum.photos++;
    }
    if (d.settings && !(await db.settings.get('settings'))) await db.settings.put(mergeSettings(d.settings));
  });
  return sum;
}
