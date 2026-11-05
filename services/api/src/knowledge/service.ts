// Operações do módulo Conhecimento (Fase 04, docs/CONHECIMENTO.md). Usado pelas rotas (/api/v1/knowledge/*) e pelos
// handlers das propostas aprovadas do assistente — o mesmo caminho e as mesmas validações nos dois casos.
//
// Regras centrais:
//  - Toda consulta filtra por user_id; ID de outra conta simplesmente "não existe".
//  - O tempo de uma sessão do cronômetro é calculado AQUI (computeActive) com os horários do servidor; o app só pode
//    reduzir o resultado. Registros manuais são aceitos, mas rendem pouco XP (regras conservadoras).
//  - O progresso das metas é sempre derivado das sessões. Metas vinculadas a um hábito/missão alimentam o vínculo, e a
//    recompensa da própria meta vira 0 XP (a mesma atividade nunca rende duas recompensas de conclusão).
//  - Uma sessão alimenta no máximo UMA missão (chave única knowledge:session:<id> nos registros da missão).
//  - Escritas rodam em lifeTx (perfil bloqueado): serializa a conta; XP só pelo motor da Fase 01 (idempotente por chave,
//    teto diário, estorno ao excluir).
import { randomUUID } from 'node:crypto';
import {
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_PROTOCOL,
  KNOWLEDGE_REWARD,
  TIMER_RULES,
  addSeen,
  breakPhaseAfter,
  computeActive,
  focusLimitMs,
  goalXp,
  sessionXp,
  type BookInput,
  type BookPatch,
  type BookStatus,
  type BookView,
  type GoalInput,
  type GoalPatch,
  type GoalView,
  type KnowledgeDashboardView,
  type KnowledgeModule,
  type KnowledgeStatsView,
  type ManualSession,
  type NoteInput,
  type NoteKind,
  type NoteView,
  type PomodoroConfig,
  type SeenRange,
  type Segment,
  type SessionKind,
  type SessionOrigin,
  type SessionView,
  type SubjectColor,
  type SubjectInput,
  type SubjectPatch,
  type SubjectView,
  type TimerFinish,
  type TimerMode,
  type TimerPhase,
  type TimerStart,
  type TimerView,
  type TopicInput,
  type TopicStatus,
  type TopicView,
} from '../../../../shared/knowledge/protocol.ts';
import type { PoolClient } from '../db/pool.ts';
import { ApiError } from '../http/core.ts';
import { addDays, localDate, mondayOf } from '../assistant/tools/time.ts';
import { activeGrant, grant, recomputeMission, reverse, scheduledOn, weekday, type LifeTx, type MissionRow } from '../life/engine.ts';
import { getHabit, getRoutine, logHabit, routineSnapshot, updateRoutine, createRoutine } from '../life/service.ts';

type Q = Pick<PoolClient, 'query'>;
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const MODULE: KnowledgeModule = 'knowledge';

// ------------------------------------------------------------------ livros

export interface BookRow {
  id: string;
  title: string;
  author: string | null;
  cover: string | null;
  total_pages: number | null;
  current_page: number;
  category: string | null;
  started_on: string | null;
  target_date: string | null;
  finished_on: string | null;
  status: BookStatus;
  rating: number | null;
  review: string | null;
  origin: 'user' | 'ai';
  version: number;
  created_at: Date;
}

const hueOf = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};

