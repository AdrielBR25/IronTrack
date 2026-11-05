// Operações do módulo Bíblia (Fase 05, docs/BIBLIA.md). Usado pelas rotas (/api/v1/bible/*) e pelos handlers das
// propostas aprovadas do assistente — mesmo caminho e mesmas validações nos dois casos.
//
// Regras centrais:
//  - Toda consulta filtra por user_id; ID de outra conta simplesmente "não existe".
//  - Referências sempre validadas contra o índice da tradução (canon.ts); o texto vem dos arquivos da tradução.
//  - Leitura registrada = capítulo por dia (idempotente). Sessões e cronômetro são os da Fase 04 (module = 'bible').
//  - XP só pelo motor do RPG (fonte 'bible', atributo Espiritualidade), idempotente por chave: sessão, dia do plano e
//    plano concluído. Reflexões, orações e crenças nunca rendem XP.
//  - Reflexões são privadas: nenhuma visão "pública" as inclui; a IA só as lê com pedido explícito.
import { randomUUID } from 'node:crypto';
import {
  BOOKS,
  TOTAL_CHAPTERS,
  TRANSLATION,
  bookById,
  chapterKey,
  chaptersBetween,
  formatKey,
  formatRef,
  formatSpan,
  normalize,
  parseKey,
  parseSpan,
  passageKey,
  spanKey,
  type BookId,
  type ChapterRef,
  type PassageRef,
} from '../../../../shared/bible/canon.ts';
import { TEMPLATES, customSchedule, dayMinutes, reschedule, templateSchedule, type PlanSchedule } from '../../../../shared/bible/plans.ts';
import {
  BIBLE_LIMITS,
  BIBLE_PROTOCOL,
  BIBLE_REWARD,
  type BibleGoalInput,
  type BibleHomeView,
  type BiblePrefsView,
  type BibleProgressView,
  type DailyVerseView,
  type MarkInput,
  type MarkKind,
  type MarkView,
  type PlanCreate,
  type PlanDayView,
  type PlanView,
  type PrefsPatch,
  type ReadingWeekDay,
  type ReflectionInput,
  type ReflectionKind,
  type ReflectionView,
  type Reminder,
} from '../../../../shared/bible/protocol.ts';
import { CURATED, dailyIndex, seedOf } from '../../../../shared/bible/verses.ts';
import type { PoolClient } from '../db/pool.ts';
import { ApiError } from '../http/core.ts';
import { addDays, mondayOf } from '../assistant/tools/time.ts';
import { grant, reverse, type LifeTx } from '../life/engine.ts';
import * as K from '../knowledge/service.ts';
import { BibleTextError, passageByKey, passageText } from './text.ts';

type Q = Pick<PoolClient, 'query'>;
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function refOrThrow(key: string): PassageRef {
  const r = parseKey(key);
  if (!r) throw new ApiError('bible_ref_invalid');
  return r;
}

// ------------------------------------------------------------------ preferências

interface PrefsRow {
  translation: 'BPM';
  show_on_home: boolean;
  verse_mode: BiblePrefsView['verseMode'];
  verse_interval_min: number;
  font_size: number;
  spacing: BiblePrefsView['spacing'];
  reading_theme: BiblePrefsView['readingTheme'];
  reminders: Reminder[];
  quiet_start: string | null;
  quiet_end: string | null;
  share_ai: boolean;
  last_ref: string | null;
  last_read_at: Date | null;
  version: number;
}

