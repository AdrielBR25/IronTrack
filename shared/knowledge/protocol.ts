// Contrato do módulo Conhecimento (IronTrack Life — Fase 04, docs/CONHECIMENTO.md): leitura, estudos, foco e metas.
// Compartilhado entre a API (que valida, calcula o tempo ativo e concede XP) e o app (que exibe e mostra a prévia com
// as MESMAS funções puras daqui).
//
// Preparação para a Fase 05 (Bíblia): sessões, metas e anotações têm `module` ('knowledge' hoje; 'bible' reservado) e
// `ref` (referência genérica, ex.: capítulo). O cronômetro, o cálculo de tempo ativo, as metas, o histórico e as
// ferramentas da IA são genéricos; a Fase 05 só acrescenta o vocabulário bíblico, o atributo e as regras de XP.
import { z } from 'zod';

export const KNOWLEDGE_PROTOCOL = 'irontrack.life.knowledge.v1';

// ------------------------------------------------------------------ vocabulário

/** Módulos que reaproveitam este motor. 'bible' fica reservado para a Fase 05 (nada grava 'bible' ainda). */
export const KNOWLEDGE_MODULES = ['knowledge', 'bible'] as const;
export type KnowledgeModule = (typeof KNOWLEDGE_MODULES)[number];

export const BOOK_STATUS = ['want', 'reading', 'done', 'paused'] as const;
export type BookStatus = (typeof BOOK_STATUS)[number];
export const BOOK_STATUS_LABEL: Record<BookStatus, string> = { want: 'Quero ler', reading: 'Lendo', done: 'Concluído', paused: 'Pausado' };

export const BOOK_CATEGORIES = ['Ficção', 'Não ficção', 'Desenvolvimento pessoal', 'Negócios', 'Tecnologia', 'Ciência', 'História', 'Biografia', 'Fé e espiritualidade', 'Saúde', 'Finanças', 'Técnico', 'Outro'] as const;

/** Tipo de sessão: leitura, estudo ou foco em outra atividade. */
export const SESSION_KINDS = ['reading', 'study', 'focus'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export const SESSION_KIND_LABEL: Record<SessionKind, string> = { reading: 'Leitura', study: 'Estudo', focus: 'Foco' };

/** Modo do cronômetro. `manual` = registro feito depois, sem cronômetro (regras de XP conservadoras). */
export const TIMER_MODES = ['stopwatch', 'countdown', 'pomodoro'] as const;
export type TimerMode = (typeof TIMER_MODES)[number];
export const TIMER_MODE_LABEL: Record<TimerMode, string> = { stopwatch: 'Cronômetro livre', countdown: 'Temporizador', pomodoro: 'Pomodoro' };
export type SessionOrigin = 'timer' | 'manual' | 'ai';

export const TOPIC_STATUS = ['pending', 'studying', 'done'] as const;
export type TopicStatus = (typeof TOPIC_STATUS)[number];
export const TOPIC_STATUS_LABEL: Record<TopicStatus, string> = { pending: 'Pendente', studying: 'Estudando', done: 'Concluído' };

export const SUBJECT_CATEGORIES = ['Programação', 'Idiomas', 'Matemática', 'Inteligência artificial', 'Desenvolvimento de jogos', 'Finanças pessoais', 'Ciências', 'Humanas', 'Concursos e provas', 'Música e artes', 'Outro'] as const;
export const SUBJECT_COLORS = ['lime', 'sky', 'violet', 'amber', 'rose', 'emerald', 'orange', 'cyan'] as const;
export type SubjectColor = (typeof SUBJECT_COLORS)[number];

export const NOTE_KINDS = ['note', 'excerpt', 'reflection'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABEL: Record<NoteKind, string> = { note: 'Nota', excerpt: 'Trecho', reflection: 'Reflexão' };

export const GOAL_METRICS = ['minutes', 'pages', 'sessions', 'days', 'book_finish'] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export const GOAL_SCOPES = ['reading', 'study', 'focus', 'any'] as const;
export type GoalScope = (typeof GOAL_SCOPES)[number];
export const GOAL_PERIODS = ['daily', 'weekly', 'by_date'] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];
export const GOAL_METRIC_UNIT: Record<GoalMetric, string> = { minutes: 'min', pages: 'páginas', sessions: 'sessões', days: 'dias', book_finish: '' };

// ------------------------------------------------------------------ limites e regras do cronômetro

export const KNOWLEDGE_LIMITS = {
  books: 500,
  subjects: 100,
  topicsPerSubject: 200,
  goals: 50,
  notesPerTarget: 1000,
  sessionsPerDay: 60,
  manualPastDays: 30,
  manualMaxMin: 600,
  rangeDays: 400,
  pages: 20_000,
  /** Capa: imagem pequena reduzida no aparelho (data URL JPEG/PNG/WebP). */
  coverChars: 160_000,
} as const;

/**
 * Tempo ativo (docs/CONHECIMENTO.md §3). O servidor marca o relógio (início, pausa, retomada) com o PRÓPRIO horário; o app
 * manda "sinais de presença" (`seen`) enquanto a tela está aberta. Trechos sem presença (tela bloqueada, aba fechada,
 * sem conexão) contam só até um limite por trecho: assim ler um livro de papel com a tela apagada vale, mas um
 * cronômetro esquecido por horas não vira horas de estudo.
 */
export const TIMER_RULES = {
  /** Intervalo do sinal de presença do app. */
  heartbeatSec: 60,
  /** Um sinal cobre este tempo depois dele (tolerância de rede/bateria). */
  seenCoverSec: 150,
  /** Cronômetro livre: cada trecho sem presença conta no máximo isto. */
  unattendedMaxSec: 60 * 60,
  /** Teto de uma sessão (o excedente nunca conta). */
  sessionMaxSec: 6 * 60 * 60,
  /** Sem nenhum sinal há mais que isto: a sessão é "interrompida" (o app oferece recuperar, salvar ou descartar). */
  staleAfterSec: 12 * 60 * 60,
  /** Mínimo para salvar uma sessão do cronômetro. */
  minSaveSec: 60,
  /** Limites de configuração. */
  countdownMaxMin: 240,
  pomodoro: { focusMin: [5, 90], shortMin: [1, 30], longMin: [5, 60], cycles: [2, 8] } as const,
} as const;

export const DEFAULT_POMODORO = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4, autoContinue: true } as const;