export async function getBook(c: Q, userId: string, id: string, lock = false): Promise<BookRow | null> {
  if (!isUuid(id)) return null;
  return (await c.query<BookRow>(`SELECT * FROM knowledge_books WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}

interface BookStats {
  minutes: number;
  sessions: number;
  pages: number;
  last: string | null;
  notes: number;
  recentPages: number;
}

async function bookStats(c: Q, userId: string, ids: string[], today: string): Promise<Map<string, BookStats>> {
  const out = new Map<string, BookStats>();
  if (!ids.length) return out;
  const r = await c.query<{ book_id: string; sec: number; n: number; pages: number; last: string | null; recent: number }>(
    `SELECT book_id, sum(active_sec)::int AS sec, count(*)::int AS n, sum(pages_read)::int AS pages, max(date) AS last,
            coalesce(sum(pages_read) FILTER (WHERE date > $3::date - 28), 0)::int AS recent
       FROM knowledge_sessions WHERE user_id = $1 AND book_id = ANY($2) GROUP BY book_id`,
    [userId, ids, today],
  );
  const notes = await c.query<{ book_id: string; n: number }>('SELECT book_id, count(*)::int AS n FROM knowledge_notes WHERE user_id = $1 AND book_id = ANY($2) GROUP BY book_id', [userId, ids]);
  const nm = new Map(notes.rows.map((x) => [x.book_id, x.n]));
  for (const x of r.rows) out.set(x.book_id, { minutes: Math.floor(x.sec / 60), sessions: x.n, pages: x.pages, last: x.last, notes: nm.get(x.book_id) ?? 0, recentPages: x.recent });
  for (const id of ids) if (!out.has(id)) out.set(id, { minutes: 0, sessions: 0, pages: 0, last: null, notes: nm.get(id) ?? 0, recentPages: 0 });
  return out;
}

export function bookView(b: BookRow, s: BookStats, today: string): BookView {
  const percent = b.total_pages ? Math.min(100, Math.round((b.current_page / b.total_pages) * 1000) / 10) : null;
  // Ritmo pelos últimos 28 dias corridos (dias sem leitura entram na média: previsão realista, não otimista).
  const daily = s.recentPages / 28;
  const remaining = b.total_pages ? b.total_pages - b.current_page : null;
  const forecast = b.status === 'reading' && remaining && remaining > 0 && daily >= 0.5 ? addDays(today, Math.ceil(remaining / daily)) : null;
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    cover: b.cover,
    hue: hueOf(b.title),
    totalPages: b.total_pages,
    currentPage: b.current_page,
    percent: b.status === 'done' ? 100 : percent,
    category: b.category,
    startedOn: b.started_on,
    targetDate: b.target_date,
    finishedOn: b.finished_on,
    status: b.status,
    rating: b.rating,
    review: b.review,
    origin: b.origin,
    version: b.version,
    stats: { minutes: s.minutes, sessions: s.sessions, pagesRead: s.pages, lastReadOn: s.last, notes: s.notes },
    pace: { pagesPerReadingDay: s.sessions ? Math.round((s.pages / Math.max(1, s.sessions)) * 10) / 10 : null, forecastFinish: forecast },
  };
}

export async function bookViews(c: Q, userId: string, today: string, opts: { status?: BookStatus[]; ids?: string[]; withCover?: boolean } = {}): Promise<BookView[]> {
  const p: unknown[] = [userId];
  let w = '';
  if (opts.status?.length) {
    p.push(opts.status);
    w += ` AND status = ANY($${p.length})`;
  }
  if (opts.ids) {
    p.push(opts.ids.filter(isUuid));
    w += ` AND id = ANY($${p.length})`;
  }
  const cols = opts.withCover === false ? "id, title, author, NULL::text AS cover, total_pages, current_page, category, started_on, target_date, finished_on, status, rating, review, origin, version, created_at" : '*';
  const rows = (await c.query<BookRow>(`SELECT ${cols} FROM knowledge_books WHERE user_id = $1${w} ORDER BY array_position(ARRAY['reading','paused','want','done'], status), updated_at DESC`, p)).rows;
  const st = await bookStats(c, userId, rows.map((r) => r.id), today);
  return rows.map((r) => bookView(r, st.get(r.id)!, today));
}

export async function oneBookView(c: Q, userId: string, id: string, today: string): Promise<BookView | null> {
  return (await bookViews(c, userId, today, { ids: [id] }))[0] ?? null;
}

export async function createBook(t: LifeTx, b: BookInput, origin: 'user' | 'ai', id: string = randomUUID()): Promise<BookRow> {
  const n = (await t.c.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_books WHERE user_id = $1', [t.userId])).rows[0].n;
  if (n >= KNOWLEDGE_LIMITS.books) throw new ApiError('life_limit');
  const status = b.status;
  const current = status === 'done' && b.totalPages ? b.totalPages : b.currentPage;
  const started = b.startedOn ?? (status === 'reading' || status === 'done' ? t.today : null);
  const r = await t.c.query<BookRow>(
    `INSERT INTO knowledge_books (id, user_id, title, author, cover, total_pages, current_page, category, started_on, target_date, finished_on, status, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [id, t.userId, b.title, b.author, b.cover ?? null, b.totalPages ?? null, current, b.category, started, b.targetDate ?? null, status === 'done' ? t.today : null, status, origin],
  );
  if (status === 'done') await syncBookReward(t, r.rows[0]);
  return r.rows[0];
}

export async function updateBook(t: LifeTx, id: string, p: BookPatch, version?: number | null): Promise<{ before: BookRow; after: BookRow }> {
  const before = await getBook(t.c, t.userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && version !== before.version) throw new ApiError('life_stale');
  const total = p.totalPages !== undefined ? p.totalPages : before.total_pages;
  const status = p.status ?? before.status;
  let current = p.currentPage ?? before.current_page;
  if (status === 'done' && before.status !== 'done' && total && p.currentPage === undefined) current = total;
  if (total && current > total) throw new ApiError('knowledge_pages');
  const finished = status === 'done' ? (before.status === 'done' ? before.finished_on : t.today) : null;
  const started = p.startedOn !== undefined ? p.startedOn : before.started_on ?? (status === 'reading' || status === 'done' ? t.today : null);
  const r = await t.c.query<BookRow>(
    `UPDATE knowledge_books SET title = $3, author = $4, cover = $5, total_pages = $6, current_page = $7, category = $8, started_on = $9, target_date = $10, finished_on = $11,
       status = $12, rating = $13, review = $14, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *`,
    [
      t.userId,
      id,
      p.title ?? before.title,
      p.author !== undefined ? p.author : before.author,
      p.cover !== undefined ? p.cover : before.cover,
      total,
      current,
      p.category !== undefined ? p.category : before.category,
      started,
      p.targetDate !== undefined ? p.targetDate : before.target_date,
      finished,
      status,
      p.rating !== undefined ? p.rating : before.rating,
      p.review !== undefined ? p.review : before.review,
    ],
  );
  const after = r.rows[0];
  if (before.status !== after.status) {
    await syncBookReward(t, after);
    await recomputeGoals(t, [t.today], { bookId: id });
  }
  return { before, after };
}

/** Recria o livro como estava (desfazer do assistente). */
export async function restoreBook(t: LifeTx, b: BookRow): Promise<void> {
  const cur = await getBook(t.c, t.userId, b.id, true);
  if (!cur) return;
  await t.c.query(
    `UPDATE knowledge_books SET title = $3, author = $4, total_pages = $5, current_page = $6, category = $7, started_on = $8, target_date = $9, finished_on = $10, status = $11,
       rating = $12, review = $13, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2`,
    [t.userId, b.id, b.title, b.author, b.total_pages, b.current_page, b.category, b.started_on, b.target_date, b.finished_on, b.status, b.rating, b.review],
  );
  const after = (await getBook(t.c, t.userId, b.id))!;
  await syncBookReward(t, after);
  await recomputeGoals(t, [t.today], { bookId: b.id });
}

export async function deleteBook(t: LifeTx, id: string): Promise<BookRow> {
  const b = await getBook(t.c, t.userId, id, true);
  if (!b) throw new ApiError('not_found');
  // Metas do livro somem junto (CASCADE): estorna o que elas tinham rendido.
  for (const g of (await t.c.query<{ id: string }>('SELECT id FROM knowledge_goals WHERE user_id = $1 AND book_id = $2', [t.userId, id])).rows) await reverseGoalGrants(t, g.id, 'Meta removida com o livro');
  await reverse(t, `knowledge:book:${id}`, `Livro removido: ${b.title}`);
  await t.c.query('DELETE FROM knowledge_books WHERE user_id = $1 AND id = $2', [t.userId, id]);
  return b;
}

async function bookMinutes(c: Q, userId: string, bookId: string): Promise<number> {
  return Math.floor((await c.query<{ s: number }>('SELECT coalesce(sum(active_sec), 0)::int AS s FROM knowledge_sessions WHERE user_id = $1 AND book_id = $2', [userId, bookId])).rows[0].s / 60);
}

/** Livro concluído rende XP uma vez, se houver leitura registrada nele (bookMinMin). Reabrir estorna. */
export async function syncBookReward(t: LifeTx, b: BookRow): Promise<void> {
  const key = `knowledge:book:${b.id}`;
  const existing = await activeGrant(t.c, t.userId, key);
  if (b.status === 'done') {
    if (existing) return;
    const minutes = await bookMinutes(t.c, t.userId, b.id);
    if (minutes < KNOWLEDGE_REWARD.bookMinMin) return;
    const day = b.finished_on && b.finished_on <= t.today ? b.finished_on : t.today;
    await grant(t, { source: 'knowledge', key, sourceId: b.id, attribute: 'knowledge', requested: KNOWLEDGE_REWARD.book, day, reason: `Livro concluído: ${b.title}`.slice(0, 200) });
  } else if (existing) await reverse(t, key, `Livro reaberto: ${b.title}`.slice(0, 200));
}

// ------------------------------------------------------------------ matérias e tópicos

export interface SubjectRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  color: SubjectColor;
  weekly_goal_min: number | null;
  notes: string | null;
  archived: boolean;
  origin: 'user' | 'ai';
  version: number;
}

export interface TopicRow {
  id: string;
  subject_id: string;
  title: string;
  notes: string | null;
  status: TopicStatus;
  position: number;
  completed_at: Date | null;
  origin: 'user' | 'ai';
  version: number;
}

export async function getSubject(c: Q, userId: string, id: string, lock = false): Promise<SubjectRow | null> {
  if (!isUuid(id)) return null;
  return (await c.query<SubjectRow>(`SELECT * FROM knowledge_subjects WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}
export async function getTopic(c: Q, userId: string, id: string, lock = false): Promise<TopicRow | null> {
  if (!isUuid(id)) return null;
  return (await c.query<TopicRow>(`SELECT * FROM knowledge_topics WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}

export async function subjectViews(c: Q, userId: string, today: string, opts: { ids?: string[]; archived?: boolean; withTopics?: boolean } = {}): Promise<SubjectView[]> {
  const p: unknown[] = [userId];
  let w = opts.archived ? '' : ' AND NOT archived';
  if (opts.ids) {
    p.push(opts.ids.filter(isUuid));
    w = ` AND id = ANY($${p.length})`;
  }
  const rows = (await c.query<SubjectRow>(`SELECT * FROM knowledge_subjects WHERE user_id = $1${w} ORDER BY archived, lower(name)`, p)).rows;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const week = mondayOf(today);
  const st = new Map(
    (
      await c.query<{ subject_id: string; total: number; wk: number; n: number; last: string | null }>(
        `SELECT subject_id, sum(active_sec)::int AS total, coalesce(sum(active_sec) FILTER (WHERE date >= $3), 0)::int AS wk, count(*)::int AS n, max(date) AS last
           FROM knowledge_sessions WHERE user_id = $1 AND subject_id = ANY($2) GROUP BY subject_id`,
        [userId, ids, week],
      )
    ).rows.map((x) => [x.subject_id, x]),
  );
  const topics = (await c.query<TopicRow>('SELECT * FROM knowledge_topics WHERE user_id = $1 AND subject_id = ANY($2) ORDER BY position, created_at', [userId, ids])).rows;
  const tmin = opts.withTopics
    ? new Map((await c.query<{ topic_id: string; s: number }>('SELECT topic_id, sum(active_sec)::int AS s FROM knowledge_sessions WHERE user_id = $1 AND topic_id = ANY($2) GROUP BY topic_id', [userId, topics.map((x) => x.id)])).rows.map((x) => [x.topic_id, x.s]))
    : new Map<string, number>();
  return rows.map((r) => {
    const s = st.get(r.id);
    const ts = topics.filter((x) => x.subject_id === r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      color: r.color,
      weeklyGoalMin: r.weekly_goal_min,
      notes: r.notes,
      archived: r.archived,
      origin: r.origin,
      version: r.version,
      minutesTotal: Math.floor((s?.total ?? 0) / 60),
      minutesWeek: Math.floor((s?.wk ?? 0) / 60),
      sessions: s?.n ?? 0,
      lastStudiedOn: s?.last ?? null,
      topics: { total: ts.length, done: ts.filter((x) => x.status === 'done').length, studying: ts.filter((x) => x.status === 'studying').length },
      ...(opts.withTopics ? { topicList: ts.map((x) => topicView(x, Math.floor((tmin.get(x.id) ?? 0) / 60))) } : {}),
    };
  });
}

export const topicView = (x: TopicRow, minutes = 0): TopicView => ({ id: x.id, subjectId: x.subject_id, title: x.title, notes: x.notes, status: x.status, position: x.position, completedAt: iso(x.completed_at), minutes, version: x.version });

export async function createSubject(c: Q, userId: string, s: SubjectInput, origin: 'user' | 'ai', id: string = randomUUID()): Promise<SubjectRow> {
  const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_subjects WHERE user_id = $1 AND NOT archived', [userId])).rows[0].n;
  if (n >= KNOWLEDGE_LIMITS.subjects) throw new ApiError('life_limit');
  const dup = (await c.query('SELECT 1 FROM knowledge_subjects WHERE user_id = $1 AND NOT archived AND lower(name) = lower($2)', [userId, s.name])).rowCount;
  if (dup) throw new ApiError('validation_failed', { name: 'Já existe uma matéria com esse nome.' });
  return (
    await c.query<SubjectRow>(
      'INSERT INTO knowledge_subjects (id, user_id, name, description, category, color, weekly_goal_min, notes, origin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [id, userId, s.name, s.description, s.category, s.color, s.weeklyGoalMin ?? null, s.notes, origin],
    )
  ).rows[0];
}

export async function updateSubject(c: Q, userId: string, id: string, p: SubjectPatch, version?: number | null): Promise<{ before: SubjectRow; after: SubjectRow }> {
  const before = await getSubject(c, userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && version !== before.version) throw new ApiError('life_stale');
  const r = await c.query<SubjectRow>(
    `UPDATE knowledge_subjects SET name = $3, description = $4, category = $5, color = $6, weekly_goal_min = $7, notes = $8, archived = $9, version = version + 1, updated_at = now()
       WHERE user_id = $1 AND id = $2 RETURNING *`,
    [
      userId,
      id,
      p.name ?? before.name,
      p.description !== undefined ? p.description : before.description,
      p.category !== undefined ? p.category : before.category,
      p.color ?? before.color,
      p.weeklyGoalMin !== undefined ? p.weeklyGoalMin : before.weekly_goal_min,
      p.notes !== undefined ? p.notes : before.notes,
      p.archived ?? before.archived,
    ],
  );
  return { before, after: r.rows[0] };
}

export async function deleteSubject(t: LifeTx, id: string): Promise<void> {
  const s = await getSubject(t.c, t.userId, id, true);
  if (!s) throw new ApiError('not_found');
  for (const g of (await t.c.query<{ id: string }>('SELECT id FROM knowledge_goals WHERE user_id = $1 AND subject_id = $2', [t.userId, id])).rows) await reverseGoalGrants(t, g.id, 'Meta removida com a matéria');
  await t.c.query('DELETE FROM knowledge_subjects WHERE user_id = $1 AND id = $2', [t.userId, id]);
}

export async function createTopics(c: Q, userId: string, subjectId: string, list: TopicInput[], origin: 'user' | 'ai', ids?: string[]): Promise<TopicRow[]> {
  const s = await getSubject(c, userId, subjectId, true);
  if (!s) throw new ApiError('not_found');
  const cur = (await c.query<{ n: number; p: number }>('SELECT count(*)::int AS n, coalesce(max(position), -1)::int AS p FROM knowledge_topics WHERE user_id = $1 AND subject_id = $2', [userId, subjectId])).rows[0];
  if (cur.n + list.length > KNOWLEDGE_LIMITS.topicsPerSubject) throw new ApiError('life_limit');
  const out: TopicRow[] = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    out.push(
      (
        await c.query<TopicRow>(
          'INSERT INTO knowledge_topics (id, user_id, subject_id, title, notes, status, position, completed_at, origin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
          [ids?.[i] ?? randomUUID(), userId, subjectId, x.title, x.notes, x.status, Math.min(999, cur.p + 1 + i), x.status === 'done' ? new Date() : null, origin],
        )
      ).rows[0],
    );
  }
  return out;
}

export async function updateTopic(c: Q, userId: string, id: string, p: { title?: string; notes?: string | null; status?: TopicStatus; position?: number }, version?: number | null): Promise<TopicRow> {
  const b = await getTopic(c, userId, id, true);
  if (!b) throw new ApiError('not_found');
  if (version != null && version !== b.version) throw new ApiError('life_stale');
  const status = p.status ?? b.status;
  return (
    await c.query<TopicRow>(
      `UPDATE knowledge_topics SET title = $3, notes = $4, status = $5, position = $6, completed_at = $7, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, id, p.title ?? b.title, p.notes !== undefined ? p.notes : b.notes, status, p.position ?? b.position, status === 'done' ? (b.completed_at ?? new Date()) : null],
    )
  ).rows[0];
}

export async function deleteTopic(c: Q, userId: string, id: string): Promise<void> {
  const r = await c.query('DELETE FROM knowledge_topics WHERE user_id = $1 AND id = $2', [userId, isUuid(id) ? id : '00000000-0000-0000-0000-000000000000']);
  if (!r.rowCount) throw new ApiError('not_found');
}

// ------------------------------------------------------------------ anotações

interface NoteRow {
  id: string;
  book_id: string | null;
  subject_id: string | null;
  topic_id: string | null;
  kind: NoteKind;
  content: string;
  page: number | null;
  created_at: Date;
  updated_at: Date;
}
const noteView = (n: NoteRow): NoteView => ({ id: n.id, bookId: n.book_id, subjectId: n.subject_id, topicId: n.topic_id, kind: n.kind, content: n.content, page: n.page, createdAt: iso(n.created_at)!, updatedAt: iso(n.updated_at)! });

export async function noteViews(c: Q, userId: string, f: { bookId?: string | null; subjectId?: string | null; topicId?: string | null; limit?: number }): Promise<NoteView[]> {
  const p: unknown[] = [userId];
  const w: string[] = [];
  for (const [col, v] of [['book_id', f.bookId], ['subject_id', f.subjectId], ['topic_id', f.topicId]] as const) {
    if (v) {
      if (!isUuid(v)) return [];
      p.push(v);
      w.push(`${col} = $${p.length}`);
    }
  }
  const lim = Math.min(500, Math.max(1, f.limit ?? 200));
  return (await c.query<NoteRow>(`SELECT * FROM knowledge_notes WHERE user_id = $1 ${w.length ? `AND (${w.join(' OR ')})` : ''} ORDER BY created_at DESC LIMIT ${lim}`, p)).rows.map(noteView);
}

export async function createNote(c: Q, userId: string, n: NoteInput): Promise<NoteView> {
  if (n.bookId && !(await getBook(c, userId, n.bookId))) throw new ApiError('validation_failed', { bookId: 'Livro não encontrado.' });
  if (n.subjectId && !(await getSubject(c, userId, n.subjectId))) throw new ApiError('validation_failed', { subjectId: 'Matéria não encontrada.' });
  if (n.topicId && !(await getTopic(c, userId, n.topicId))) throw new ApiError('validation_failed', { topicId: 'Tópico não encontrado.' });
  const cnt = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_notes WHERE user_id = $1 AND (book_id = $2 OR subject_id = $3)', [userId, n.bookId ?? null, n.subjectId ?? null])).rows[0].n;
  if (cnt >= KNOWLEDGE_LIMITS.notesPerTarget) throw new ApiError('life_limit');
  const r = await c.query<NoteRow>('INSERT INTO knowledge_notes (id, user_id, book_id, subject_id, topic_id, kind, content, page) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [randomUUID(), userId, n.bookId ?? null, n.subjectId ?? null, n.topicId ?? null, n.kind, n.content, n.page ?? null]);
  return noteView(r.rows[0]);
}

export async function updateNote(c: Q, userId: string, id: string, p: { content?: string; kind?: NoteKind; page?: number | null }): Promise<NoteView> {
  if (!isUuid(id)) throw new ApiError('not_found');
  const r = await c.query<NoteRow>(
    'UPDATE knowledge_notes SET content = coalesce($3, content), kind = coalesce($4, kind), page = CASE WHEN $5::boolean THEN $6 ELSE page END, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *',
    [userId, id, p.content ?? null, p.kind ?? null, p.page !== undefined, p.page ?? null],
  );
  if (!r.rows[0]) throw new ApiError('not_found');
  return noteView(r.rows[0]);
}

export async function deleteNote(c: Q, userId: string, id: string): Promise<void> {
  if (!isUuid(id) || !(await c.query('DELETE FROM knowledge_notes WHERE user_id = $1 AND id = $2', [userId, id])).rowCount) throw new ApiError('not_found');
}

// ------------------------------------------------------------------ alvo de uma sessão (livro/matéria/tópico/atividade)

interface Target {
  bookId: string | null;
  subjectId: string | null;
  topicId: string | null;
  label: string | null;
  title: string;
}

async function resolveTarget(c: Q, userId: string, kind: SessionKind, x: { bookId?: string | null; subjectId?: string | null; topicId?: string | null; label?: string | null }): Promise<Target> {
  let subjectId = x.subjectId ?? null;
  let topicTitle: string | null = null;
  if (x.topicId) {
    const tp = await getTopic(c, userId, x.topicId);
    if (!tp) throw new ApiError('validation_failed', { topicId: 'Tópico não encontrado.' });
    if (subjectId && tp.subject_id !== subjectId) throw new ApiError('validation_failed', { topicId: 'O tópico é de outra matéria.' });
    subjectId = tp.subject_id;
    topicTitle = tp.title;
  }
  let book: BookRow | null = null;
  if (x.bookId) {
    book = await getBook(c, userId, x.bookId);
    if (!book) throw new ApiError('validation_failed', { bookId: 'Livro não encontrado.' });
  }
  let subject: SubjectRow | null = null;
  if (subjectId) {
    subject = await getSubject(c, userId, subjectId);
    if (!subject) throw new ApiError('validation_failed', { subjectId: 'Matéria não encontrada.' });
  }
  const label = x.label ?? null;
  const title = (book ? book.title : subject ? (topicTitle ? `${subject.name} · ${topicTitle}` : subject.name) : label) ?? (kind === 'reading' ? 'Leitura livre' : kind === 'study' ? 'Estudo livre' : 'Foco');
  return { bookId: book?.id ?? null, subjectId: subject?.id ?? null, topicId: x.topicId ?? null, label, title: title.slice(0, 160) };
}

// ------------------------------------------------------------------ sessões

export interface SessionRow {
  id: string;
  module: KnowledgeModule;
  kind: SessionKind;
  mode: TimerMode | 'manual';
  origin: SessionOrigin;
  book_id: string | null;
  subject_id: string | null;
  topic_id: string | null;
  label: string | null;
  title: string;
  ref: string | null;
  date: string;
  started_at: Date | null;
  ended_at: Date | null;
  active_sec: number;
  pause_sec: number;
  excluded_sec: number;
  focus_blocks: number;
  page_before: number | null;
  page_start: number | null;
  page_end: number | null;
  pages_read: number;
  note: string | null;
  segments: Segment[] | null;
  client_id: string | null;
  version: number;
  created_at: Date;
}

const sessionKey = (s: Pick<SessionRow, 'id' | 'origin'>) => (s.origin === 'timer' ? `knowledge:session:${s.id}` : `knowledge:manual:${s.id}`);

export function sessionView(s: SessionRow, xp = 0): SessionView {
  return {
    id: s.id,
    module: s.module,
    kind: s.kind,
    mode: s.mode,
    origin: s.origin,
    bookId: s.book_id,
    subjectId: s.subject_id,
    topicId: s.topic_id,
    label: s.label,
    title: s.title,
    date: s.date,
    startedAt: iso(s.started_at),
    endedAt: iso(s.ended_at),
    activeMin: Math.floor(s.active_sec / 60),
    activeSec: s.active_sec,
    pauseSec: s.pause_sec,
    excludedSec: s.excluded_sec,
    focusBlocks: s.focus_blocks,
    pageStart: s.page_start,
    pageEnd: s.page_end,
    pagesRead: s.pages_read,
    note: s.note,
    xp,
    version: s.version,
  };
}

export async function getSession(c: Q, userId: string, id: string, lock = false): Promise<SessionRow | null> {
  if (!isUuid(id)) return null;
  return (await c.query<SessionRow>(`SELECT * FROM knowledge_sessions WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}

export async function sessionViews(c: Q, userId: string, f: { from?: string; to?: string; bookId?: string; subjectId?: string; kind?: SessionKind; ids?: string[]; limit?: number } = {}): Promise<SessionView[]> {
  const p: unknown[] = [userId];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    w.push(sql.replace('?', `$${p.length}`));
  };
  if (f.from) add('date >= ?', f.from);
  if (f.to) add('date <= ?', f.to);
  if (f.bookId) add('book_id = ?', isUuid(f.bookId) ? f.bookId : null);
  if (f.subjectId) add('subject_id = ?', isUuid(f.subjectId) ? f.subjectId : null);
  if (f.kind) add('kind = ?', f.kind);
  if (f.ids) add('id = ANY(?)', f.ids.filter(isUuid));
  const lim = Math.min(500, Math.max(1, f.limit ?? 200));
  const rows = (await c.query<SessionRow>(`SELECT * FROM knowledge_sessions WHERE user_id = $1 ${w.map((x) => `AND ${x}`).join(' ')} ORDER BY date DESC, coalesce(started_at, created_at) DESC LIMIT ${lim}`, p)).rows;
  if (!rows.length) return [];
  const keys = rows.map(sessionKey);
  const xp = new Map((await c.query<{ source_key: string; amount: number }>("SELECT source_key, amount FROM life_xp_events WHERE user_id = $1 AND kind = 'grant' AND reversed_at IS NULL AND source_key = ANY($2)", [userId, keys])).rows.map((x) => [x.source_key, x.amount]));
  return rows.map((r) => sessionView(r, xp.get(sessionKey(r)) ?? 0));
}

interface NewSession {
  id: string;
  clientId: string | null;
  kind: SessionKind;
  mode: TimerMode | 'manual';
  origin: SessionOrigin;
  target: Target;
  date: string;
  startedAt: Date | null;
  endedAt: Date | null;
  activeSec: number;
  pauseSec: number;
  excludedSec: number;
  focusBlocks: number;
  segments: Segment[] | null;
  pageEnd: number | null;
  pagesRead: number | null;
  finishBook: boolean;
  note: string | null;
}

async function insertSession(t: LifeTx, s: NewSession): Promise<SessionRow> {
  const cnt = (await t.c.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_sessions WHERE user_id = $1 AND date = $2', [t.userId, s.date])).rows[0].n;
  if (cnt >= KNOWLEDGE_LIMITS.sessionsPerDay) throw new ApiError('life_limit');
  let pageBefore: number | null = null;
  let pageStart: number | null = null;
  let pageEnd: number | null = null;
  let pagesRead = s.pagesRead ?? 0;
  let book: BookRow | null = null;
  if (s.target.bookId) {
    book = await getBook(t.c, t.userId, s.target.bookId, true);
    if (!book) throw new ApiError('validation_failed', { bookId: 'Livro não encontrado.' });
    pageBefore = book.current_page;
    pageStart = book.current_page;
    let next = book.current_page;
    if (s.pageEnd != null) {
      if (book.total_pages && s.pageEnd > book.total_pages) throw new ApiError('knowledge_pages');
      pageEnd = s.pageEnd;
      if (s.pagesRead == null) pagesRead = Math.max(0, s.pageEnd - book.current_page);
      next = Math.max(book.current_page, s.pageEnd);
    } else if (pagesRead > 0) {
      next = book.total_pages ? Math.min(book.total_pages, book.current_page + pagesRead) : book.current_page + pagesRead;
      pageEnd = next;
    }
    pagesRead = Math.min(2000, pagesRead);
    const done = s.finishBook || false;
    const status: BookStatus = done ? 'done' : book.status === 'done' ? 'done' : 'reading';
    if (done && book.total_pages) next = book.total_pages;
    await t.c.query(
      `UPDATE knowledge_books SET current_page = $3, status = $4, started_on = coalesce(started_on, $5), finished_on = CASE WHEN $4 = 'done' THEN coalesce(finished_on, $6) ELSE NULL END, version = version + 1, updated_at = now()
         WHERE user_id = $1 AND id = $2`,
      [t.userId, book.id, next, status, s.date, t.today],
    );
  }
  const r = await t.c.query<SessionRow>(
    `INSERT INTO knowledge_sessions (id, user_id, module, kind, mode, origin, book_id, subject_id, topic_id, label, title, date, started_at, ended_at, active_sec, pause_sec, excluded_sec, focus_blocks,
       page_before, page_start, page_end, pages_read, note, segments, client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25) RETURNING *`,
    [
      s.id, t.userId, MODULE, s.kind, s.mode, s.origin, s.target.bookId, s.target.subjectId, s.target.topicId, s.target.label, s.target.title, s.date, s.startedAt, s.endedAt,
      Math.min(36000, s.activeSec), s.pauseSec, s.excludedSec, s.focusBlocks, pageBefore, pageStart, pageEnd, pagesRead, s.note, s.segments ? JSON.stringify(s.segments) : null, s.clientId,
    ],
  );
  if (s.target.topicId) await t.c.query("UPDATE knowledge_topics SET status = 'studying', version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 AND status = 'pending'", [t.userId, s.target.topicId]);
  await sessionEffects(t, r.rows[0]);
  if (book) await syncBookReward(t, (await getBook(t.c, t.userId, book.id))!);
  return r.rows[0];
}

/** Datas aceitas para registro manual: até 30 dias para trás, nunca no futuro. */
function checkManualDate(t: LifeTx, date: string): void {
  if (date > t.today || date < addDays(t.today, -KNOWLEDGE_LIMITS.manualPastDays)) throw new ApiError('knowledge_date_not_allowed');
}

export async function createManualSession(t: LifeTx, m: ManualSession, origin: 'manual' | 'ai', id: string = randomUUID()): Promise<{ id: string; existed: boolean }> {
  const ex = await t.c.query<{ id: string }>('SELECT id FROM knowledge_sessions WHERE user_id = $1 AND client_id = $2', [t.userId, m.clientId]);
  if (ex.rows[0]) return { id: ex.rows[0].id, existed: true };
  checkManualDate(t, m.date);
  const target = await resolveTarget(t.c, t.userId, m.kind, m);
  const row = await insertSession(t, {
    id,
    clientId: m.clientId,
    kind: m.kind,
    mode: 'manual',
    origin,
    target,
    date: m.date,
    startedAt: null,
    endedAt: null,
    activeSec: m.minutes * 60,
    pauseSec: 0,
    excludedSec: 0,
    focusBlocks: 0,
    segments: null,
    pageEnd: m.pageEnd ?? null,
    pagesRead: m.pagesRead ?? null,
    finishBook: m.finishBook,
    note: m.note,
  });
  return { id: row.id, existed: false };
}

export async function updateSession(t: LifeTx, id: string, p: { note?: string | null; topicId?: string | null; minutes?: number; pagesRead?: number }, version?: number | null): Promise<SessionRow> {
  const s = await getSession(t.c, t.userId, id, true);
  if (!s) throw new ApiError('not_found');
  if (version != null && version !== s.version) throw new ApiError('life_stale');
  let active = s.active_sec;
  if (p.minutes !== undefined) {
    // Cronômetro: só para menos (o servidor mediu). Manual: livre dentro do limite.
    if (s.origin === 'timer' && p.minutes * 60 > s.active_sec) throw new ApiError('validation_failed', { minutes: 'O tempo do cronômetro só pode ser reduzido.' });
    active = p.minutes * 60;
  }
  let topicId = s.topic_id;
  if (p.topicId !== undefined) {
    if (p.topicId) {
      const tp = await getTopic(t.c, t.userId, p.topicId);
      if (!tp || (s.subject_id && tp.subject_id !== s.subject_id)) throw new ApiError('validation_failed', { topicId: 'Tópico não encontrado nesta matéria.' });
    }
    topicId = p.topicId;
  }
  const r = await t.c.query<SessionRow>(
    'UPDATE knowledge_sessions SET note = $3, topic_id = $4, active_sec = $5, pages_read = $6, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *',
    [t.userId, id, p.note !== undefined ? p.note : s.note, topicId, active, p.pagesRead ?? s.pages_read],
  );
  if (active !== s.active_sec || (p.pagesRead !== undefined && p.pagesRead !== s.pages_read)) {
    await syncSessionReward(t, r.rows[0]);
    await recomputeGoals(t, [s.date]);
  }
  return r.rows[0];
}

/** Exclui a sessão: estorna o XP dela, devolve a página do livro (se ainda for a mesma) e recalcula metas/missões. */
export async function deleteSession(t: LifeTx, id: string): Promise<SessionRow> {
  const s = await getSession(t.c, t.userId, id, true);
  if (!s) throw new ApiError('not_found');
  await t.c.query('DELETE FROM knowledge_sessions WHERE user_id = $1 AND id = $2', [t.userId, id]);
  if (s.book_id && s.page_before != null && s.page_end != null) {
    await t.c.query('UPDATE knowledge_books SET current_page = $4, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 AND current_page = $3 AND status <> \'done\'', [t.userId, s.book_id, s.page_end, s.page_before]);
  }
  await reverse(t, sessionKey(s), `Sessão excluída: ${s.title}`.slice(0, 200));
  // Registro na missão vinculada (se houver) sai junto; a missão recalcula (e estorna, se deixar de estar concluída).
  const me = await t.c.query<{ mission_id: string }>('DELETE FROM life_mission_entries WHERE user_id = $1 AND source_key = $2 RETURNING mission_id', [t.userId, `knowledge:session:${id}`]);
  for (const x of me.rows) {
    const m = (await t.c.query<MissionRow>('SELECT * FROM life_missions WHERE user_id = $1 AND id = $2 FOR UPDATE', [t.userId, x.mission_id])).rows[0];
    if (m) await recomputeMission(t, m);
  }
  await recomputeGoals(t, [s.date]);
  if (s.book_id) {
    const b = await getBook(t.c, t.userId, s.book_id);
    if (b) await syncBookReward(t, b);
  }
  return s;
}

/** Efeitos de uma sessão nova: XP da sessão, registro na missão vinculada (no máximo uma), metas e hábitos vinculados. */
async function sessionEffects(t: LifeTx, s: SessionRow): Promise<void> {
  await syncSessionReward(t, s);
  await feedMission(t, s);
  await recomputeGoals(t, [s.date]);
}

const inWindow = (t: LifeTx, date: string) => date <= t.today && date >= addDays(t.today, -1);

/**
 * XP da sessão (chave por sessão: reenvio/repetição nunca soma). Só hoje/ontem. Teto do módulo por dia e teto de
 * registros manuais. Foco sem livro/matéria vai para Disciplina; leitura e estudo, para Conhecimento.
 */
export async function syncSessionReward(t: LifeTx, s: SessionRow): Promise<void> {
  const key = sessionKey(s);
  const existing = await activeGrant(t.c, t.userId, key);
  let desired = sessionXp(s.active_sec, s.origin === 'timer' ? 'timer' : 'manual');
  if (!inWindow(t, s.date)) desired = existing ? Math.min(existing.amount, desired) : 0;
  if (existing && existing.amount === desired) return;
  if (existing) await reverse(t, key, `Sessão ajustada: ${s.title}`.slice(0, 200));
  if (desired <= 0) return;
  const used = (await t.c.query<{ all: number; manual: number }>(
    "SELECT coalesce(sum(amount), 0)::int AS all, coalesce(sum(amount) FILTER (WHERE source_key LIKE 'knowledge:manual:%'), 0)::int AS manual FROM life_xp_events WHERE user_id = $1 AND day = $2 AND source = 'knowledge' AND (source_key LIKE 'knowledge:session:%' OR source_key LIKE 'knowledge:manual:%')",
    [t.userId, s.date],
  )).rows[0];
  let amount = Math.min(desired, Math.max(0, KNOWLEDGE_REWARD.sessionsDailyMax - used.all));
  if (s.origin !== 'timer') amount = Math.min(amount, Math.max(0, KNOWLEDGE_REWARD.manualDailyMax - used.manual));
  const attribute = s.kind === 'focus' && !s.book_id && !s.subject_id ? 'discipline' : 'knowledge';
  const label = s.kind === 'reading' ? 'Leitura' : s.kind === 'study' ? 'Estudo' : 'Foco';
  const min = Math.floor(s.active_sec / 60);
  await grant(t, { source: 'knowledge', key, sourceId: s.id, attribute, requested: amount, day: s.date, reason: `${label}${s.origin === 'timer' ? '' : ' (registro manual)'}: ${s.title} · ${min} min`.slice(0, 200) });
}

// ------------------------------------------------------------------ metas

export interface GoalRow {
  id: string;
  module: KnowledgeModule;
  title: string;
  metric: GoalView['metric'];
  scope: GoalView['scope'];
  subject_id: string | null;
  book_id: string | null;
  period: GoalView['period'];
  target: number;
  days: number[];
  due_date: string | null;
  preferred_time: string | null;
  habit_id: string | null;
  mission_id: string | null;
  status: GoalView['status'];
  starts_on: string;
  origin: 'user' | 'ai';
  version: number;
}

export async function getGoal(c: Q, userId: string, id: string, lock = false): Promise<GoalRow | null> {
  if (!isUuid(id)) return null;
  return (await c.query<GoalRow>(`SELECT * FROM knowledge_goals WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}

export function periodOf(g: Pick<GoalRow, 'period' | 'starts_on' | 'due_date'>, date: string): { start: string; end: string } {
  if (g.period === 'daily') return { start: date, end: date };
  if (g.period === 'weekly') {
    const start = mondayOf(date);
    return { start, end: addDays(start, 6) };
  }
  return { start: g.starts_on, end: g.due_date ?? date };
}

/** Filtro SQL das sessões que contam para a meta (escopo, matéria, livro). */
function goalFilter(g: GoalRow, p: unknown[]): string {
  const w: string[] = [`module = '${g.module === 'bible' ? 'bible' : 'knowledge'}'`];
  if (g.scope !== 'any') {
    p.push(g.scope);
    w.push(`kind = $${p.length}`);
  }
  if (g.subject_id) {
    p.push(g.subject_id);
    w.push(`subject_id = $${p.length}`);
  }
  if (g.book_id) {
    p.push(g.book_id);
    w.push(`book_id = $${p.length}`);
  }
  return w.join(' AND ');
}

export const goalMatches = (g: GoalRow, s: Pick<SessionRow, 'kind' | 'subject_id' | 'book_id' | 'module'>) =>
  g.module === s.module && (g.scope === 'any' || g.scope === s.kind) && (!g.subject_id || g.subject_id === s.subject_id) && (!g.book_id || g.book_id === s.book_id);

export async function goalProgress(c: Q, userId: string, g: GoalRow, start: string, end: string): Promise<number> {
  if (g.metric === 'book_finish') {
    const b = g.book_id ? await getBook(c, userId, g.book_id) : null;
    return b && b.status === 'done' && b.finished_on && b.finished_on <= (g.due_date ?? b.finished_on) ? 1 : 0;
  }
  const p: unknown[] = [userId, start, end];
  const f = goalFilter(g, p);
  const agg = g.metric === 'minutes' ? 'coalesce(sum(active_sec), 0) / 60' : g.metric === 'pages' ? 'coalesce(sum(pages_read), 0)' : g.metric === 'sessions' ? 'count(*) FILTER (WHERE active_sec >= 60 OR pages_read > 0)' : 'count(DISTINCT date)';
  return Number((await c.query<{ n: number }>(`SELECT (${agg})::int AS n FROM knowledge_sessions WHERE user_id = $1 AND date BETWEEN $2 AND $3 AND ${f}`, p)).rows[0].n);
}

const goalKey = (g: Pick<GoalRow, 'id'>, start: string) => `knowledge:goal:${g.id}:${start}`;

async function reverseGoalGrants(t: LifeTx, goalId: string, reason: string): Promise<void> {
  const keys = (await t.c.query<{ source_key: string }>("SELECT source_key FROM life_xp_events WHERE user_id = $1 AND kind = 'grant' AND reversed_at IS NULL AND source_key LIKE $2", [t.userId, `knowledge:goal:${goalId}:%`])).rows;
  for (const k of keys) await reverse(t, k.source_key, reason);
}

/**
 * Recalcula as metas afetadas pelas datas: concede (uma vez por período) ou estorna. Só períodos que terminam a partir
 * de ontem rendem XP novo. Meta vinculada a hábito: o registro conclui o HÁBITO (XP dele) e a meta fica com 0 XP;
 * vinculada a missão: a missão paga ao ser concluída e a meta fica com 0 XP.
 */
export async function recomputeGoals(t: LifeTx, dates: string[], only: { goalId?: string; bookId?: string } = {}): Promise<void> {
  const p: unknown[] = [t.userId];
  let w = "status IN ('active', 'completed')";
  if (only.goalId) {
    p.push(only.goalId);
    w += ` AND id = $${p.length}`;
  }
  if (only.bookId) {
    p.push(only.bookId);
    w += ` AND book_id = $${p.length}`;
  }
  const goals = (await t.c.query<GoalRow>(`SELECT * FROM knowledge_goals WHERE user_id = $1 AND ${w} ORDER BY created_at`, p)).rows;
  for (const g of goals) {
    const periods = new Map<string, { start: string; end: string; date: string }>();
    for (const d of dates) {
      const per = periodOf(g, d);
      if (per.end < g.starts_on || (g.period === 'daily' && d < g.starts_on)) continue;
      periods.set(per.start, { ...per, date: d });
    }
    for (const per of periods.values()) await settleGoal(t, g, per);
  }
}

async function settleGoal(t: LifeTx, g: GoalRow, per: { start: string; end: string; date: string }): Promise<void> {
  const progress = await goalProgress(t.c, t.userId, g, per.start, per.end);
  const scheduled = g.period !== 'daily' || g.days.includes(weekday(per.date));
  const met = scheduled && progress >= g.target;
  const key = goalKey(g, per.start);
  const existing = await activeGrant(t.c, t.userId, key);
  let habitPays = false;
  // Hábito vinculado (metas diárias): o progresso real do dia vai para o hábito.
  if (g.habit_id && g.period === 'daily' && inWindow(t, per.date)) {
    const h = await getHabit(t.c, t.userId, g.habit_id);
    if (h && h.status === 'active' && scheduledOn({ ...h, start_date: h.start_date }, per.date) && per.date >= h.start_date) {
      const amount = h.goal_kind === 'check' ? (met ? 1 : 0) : (h.goal_kind === 'duration' && g.metric === 'minutes') || (h.goal_kind === 'count' && g.metric !== 'minutes') ? Math.min(10000, progress) : met ? h.goal_target : 0;
      const cur = (await t.c.query<{ amount: number }>('SELECT amount FROM life_habit_logs WHERE user_id = $1 AND habit_id = $2 AND date = $3', [t.userId, h.id, per.date])).rows[0];
      if ((cur ? cur.amount !== amount : amount > 0)) await logHabit(t, h.id, amount, per.date);
      habitPays = true;
    }
  }
  if (met) {
    if (existing) return;
    if (per.end < addDays(t.today, -1)) return;
    const linked = habitPays || !!g.mission_id;
    const day = per.end < t.today ? per.end : per.date <= t.today ? (per.date > per.start ? per.date : t.today < per.end ? t.today : per.end) : t.today;
    const attribute = g.metric === 'book_finish' ? 'knowledge' : 'discipline';
    await grant(t, { source: 'knowledge', key, sourceId: g.id, attribute, requested: linked ? 0 : goalXp(g.period), day: day > t.today ? t.today : day, reason: `Meta cumprida: ${g.title}${linked ? ' (XP pelo vínculo)' : ''}`.slice(0, 200) });
    return;
  }
  if (existing) await reverse(t, key, `Meta deixou de estar cumprida: ${g.title}`.slice(0, 200));
}

/** Sessão → registro na missão vinculada (a primeira meta ativa que combina). Uma sessão alimenta uma missão só. */
async function feedMission(t: LifeTx, s: SessionRow): Promise<void> {
  if (!inWindow(t, s.date)) return;
  const goals = (await t.c.query<GoalRow>("SELECT * FROM knowledge_goals WHERE user_id = $1 AND status = 'active' AND mission_id IS NOT NULL ORDER BY created_at", [t.userId])).rows.filter((g) => goalMatches(g, s));
  for (const g of goals) {
    const m = (await t.c.query<MissionRow>('SELECT * FROM life_missions WHERE user_id = $1 AND id = $2 FOR UPDATE', [t.userId, g.mission_id])).rows[0];
    if (!m || m.metric !== 'manual' || m.status !== 'active' || s.date < m.starts_on || s.date > m.ends_on) continue;
    const amount = m.unit === 'minutes' ? Math.floor(s.active_sec / 60) : m.unit === 'pages' ? s.pages_read : 1;
    if (amount <= 0) continue;
    const r = await t.c.query(
      `INSERT INTO life_mission_entries (id, user_id, mission_id, date, amount, note, source_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, source_key) WHERE source_key IS NOT NULL DO NOTHING`,
      [randomUUID(), t.userId, m.id, s.date, Math.min(10000, amount), `Sessão: ${s.title}`.slice(0, 200), `knowledge:session:${s.id}`],
    );
    if (r.rowCount) await recomputeMission(t, m);
    return;
  }
}

async function validateGoalLinks(t: LifeTx, g: { habitId?: string | null; missionId?: string | null; subjectId?: string | null; bookId?: string | null; period?: string }): Promise<void> {
  if (g.subjectId && !(await getSubject(t.c, t.userId, g.subjectId))) throw new ApiError('validation_failed', { subjectId: 'Matéria não encontrada.' });
  if (g.bookId && !(await getBook(t.c, t.userId, g.bookId))) throw new ApiError('validation_failed', { bookId: 'Livro não encontrado.' });
  if (g.habitId) {
    if (g.period && g.period !== 'daily') throw new ApiError('validation_failed', { habitId: 'Só metas diárias podem ser vinculadas a um hábito.' });
    if (!(await getHabit(t.c, t.userId, g.habitId))) throw new ApiError('validation_failed', { habitId: 'Hábito não encontrado.' });
  }
  if (g.missionId) {
    const m = (await t.c.query<{ metric: string }>('SELECT metric FROM life_missions WHERE user_id = $1 AND id = $2', [t.userId, g.missionId])).rows[0];
    if (!m || m.metric !== 'manual') throw new ApiError('validation_failed', { missionId: 'Missão não encontrada (só missões com registro manual).' });
  }
}

export async function defaultGoalTitle(c: Q, userId: string, g: GoalInput): Promise<string> {
  const subject = g.subjectId ? (await getSubject(c, userId, g.subjectId))?.name : null;
  const book = g.bookId ? (await getBook(c, userId, g.bookId))?.title : null;
  if (g.metric === 'book_finish') return `Terminar "${book ?? 'livro'}"`.slice(0, 80);
  const what = book ? `"${book}"` : subject ?? (g.scope === 'reading' ? 'leitura' : g.scope === 'study' ? 'estudo' : g.scope === 'focus' ? 'foco' : 'leitura/estudo');
  const per = g.period === 'daily' ? 'por dia' : g.period === 'weekly' ? 'por semana' : `até ${g.dueDate}`;
  const verb = g.scope === 'reading' || book ? 'Ler' : g.scope === 'study' || subject ? 'Estudar' : 'Focar';
  const qty = g.metric === 'minutes' ? `${g.target} min` : g.metric === 'pages' ? `${g.target} páginas` : g.metric === 'sessions' ? `${g.target} sessões` : `${g.target}× (dias)`;
  return (g.metric === 'pages' ? `Ler ${qty} ${book ? `de ${what} ` : ''}${per}` : `${verb} ${subject || book ? `${what} ` : ''}${qty} ${per}`).replace(/\s+/g, ' ').slice(0, 80);
}

export async function createGoal(t: LifeTx, g: GoalInput, origin: 'user' | 'ai', id: string = randomUUID()): Promise<GoalRow> {
  const n = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM knowledge_goals WHERE user_id = $1 AND status IN ('active', 'paused')", [t.userId])).rows[0].n;
  if (n >= KNOWLEDGE_LIMITS.goals) throw new ApiError('life_limit');
  await validateGoalLinks(t, g);
  if (g.dueDate && g.dueDate < t.today) throw new ApiError('validation_failed', { dueDate: 'O prazo já passou.' });
  const title = g.title ?? (await defaultGoalTitle(t.c, t.userId, g));
  const row = (
    await t.c.query<GoalRow>(
      `INSERT INTO knowledge_goals (id, user_id, title, metric, scope, subject_id, book_id, period, target, days, due_date, preferred_time, habit_id, mission_id, starts_on, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [id, t.userId, title, g.metric, g.scope, g.subjectId ?? null, g.bookId ?? null, g.period, g.target, g.days, g.dueDate ?? null, g.preferredTime ?? null, g.habitId ?? null, g.missionId ?? null, t.today, origin],
    )
  ).rows[0];
  await recomputeGoals(t, [t.today], { goalId: row.id });
  return row;
}

export async function updateGoal(t: LifeTx, id: string, p: GoalPatch, version?: number | null): Promise<{ before: GoalRow; after: GoalRow }> {
  const before = await getGoal(t.c, t.userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && version !== before.version) throw new ApiError('life_stale');
  const habitId = p.habitId !== undefined ? p.habitId : before.habit_id;
  const missionId = p.missionId !== undefined ? p.missionId : before.mission_id;
  if (habitId && missionId) throw new ApiError('validation_failed', { missionId: 'Vincule a um hábito OU a uma missão.' });
  await validateGoalLinks(t, { habitId: p.habitId, missionId: p.missionId, period: before.period });
  const r = await t.c.query<GoalRow>(
    `UPDATE knowledge_goals SET title = $3, target = $4, days = $5, due_date = $6, preferred_time = $7, habit_id = $8, mission_id = $9, status = $10, version = version + 1, updated_at = now()
       WHERE user_id = $1 AND id = $2 RETURNING *`,
    [
      t.userId,
      id,
      p.title ?? before.title,
      before.metric === 'book_finish' ? 1 : p.target ?? before.target,
      p.days ?? before.days,
      p.dueDate !== undefined ? p.dueDate : before.due_date,
      p.preferredTime !== undefined ? p.preferredTime : before.preferred_time,
      habitId,
      missionId,
      p.status ?? before.status,
    ],
  );
  const after = r.rows[0];
  if (after.status === 'archived' && before.status !== 'archived') {
    // Arquivar não apaga o que já foi conquistado; só deixa de acompanhar.
  } else await recomputeGoals(t, [t.today, addDays(t.today, -1)], { goalId: id });
  return { before, after };
}

export async function deleteGoal(t: LifeTx, id: string): Promise<GoalRow> {
  const g = await getGoal(t.c, t.userId, id, true);
  if (!g) throw new ApiError('not_found');
  await reverseGoalGrants(t, id, `Meta excluída: ${g.title}`.slice(0, 200));
  await t.c.query('DELETE FROM knowledge_goals WHERE user_id = $1 AND id = $2', [t.userId, id]);
  return g;
}

/** Recria uma meta exatamente como estava (desfazer do assistente). */
export async function restoreGoal(t: LifeTx, g: GoalRow): Promise<void> {
  await t.c.query('DELETE FROM knowledge_goals WHERE user_id = $1 AND id = $2', [t.userId, g.id]);
  await t.c.query(
    `INSERT INTO knowledge_goals (id, user_id, module, title, metric, scope, subject_id, book_id, period, target, days, due_date, preferred_time, habit_id, mission_id, status, starts_on, origin, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [g.id, t.userId, g.module, g.title, g.metric, g.scope, g.subject_id, g.book_id, g.period, g.target, g.days, g.due_date, g.preferred_time, g.habit_id, g.mission_id, g.status, g.starts_on, g.origin, g.version + 1],
  );
  await recomputeGoals(t, [t.today, addDays(t.today, -1)], { goalId: g.id });
}

export async function goalViews(c: Q, userId: string, today: string, opts: { includeArchived?: boolean; ids?: string[] } = {}): Promise<GoalView[]> {
  const p: unknown[] = [userId];
  let w = opts.includeArchived ? '' : " AND status <> 'archived'";
  if (opts.ids) {
    p.push(opts.ids.filter(isUuid));
    w += ` AND id = ANY($${p.length})`;
  }
  const rows = (await c.query<GoalRow>(`SELECT * FROM knowledge_goals WHERE user_id = $1${w} ORDER BY array_position(ARRAY['active','paused','completed','archived'], status), created_at`, p)).rows;
  const out: GoalView[] = [];
  const monday = mondayOf(today);
  for (const g of rows) {
    const per = periodOf(g, today);
    const progress = await goalProgress(c, userId, g, per.start, per.end);
    const scheduledToday = g.period !== 'daily' || g.days.includes(weekday(today));
    let week: GoalView['week'] = null;
    if (g.period === 'daily') {
      let met = 0;
      let scheduled = 0;
      for (let d = monday > g.starts_on ? monday : g.starts_on; d <= today; d = addDays(d, 1)) {
        if (!g.days.includes(weekday(d))) continue;
        scheduled++;
        if ((await goalProgress(c, userId, g, d, d)) >= g.target) met++;
      }
      week = { met, scheduled };
    }
    let linkedName: string | null = null;
    if (g.habit_id) linkedName = (await c.query<{ name: string }>('SELECT name FROM life_habits WHERE user_id = $1 AND id = $2', [userId, g.habit_id])).rows[0]?.name ?? null;
    if (g.mission_id) linkedName = (await c.query<{ title: string }>('SELECT title FROM life_missions WHERE user_id = $1 AND id = $2', [userId, g.mission_id])).rows[0]?.title ?? null;
    out.push({
      id: g.id,
      title: g.title,
      metric: g.metric,
      scope: g.scope,
      subjectId: g.subject_id,
      bookId: g.book_id,
      period: g.period,
      target: g.target,
      days: g.days,
      dueDate: g.due_date,
      preferredTime: g.preferred_time,
      habitId: g.habit_id,
      missionId: g.mission_id,
      status: g.status,
      origin: g.origin,
      version: g.version,
      current: { start: per.start, end: per.end, progress, met: scheduledToday && progress >= g.target, scheduledToday },
      week,
      linkedName,
    });
  }
  return out;
}

/** Coloca a meta (horário, duração) numa rotina da Fase 01 — existente ou nova. O hábito vinculado vai junto. */
export async function addGoalToRoutine(t: LifeTx, goalId: string, r: { routineId?: string | null; newRoutine?: { name: string; kind: 'morning' | 'study' | 'night' | 'custom'; days: number[] } | null; startTime?: string | null }): Promise<{ routineId: string; created: boolean }> {
  const g = await getGoal(t.c, t.userId, goalId);
  if (!g) throw new ApiError('not_found');
  const item = { title: g.title.slice(0, 80), startTime: r.startTime ?? g.preferred_time ?? null, durationMin: g.metric === 'minutes' && g.period === 'daily' ? Math.min(600, g.target) : null, habitId: g.habit_id, missionId: null };
  if (r.newRoutine) {
    const row = await createRoutine(t, { name: r.newRoutine.name, kind: r.newRoutine.kind, days: r.newRoutine.days, items: [item] }, 'user');
    return { routineId: row.id, created: true };
  }
  const snap = await routineSnapshot(t.c, t.userId, r.routineId!);
  if (!snap) throw new ApiError('validation_failed', { routineId: 'Rotina não encontrada.' });
  const items = [...snap.items.map((i) => ({ id: i.id, title: i.title, startTime: i.start_time, durationMin: i.duration_min, habitId: i.habit_id, missionId: i.mission_id })), item];
  if (items.length > 30) throw new ApiError('life_limit');
  await updateRoutine(t, snap.row.id, { items });
  if (!g.preferred_time && item.startTime) await t.c.query('UPDATE knowledge_goals SET preferred_time = $3, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2', [t.userId, g.id, item.startTime]);
  return { routineId: snap.row.id, created: false };
}

// ------------------------------------------------------------------ cronômetro

interface TimerState {
  segments: Segment[];
  seen: SeenRange[];
  phase: TimerPhase;
  phaseStartedAt: number;
  focusDone: number;
}
interface TimerRow {
  id: string;
  module: KnowledgeModule;
  kind: SessionKind;
  mode: TimerMode;
  book_id: string | null;
  subject_id: string | null;
  topic_id: string | null;
  label: string | null;
  title: string;
  planned_sec: number | null;
  pomodoro: PomodoroConfig | null;
  sound: boolean;
  start_page: number | null;
  state: TimerState;
  started_at: Date;
  last_seen_at: Date;
  version: number;
}

const unattendedFor = (r: Pick<TimerRow, 'mode' | 'planned_sec' | 'pomodoro'>) =>
  Math.max(TIMER_RULES.unattendedMaxSec * 1000, r.mode === 'pomodoro' && r.pomodoro ? r.pomodoro.focusMin * 60_000 : r.mode === 'countdown' && r.planned_sec ? r.planned_sec * 1000 : 0);

function timerActive(r: TimerRow, now: number) {
  return computeActive(r.state.segments, r.state.seen, now, {
    unattendedMaxMs: unattendedFor(r),
    segmentMaxMs: r.mode === 'pomodoro' && r.pomodoro ? r.pomodoro.focusMin * 60_000 + 2000 : null,
    totalMaxMs: r.mode === 'countdown' && r.planned_sec ? r.planned_sec * 1000 + 2000 : null,
  });
}

function phaseEnd(r: TimerRow): number | null {
  const st = r.state;
  if (st.phase === 'focus') {
    const open = st.segments[st.segments.length - 1];
    if (!open || open.e !== null) return null;
    const before = computeActive(st.segments.slice(0, -1), st.seen, open.s, { unattendedMaxMs: unattendedFor(r) }).activeSec * 1000;
    const lim = focusLimitMs(r.mode, r.planned_sec, r.pomodoro, before);
    return lim === null ? null : open.s + lim;
  }
  if ((st.phase === 'short_break' || st.phase === 'long_break') && r.pomodoro) return st.phaseStartedAt + (st.phase === 'long_break' ? r.pomodoro.longBreakMin : r.pomodoro.shortBreakMin) * 60_000;
  return null;
}

function timerView(r: TimerRow, now: number): TimerView {
  return {
    id: r.id,
    module: r.module,
    kind: r.kind,
    mode: r.mode,
    bookId: r.book_id,
    subjectId: r.subject_id,
    topicId: r.topic_id,
    label: r.label,
    title: r.title,
    plannedSec: r.planned_sec,
    pomodoro: r.pomodoro,
    sound: r.sound,
    startPage: r.start_page,
    phase: r.state.phase,
    phaseStartedAt: r.state.phaseStartedAt,
    phaseEndsAt: phaseEnd(r),
    focusDone: r.state.focusDone,
    segments: r.state.segments,
    seen: r.state.seen,
    startedAt: new Date(r.started_at).getTime(),
    lastSeenAt: new Date(r.last_seen_at).getTime(),
    active: timerActive(r, now),
    stale: now - new Date(r.last_seen_at).getTime() > TIMER_RULES.staleAfterSec * 1000,
    version: r.version,
    serverNow: now,
  };
}

async function getTimer(c: Q, userId: string, lock = false): Promise<TimerRow | null> {
  return (await c.query<TimerRow>(`SELECT * FROM knowledge_timers WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId])).rows[0] ?? null;
}

export async function currentTimer(c: Q, userId: string, now: number): Promise<TimerView | null> {
  const r = await getTimer(c, userId);
  return r ? timerView(r, now) : null;
}

export async function startTimer(t: LifeTx, s: TimerStart): Promise<TimerView> {
  const cur = await getTimer(t.c, t.userId, true);
  if (cur) {
    if (cur.id === s.id) return timerView(cur, t.now);
    throw new ApiError('knowledge_timer_active');
  }
  if (await getSession(t.c, t.userId, s.id)) throw new ApiError('knowledge_timer_missing');
  const target = await resolveTarget(t.c, t.userId, s.kind, s);
  const book = target.bookId ? await getBook(t.c, t.userId, target.bookId) : null;
  const now = t.now;
  const state: TimerState = { segments: [{ s: now, e: null }], seen: [[now, now]], phase: 'focus', phaseStartedAt: now, focusDone: 0 };
  const r = await t.c.query<TimerRow>(
    `INSERT INTO knowledge_timers (user_id, id, module, kind, mode, book_id, subject_id, topic_id, label, title, planned_sec, pomodoro, sound, start_page, state, started_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16) RETURNING *`,
    [t.userId, s.id, MODULE, s.kind, s.mode, target.bookId, target.subjectId, target.topicId, target.label, target.title, s.mode === 'countdown' ? (s.plannedMin ?? 25) * 60 : null, s.mode === 'pomodoro' ? JSON.stringify(s.pomodoro) : null, s.sound, book?.current_page ?? null, JSON.stringify(state), new Date(now)],
  );
  return timerView(r.rows[0], now);
}

/** Limita um horário informado pelo app ao intervalo válido: depois do último evento, nunca no futuro. */
function clampAt(at: string | null | undefined, floor: number, now: number): number {
  const v = at ? Date.parse(at) : now;
  if (!Number.isFinite(v)) return now;
  return Math.min(now, Math.max(floor, v));
}
const lastEventAt = (st: TimerState) => {
  const last = st.segments[st.segments.length - 1];
  return Math.max(st.phaseStartedAt, last ? (last.e ?? last.s) : 0);
};

function closeFocus(r: TimerRow, at: number): void {
  const st = r.state;
  const open = st.segments[st.segments.length - 1];
  if (!open || open.e !== null) return;
  const end = phaseEnd(r);
  open.e = Math.max(open.s, end !== null ? Math.min(at, end) : at);
}

export async function timerEvents(t: LifeTx, id: string, events: { type: 'pause' | 'resume' | 'seen' | 'break'; at?: string | null }[], version?: number): Promise<TimerView> {
  const r = await getTimer(t.c, t.userId, true);
  if (!r || r.id !== id) throw new ApiError('knowledge_timer_missing');
  void version;
  const st = r.state;
  for (const ev of events) {
    if (ev.type === 'seen') {
      const at = clampAt(ev.at, new Date(r.started_at).getTime(), t.now);
      st.seen = addSeen(st.seen, at);
      continue;
    }
    const at = clampAt(ev.at, lastEventAt(st), t.now);
    st.seen = addSeen(st.seen, at);
    if (ev.type === 'pause') {
      if (st.phase === 'focus') closeFocus(r, at);
      if (st.phase !== 'paused') {
        st.phase = 'paused';
        st.phaseStartedAt = at;
      }
    } else if (ev.type === 'break') {
      if (r.mode !== 'pomodoro' || !r.pomodoro || st.phase !== 'focus') continue;
      closeFocus(r, at);
      st.focusDone += 1;
      const b = breakPhaseAfter(st.focusDone, r.pomodoro);
      st.phase = b.phase;
      // A pausa começa quando o foco terminou de fato (fim planejado), mesmo se o app só soube depois.
      st.phaseStartedAt = st.segments[st.segments.length - 1].e ?? at;
    } else if (ev.type === 'resume') {
      if (st.phase === 'focus') continue;
      if (r.mode === 'countdown' && r.planned_sec && timerActive(r, at).activeSec >= r.planned_sec) continue;
      st.segments.push({ s: at, e: null });
      if (st.segments.length > 300) throw new ApiError('life_limit');
      st.phase = 'focus';
      st.phaseStartedAt = at;
    }
  }
  const lastSeen = st.seen.length ? st.seen[st.seen.length - 1][1] : new Date(r.last_seen_at).getTime();
  const u = await t.c.query<TimerRow>('UPDATE knowledge_timers SET state = $2, last_seen_at = $3, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING *', [t.userId, JSON.stringify(st), new Date(Math.max(lastSeen, new Date(r.last_seen_at).getTime()))]);
  return timerView(u.rows[0], t.now);
}

export async function discardTimer(t: LifeTx, id: string): Promise<void> {
  const r = await t.c.query('DELETE FROM knowledge_timers WHERE user_id = $1 AND id = $2', [t.userId, isUuid(id) ? id : null]);
  if (!r.rowCount) throw new ApiError('knowledge_timer_missing');
}

/** Encerra: fecha o trecho aberto, calcula o tempo que conta, grava a sessão (id = id do cronômetro) e recompensa. */
export async function finishTimer(t: LifeTx, id: string, f: TimerFinish): Promise<{ id: string; existed: boolean; excludedSec: number }> {
  const r = await getTimer(t.c, t.userId, true);
  if (!r || r.id !== id) {
    if (await getSession(t.c, t.userId, id)) return { id, existed: true, excludedSec: 0 };
    throw new ApiError('knowledge_timer_missing');
  }
  const st = r.state;
  const at = clampAt(f.at, lastEventAt(st), t.now);
  if (st.phase === 'focus') closeFocus(r, at);
  const end = Math.max(...st.segments.map((x) => x.e ?? at), new Date(r.started_at).getTime());
  const act = timerActive(r, end);
  let activeSec = act.activeSec;
  if (f.activeMin != null) activeSec = Math.min(activeSec, f.activeMin * 60);
  const hasPages = (f.pagesRead ?? 0) > 0 || f.pageEnd != null;
  if (activeSec < TIMER_RULES.minSaveSec && !hasPages) throw new ApiError('validation_failed', { activeMin: 'Sessão curta demais para salvar (menos de 1 minuto). Descarte ou continue.' });
  const startedAt = new Date(r.started_at);
  const wall = Math.max(0, Math.round((end - startedAt.getTime()) / 1000));
  const target: Target = { bookId: r.book_id, subjectId: r.subject_id, topicId: r.topic_id, label: r.label, title: r.title };
  await t.c.query('DELETE FROM knowledge_timers WHERE user_id = $1', [t.userId]);
  await insertSession(t, {
    id: r.id,
    clientId: null,
    kind: r.kind,
    mode: r.mode,
    origin: 'timer',
    target,
    date: localDate(startedAt.getTime(), t.tz),
    startedAt,
    endedAt: new Date(end),
    activeSec,
    pauseSec: Math.max(0, wall - act.rawSec),
    excludedSec: act.excludedSec + (act.activeSec - activeSec),
    focusBlocks: r.mode === 'pomodoro' ? st.segments.filter((x) => x.e !== null && x.e - x.s >= 60_000).length : 0,
    segments: st.segments,
    pageEnd: f.pageEnd ?? null,
    pagesRead: f.pagesRead ?? null,
    finishBook: f.finishBook,
    note: f.note,
  });
  return { id: r.id, existed: false, excludedSec: act.excludedSec };
}

// ------------------------------------------------------------------ painel e estatísticas

export async function dashboard(t: Pick<LifeTx, 'c' | 'userId' | 'today' | 'now'>): Promise<KnowledgeDashboardView> {
  const { c, userId, today } = t;
  const from = addDays(today, -6);
  const days = (await c.query<{ date: string; kind: SessionKind; sec: number; n: number; pages: number }>('SELECT date, kind, sum(active_sec)::int AS sec, count(*)::int AS n, sum(pages_read)::int AS pages FROM knowledge_sessions WHERE user_id = $1 AND module = $2 AND date BETWEEN $3 AND $4 GROUP BY date, kind', [userId, MODULE, from, today])).rows;
  const of = (d: string, k: SessionKind) => days.find((x) => x.date === d && x.kind === k);
  const todayRows = days.filter((x) => x.date === today);
  const xp = (await c.query<{ n: number }>("SELECT coalesce(sum(amount), 0)::int AS n FROM life_xp_events WHERE user_id = $1 AND day = $2 AND source = 'knowledge' AND kind = 'grant' AND reversed_at IS NULL", [userId, today])).rows[0].n;
  const week: KnowledgeDashboardView['week'] = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const any = days.some((x) => x.date === d);
    const m = (k: SessionKind) => (any ? Math.floor((of(d, k)?.sec ?? 0) / 60) : null);
    week.push({ date: d, reading: m('reading'), study: m('study'), focus: m('focus') });
  }
  const subjects = await subjectViews(c, userId, today);
  return {
    protocol: KNOWLEDGE_PROTOCOL,
    today,
    readingMin: Math.floor((of(today, 'reading')?.sec ?? 0) / 60),
    studyMin: Math.floor((of(today, 'study')?.sec ?? 0) / 60),
    focusMin: Math.floor((of(today, 'focus')?.sec ?? 0) / 60),
    sessionsToday: todayRows.reduce((s, x) => s + x.n, 0),
    pagesToday: todayRows.reduce((s, x) => s + x.pages, 0),
    xpToday: xp,
    goals: (await goalViews(c, userId, today)).filter((g) => g.status === 'active'),
    reading: await bookViews(c, userId, today, { status: ['reading'] }),
    subjectsWeek: subjects.filter((s) => s.minutesWeek > 0 || s.weeklyGoalMin).map((s) => ({ id: s.id, name: s.name, color: s.color, minutes: s.minutesWeek, goal: s.weeklyGoalMin })),
    week,
    timer: await currentTimer(c, userId, t.now),
    recent: await sessionViews(c, userId, { limit: 5 }),
  };
}

export async function statsView(c: Q, userId: string, from: string, to: string, today: string, tz: string): Promise<KnowledgeStatsView> {
  const rows = (await c.query<{ date: string; kind: SessionKind; sec: number; n: number; pages: number }>('SELECT date, kind, sum(active_sec)::int AS sec, count(*)::int AS n, sum(pages_read)::int AS pages FROM knowledge_sessions WHERE user_id = $1 AND module = $2 AND date BETWEEN $3 AND $4 GROUP BY date, kind ORDER BY date', [userId, MODULE, from, to])).rows;
  const byDay = new Map<string, KnowledgeStatsView['days'][number]>();
  for (const r of rows) {
    const d = byDay.get(r.date) ?? { date: r.date, reading: 0, study: 0, focus: 0, pages: 0, sessions: 0 };
    d[r.kind] += Math.floor(r.sec / 60);
    d.pages += r.pages;
    d.sessions += r.n;
    byDay.set(r.date, d);
  }
  const days = [...byDay.values()];
  const end = to < today ? to : today;
  const weeks: KnowledgeStatsView['weeks'] = [];
  for (let w = mondayOf(from); w <= end; w = addDays(w, 7)) {
    const ds = days.filter((d) => d.date >= w && d.date <= addDays(w, 6));
    weeks.push({ start: w, minutes: ds.reduce((s, d) => s + d.reading + d.study + d.focus, 0), reading: ds.reduce((s, d) => s + d.reading, 0), study: ds.reduce((s, d) => s + d.study, 0), focus: ds.reduce((s, d) => s + d.focus, 0), daysWithRecords: ds.length });
  }
  const books = (await c.query<{ id: string; title: string; finished_on: string }>("SELECT id, title, finished_on FROM knowledge_books WHERE user_id = $1 AND status = 'done' AND finished_on BETWEEN $2 AND $3 ORDER BY finished_on", [userId, from, to])).rows;
  const goals = (await c.query<{ day: string }>("SELECT day FROM life_xp_events WHERE user_id = $1 AND kind = 'grant' AND reversed_at IS NULL AND source_key LIKE 'knowledge:goal:%' AND day BETWEEN $2 AND $3", [userId, from, to])).rows;
  const months: KnowledgeStatsView['months'] = [];
  for (let m = from.slice(0, 7); m <= end.slice(0, 7); ) {
    const first = `${m}-01`;
    const [y, mo] = m.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const a = first > from ? first : from;
    const b = last < end ? last : end;
    const inRange = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1);
    const ds = days.filter((d) => d.date.startsWith(m));
    months.push({ month: m, daysWithRecords: ds.length, daysInRange: inRange, minutes: ds.reduce((s, d) => s + d.reading + d.study + d.focus, 0), booksFinished: books.filter((x) => x.finished_on.startsWith(m)).length, goalsMet: goals.filter((x) => x.day.startsWith(m)).length });
    m = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
  }
  const subj = (await c.query<{ id: string | null; name: string | null; color: SubjectColor | null; kind: SessionKind; sec: number; n: number }>(
    `SELECT s.subject_id AS id, k.name, k.color, s.kind, sum(s.active_sec)::int AS sec, count(*)::int AS n FROM knowledge_sessions s LEFT JOIN knowledge_subjects k ON k.id = s.subject_id
      WHERE s.user_id = $1 AND s.module = $2 AND s.date BETWEEN $3 AND $4 GROUP BY s.subject_id, k.name, k.color, s.kind`,
    [userId, MODULE, from, to],
  )).rows;
  const bySubject = new Map<string, KnowledgeStatsView['bySubject'][number]>();
  for (const r of subj) {
    const key = r.id ?? (r.kind === 'reading' ? '_reading' : '_other');
    const name = r.name ?? (r.kind === 'reading' ? 'Leitura (livros e textos)' : 'Outras atividades');
    const x = bySubject.get(key) ?? { id: r.id, name, color: r.color, minutes: 0, sessions: 0 };
    x.minutes += Math.floor(r.sec / 60);
    x.sessions += r.n;
    bySubject.set(key, x);
  }
  const hours = (await c.query<{ h: number; sec: number }>(`SELECT extract(hour FROM started_at AT TIME ZONE $5)::int AS h, sum(active_sec)::int AS sec FROM knowledge_sessions WHERE user_id = $1 AND module = $2 AND date BETWEEN $3 AND $4 AND started_at IS NOT NULL GROUP BY 1 ORDER BY 1`, [userId, MODULE, from, to, tz])).rows;
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    run = prev && addDays(prev, 1) === d.date ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d.date;
  }
  const minutes = days.reduce((s, d) => s + d.reading + d.study + d.focus, 0);
  const inRange = Math.max(0, Math.round((Date.parse(end) - Date.parse(from)) / 86_400_000) + 1);
  return {
    from,
    to,
    today,
    days,
    weeks,
    months,
    bySubject: [...bySubject.values()].sort((a, b) => b.minutes - a.minutes),
    booksFinished: books.map((b) => ({ id: b.id, title: b.title, finishedOn: b.finished_on })),
    goalsMet: goals.length,
    totals: { minutes, sessions: days.reduce((s, d) => s + d.sessions, 0), pages: days.reduce((s, d) => s + d.pages, 0), daysWithRecords: days.length, daysInRange: inRange, avgPerRecordedDay: days.length ? Math.round(minutes / days.length) : 0, bestStreak: best },
    byHour: hours.map((h) => ({ hour: h.h, minutes: Math.floor(h.sec / 60) })),
  };
}

export { getRoutine };
