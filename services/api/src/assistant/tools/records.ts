// Leitura dos registros da conta para as ferramentas da IA. TODA consulta filtra por `user_id` da sessão; os nomes de
// tabela são fixos e os valores vão como parâmetros. Lê a cópia sincronizada na nuvem (o app sincroniza antes de
// perguntar), ignorando registros excluídos.
import type { Pool, PoolClient } from '../../db/pool.ts';

type Doc = Record<string, unknown>;
type Q = Pick<Pool | PoolClient, 'query'>;

export interface RoutineRow {
  id: string;
  version: number;
  doc: Doc;
}

export async function loadRoutines(q: Q, userId: string): Promise<RoutineRow[]> {
  const r = await q.query<RoutineRow>('SELECT id, version, doc FROM routines WHERE user_id = $1 AND NOT deleted ORDER BY updated_at DESC LIMIT 100', [userId]);
  return r.rows;
}

export async function loadRoutine(q: Q, userId: string, id: string, lock = false): Promise<RoutineRow | null> {
  const r = await q.query<RoutineRow>(`SELECT id, version, doc FROM routines WHERE user_id = $1 AND id = $2 AND NOT deleted${lock ? ' FOR UPDATE' : ''}`, [userId, id]);
  return r.rows[0] ?? null;
}

export interface SessionDoc {
  id: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  durationSec?: number;
  routineId?: string;
  workoutId?: string;
  workoutLabel?: string;
  workoutName?: string;
  notes?: string;
  exercises: {
    id: string;
    name: string;
    exerciseKey?: string;
    templateId?: string;
    muscleGroup?: string;
    equipment?: string;
    modality?: string;
    sets: { id: string; type: string; status: string; weight?: number | null; reps?: number | null; durationSec?: number | null; distance?: number | null; rpe?: number | null; rir?: number | null; segments?: { weight: number | null; reps: number | null }[] }[];
  }[];
}

/** Treinos concluídos no intervalo [fromMs, toMs), do mais recente ao mais antigo. */
export async function loadCompletedSessions(q: Q, userId: string, fromMs: number, toMs: number, limit: number): Promise<SessionDoc[]> {
  const r = await q.query<{ doc: SessionDoc }>(
    `SELECT doc FROM workout_sessions WHERE user_id = $1 AND NOT deleted AND status = 'completed' AND started_at >= to_timestamp($2 / 1000.0) AND started_at < to_timestamp($3 / 1000.0)
     ORDER BY started_at DESC LIMIT $4`,
    [userId, fromMs, toMs, limit],
  );
  return r.rows.map((x) => x.doc).filter((d) => d && Array.isArray(d.exercises));
}

export async function loadSession(q: Q, userId: string, id: string): Promise<SessionDoc | null> {
  const r = await q.query<{ doc: SessionDoc }>('SELECT doc FROM workout_sessions WHERE user_id = $1 AND id = $2 AND NOT deleted', [userId, id]);
  return r.rows[0]?.doc ?? null;
}

export async function loadDocs(q: Q, table: 'goals' | 'body_measurements', userId: string, limit: number): Promise<Doc[]> {
  const order = table === 'body_measurements' ? 'date DESC NULLS LAST' : 'updated_at DESC';
  const r = await q.query<{ doc: Doc }>(`SELECT doc FROM ${table} WHERE user_id = $1 AND NOT deleted ORDER BY ${order} LIMIT $2`, [userId, limit]);
  return r.rows.map((x) => x.doc);
}

export async function loadSettings(q: Q, userId: string): Promise<Doc | null> {
  const r = await q.query<{ doc: Doc }>("SELECT doc FROM user_settings WHERE user_id = $1 AND id = 'settings' AND NOT deleted", [userId]);
  return r.rows[0]?.doc ?? null;
}

export async function recordCounts(q: Q, userId: string): Promise<Record<string, number>> {
  const r = await q.query<{ k: string; n: number }>(
    `SELECT 'fichas' AS k, count(*)::int AS n FROM routines WHERE user_id = $1 AND NOT deleted
     UNION ALL SELECT 'treinos_concluidos', count(*)::int FROM workout_sessions WHERE user_id = $1 AND NOT deleted AND status = 'completed'
     UNION ALL SELECT 'metas', count(*)::int FROM goals WHERE user_id = $1 AND NOT deleted
     UNION ALL SELECT 'avaliacoes_corporais', count(*)::int FROM body_measurements WHERE user_id = $1 AND NOT deleted
     UNION ALL SELECT 'exercicios_personalizados', count(*)::int FROM custom_exercises WHERE user_id = $1 AND NOT deleted`,
    [userId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.k, x.n]));
}

