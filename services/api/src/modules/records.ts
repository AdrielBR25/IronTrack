// Registros do app no PostgreSQL (Prompt 21): uma tabela por coleção, validação no servidor, normalização do dono e
// projeção relacional dos treinos. Usado pela sincronização, pela importação e pela exportação.
// Os nomes de tabela vêm SÓ deste mapa constante (nunca do cliente); todos os valores vão como parâmetros ($n).
import { canonicalJson } from '../../../../shared/canonical.ts';
import { PROFILE_OWNED, SYNC_COLLECTIONS, entityIdOf, expectedProfileBoundId, type SyncCollection } from '../../../../shared/sync/collections.ts';
import { SYNC_LIMITS } from '../../../../shared/sync/protocol.ts';
import type { PoolClient } from '../db/pool.ts';

type Doc = Record<string, unknown>;

interface TableSpec {
  table: string;
  /** Colunas tipadas extraídas do registro (já validado). */
  columns: (doc: Doc) => Record<string, unknown>;
  /** Regras mínimas de formato (o app valida o resto); devolve o motivo da recusa ou null. */
  validate: (doc: Doc) => string | null;
}

const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isMs = (v: unknown): v is number => isNum(v) && v >= 0 && v < 8.64e15;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && ISO_DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const ts = (v: unknown): string | null => (isMs(v) ? new Date(v).toISOString() : null);
const opt = (v: unknown) => (v === undefined ? null : v);

function validateSession(d: Doc): string | null {
  if (!['active', 'completed', 'discarded'].includes(d.status as string)) return 'status';
  if (!isMs(d.startedAt)) return 'startedAt';
  if (!Array.isArray(d.exercises)) return 'exercises';
  const exIds = new Set<string>();
  for (const e of d.exercises as unknown[]) {
    if (!e || typeof e !== 'object') return 'exercises';
    const x = e as Doc;
    if (!isStr(x.id, 200) || exIds.has(x.id)) return 'exercises.id';
    exIds.add(x.id);
    if (typeof x.name !== 'string') return 'exercises.name';
    if (!Array.isArray(x.sets)) return 'exercises.sets';
    const setIds = new Set<string>();
    for (const s of x.sets as unknown[]) {
      const y = s as Doc;
      if (!y || typeof y !== 'object' || !isStr(y.id, 200) || setIds.has(y.id)) return 'sets.id';
      setIds.add(y.id);
      if (!['warmup', 'normal', 'drop'].includes(y.type as string) || !['pending', 'done', 'skipped'].includes(y.status as string)) return 'sets.type';
      if (y.weight !== null && y.weight !== undefined && !isNum(y.weight)) return 'sets.weight';
      if (y.reps !== null && y.reps !== undefined && !isNum(y.reps)) return 'sets.reps';
    }
  }
  return null;
}

export const TABLES: Record<SyncCollection, TableSpec> = {
  settings: { table: 'user_settings', columns: () => ({}), validate: (d) => (d.id === 'settings' ? null : 'id') },
  routines: {
    table: 'routines',
    columns: (d) => ({ name: typeof d.name === 'string' ? d.name.slice(0, 200) : null }),
    validate: (d) => (!Array.isArray(d.workouts) ? 'workouts' : (d.workouts as unknown[]).some((w) => !w || typeof w !== 'object' || !Array.isArray((w as Doc).exercises)) ? 'workouts.exercises' : null),
  },
  sessions: {
    table: 'workout_sessions',
    columns: (d) => ({ status: d.status, routine_id: opt(d.routineId), workout_id: opt(d.workoutId), started_at: ts(d.startedAt), finished_at: ts(d.finishedAt) }),
    validate: validateSession,
  },
  rotations: { table: 'rotation_states', columns: (d) => ({ next_index: isInt(d.nextIndex) ? d.nextIndex : null }), validate: (d) => (isInt(d.nextIndex) && (d.nextIndex as number) >= 0 ? null : 'nextIndex') },
  overrides: {
    table: 'day_overrides',
    columns: (d) => ({ routine_id: d.routineId, date: d.date, kind: d.kind }),
    validate: (d) => (!isIsoDate(d.date) ? 'date' : !['rest', 'workout'].includes(d.kind as string) ? 'kind' : null),
  },
  bodyEntries: { table: 'body_measurements', columns: (d) => ({ date: d.date }), validate: (d) => (isIsoDate(d.date) ? null : 'date') },
  goals: {
    table: 'goals',
    columns: (d) => ({ type: typeof d.type === 'string' ? d.type.slice(0, 40) : null, status: d.status }),
    validate: (d) => (['active', 'paused', 'archived'].includes(d.status as string) ? null : 'status'),
  },
  planEntries: {
    table: 'plan_entries',
    columns: (d) => ({ scope: d.scope, weekday: isInt(d.weekday) ? d.weekday : null, date: isIsoDate(d.date) ? d.date : null }),
    validate: (d) =>
      !['weekly', 'date'].includes(d.scope as string)
        ? 'scope'
        : d.weekday !== null && d.weekday !== undefined && !(isInt(d.weekday) && (d.weekday as number) >= 0 && (d.weekday as number) <= 6)
          ? 'weekday'
          : d.date !== null && d.date !== undefined && !isIsoDate(d.date)
            ? 'date'
            : null,
  },
  calendarDecisions: {
    table: 'calendar_decisions',
    columns: (d) => ({ conflict_id: d.conflictId, date: isIsoDate(d.date) ? d.date : null }),
    validate: (d) => (!isStr(d.conflictId) ? 'conflictId' : d.date !== undefined && d.date !== null && !isIsoDate(d.date) ? 'date' : null),
  },
  customExercises: {
    table: 'custom_exercises',
    columns: (d) => ({ name: typeof d.name === 'string' ? d.name.slice(0, 200) : null, archived: d.archivedAt !== null && d.archivedAt !== undefined }),
    validate: (d) => (typeof d.id === 'string' && d.id.startsWith('cx_') ? (typeof d.name === 'string' ? null : 'name') : 'id'),
  },
  exerciseFavorites: { table: 'exercise_favorites', columns: (d) => ({ target: d.target }), validate: (d) => (typeof d.target === 'string' && /^(catalog|custom):.{1,200}$/.test(d.target) ? null : 'target') },
};