/** Recompensas (o servidor aplica; o app usa para explicar). Ver docs/CONHECIMENTO.md §5. */
export const KNOWLEDGE_REWARD = {
  /** Sessão com cronômetro: mínimo para valer XP. */
  sessionMinMin: 10,
  /** 5 XP aos 10 min, +1 a cada 3 min, até 30 XP (≈ 85 min). */
  sessionBase: 5,
  sessionPerMin: 1 / 3,
  sessionMax: 30,
  /** Registro manual (sem cronômetro): metade, até 10 XP, só hoje/ontem, no máximo 20 XP manuais por dia. */
  manualFactor: 0.5,
  manualMax: 10,
  manualDailyMax: 20,
  /** Teto diário do módulo para sessões (além do teto geral do RPG). */
  sessionsDailyMax: 90,
  /** Metas cumpridas (uma vez por período). */
  goalDaily: 10,
  goalWeekly: 30,
  goalByDate: 40,
  /** Livro concluído: exige ao menos `bookMinMin` minutos de leitura registrada no livro (evita "concluir" sem ler). */
  book: 40,
  bookMinMin: 30,
} as const;

export function sessionXp(activeSec: number, origin: SessionOrigin): number {
  const min = Math.floor(activeSec / 60);
  if (min < KNOWLEDGE_REWARD.sessionMinMin) return 0;
  const base = Math.min(KNOWLEDGE_REWARD.sessionMax, Math.floor(KNOWLEDGE_REWARD.sessionBase + (min - KNOWLEDGE_REWARD.sessionMinMin) * KNOWLEDGE_REWARD.sessionPerMin));
  return origin === 'timer' ? base : Math.min(KNOWLEDGE_REWARD.manualMax, Math.floor(base * KNOWLEDGE_REWARD.manualFactor));
}

export const goalXp = (period: GoalPeriod): number => (period === 'daily' ? KNOWLEDGE_REWARD.goalDaily : period === 'weekly' ? KNOWLEDGE_REWARD.goalWeekly : KNOWLEDGE_REWARD.goalByDate);