/** Exercícios já registrados em treinos concluídos (nome, quantas vezes, último treino). */
export async function performedExercises(q: Q, userId: string, limit: number): Promise<{ name: string; sessions: number; last: string }[]> {
  const r = await q.query<{ name: string; sessions: number; last: Date }>(
    `SELECT e.name, count(DISTINCT e.session_id)::int AS sessions, max(s.started_at) AS last
       FROM workout_exercises e JOIN workout_sessions s ON s.user_id = e.user_id AND s.id = e.session_id
      WHERE e.user_id = $1 AND NOT s.deleted AND s.status = 'completed'
      GROUP BY e.name ORDER BY sessions DESC, last DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows.map((x) => ({ name: x.name, sessions: x.sessions, last: x.last.toISOString() }));
}

// ------------------------------------------------------------------ cálculos sobre os registros

export const normalizeName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

type Ex = SessionDoc['exercises'][number];
type SetT = Ex['sets'][number];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const workSets = (e: Ex) => (Array.isArray(e.sets) ? e.sets : []).filter((s) => s && s.status === 'done' && s.type !== 'warmup');

/** Partes da série (carga × repetições), incluindo as partes extras (séries em partes). */
function parts(s: SetT): { w: number; r: number }[] {
  const out: { w: number; r: number }[] = [];
  const w = num(s.weight);
  const r = num(s.reps);
  if (r !== null && r > 0) out.push({ w: w ?? 0, r });
  for (const seg of Array.isArray(s.segments) ? s.segments : []) {
    const sw = num(seg?.weight);
    const sr = num(seg?.reps);
    if (sr !== null && sr > 0) out.push({ w: sw ?? 0, r: sr });
  }
  return out;
}

/** 1RM estimada pela fórmula de Epley (só séries com carga e até 12 repetições). */
export const epley = (w: number, r: number): number | null => (w > 0 && r >= 1 && r <= 12 ? (r === 1 ? w : w * (1 + r / 30)) : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ExerciseStats {
  doneSets: number;
  volumeKg: number;
  bestWeightKg: number | null;
  bestWeightReps: number | null;
  maxReps: number | null;
  e1rmKg: number | null;
  sets: string[];
}

export function exerciseStats(e: Ex): ExerciseStats {
  const ws = workSets(e);
  let volume = 0;
  let bestW: number | null = null;
  let bestWR: number | null = null;
  let maxR: number | null = null;
  let e1: number | null = null;
  const sets: string[] = [];
  for (const s of ws) {
    const ps = parts(s);
    const label: string[] = [];
    for (const p of ps) {
      volume += p.w * p.r;
      if (p.w > 0 && (bestW === null || p.w > bestW || (p.w === bestW && p.r > (bestWR ?? 0)))) {
        bestW = p.w;
        bestWR = p.r;
      }
      if (maxR === null || p.r > maxR) maxR = p.r;
      const est = epley(p.w, p.r);
      if (est !== null && (e1 === null || est > e1)) e1 = est;
      label.push(p.w > 0 ? `${round1(p.w)} kg × ${p.r}` : `${p.r} reps`);
    }
    const dur = num(s.durationSec);
    const dist = num(s.distance);
    if (!label.length && dur) label.push(`${dur} s`);
    if (dist) label.push(`${round1(dist)} m`);
    if (s.type === 'drop') label.push('(drop)');
    if (num(s.rir) !== null) label.push(`RIR ${s.rir}`);
    if (num(s.rpe) !== null) label.push(`RPE ${s.rpe}`);
    sets.push(label.join(' + ') || 'feita (sem carga/reps registradas)');
  }
  return { doneSets: ws.length, volumeKg: Math.round(volume), bestWeightKg: bestW, bestWeightReps: bestWR, maxReps: maxR, e1rmKg: e1 === null ? null : round1(e1), sets };
}