export async function prefsRow(c: Q, userId: string): Promise<PrefsRow> {
  const r = await c.query<PrefsRow>('SELECT * FROM bible_prefs WHERE user_id = $1', [userId]);
  if (r.rows[0]) return r.rows[0];
  await c.query('INSERT INTO bible_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  return (await c.query<PrefsRow>('SELECT * FROM bible_prefs WHERE user_id = $1', [userId])).rows[0];
}

export const prefsView = (p: PrefsRow): BiblePrefsView => ({
  translation: p.translation,
  showOnHome: p.show_on_home,
  verseMode: p.verse_mode,
  verseIntervalMin: p.verse_interval_min,
  fontSize: p.font_size,
  spacing: p.spacing,
  readingTheme: p.reading_theme,
  reminders: p.reminders ?? [],
  quietStart: p.quiet_start,
  quietEnd: p.quiet_end,
  shareAi: p.share_ai,
  lastRef: p.last_ref,
  lastReadAt: iso(p.last_read_at),
  version: p.version,
});

export async function updatePrefs(c: Q, userId: string, patch: PrefsPatch, version?: number | null): Promise<BiblePrefsView> {
  const cur = await prefsRow(c, userId);
  if (version != null && version !== cur.version) throw new ApiError('life_stale');
  const r = await c.query<PrefsRow>(
    `UPDATE bible_prefs SET show_on_home = $2, verse_mode = $3, verse_interval_min = $4, font_size = $5, spacing = $6, reading_theme = $7, reminders = $8,
       quiet_start = $9, quiet_end = $10, share_ai = $11, translation = $12, version = version + 1, updated_at = now() WHERE user_id = $1 RETURNING *`,
    [
      userId,
      patch.showOnHome ?? cur.show_on_home,
      patch.verseMode ?? cur.verse_mode,
      patch.verseIntervalMin ?? cur.verse_interval_min,
      patch.fontSize ?? cur.font_size,
      patch.spacing ?? cur.spacing,
      patch.readingTheme ?? cur.reading_theme,
      JSON.stringify(patch.reminders ?? cur.reminders ?? []),
      patch.quietStart !== undefined ? patch.quietStart : cur.quiet_start,
      patch.quietEnd !== undefined ? patch.quietEnd : cur.quiet_end,
      patch.shareAi ?? cur.share_ai,
      patch.translation ?? cur.translation,
    ],
  );
  return prefsView(r.rows[0]);
}

/** "Continuar de onde parei": grava a última passagem aberta (não mexe na versão das preferências). */
export async function setPosition(c: Q, userId: string, ref: string): Promise<void> {
  const r = refOrThrow(ref);
  await prefsRow(c, userId);
  await c.query('UPDATE bible_prefs SET last_ref = $2, last_read_at = now() WHERE user_id = $1', [userId, passageKey({ b: r.b, c: r.c, v1: r.v1 })]);
}

// ------------------------------------------------------------------ versículo do dia

async function isFavorite(c: Q, userId: string, ref: string): Promise<boolean> {
  const r = parseKey(ref)!;
  return !!(await c.query("SELECT 1 FROM bible_marks WHERE user_id = $1 AND kind = 'favorite' AND book = $2 AND chapter = $3 AND verse_start = $4 AND verse_end = $5", [userId, r.b, r.c, r.v1 ?? 1, r.v2 ?? r.v1 ?? 1])).rowCount;
}

async function verseView(c: Q, userId: string, date: string, seq: number, idx: number): Promise<DailyVerseView> {
  const cur = CURATED[idx];
  const passage = passageByKey(cur.ref);
  return { date, seq, theme: cur.theme, context: cur.context ?? null, passage: { ref: passage.ref, label: passage.label, translation: passage.translation, verses: passage.verses }, favorite: await isFavorite(c, userId, cur.ref) };
}

/**
 * Passagem do dia (data local da conta). Determinística por conta e dia: atualizar a página ou abrir em outro aparelho
 * mostra a mesma. O primeiro acesso do dia entra no histórico. Nenhuma IA envolvida.
 */
export async function dailyVerse(c: Q, userId: string, today: string): Promise<DailyVerseView> {
  const saved = (await c.query<{ ref: string }>('SELECT ref FROM bible_daily_verses WHERE user_id = $1 AND date = $2 AND seq = 0', [userId, today])).rows[0];
  let idx = saved ? CURATED.findIndex((p) => p.ref === saved.ref) : -1;
  if (idx < 0) {
    idx = dailyIndex(seedOf(userId), today);
    await c.query('INSERT INTO bible_daily_verses (user_id, date, seq, ref, theme) VALUES ($1, $2, 0, $3, $4) ON CONFLICT DO NOTHING', [userId, today, CURATED[idx].ref, CURATED[idx].theme]);
  }
  return verseView(c, userId, today, 0, idx);
}

/** "Outra passagem": a próxima extra do dia (até 10), também no histórico. */
export async function anotherVerse(c: Q, userId: string, today: string): Promise<DailyVerseView> {
  await dailyVerse(c, userId, today);
  const used = (await c.query<{ seq: number; ref: string }>('SELECT seq, ref FROM bible_daily_verses WHERE user_id = $1 AND date = $2 ORDER BY seq', [userId, today])).rows;
  const seq = used.length;
  if (seq > BIBLE_LIMITS.extraVersesPerDay) {
    const last = used[used.length - 1];
    return verseView(c, userId, today, last.seq, CURATED.findIndex((p) => p.ref === last.ref));
  }
  const seen = new Set(used.map((u) => u.ref));
  let idx = dailyIndex(seedOf(userId), today, seq);
  for (let k = 1; seen.has(CURATED[idx].ref) && k < CURATED.length; k++) idx = (idx + k) % CURATED.length;
  await c.query('INSERT INTO bible_daily_verses (user_id, date, seq, ref, theme) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [userId, today, seq, CURATED[idx].ref, CURATED[idx].theme]);
  return verseView(c, userId, today, seq, idx);
}

export async function verseHistory(c: Q, userId: string, limit = 60): Promise<DailyVerseView[]> {
  const rows = (await c.query<{ date: string; seq: number; ref: string }>('SELECT date, seq, ref FROM bible_daily_verses WHERE user_id = $1 ORDER BY date DESC, seq DESC LIMIT $2', [userId, Math.min(200, limit)])).rows;
  const out: DailyVerseView[] = [];
  for (const r of rows) {
    const idx = CURATED.findIndex((p) => p.ref === r.ref);
    if (idx >= 0) out.push(await verseView(c, userId, r.date, r.seq, idx));
  }
  return out;
}

// ------------------------------------------------------------------ favoritos e destaques

interface MarkRow {
  id: string;
  kind: MarkKind;
  book: BookId;
  chapter: number;
  verse_start: number;
  verse_end: number;
  color: MarkView['color'];
  tags: string[];
  created_at: Date;
}
const markRef = (m: Pick<MarkRow, 'book' | 'chapter' | 'verse_start' | 'verse_end'>) => passageKey({ b: m.book, c: m.chapter, v1: m.verse_start, v2: m.verse_end });
const markView = (m: MarkRow, withText = false): MarkView => {
  const ref = markRef(m);
  return { id: m.id, kind: m.kind, ref, label: formatKey(ref), color: m.color, tags: m.tags, createdAt: iso(m.created_at)!, ...(withText ? { text: safeText(ref) } : {}) };
};
const safeText = (ref: string) => {
  try {
    return passageText(ref);
  } catch (e) {
    if (e instanceof BibleTextError) return '';
    throw e;
  }
};

export async function markViews(c: Q, userId: string, f: { kind?: MarkKind | null; book?: string | null; chapter?: number | null; tag?: string | null; withText?: boolean; limit?: number } = {}): Promise<MarkView[]> {
  const p: unknown[] = [userId];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    w.push(sql.replace('?', `$${p.length}`));
  };
  if (f.kind) add('kind = ?', f.kind);
  if (f.book) add('book = ?', f.book);
  if (f.chapter) add('chapter = ?', f.chapter);
  if (f.tag) add('? = ANY(tags)', f.tag.toLowerCase());
  const lim = Math.min(500, Math.max(1, f.limit ?? 300));
  const rows = (await c.query<MarkRow>(`SELECT * FROM bible_marks WHERE user_id = $1 ${w.map((x) => `AND ${x}`).join(' ')} ORDER BY created_at DESC LIMIT ${lim}`, p)).rows;
  return rows.map((r) => markView(r, f.withText));
}

/** Favoritar/destacar é idempotente: a mesma passagem atualiza a cor/etiquetas em vez de duplicar. */
export async function upsertMark(c: Q, userId: string, m: MarkInput, origin: 'user' | 'ai' = 'user', id: string = randomUUID()): Promise<{ mark: MarkView; created: boolean }> {
  const r = refOrThrow(m.ref);
  const v1 = r.v1 ?? 1;
  const v2 = r.v2 ?? r.v1 ?? 1;
  const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM bible_marks WHERE user_id = $1', [userId])).rows[0].n;
  const ex = (await c.query<MarkRow>('SELECT * FROM bible_marks WHERE user_id = $1 AND kind = $2 AND book = $3 AND chapter = $4 AND verse_start = $5 AND verse_end = $6', [userId, m.kind, r.b, r.c, v1, v2])).rows[0];
  if (ex) {
    const u = await c.query<MarkRow>('UPDATE bible_marks SET color = $3, tags = $4, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *', [userId, ex.id, m.kind === 'highlight' ? (m.color ?? ex.color ?? 'lime') : null, m.tags.length ? m.tags : ex.tags]);
    return { mark: markView(u.rows[0], true), created: false };
  }
  if (n >= BIBLE_LIMITS.marks) throw new ApiError('life_limit');
  const row = (
    await c.query<MarkRow>('INSERT INTO bible_marks (id, user_id, kind, book, chapter, verse_start, verse_end, color, tags, origin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *', [
      id,
      userId,
      m.kind,
      r.b,
      r.c,
      v1,
      v2,
      m.kind === 'highlight' ? (m.color ?? 'lime') : null,
      m.tags,
      origin,
    ])
  ).rows[0];
  return { mark: markView(row, true), created: true };
}

export async function patchMark(c: Q, userId: string, id: string, p: { color?: MarkView['color']; tags?: string[] }): Promise<MarkView> {
  if (!isUuid(id)) throw new ApiError('not_found');
  const cur = (await c.query<MarkRow>('SELECT * FROM bible_marks WHERE user_id = $1 AND id = $2', [userId, id])).rows[0];
  if (!cur) throw new ApiError('not_found');
  const r = await c.query<MarkRow>('UPDATE bible_marks SET color = $3, tags = $4, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *', [userId, id, cur.kind === 'highlight' ? (p.color !== undefined ? (p.color ?? 'lime') : cur.color) : null, p.tags ?? cur.tags]);
  return markView(r.rows[0], true);
}

export async function deleteMark(c: Q, userId: string, id: string): Promise<void> {
  if (!isUuid(id) || !(await c.query('DELETE FROM bible_marks WHERE user_id = $1 AND id = $2', [userId, id])).rowCount) throw new ApiError('not_found');
}

// ------------------------------------------------------------------ reflexões (diário espiritual)

export interface ReflectionRow {
  id: string;
  kind: ReflectionKind;
  date: string;
  title: string | null;
  content: string;
  book: BookId | null;
  chapter: number | null;
  verse_start: number | null;
  verse_end: number | null;
  tags: string[];
  favorite: boolean;
  origin: 'user' | 'ai';
  client_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const reflRef = (r: Pick<ReflectionRow, 'book' | 'chapter' | 'verse_start' | 'verse_end'>) => (r.book && r.chapter ? passageKey({ b: r.book, c: r.chapter, ...(r.verse_start ? { v1: r.verse_start, v2: r.verse_end ?? r.verse_start } : {}) }) : null);
export const reflectionView = (r: ReflectionRow): ReflectionView => {
  const ref = reflRef(r);
  return { id: r.id, kind: r.kind, date: r.date, title: r.title, content: r.content, ref, label: ref ? formatKey(ref) : null, tags: r.tags, favorite: r.favorite, origin: r.origin, version: r.version, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! };
};

export async function reflectionViews(c: Q, userId: string, f: { q?: string | null; kind?: ReflectionKind | null; tag?: string | null; favorite?: boolean; book?: string | null; chapter?: number | null; from?: string | null; to?: string | null; ids?: string[]; limit?: number } = {}): Promise<ReflectionView[]> {
  const p: unknown[] = [userId];
  const w: string[] = [];
  const add = (sql: string, v: unknown) => {
    p.push(v);
    w.push(sql.replaceAll('?', `$${p.length}`));
  };
  // Busca sem acento/caixa ("familia" acha "família").
  if (f.q) add("translate(lower(content || ' ' || coalesce(title, '')), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') LIKE ?", `%${normalize(f.q).replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  if (f.kind) add('kind = ?', f.kind);
  if (f.tag) add('? = ANY(tags)', f.tag.toLowerCase());
  if (f.favorite) w.push('favorite');
  if (f.book) add('book = ?', f.book);
  if (f.chapter) add('chapter = ?', f.chapter);
  if (f.from) add('date >= ?', f.from);
  if (f.to) add('date <= ?', f.to);
  if (f.ids) add('id = ANY(?)', f.ids.filter(isUuid));
  const lim = Math.min(500, Math.max(1, f.limit ?? 200));
  const rows = (await c.query<ReflectionRow>(`SELECT * FROM bible_reflections WHERE user_id = $1 ${w.map((x) => `AND ${x}`).join(' ')} ORDER BY date DESC, created_at DESC LIMIT ${lim}`, p)).rows;
  return rows.map(reflectionView);
}

export async function getReflection(c: Q, userId: string, id: string, lock = false): Promise<ReflectionRow | null> {
  if (!isUuid(id)) return null;
  return (await c.query<ReflectionRow>(`SELECT * FROM bible_reflections WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}

export async function createReflection(c: Q, userId: string, today: string, x: ReflectionInput, origin: 'user' | 'ai' = 'user', id: string = randomUUID()): Promise<{ reflection: ReflectionView; existed: boolean }> {
  const ex = (await c.query<ReflectionRow>('SELECT * FROM bible_reflections WHERE user_id = $1 AND client_id = $2', [userId, x.clientId])).rows[0];
  if (ex) return { reflection: reflectionView(ex), existed: true };
  const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM bible_reflections WHERE user_id = $1', [userId])).rows[0].n;
  if (n >= BIBLE_LIMITS.reflections) throw new ApiError('life_limit');
  const date = x.date ?? today;
  if (date > today) throw new ApiError('validation_failed', { date: 'A data não pode estar no futuro.' });
  const r = x.ref ? refOrThrow(x.ref) : null;
  const row = (
    await c.query<ReflectionRow>(
      `INSERT INTO bible_reflections (id, user_id, kind, date, title, content, book, chapter, verse_start, verse_end, tags, favorite, origin, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [id, userId, x.kind, date, x.title, x.content, r?.b ?? null, r?.c ?? null, r?.v1 ?? null, r?.v1 ? (r.v2 ?? r.v1) : null, x.tags, x.favorite, origin, x.clientId],
    )
  ).rows[0];
  return { reflection: reflectionView(row), existed: false };
}

export async function updateReflection(c: Q, userId: string, today: string, id: string, p: { kind?: ReflectionKind; date?: string; title?: string | null; content?: string; ref?: string | null; tags?: string[]; favorite?: boolean }, version?: number | null): Promise<ReflectionView> {
  const cur = await getReflection(c, userId, id, true);
  if (!cur) throw new ApiError('not_found');
  if (version != null && version !== cur.version) throw new ApiError('life_stale');
  if (p.date && p.date > today) throw new ApiError('validation_failed', { date: 'A data não pode estar no futuro.' });
  const r = p.ref === undefined ? undefined : p.ref ? refOrThrow(p.ref) : null;
  const row = (
    await c.query<ReflectionRow>(
      `UPDATE bible_reflections SET kind = $3, date = $4, title = $5, content = $6, book = $7, chapter = $8, verse_start = $9, verse_end = $10, tags = $11, favorite = $12, version = version + 1, updated_at = now()
         WHERE user_id = $1 AND id = $2 RETURNING *`,
      [
        userId,
        id,
        p.kind ?? cur.kind,
        p.date ?? cur.date,
        p.title !== undefined ? p.title : cur.title,
        p.content ?? cur.content,
        r === undefined ? cur.book : (r?.b ?? null),
        r === undefined ? cur.chapter : (r?.c ?? null),
        r === undefined ? cur.verse_start : (r?.v1 ?? null),
        r === undefined ? cur.verse_end : r?.v1 ? (r.v2 ?? r.v1) : null,
        p.tags ?? cur.tags,
        p.favorite ?? cur.favorite,
      ],
    )
  ).rows[0];
  return reflectionView(row);
}

export async function deleteReflection(c: Q, userId: string, id: string): Promise<void> {
  if (!isUuid(id) || !(await c.query('DELETE FROM bible_reflections WHERE user_id = $1 AND id = $2', [userId, id])).rowCount) throw new ApiError('not_found');
}

// ------------------------------------------------------------------ leitura registrada (capítulos)

function checkReadDate(t: LifeTx, date: string): void {
  if (date > t.today || date < addDays(t.today, -BIBLE_LIMITS.readPastDays)) throw new ApiError('bible_date_not_allowed');
}

/**
 * Registra capítulos lidos num dia (um registro por capítulo/dia: repetir não duplica). Recalcula as metas do dia
 * (hábitos vinculados recebem o progresso). Devolve só os capítulos novos.
 */
export async function logChapters(t: LifeTx, chapters: ChapterRef[], date: string, source: 'reader' | 'session' | 'plan' | 'manual' | 'ai', o: { sessionId?: string | null; planId?: string | null; recompute?: boolean } = {}): Promise<string[]> {
  checkReadDate(t, date);
  const added: string[] = [];
  for (const ch of chapters.slice(0, BIBLE_LIMITS.chaptersPerDay)) {
    const r = await t.c.query(
      'INSERT INTO bible_chapter_logs (id, user_id, book, chapter, date, source, session_id, plan_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id, book, chapter, date) DO NOTHING',
      [randomUUID(), t.userId, ch.b, ch.c, date, source, o.sessionId ?? null, o.planId ?? null],
    );
    if (r.rowCount) added.push(chapterKey(ch));
  }
  if (added.length && o.recompute !== false) await K.recomputeGoals(t, [date]);
  return added;
}

/** Desfaz "marquei como lido" (só registros do leitor/manuais; os de sessão saem com a sessão). */
export async function unlogChapter(t: LifeTx, ch: ChapterRef, date: string): Promise<boolean> {
  const r = await t.c.query("DELETE FROM bible_chapter_logs WHERE user_id = $1 AND book = $2 AND chapter = $3 AND date = $4 AND source IN ('reader', 'manual', 'ai')", [t.userId, ch.b, ch.c, date]);
  if (r.rowCount) await K.recomputeGoals(t, [date]);
  return !!r.rowCount;
}

export async function progressView(c: Q, userId: string): Promise<BibleProgressView> {
  const rows = (await c.query<{ book: BookId; chapter: number }>('SELECT DISTINCT book, chapter FROM bible_chapter_logs WHERE user_id = $1', [userId])).rows;
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.book, (per.get(r.book) ?? 0) + 1);
  return {
    chaptersRead: rows.length,
    totalChapters: TOTAL_CHAPTERS,
    books: BOOKS.map((b) => ({ id: b.id, read: per.get(b.id) ?? 0, total: b.chapters })),
    readKeys: rows.map((r) => chapterKey({ b: r.book, c: r.chapter })),
  };
}

/** Minutos (sessões bíblicas) e capítulos registrados por dia, num intervalo. Só dias com registro. */
export async function readingDays(c: Q, userId: string, from: string, to: string): Promise<ReadingWeekDay[]> {
  const mins = (await c.query<{ date: string; sec: number }>("SELECT date, sum(active_sec)::int AS sec FROM knowledge_sessions WHERE user_id = $1 AND module = 'bible' AND date BETWEEN $2 AND $3 GROUP BY date", [userId, from, to])).rows;
  const chs = (await c.query<{ date: string; n: number }>('SELECT date, count(*)::int AS n FROM bible_chapter_logs WHERE user_id = $1 AND date BETWEEN $2 AND $3 GROUP BY date', [userId, from, to])).rows;
  const map = new Map<string, ReadingWeekDay>();
  for (const m of mins) map.set(m.date, { date: m.date, minutes: Math.floor(m.sec / 60), chapters: 0 });
  for (const x of chs) map.set(x.date, { ...(map.get(x.date) ?? { date: x.date, minutes: 0 }), chapters: x.n });
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ------------------------------------------------------------------ sessões (cronômetro e registro manual da Fase 04)

const spanTitle = (from: ChapterRef, to: ChapterRef) => `Bíblia · ${formatSpan(from, to)}`;

export async function startTimer(t: LifeTx, s: { id: string; ref: string; mode: 'stopwatch' | 'countdown' | 'pomodoro'; plannedMin?: number | null; sound: boolean }) {
  const r = refOrThrow(s.ref);
  const ch = { b: r.b, c: r.c };
  return K.startTimer(
    t,
    { id: s.id, kind: 'reading', bookId: null, subjectId: null, topicId: null, label: null, mode: s.mode, plannedMin: s.plannedMin ?? null, pomodoro: s.mode === 'pomodoro' ? { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4, autoContinue: true } : null, sound: s.sound },
    { ref: chapterKey(ch), title: spanTitle(ch, ch) },
  );
}

/**
 * Hook de encerramento do cronômetro bíblico: registra os capítulos do início até `reached` (capítulo alcançado,
 * inclusive) e devolve o trecho/título da sessão. Sem `reached`, nenhum capítulo é dado como lido.
 */
export const finishHook =
  (t: LifeTx, reached: string | null | undefined) =>
  async (timer: { id: string; ref: string | null; title: string; date: string }): Promise<{ ref: string | null; title: string }> => {
    const start = timer.ref ? parseKey(timer.ref) : null;
    if (!start) return { ref: timer.ref, title: timer.title };
    const from = { b: start.b, c: start.c };
    const to = reached ? parseKey(reached) : null;
    if (!to) return { ref: chapterKey(from), title: `${spanTitle(from, from)} (em andamento)` };
    const list = chaptersBetween(from, { b: to.b, c: to.c }, 150);
    if (!list.length) throw new ApiError('validation_failed', { reached: 'O capítulo alcançado vem antes do início da leitura.' });
    const last = list[list.length - 1];
    if (timer.date >= addDays(t.today, -BIBLE_LIMITS.readPastDays)) await logChapters(t, list, timer.date, 'session', { sessionId: timer.id, recompute: false });
    return { ref: spanKey(from, last), title: spanTitle(from, last) };
  };

export async function finishTimer(t: LifeTx, id: string, f: { at?: string | null; activeMin?: number | null; reached?: string | null; note?: string | null }) {
  return K.finishTimer(t, id, { at: f.at ?? null, activeMin: f.activeMin ?? null, pageEnd: null, pagesRead: null, finishBook: false, note: f.note ?? null }, finishHook(t, f.reached));
}

export async function createManualSession(t: LifeTx, m: { clientId: string; date: string; minutes: number; span: string; note: string | null }, origin: 'manual' | 'ai' = 'manual', id: string = randomUUID()) {
  const sp = parseSpan(m.span);
  if (!sp) throw new ApiError('bible_ref_invalid');
  const list = chaptersBetween(sp.from, sp.to, 150);
  return K.createManualSession(
    t,
    { clientId: m.clientId, kind: 'reading', bookId: null, subjectId: null, topicId: null, label: null, date: m.date, minutes: m.minutes, startTime: null, pageEnd: null, pagesRead: null, finishBook: false, note: m.note },
    origin,
    id,
    { ref: spanKey(sp.from, sp.to), title: spanTitle(sp.from, sp.to), before: async (sid) => void (await logChapters(t, list, m.date, origin === 'ai' ? 'ai' : 'manual', { sessionId: sid, recompute: false })) },
  );
}

// ------------------------------------------------------------------ planos

export interface PlanRow {
  id: string;
  template: PlanView['template'];
  title: string;
  description: string | null;
  schedule: PlanSchedule;
  start_date: string;
  status: PlanView['status'];
  paused_on: string | null;
  completed_on: string | null;
  origin: 'user' | 'ai';
  version: number;
  created_at: Date;
}

export async function getPlan(c: Q, userId: string, id: string, lock = false): Promise<PlanRow | null> {
  if (!isUuid(id)) return null;
  return (await c.query<PlanRow>(`SELECT * FROM bible_plans WHERE user_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [userId, id])).rows[0] ?? null;
}

const dayLabel = (day: string[]) => {
  const refs = day.map((k) => parseKey(k)!).filter(Boolean);
  if (!refs.length) return '';
  // Agrupa capítulos seguidos do mesmo livro: "Gênesis 1–3, Salmo 1".
  const parts: string[] = [];
  let a = refs[0];
  let z = refs[0];
  for (const r of refs.slice(1)) {
    if (r.b === z.b && r.c === z.c + 1) z = r;
    else {
      parts.push(formatSpan(a, z));
      a = r;
      z = r;
    }
  }
  parts.push(formatSpan(a, z));
  return parts.join(', ');
};

export function planView(p: PlanRow, done: Map<number, string>, today: string, withDays = false): PlanView {
  const days: PlanDayView[] = p.schedule.map((d, i) => ({ day: i, chapters: d, label: dayLabel(d), minutes: dayMinutes(d), completedOn: done.get(i) ?? null }));
  const doneDays = days.filter((d) => d.completedOn).length;
  const next = days.find((d) => !d.completedOn) ?? null;
  // Ritmo sugerido: um dia do plano por dia desde o início, descontando o tempo pausado (informativo).
  const ref = p.status === 'paused' && p.paused_on ? p.paused_on : today;
  const elapsed = Math.max(0, Math.round((Date.parse(`${ref}T00:00:00Z`) - Date.parse(`${p.start_date}T00:00:00Z`)) / 86_400_000) + 1);
  const behind = p.status === 'active' ? Math.max(0, Math.min(days.length, elapsed) - doneDays) : 0;
  return {
    id: p.id,
    template: p.template,
    title: p.title,
    description: p.description,
    status: p.status,
    startDate: p.start_date,
    pausedOn: p.paused_on,
    completedOn: p.completed_on,
    totalDays: days.length,
    doneDays,
    totalChapters: p.schedule.reduce((n, d) => n + d.length, 0),
    percent: days.length ? Math.round((doneDays / days.length) * 100) : 0,
    next,
    behind,
    origin: p.origin,
    version: p.version,
    ...(withDays ? { days } : {}),
  };
}

async function doneMap(c: Q, userId: string, planIds: string[]): Promise<Map<string, Map<number, string>>> {
  const out = new Map<string, Map<number, string>>();
  if (!planIds.length) return out;
  const rows = (await c.query<{ plan_id: string; day: number; completed_on: string }>('SELECT plan_id, day, completed_on FROM bible_plan_days WHERE user_id = $1 AND plan_id = ANY($2)', [userId, planIds])).rows;
  for (const r of rows) {
    if (!out.has(r.plan_id)) out.set(r.plan_id, new Map());
    out.get(r.plan_id)!.set(r.day, r.completed_on);
  }
  return out;
}

export async function planViews(c: Q, userId: string, today: string, o: { ids?: string[]; status?: PlanView['status'][]; withDays?: boolean } = {}): Promise<PlanView[]> {
  const p: unknown[] = [userId];
  let w = '';
  if (o.ids) {
    p.push(o.ids.filter(isUuid));
    w += ` AND id = ANY($${p.length})`;
  }
  if (o.status) {
    p.push(o.status);
    w += ` AND status = ANY($${p.length})`;
  }
  const rows = (await c.query<PlanRow>(`SELECT * FROM bible_plans WHERE user_id = $1${w} ORDER BY array_position(ARRAY['active','paused','completed','archived'], status), created_at DESC`, p)).rows;
  const done = await doneMap(c, userId, rows.map((r) => r.id));
  return rows.map((r) => planView(r, done.get(r.id) ?? new Map(), today, o.withDays));
}

/** Monta o cronograma (modelo ou personalizado), sempre com capítulos que existem na tradução. */
export function buildSchedule(x: PlanCreate): { template: PlanRow['template']; title: string; description: string | null; schedule: PlanSchedule } {
  if (x.template) {
    const info = TEMPLATES[x.template];
    const schedule = templateSchedule(x.template, x.template === 'daily15' ? null : x.days);
    return { template: x.template, title: x.title ?? info.title, description: x.description ?? info.description, schedule };
  }
  let chapters: ChapterRef[];
  let what: string;
  if (x.span) {
    const sp = parseSpan(x.span)!;
    chapters = chaptersBetween(sp.from, sp.to, BIBLE_LIMITS.planChapters);
    what = formatSpan(sp.from, sp.to);
  } else {
    const ids = [...new Set(x.books!)];
    chapters = ids.flatMap((b) => Array.from({ length: bookById(b)!.chapters }, (_, i) => ({ b: b as BookId, c: i + 1 })));
    what = ids.map((b) => bookById(b)!.name).join(', ');
  }
  if (!chapters.length) throw new ApiError('bible_ref_invalid');
  if (chapters.length > BIBLE_LIMITS.planChapters) throw new ApiError('validation_failed', { books: 'Plano grande demais.' });
  const schedule = customSchedule(chapters, { days: x.days ?? null, perDay: x.perDay ?? null });
  if (schedule.length > BIBLE_LIMITS.planDays) throw new ApiError('validation_failed', { days: `No máximo ${BIBLE_LIMITS.planDays} dias.` });
  return { template: 'custom', title: (x.title ?? `Leitura: ${what}`).slice(0, 80), description: x.description ?? `${chapters.length} capítulos em ${schedule.length} dias.`, schedule };
}

export async function createPlan(t: LifeTx, x: PlanCreate, origin: 'user' | 'ai' = 'user', id: string = x.id ?? randomUUID()): Promise<PlanRow> {
  const ex = await getPlan(t.c, t.userId, id);
  if (ex) return ex;
  const n = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM bible_plans WHERE user_id = $1 AND status IN ('active', 'paused')", [t.userId])).rows[0].n;
  if (n >= BIBLE_LIMITS.plans) throw new ApiError('life_limit');
  const b = buildSchedule(x);
  const start = x.startDate ?? t.today;
  if (start < addDays(t.today, -BIBLE_LIMITS.readPastDays)) throw new ApiError('validation_failed', { startDate: 'Data de início muito antiga.' });
  return (
    await t.c.query<PlanRow>('INSERT INTO bible_plans (id, user_id, template, title, description, schedule, start_date, origin) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [
      id,
      t.userId,
      b.template,
      b.title,
      b.description,
      JSON.stringify(b.schedule),
      start,
      origin,
    ])
  ).rows[0];
}

/** Pausar, retomar, arquivar, renomear ou reorganizar (redistribui o que falta; os dias concluídos continuam). */
export async function updatePlan(t: LifeTx, id: string, p: { title?: string; status?: 'active' | 'paused' | 'archived'; remainingDays?: number }, version?: number | null): Promise<{ before: PlanRow; after: PlanRow; beforeDays: { day: number; completed_on: string }[] }> {
  const before = await getPlan(t.c, t.userId, id, true);
  if (!before) throw new ApiError('not_found');
  if (version != null && version !== before.version) throw new ApiError('life_stale');
  const beforeDays = (await t.c.query<{ day: number; completed_on: string }>('SELECT day, completed_on FROM bible_plan_days WHERE user_id = $1 AND plan_id = $2 ORDER BY day', [t.userId, id])).rows;
  let schedule = before.schedule;
  if (p.remainingDays) {
    if (before.status === 'completed') throw new ApiError('bible_plan_inactive');
    const done = new Set(beforeDays.map((d) => d.day));
    const r = reschedule(before.schedule, done, p.remainingDays);
    schedule = r.schedule;
    if (schedule.length > BIBLE_LIMITS.planDays) throw new ApiError('validation_failed', { remainingDays: `No máximo ${BIBLE_LIMITS.planDays} dias.` });
    // O histórico continua: cada dia concluído muda só de posição.
    await t.c.query('DELETE FROM bible_plan_days WHERE user_id = $1 AND plan_id = $2', [t.userId, id]);
    for (const d of beforeDays) await t.c.query('INSERT INTO bible_plan_days (plan_id, user_id, day, completed_on) VALUES ($1, $2, $3, $4)', [id, t.userId, r.moved.get(d.day)!, d.completed_on]);
  }
  let status = before.status;
  let pausedOn = before.paused_on;
  if (p.status && p.status !== before.status) {
    if (before.status === 'completed' && p.status !== 'archived') throw new ApiError('bible_plan_inactive');
    status = p.status;
    pausedOn = p.status === 'paused' ? t.today : null;
  }
  const after = (
    await t.c.query<PlanRow>('UPDATE bible_plans SET title = $3, status = $4, paused_on = $5, schedule = $6, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *', [
      t.userId,
      id,
      p.title ?? before.title,
      status,
      pausedOn,
      JSON.stringify(schedule),
    ])
  ).rows[0];
  return { before, after, beforeDays };
}

/** Desfazer do assistente: volta o plano e os dias concluídos exatamente como estavam. */
export async function restorePlan(t: LifeTx, before: PlanRow, days: { day: number; completed_on: string }[]): Promise<void> {
  await t.c.query('UPDATE bible_plans SET title = $3, status = $4, paused_on = $5, schedule = $6, completed_on = $7, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2', [
    t.userId,
    before.id,
    before.title,
    before.status,
    before.paused_on,
    JSON.stringify(before.schedule),
    before.completed_on,
  ]);
  await t.c.query('DELETE FROM bible_plan_days WHERE user_id = $1 AND plan_id = $2', [t.userId, before.id]);
  for (const d of days) await t.c.query('INSERT INTO bible_plan_days (plan_id, user_id, day, completed_on) VALUES ($1, $2, $3, $4)', [before.id, t.userId, d.day, d.completed_on]);
}

export async function deletePlan(t: LifeTx, id: string): Promise<PlanRow> {
  const p = await getPlan(t.c, t.userId, id, true);
  if (!p) throw new ApiError('not_found');
  const keys = (await t.c.query<{ source_key: string }>("SELECT source_key FROM life_xp_events WHERE user_id = $1 AND kind = 'grant' AND reversed_at IS NULL AND (source_key LIKE $2 OR source_key = $3)", [t.userId, `bible:planday:${id}:%`, `bible:plan:${id}`])).rows;
  for (const k of keys) await reverse(t, k.source_key, `Plano excluído: ${p.title}`.slice(0, 200));
  // Os capítulos lidos continuam registrados (a leitura aconteceu); só deixam de apontar para o plano.
  await t.c.query('DELETE FROM bible_plans WHERE user_id = $1 AND id = $2', [t.userId, id]);
  return p;
}

const planDayKey = (planId: string, day: number) => `bible:planday:${planId}:${day}`;
const inWindow = (t: LifeTx, date: string) => date <= t.today && date >= addDays(t.today, -1);

/**
 * Conclui um dia do plano: registra os capítulos do dia (fonte 'plan'), concede o XP do dia (5, no máximo 2 dias por
 * dia, só hoje/ontem) e, se todos os dias estiverem concluídos, conclui o plano (40 XP se a leitura se espalhou por
 * datas suficientes). Repetir não muda nada.
 */
export async function completeDay(t: LifeTx, planId: string, day: number, date: string = t.today): Promise<{ plan: PlanRow; added: string[]; already: boolean }> {
  const p = await getPlan(t.c, t.userId, planId, true);
  if (!p) throw new ApiError('not_found');
  if (p.status !== 'active') throw new ApiError('bible_plan_inactive');
  if (!Number.isInteger(day) || day < 0 || day >= p.schedule.length) throw new ApiError('validation_failed', { day: 'Dia inexistente neste plano.' });
  checkReadDate(t, date);
  const ins = await t.c.query('INSERT INTO bible_plan_days (plan_id, user_id, day, completed_on) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [planId, t.userId, day, date]);
  if (!ins.rowCount) return { plan: p, added: [], already: true };
  const added = await logChapters(t, p.schedule[day].map((k) => parseKey(k) as ChapterRef), date, 'plan', { planId, recompute: false });
  if (inWindow(t, date)) {
    const today = (await t.c.query<{ n: number }>("SELECT count(*)::int AS n FROM life_xp_events WHERE user_id = $1 AND day = $2 AND source = 'bible' AND kind = 'grant' AND reversed_at IS NULL AND amount > 0 AND source_key LIKE 'bible:planday:%'", [t.userId, date])).rows[0].n;
    await grant(t, { source: 'bible', key: planDayKey(planId, day), sourceId: planId, attribute: 'spirituality', requested: today < BIBLE_REWARD.planDaysPerDay ? BIBLE_REWARD.planDay : 0, day: date, reason: `Plano "${p.title}": dia ${day + 1} concluído`.slice(0, 200) });
  }
  let plan = p;
  const doneCount = (await t.c.query<{ n: number; dates: number }>('SELECT count(*)::int AS n, count(DISTINCT completed_on)::int AS dates FROM bible_plan_days WHERE user_id = $1 AND plan_id = $2', [t.userId, planId])).rows[0];
  if (doneCount.n >= p.schedule.length) {
    plan = (await t.c.query<PlanRow>("UPDATE bible_plans SET status = 'completed', completed_on = $3, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *", [t.userId, planId, date])).rows[0];
    const enough = doneCount.dates >= Math.min(BIBLE_REWARD.planMinDates, p.schedule.length);
    await grant(t, { source: 'bible', key: `bible:plan:${planId}`, sourceId: planId, attribute: 'spirituality', requested: enough ? BIBLE_REWARD.plan : 0, day: t.today, reason: `Plano de leitura concluído: ${p.title}`.slice(0, 200) });
  }
  await K.recomputeGoals(t, [date, t.today]);
  return { plan, added, already: false };
}

/** Desmarca um dia (engano): estorna o XP do dia e, se o plano estava concluído, volta a "em andamento". */
export async function uncompleteDay(t: LifeTx, planId: string, day: number): Promise<PlanRow> {
  const p = await getPlan(t.c, t.userId, planId, true);
  if (!p) throw new ApiError('not_found');
  const d = (await t.c.query<{ completed_on: string }>('DELETE FROM bible_plan_days WHERE user_id = $1 AND plan_id = $2 AND day = $3 RETURNING completed_on', [t.userId, planId, day])).rows[0];
  if (!d) return p;
  await t.c.query("DELETE FROM bible_chapter_logs WHERE user_id = $1 AND plan_id = $2 AND date = $3 AND source = 'plan' AND (book || '.' || chapter) = ANY($4)", [t.userId, planId, d.completed_on, p.schedule[day] ?? []]);
  await reverse(t, planDayKey(planId, day), `Dia ${day + 1} do plano desmarcado`);
  let plan = p;
  if (p.status === 'completed') {
    await reverse(t, `bible:plan:${planId}`, `Plano reaberto: ${p.title}`.slice(0, 200));
    plan = (await t.c.query<PlanRow>("UPDATE bible_plans SET status = 'active', completed_on = NULL, version = version + 1, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING *", [t.userId, planId])).rows[0];
  }
  await K.recomputeGoals(t, [d.completed_on, t.today]);
  return plan;
}

// ------------------------------------------------------------------ metas (knowledge_goals com module = 'bible')

export function goalInput(g: BibleGoalInput): K.AnyGoalInput {
  return {
    title: g.title ?? defaultGoalTitle(g),
    metric: g.metric,
    scope: 'reading',
    subjectId: null,
    bookId: null,
    period: g.period,
    target: g.target,
    days: g.days,
    dueDate: g.dueDate ?? null,
    preferredTime: g.preferredTime ?? null,
    habitId: g.habitId ?? null,
    missionId: g.missionId ?? null,
    module: 'bible',
    ref: g.book ?? null,
    planId: g.planId ?? null,
  };
}

export function defaultGoalTitle(g: Pick<BibleGoalInput, 'metric' | 'period' | 'target' | 'book' | 'dueDate'>): string {
  const book = g.book ? bookById(g.book)?.name : null;
  const per = g.period === 'daily' ? 'por dia' : g.period === 'weekly' ? 'por semana' : `até ${g.dueDate?.split('-').reverse().slice(0, 2).join('/')}`;
  const where = book ? ` de ${book}` : ' da Bíblia';
  if (g.metric === 'plan_finish') return `Concluir o plano ${per}`.slice(0, 80);
  if (g.metric === 'minutes') return `Ler a Bíblia ${g.target} min ${per}`.slice(0, 80);
  if (g.metric === 'chapters') return `Ler ${g.target} capítulo${g.target > 1 ? 's' : ''}${where} ${per}`.slice(0, 80);
  if (g.metric === 'days') return `Ler${where} em ${g.target} dias ${per}`.slice(0, 80);
  return `${g.target} sessões de leitura${where} ${per}`.slice(0, 80);
}

export async function createGoal(t: LifeTx, g: BibleGoalInput, origin: 'user' | 'ai' = 'user', id?: string) {
  return K.createGoal(t, goalInput(g), origin, id);
}

// ------------------------------------------------------------------ painel

export async function home(t: Pick<LifeTx, 'c' | 'userId' | 'today' | 'now'>): Promise<BibleHomeView> {
  const { c, userId, today } = t;
  const prefs = prefsView(await prefsRow(c, userId));
  const monday = mondayOf(today);
  const days = await readingDays(c, userId, monday, addDays(monday, 6));
  const week: ReadingWeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    return days.find((x) => x.date === d) ?? { date: d, minutes: 0, chapters: 0 };
  });
  const totals = (await c.query<{ ch: number; sec: number; days: number }>(
    `SELECT (SELECT count(*) FROM (SELECT DISTINCT book, chapter FROM bible_chapter_logs WHERE user_id = $1) x)::int AS ch,
            (SELECT coalesce(sum(active_sec), 0) FROM knowledge_sessions WHERE user_id = $1 AND module = 'bible')::int AS sec,
            (SELECT count(*) FROM (SELECT date FROM bible_chapter_logs WHERE user_id = $1 UNION SELECT date FROM knowledge_sessions WHERE user_id = $1 AND module = 'bible') d)::int AS days`,
    [userId],
  )).rows[0];
  const resume = prefs.lastRef ? { ref: prefs.lastRef, label: formatKey(prefs.lastRef) } : null;
  return {
    protocol: BIBLE_PROTOCOL,
    today,
    prefs,
    verse: prefs.verseMode === 'on_request' ? null : await dailyVerse(c, userId, today),
    resume,
    plans: await planViews(c, userId, today, { status: ['active', 'paused'] }),
    week,
    weekMinutes: week.reduce((n, d) => n + d.minutes, 0),
    weekChapters: week.reduce((n, d) => n + d.chapters, 0),
    totals: { chaptersRead: totals.ch, minutes: Math.floor(totals.sec / 60), daysWithReading: totals.days },
    reflections: await reflectionViews(c, userId, { limit: 3 }),
    favorites: await markViews(c, userId, { kind: 'favorite', withText: true, limit: 4 }),
    goals: (await K.goalViews(c, userId, today, { module: 'bible' })).filter((g) => g.status === 'active'),
    timer: await K.currentTimer(c, userId, t.now).then((x) => (x && x.module === 'bible' ? x : null)),
    recent: await K.sessionViews(c, userId, { module: 'bible', limit: 5 }),
  };
}

/** Prévia do versículo de uma referência para listas (a passagem completa vem dos arquivos no app). */
export const labelOf = (key: string) => formatKey(key);
export { formatRef, TRANSLATION };