// ------------------------------------------------------------------ tempo ativo (função pura, igual no app e no servidor)

/** Trecho de atividade [início, fim] em ms (fim null = em andamento). */
export interface Segment {
  s: number;
  e: number | null;
}
/** Intervalos com presença confirmada [a, b] em ms (sinais próximos são unidos). */
export type SeenRange = [number, number];

export interface ActiveBreakdown {
  /** Segundos que contam. */
  activeSec: number;
  /** Com presença confirmada. */
  attendedSec: number;
  /** Sem presença, mas dentro do limite por trecho (contam). */
  unattendedSec: number;
  /** Sem presença acima do limite, ou acima do teto da sessão (NÃO contam). */
  excludedSec: number;
  /** Tempo bruto dos trechos. */
  rawSec: number;
}

/** Acrescenta um sinal de presença aos intervalos (une quando o novo cai dentro da cobertura do último). */
export function addSeen(seen: SeenRange[], at: number, coverMs = TIMER_RULES.seenCoverSec * 1000): SeenRange[] {
  const out = seen.map((r) => [r[0], r[1]] as SeenRange);
  const last = out[out.length - 1];
  if (last && at >= last[0] && at <= last[1] + coverMs) last[1] = Math.max(last[1], at);
  else if (last && at < last[0]) {
    // Sinal atrasado (fila offline): insere ordenado e une vizinhos.
    out.push([at, at]);
    out.sort((a, b) => a[0] - b[0]);
    const merged: SeenRange[] = [];
    for (const r of out) {
      const m = merged[merged.length - 1];
      if (m && r[0] <= m[1] + coverMs) m[1] = Math.max(m[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged.slice(-400);
  } else out.push([at, at]);
  return out.slice(-400);
}

/**
 * Tempo ativo dos trechos. `unattendedMaxMs` limita CADA trecho sem presença; `phaseMaxMs` (pomodoro/temporizador) limita
 * cada trecho ao planejado; `sessionMaxMs` limita o total.
 */
export function computeActive(
  segments: Segment[],
  seen: SeenRange[],
  now: number,
  o: { unattendedMaxMs?: number; sessionMaxMs?: number; coverMs?: number; segmentMaxMs?: number | null; totalMaxMs?: number | null } = {},
): ActiveBreakdown {
  const cover = o.coverMs ?? TIMER_RULES.seenCoverSec * 1000;
  const unMax = o.unattendedMaxMs ?? TIMER_RULES.unattendedMaxSec * 1000;
  const covered = seen.map(([a, b]) => [a, b + cover] as const);
  let attended = 0;
  let unattended = 0;
  let excluded = 0;
  let raw = 0;
  for (const seg of segments) {
    const s = seg.s;
    let e = Math.max(s, Math.min(seg.e ?? now, now));
    raw += e - s;
    if (o.segmentMaxMs && e - s > o.segmentMaxMs) {
      excluded += e - s - o.segmentMaxMs;
      e = s + o.segmentMaxMs;
    }
    // Partes cobertas dentro do trecho, em ordem.
    let cursor = s;
    const gaps: number[] = [];
    for (const [a, b] of covered) {
      if (b <= cursor || a >= e) continue;
      const ca = Math.max(a, cursor);
      const cb = Math.min(b, e);
      if (ca > cursor) gaps.push(ca - cursor);
      attended += cb - ca;
      cursor = cb;
      if (cursor >= e) break;
    }
    if (cursor < e) gaps.push(e - cursor);
    for (const g of gaps) {
      unattended += Math.min(g, unMax);
      excluded += Math.max(0, g - unMax);
    }
  }
  let active = attended + unattended;
  const cap = Math.min(o.sessionMaxMs ?? TIMER_RULES.sessionMaxSec * 1000, o.totalMaxMs ?? Infinity);
  if (active > cap) {
    excluded += active - cap;
    // Corta primeiro o tempo sem presença.
    const cut = active - cap;
    const fromUn = Math.min(unattended, cut);
    unattended -= fromUn;
    attended -= cut - fromUn;
    active = cap;
  }
  const sec = (ms: number) => Math.max(0, Math.round(ms / 1000));
  return { activeSec: sec(attended) + sec(unattended), attendedSec: sec(attended), unattendedSec: sec(unattended), excludedSec: sec(excluded), rawSec: sec(raw) };
}

// ------------------------------------------------------------------ cronômetro (estado compartilhado entre aparelhos)

export type TimerPhase = 'focus' | 'short_break' | 'long_break' | 'paused';

export interface PomodoroConfig {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  cyclesBeforeLong: number;
  autoContinue: boolean;
}

export interface TimerView {
  id: string;
  module: KnowledgeModule;
  kind: SessionKind;
  mode: TimerMode;
  bookId: string | null;
  subjectId: string | null;
  topicId: string | null;
  label: string | null;
  /** Nome do livro/matéria/tópico para exibir. */
  title: string;
  plannedSec: number | null;
  pomodoro: PomodoroConfig | null;
  sound: boolean;
  startPage: number | null;
  phase: TimerPhase;
  /** Início da fase atual (ms, relógio do servidor). */
  phaseStartedAt: number;
  /** Fim planejado da fase atual (foco do pomodoro, temporizador, pausas do pomodoro); null = livre. */
  phaseEndsAt: number | null;
  focusDone: number;
  segments: Segment[];
  seen: SeenRange[];
  startedAt: number;
  lastSeenAt: number;
  /** Prévia do tempo que conta agora. */
  active: ActiveBreakdown;
  stale: boolean;
  version: number;
  serverNow: number;
}

/** Fim planejado da fase de foco atual (null = sem limite). */
export function focusLimitMs(mode: TimerMode, plannedSec: number | null, pomodoro: PomodoroConfig | null, activeBeforeSegMs: number): number | null {
  if (mode === 'pomodoro' && pomodoro) return pomodoro.focusMin * 60_000;
  if (mode === 'countdown' && plannedSec) return Math.max(0, plannedSec * 1000 - activeBeforeSegMs);
  return null;
}

export function breakPhaseAfter(focusDone: number, p: PomodoroConfig): { phase: 'short_break' | 'long_break'; ms: number } {
  return focusDone > 0 && focusDone % p.cyclesBeforeLong === 0 ? { phase: 'long_break', ms: p.longBreakMin * 60_000 } : { phase: 'short_break', ms: p.shortBreakMin * 60_000 };
}

// ------------------------------------------------------------------ entradas (validadas no servidor)

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const uuid = z.string().uuid();
const COVER_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort());

export const bookInputSchema = z
  .object({
    title: trimmed(160),
    author: optText(120),
    cover: z.string().max(KNOWLEDGE_LIMITS.coverChars).regex(COVER_RE).nullish(),
    totalPages: z.number().int().min(1).max(KNOWLEDGE_LIMITS.pages).nullish(),
    currentPage: z.number().int().min(0).max(KNOWLEDGE_LIMITS.pages).default(0),
    category: optText(40),
    startedOn: isoDate.nullish(),
    targetDate: isoDate.nullish(),
    status: z.enum(BOOK_STATUS).default('want'),
  })
  .strict()
  .refine((b) => !b.totalPages || b.currentPage <= b.totalPages, { message: 'A página atual passa do total.', path: ['currentPage'] });
export type BookInput = z.output<typeof bookInputSchema>;

export const bookPatchSchema = z
  .object({
    title: trimmed(160).optional(),
    author: optText(120).optional(),
    cover: z.string().max(KNOWLEDGE_LIMITS.coverChars).regex(COVER_RE).nullable().optional(),
    totalPages: z.number().int().min(1).max(KNOWLEDGE_LIMITS.pages).nullable().optional(),
    currentPage: z.number().int().min(0).max(KNOWLEDGE_LIMITS.pages).optional(),
    category: optText(40).optional(),
    startedOn: isoDate.nullable().optional(),
    targetDate: isoDate.nullable().optional(),
    status: z.enum(BOOK_STATUS).optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    review: optText(2000).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type BookPatch = z.infer<typeof bookPatchSchema>;

export const subjectInputSchema = z
  .object({
    name: trimmed(60),
    description: optText(300),
    category: optText(40),
    color: z.enum(SUBJECT_COLORS).default('lime'),
    weeklyGoalMin: z.number().int().min(10).max(3000).nullish(),
    notes: optText(4000),
  })
  .strict();
export type SubjectInput = z.output<typeof subjectInputSchema>;
export const subjectPatchSchema = z
  .object({
    name: trimmed(60).optional(),
    description: optText(300).optional(),
    category: optText(40).optional(),
    color: z.enum(SUBJECT_COLORS).optional(),
    weeklyGoalMin: z.number().int().min(10).max(3000).nullable().optional(),
    notes: optText(4000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type SubjectPatch = z.infer<typeof subjectPatchSchema>;

export const topicInputSchema = z.object({ title: trimmed(120), notes: optText(2000), status: z.enum(TOPIC_STATUS).default('pending') }).strict();
export type TopicInput = z.output<typeof topicInputSchema>;
export const topicPatchSchema = z
  .object({ title: trimmed(120).optional(), notes: optText(2000).optional(), status: z.enum(TOPIC_STATUS).optional(), position: z.number().int().min(0).max(999).optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });

export const noteInputSchema = z
  .object({
    bookId: uuid.nullish(),
    subjectId: uuid.nullish(),
    topicId: uuid.nullish(),
    kind: z.enum(NOTE_KINDS).default('note'),
    content: trimmed(4000),
    page: z.number().int().min(0).max(KNOWLEDGE_LIMITS.pages).nullish(),
  })
  .strict()
  .refine((n) => !!(n.bookId || n.subjectId || n.topicId), { message: 'Escolha um livro, matéria ou tópico.', path: ['bookId'] });
export type NoteInput = z.output<typeof noteInputSchema>;

const sessionTarget = {
  kind: z.enum(SESSION_KINDS),
  bookId: uuid.nullish(),
  subjectId: uuid.nullish(),
  topicId: uuid.nullish(),
  label: optText(80),
};

export const pomodoroSchema = z
  .object({
    focusMin: z.number().int().min(TIMER_RULES.pomodoro.focusMin[0]).max(TIMER_RULES.pomodoro.focusMin[1]),
    shortBreakMin: z.number().int().min(TIMER_RULES.pomodoro.shortMin[0]).max(TIMER_RULES.pomodoro.shortMin[1]),
    longBreakMin: z.number().int().min(TIMER_RULES.pomodoro.longMin[0]).max(TIMER_RULES.pomodoro.longMin[1]),
    cyclesBeforeLong: z.number().int().min(TIMER_RULES.pomodoro.cycles[0]).max(TIMER_RULES.pomodoro.cycles[1]),
    autoContinue: z.boolean().default(true),
  })
  .strict();

export const timerStartSchema = z
  .object({
    id: uuid,
    ...sessionTarget,
    mode: z.enum(TIMER_MODES),
    plannedMin: z.number().int().min(1).max(TIMER_RULES.countdownMaxMin).nullish(),
    pomodoro: pomodoroSchema.nullish(),
    sound: z.boolean().default(true),
  })
  .strict()
  .refine((t) => t.mode !== 'countdown' || !!t.plannedMin, { message: 'Informe a duração.', path: ['plannedMin'] })
  .refine((t) => t.mode !== 'pomodoro' || !!t.pomodoro, { message: 'Configure o pomodoro.', path: ['pomodoro'] });
export type TimerStart = z.output<typeof timerStartSchema>;

/** Eventos do cronômetro. `at` (ISO) só pode estar no passado recente; o servidor limita ao intervalo válido. */
export const timerEventSchema = z
  .object({
    type: z.enum(['pause', 'resume', 'seen', 'break']),
    at: z.string().datetime().nullish(),
  })
  .strict();
export const timerEventsSchema = z.object({ version: z.number().int().positive().optional(), events: z.array(timerEventSchema).min(1).max(200) }).strict();

export const timerFinishSchema = z
  .object({
    at: z.string().datetime().nullish(),
    /** Só pode REDUZIR o tempo calculado (ex.: "parei de ler 10 min antes"). */
    activeMin: z.number().int().min(0).max(TIMER_RULES.sessionMaxSec / 60).nullish(),
    pageEnd: z.number().int().min(0).max(KNOWLEDGE_LIMITS.pages).nullish(),
    pagesRead: z.number().int().min(0).max(2000).nullish(),
    finishBook: z.boolean().default(false),
    note: optText(2000),
  })
  .strict();
export type TimerFinish = z.output<typeof timerFinishSchema>;

export const manualSessionSchema = z
  .object({
    clientId: uuid,
    ...sessionTarget,
    date: isoDate,
    minutes: z.number().int().min(0).max(KNOWLEDGE_LIMITS.manualMaxMin),
    startTime: z.string().regex(HHMM).nullish(),
    pageEnd: z.number().int().min(0).max(KNOWLEDGE_LIMITS.pages).nullish(),
    pagesRead: z.number().int().min(0).max(2000).nullish(),
    finishBook: z.boolean().default(false),
    note: optText(2000),
  })
  .strict()
  .refine((s) => s.minutes > 0 || (s.pagesRead ?? 0) > 0 || s.pageEnd != null, { message: 'Informe o tempo ou as páginas.', path: ['minutes'] });
export type ManualSession = z.output<typeof manualSessionSchema>;

export const sessionPatchSchema = z
  .object({
    note: optText(2000).optional(),
    topicId: uuid.nullable().optional(),
    /** Manual: qualquer valor; cronômetro: só para menos. */
    minutes: z.number().int().min(0).max(KNOWLEDGE_LIMITS.manualMaxMin).optional(),
    pagesRead: z.number().int().min(0).max(2000).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });

export const goalInputSchema = z
  .object({
    title: optText(80),
    metric: z.enum(GOAL_METRICS),
    scope: z.enum(GOAL_SCOPES).default('any'),
    subjectId: uuid.nullish(),
    bookId: uuid.nullish(),
    period: z.enum(GOAL_PERIODS),
    target: z.number().int().min(1).max(10_000).default(1),
    days: days.default([0, 1, 2, 3, 4, 5, 6]),
    dueDate: isoDate.nullish(),
    preferredTime: z.string().regex(HHMM).nullish(),
    habitId: uuid.nullish(),
    missionId: uuid.nullish(),
  })
  .strict()
  .refine((g) => g.metric !== 'book_finish' || (!!g.bookId && g.period === 'by_date'), { message: 'Escolha o livro e o prazo.', path: ['bookId'] })
  .refine((g) => g.period !== 'by_date' || !!g.dueDate, { message: 'Informe o prazo.', path: ['dueDate'] })
  .refine((g) => !(g.habitId && g.missionId), { message: 'Vincule a um hábito OU a uma missão.', path: ['missionId'] })
  .refine((g) => !(g.metric === 'days' && g.period === 'daily'), { message: '"Dias" só faz sentido por semana.', path: ['metric'] })
  .transform((g) => ({ ...g, target: g.metric === 'book_finish' ? 1 : g.target, scope: g.metric === 'book_finish' ? ('reading' as const) : g.bookId ? ('reading' as const) : g.subjectId ? ('study' as const) : g.scope }));
export type GoalInput = z.output<typeof goalInputSchema>;
export const goalPatchSchema = z
  .object({
    title: optText(80).optional(),
    target: z.number().int().min(1).max(10_000).optional(),
    days: days.optional(),
    dueDate: isoDate.nullable().optional(),
    preferredTime: z.string().regex(HHMM).nullable().optional(),
    habitId: uuid.nullable().optional(),
    missionId: uuid.nullable().optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type GoalPatch = z.infer<typeof goalPatchSchema>;

export const goalRoutineSchema = z
  .object({
    routineId: uuid.nullish(),
    newRoutine: z.object({ name: trimmed(60), kind: z.enum(['morning', 'study', 'night', 'custom']), days: days.default([1, 2, 3, 4, 5]) }).strict().nullish(),
    startTime: z.string().regex(HHMM).nullish(),
  })
  .strict()
  .refine((r) => !!r.routineId !== !!r.newRoutine, { message: 'Escolha uma rotina ou crie uma nova.', path: ['routineId'] });

// ------------------------------------------------------------------ visões devolvidas ao app

export interface BookView {
  id: string;
  title: string;
  author: string | null;
  cover: string | null;
  /** Matiz da capa gerada (sem imagem). */
  hue: number;
  totalPages: number | null;
  currentPage: number;
  /** 0–100 (null sem total de páginas). */
  percent: number | null;
  category: string | null;
  startedOn: string | null;
  targetDate: string | null;
  finishedOn: string | null;
  status: BookStatus;
  rating: number | null;
  review: string | null;
  origin: 'user' | 'ai';
  version: number;
  stats: { minutes: number; sessions: number; pagesRead: number; lastReadOn: string | null; notes: number };
  /** Ritmo médio (páginas/dia nos dias com leitura) e previsão de término, quando dá para calcular. */
  pace: { pagesPerReadingDay: number | null; forecastFinish: string | null };
}

export interface TopicView {
  id: string;
  subjectId: string;
  title: string;
  notes: string | null;
  status: TopicStatus;
  position: number;
  completedAt: string | null;
  minutes: number;
  version: number;
}

export interface SubjectView {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  color: SubjectColor;
  weeklyGoalMin: number | null;
  notes: string | null;
  archived: boolean;
  origin: 'user' | 'ai';
  version: number;
  minutesTotal: number;
  minutesWeek: number;
  sessions: number;
  lastStudiedOn: string | null;
  topics: { total: number; done: number; studying: number };
  /** Topics completos só no detalhe. */
  topicList?: TopicView[];
}

export interface SessionView {
  id: string;
  module: KnowledgeModule;
  kind: SessionKind;
  mode: TimerMode | 'manual';
  origin: SessionOrigin;
  bookId: string | null;
  subjectId: string | null;
  topicId: string | null;
  label: string | null;
  title: string;
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  activeMin: number;
  activeSec: number;
  pauseSec: number;
  excludedSec: number;
  focusBlocks: number;
  pageStart: number | null;
  pageEnd: number | null;
  pagesRead: number;
  note: string | null;
  xp: number;
  version: number;
}

export interface NoteView {
  id: string;
  bookId: string | null;
  subjectId: string | null;
  topicId: string | null;
  kind: NoteKind;
  content: string;
  page: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalView {
  id: string;
  title: string;
  metric: GoalMetric;
  scope: GoalScope;
  subjectId: string | null;
  bookId: string | null;
  period: GoalPeriod;
  target: number;
  days: number[];
  dueDate: string | null;
  preferredTime: string | null;
  habitId: string | null;
  missionId: string | null;
  status: 'active' | 'paused' | 'archived' | 'completed';
  origin: 'user' | 'ai';
  version: number;
  /** Período atual: início/fim, progresso real e se foi cumprida. scheduledToday = metas diárias fora dos dias escolhidos. */
  current: { start: string; end: string; progress: number; met: boolean; scheduledToday: boolean };
  /** Semana atual (metas diárias): dias cumpridos / dias previstos até hoje. */
  week: { met: number; scheduled: number } | null;
  linkedName: string | null;
}

export interface KnowledgeDashboardView {
  protocol: typeof KNOWLEDGE_PROTOCOL;
  today: string;
  readingMin: number;
  studyMin: number;
  focusMin: number;
  sessionsToday: number;
  pagesToday: number;
  xpToday: number;
  goals: GoalView[];
  reading: BookView[];
  subjectsWeek: { id: string; name: string; color: SubjectColor; minutes: number; goal: number | null }[];
  /** Últimos 7 dias (minutos por dia; null = sem registro). */
  week: { date: string; reading: number | null; study: number | null; focus: number | null }[];
  timer: TimerView | null;
  recent: SessionView[];
}

export interface KnowledgeStatsView {
  from: string;
  to: string;
  today: string;
  /** Só dias COM registro. Ausência = sem registro (não é "zero estudado"). */
  days: { date: string; reading: number; study: number; focus: number; pages: number; sessions: number }[];
  weeks: { start: string; minutes: number; reading: number; study: number; focus: number; daysWithRecords: number }[];
  months: { month: string; daysWithRecords: number; daysInRange: number; minutes: number; booksFinished: number; goalsMet: number }[];
  bySubject: { id: string | null; name: string; color: SubjectColor | null; minutes: number; sessions: number }[];
  booksFinished: { id: string; title: string; finishedOn: string }[];
  goalsMet: number;
  totals: { minutes: number; sessions: number; pages: number; daysWithRecords: number; daysInRange: number; avgPerRecordedDay: number; bestStreak: number };
  byHour: { hour: number; minutes: number }[];
}

export interface KnowledgeMutation {
  outcome: import('../life/protocol.ts').RewardOutcome;
  id?: string;
  existed?: boolean;
  [k: string]: unknown;
}