/** Todas as tabelas de dados do app (exportação e contagens). */
export const ALL_RECORD_TABLES = SYNC_COLLECTIONS.map((c) => ({ collection: c, table: TABLES[c].table }));

export class RecordError extends Error {
  readonly code: 'invalid_record' | 'entity_mismatch' | 'too_large' | 'profile_mismatch';
  readonly field?: string;
  constructor(code: RecordError['code'], field?: string) {
    super(code);
    this.code = code;
    if (field !== undefined) this.field = field;
    this.name = 'RecordError';
  }
}

/**
 * Normaliza e valida um registro para gravar na conta: o dono é SEMPRE o perfil da conta autenticada (o valor
 * enviado é ignorado), o ID tem de bater com a entidade e os IDs dependentes de perfil têm de usar o perfil da conta.
 */
export function normalizeRecord(collection: SyncCollection, entityId: string, raw: Doc, dataProfileId: string): Doc {
  const doc: Doc = { ...raw };
  if (PROFILE_OWNED.includes(collection)) doc.profileId = dataProfileId;
  if (entityIdOf(collection, doc) !== entityId) throw new RecordError('entity_mismatch');
  const bound = expectedProfileBoundId(collection, doc, dataProfileId);
  if (bound !== null && doc.id !== bound) throw new RecordError('profile_mismatch');
  const why = TABLES[collection].validate(doc);
  if (why) throw new RecordError('invalid_record', why);
  const text = canonicalJson(doc);
  if (Buffer.byteLength(text, 'utf8') > SYNC_LIMITS.maxDocBytes) throw new RecordError('too_large');
  // jsonb não aceita o caractere nulo.
  if (text.includes('\\u0000')) throw new RecordError('invalid_record', 'nul');
  return JSON.parse(text) as Doc;
}

export interface CurrentRow {
  version: number;
  deleted: boolean;
  doc: Doc;
  server_seq: number;
}

export async function lockRow(c: PoolClient, collection: SyncCollection, userId: string, entityId: string): Promise<CurrentRow | null> {
  const t = TABLES[collection].table;
  const r = await c.query<CurrentRow>(`SELECT version, deleted, doc, server_seq FROM ${t} WHERE user_id = $1 AND id = $2 FOR UPDATE`, [userId, entityId]);
  return r.rows[0] ?? null;
}

/** Grava (insere ou atualiza) a versão nova de um registro e reescreve a projeção do treino. */
export async function writeRow(c: PoolClient, collection: SyncCollection, userId: string, entityId: string, doc: Doc, version: number, seq: number, deviceId: string | null): Promise<void> {
  const spec = TABLES[collection];
  const cols = spec.columns(doc);
  const names = Object.keys(cols);
  const base = ['user_id', 'id', 'doc', 'version', 'server_seq', 'deleted', 'device_id', ...names];
  const values = [userId, entityId, JSON.stringify(doc), version, seq, false, deviceId, ...names.map((n) => cols[n])];
  const ph = base.map((_, i) => `$${i + 1}`);
  const updates = base.slice(2).map((n) => `${n} = EXCLUDED.${n}`);
  await c.query(`INSERT INTO ${spec.table} (${base.join(', ')}) VALUES (${ph.join(', ')}) ON CONFLICT (user_id, id) DO UPDATE SET ${updates.join(', ')}, updated_at = now()`, values);
  if (collection === 'sessions') await rewriteSessionProjection(c, userId, entityId, doc);
}

/** Marca como excluído (os outros aparelhos recebem a exclusão). O conteúdo anterior vai para `record_revisions`. */
export async function deleteRow(c: PoolClient, collection: SyncCollection, userId: string, entityId: string, version: number, seq: number, deviceId: string | null): Promise<void> {
  const spec = TABLES[collection];
  await c.query(`UPDATE ${spec.table} SET deleted = true, doc = '{}'::jsonb, version = $3, server_seq = $4, device_id = $5, updated_at = now() WHERE user_id = $1 AND id = $2`, [userId, entityId, version, seq, deviceId]);
  if (collection === 'sessions') await c.query('DELETE FROM workout_exercises WHERE user_id = $1 AND session_id = $2', [userId, entityId]);
}

export async function saveRevision(c: PoolClient, userId: string, collection: SyncCollection, entityId: string, row: CurrentRow, reason: 'conflict_resolution' | 'import_replace' | 'delete', deviceId: string | null): Promise<void> {
  if (row.deleted) return;
  await c.query('INSERT INTO record_revisions (user_id, collection, entity_id, version, doc, reason, device_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [userId, collection, entityId, row.version, JSON.stringify(row.doc), reason, deviceId]);
  // Mantém as 20 versões mais recentes por registro.
  await c.query(
    `DELETE FROM record_revisions WHERE user_id = $1 AND collection = $2 AND entity_id = $3
       AND id NOT IN (SELECT id FROM record_revisions WHERE user_id = $1 AND collection = $2 AND entity_id = $3 ORDER BY id DESC LIMIT 20)`,
    [userId, collection, entityId],
  );
}

/** Projeção relacional (exercícios e séries) do treino; mesma transação da gravação do registro. */
async function rewriteSessionProjection(c: PoolClient, userId: string, sessionId: string, doc: Doc): Promise<void> {
  await c.query('DELETE FROM workout_exercises WHERE user_id = $1 AND session_id = $2', [userId, sessionId]);
  const exercises = (doc.exercises as Doc[]).map((e, i) => ({
    id: e.id,
    position: i,
    exercise_key: typeof e.exerciseKey === 'string' ? e.exerciseKey : '',
    template_id: typeof e.templateId === 'string' ? e.templateId : null,
    catalog_id: typeof e.catalogId === 'string' ? e.catalogId : null,
    custom_exercise_id: typeof e.customExerciseId === 'string' ? e.customExerciseId : null,
    name: String(e.name).slice(0, 200),
    muscle_group: typeof e.muscleGroup === 'string' ? e.muscleGroup.slice(0, 100) : null,
  }));
  const sets = (doc.exercises as Doc[]).flatMap((e) =>
    (e.sets as Doc[]).map((s, i) => ({
      exercise_id: e.id,
      id: s.id,
      position: i,
      type: s.type,
      status: s.status,
      weight_kg: isNum(s.weight) ? s.weight : null,
      reps: isNum(s.reps) ? Math.round(s.reps as number) : null,
      duration_sec: isNum(s.durationSec) ? Math.round(s.durationSec as number) : null,
      distance_m: isNum(s.distance) ? s.distance : null,
      completed_at: ts(s.completedAt),
    })),
  );
  if (exercises.length)
    await c.query(
      `INSERT INTO workout_exercises (user_id, session_id, id, position, exercise_key, template_id, catalog_id, custom_exercise_id, name, muscle_group)
       SELECT $1, $2, x.id, x.position, x.exercise_key, x.template_id, x.catalog_id, x.custom_exercise_id, x.name, x.muscle_group
         FROM jsonb_to_recordset($3::jsonb) AS x(id text, position int, exercise_key text, template_id text, catalog_id text, custom_exercise_id text, name text, muscle_group text)`,
      [userId, sessionId, JSON.stringify(exercises)],
    );
  if (sets.length)
    await c.query(
      `INSERT INTO workout_sets (user_id, session_id, exercise_id, id, position, type, status, weight_kg, reps, duration_sec, distance_m, completed_at)
       SELECT $1, $2, x.exercise_id, x.id, x.position, x.type, x.status, x.weight_kg, x.reps, x.duration_sec, x.distance_m, x.completed_at
         FROM jsonb_to_recordset($3::jsonb) AS x(exercise_id text, id text, position int, type text, status text, weight_kg numeric, reps int, duration_sec int, distance_m numeric, completed_at timestamptz)`,
      [userId, sessionId, JSON.stringify(sets)],
    );
}

/** Reserva `n` posições do cursor da conta. Bloqueia a linha do usuário até o fim da transação (gravações em série). */
export async function lockUserSeq(c: PoolClient, userId: string): Promise<{ seq: number; dataProfileId: string }> {
  const r = await c.query<{ sync_seq: number; data_profile_id: string }>('SELECT sync_seq, data_profile_id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!r.rows[0]) throw new Error('conta inexistente');
  return { seq: r.rows[0].sync_seq, dataProfileId: r.rows[0].data_profile_id };
}

export async function saveUserSeq(c: PoolClient, userId: string, seq: number): Promise<void> {
  await c.query('UPDATE users SET sync_seq = $2 WHERE id = $1 AND sync_seq <= $2', [userId, seq]);
}
