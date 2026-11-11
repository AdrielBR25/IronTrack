// Contrato do módulo Bíblia (IronTrack Life — Fase 05, docs/BIBLIA.md). Compartilhado entre a API (que valida, grava por
// conta e concede XP) e o app. O texto bíblico NÃO passa pela API para leitura: o app lê os arquivos da tradução
// empacotados (offline), e a API usa os mesmos arquivos para busca, versículo do dia e ferramentas da IA.
//
// Reaproveita o motor da Fase 04: sessões e cronômetro (`knowledge_sessions`/`knowledge_timers` com module = 'bible' e
// ref = trecho de capítulos), metas (`knowledge_goals` com module = 'bible') e o vínculo com hábitos/missões.
import { z } from 'zod';
import type { GoalView, SessionView, TimerView } from '../knowledge/protocol.ts';
import type { RewardOutcome } from '../life/protocol.ts';
import { isBookId, parseKey, parseSpan, type BookId } from './canon.ts';
import { PLAN_TEMPLATES, type PlanTemplate } from './plans.ts';
import type { VerseTheme } from './verses.ts';

export const BIBLE_PROTOCOL = 'irontrack.life.bible.v1';

// ------------------------------------------------------------------ vocabulário

export const VERSE_MODES = ['daily', 'on_open', 'interval', 'on_request'] as const;
export type VerseMode = (typeof VERSE_MODES)[number];
export const VERSE_MODE_LABEL: Record<VerseMode, string> = {
  daily: 'Uma vez ao dia',
  on_open: 'Ao abrir a área Bíblia',
  interval: 'Em intervalos durante o uso',
  on_request: 'Só quando eu pedir',
};

export const READING_THEMES = ['dark', 'sepia', 'light'] as const;
export type ReadingTheme = (typeof READING_THEMES)[number];
export const READING_THEME_LABEL: Record<ReadingTheme, string> = { dark: 'Escuro', sepia: 'Sépia', light: 'Claro' };
export const SPACINGS = ['compact', 'normal', 'relaxed'] as const;
export type Spacing = (typeof SPACINGS)[number];
export const SPACING_LABEL: Record<Spacing, string> = { compact: 'Compacto', normal: 'Normal', relaxed: 'Amplo' };

export const HIGHLIGHT_COLORS = ['lime', 'amber', 'sky', 'rose', 'violet'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const MARK_KINDS = ['favorite', 'highlight'] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export const REFLECTION_KINDS = ['reflection', 'gratitude', 'note'] as const;
export type ReflectionKind = (typeof REFLECTION_KINDS)[number];
export const REFLECTION_KIND_LABEL: Record<ReflectionKind, string> = { reflection: 'Reflexão', gratitude: 'Gratidão', note: 'Anotação' };

export const REMINDER_KINDS = ['verse', 'reading', 'plan', 'reflection'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
export const REMINDER_LABEL: Record<ReminderKind, string> = { verse: 'Versículo do dia', reading: 'Horário de leitura', plan: 'Plano de leitura', reflection: 'Momento de reflexão' };

export const PLAN_STATUS = ['active', 'paused', 'completed', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUS)[number];
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = { active: 'Em andamento', paused: 'Pausado', completed: 'Concluído', archived: 'Arquivado' };

/** Metas da Bíblia (usam knowledge_goals com module = 'bible'). */
export const BIBLE_GOAL_METRICS = ['minutes', 'chapters', 'days', 'sessions', 'plan_finish'] as const;
export type BibleGoalMetric = (typeof BIBLE_GOAL_METRICS)[number];
export const BIBLE_GOAL_UNIT: Record<BibleGoalMetric, string> = { minutes: 'min', chapters: 'capítulos', days: 'dias', sessions: 'sessões', plan_finish: '' };

export const BIBLE_LIMITS = {
  marks: 5000,
  reflections: 5000,
  plans: 30,
  planDays: 400,
  planChapters: 1200,
  tags: 8,
  tagChars: 30,
  reflectionChars: 8000,
  passageVerses: 60,
  searchResults: 50,
  readPastDays: 30,
  chaptersPerDay: 150,
  extraVersesPerDay: 10,
} as const;

/** Recompensas (o servidor aplica; o app usa para explicar). Ver docs/BIBLIA.md §8. Atributo: Espiritualidade. */
export const BIBLE_REWARD = {
  /** Sessões de leitura bíblica com cronômetro: mesma régua da Fase 04 (≥ 10 min: 5 XP + 1 a cada 3 min, máx. 30). */
  sessionsDailyMax: 60,
  /** Dia do plano concluído: 5 XP, no máximo 2 dias por dia (10 XP). */
  planDay: 5,
  planDaysPerDay: 2,
  /** Plano concluído: 40 XP, se a leitura se espalhou por pelo menos min(7, dias do plano) datas diferentes. */
  plan: 40,
  planMinDates: 7,
  /** Metas cumpridas: as mesmas da Fase 04 (diária 10, semanal 30, por prazo 40; 0 se vinculada a hábito/missão). */
} as const;

// ------------------------------------------------------------------ entradas (validadas no servidor)

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).transform((d) => [...new Set(d)].sort());

export const bookIdSchema = z.string().refine((b) => isBookId(b), { message: 'Livro inexistente nesta tradução.' }) as unknown as z.ZodType<BookId>;
export const chapterKeySchema = z.string().refine((k) => {
  const r = parseKey(k);
  return !!r && !r.v1;
}, { message: 'Capítulo inexistente nesta tradução.' });
export const passageKeySchema = z.string().refine((k) => !!parseKey(k), { message: 'Referência inexistente nesta tradução.' });
export const spanKeySchema = z.string().refine((k) => !!parseSpan(k), { message: 'Trecho inválido.' });

const tags = z
  .array(z.string().trim().min(1).max(BIBLE_LIMITS.tagChars))
  .max(BIBLE_LIMITS.tags)
  .default([])
  .transform((t) => [...new Set(t.map((x) => x.toLowerCase()))]);

export const reminderSchema = z
  .object({
    kind: z.enum(REMINDER_KINDS),
    enabled: z.boolean().default(true),
    time: z.string().regex(HHMM),
    days: days.default([0, 1, 2, 3, 4, 5, 6]),
  })
  .strict();
export type Reminder = z.output<typeof reminderSchema>;

export const prefsPatchSchema = z
  .object({
    showOnHome: z.boolean().optional(),
    verseMode: z.enum(VERSE_MODES).optional(),
    verseIntervalMin: z.number().int().min(30).max(720).optional(),
    fontSize: z.number().int().min(14).max(30).optional(),
    spacing: z.enum(SPACINGS).optional(),
    readingTheme: z.enum(READING_THEMES).optional(),
    translation: z.enum(['BPM']).optional(),
    reminders: z.array(reminderSchema).max(8).optional(),
    quietStart: z.string().regex(HHMM).nullable().optional(),
    quietEnd: z.string().regex(HHMM).nullable().optional(),
    shareAi: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });
export type PrefsPatch = z.infer<typeof prefsPatchSchema>;

export const positionSchema = z.object({ ref: passageKeySchema }).strict();

export const markInputSchema = z
  .object({
    kind: z.enum(MARK_KINDS),
    ref: passageKeySchema,
    color: z.enum(HIGHLIGHT_COLORS).nullish(),
    tags,
  })
  .strict();
export type MarkInput = z.output<typeof markInputSchema>;
export const markPatchSchema = z.object({ color: z.enum(HIGHLIGHT_COLORS).nullable().optional(), tags: tags.optional() }).strict();

export const reflectionInputSchema = z
  .object({
    clientId: z.string().uuid(),
    kind: z.enum(REFLECTION_KINDS).default('reflection'),
    date: isoDate.nullish(),
    title: optText(120),
    content: z.string().trim().min(1).max(BIBLE_LIMITS.reflectionChars),
    ref: passageKeySchema.nullish(),
    tags,
    favorite: z.boolean().default(false),
  })
  .strict();
export type ReflectionInput = z.output<typeof reflectionInputSchema>;
export const reflectionPatchSchema = z
  .object({
    kind: z.enum(REFLECTION_KINDS).optional(),
    date: isoDate.optional(),
    title: optText(120).optional(),
    content: z.string().trim().min(1).max(BIBLE_LIMITS.reflectionChars).optional(),
    ref: passageKeySchema.nullable().optional(),
    tags: tags.optional(),
    favorite: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });

/** Marcar capítulo(s) como lido(s) (leitor, plano ou registro manual). Idempotente por capítulo e dia. */
export const readInputSchema = z
  .object({
    chapters: z.array(chapterKeySchema).min(1).max(BIBLE_LIMITS.chaptersPerDay),
    date: isoDate.nullish(),
    planId: z.string().uuid().nullish(),
  })
  .strict();

/** Registro manual de leitura bíblica (sem cronômetro): minutos + trecho. */
export const bibleManualSchema = z
  .object({
    clientId: z.string().uuid(),
    date: isoDate,
    minutes: z.number().int().min(1).max(600),
    span: spanKeySchema,
    note: optText(2000),
  })
  .strict();

/** Iniciar o cronômetro da Fase 04 numa leitura bíblica. */
export const bibleTimerStartSchema = z
  .object({
    id: z.string().uuid(),
    ref: chapterKeySchema,
    mode: z.enum(['stopwatch', 'countdown', 'pomodoro']).default('stopwatch'),
    plannedMin: z.number().int().min(1).max(240).nullish(),
    planId: z.string().uuid().nullish(),
    sound: z.boolean().default(true),
  })
  .strict()
  .refine((t) => t.mode !== 'countdown' || !!t.plannedMin, { message: 'Informe a duração.', path: ['plannedMin'] });

/** Encerrar a leitura: até onde chegou (capítulo). `reached` null = não terminou nenhum capítulo. */
export const bibleTimerFinishSchema = z
  .object({
    at: z.string().datetime().nullish(),
    activeMin: z.number().int().min(0).max(360).nullish(),
    reached: chapterKeySchema.nullish(),
    note: optText(2000),
  })
  .strict();

export const planCreateSchema = z
  .object({
    id: z.string().uuid().nullish(),
    template: z.enum(PLAN_TEMPLATES).nullish(),
    title: optText(80),
    description: optText(300),
    /** Plano personalizado: livros (na ordem pedida) OU um trecho "JHN.1-JHN.21". */
    books: z.array(bookIdSchema).min(1).max(66).nullish(),
    span: spanKeySchema.nullish(),
    days: z.number().int().min(1).max(BIBLE_LIMITS.planDays).nullish(),
    perDay: z.number().int().min(1).max(30).nullish(),
    startDate: isoDate.nullish(),
  })
  .strict()
  .refine((p) => !!p.template !== !!(p.books?.length || p.span), { message: 'Escolha um modelo OU os livros/trecho.', path: ['template'] })
  .refine((p) => !(p.days && p.perDay), { message: 'Use dias OU capítulos por dia.', path: ['perDay'] });
export type PlanCreate = z.output<typeof planCreateSchema>;

export const planPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
    /** Reorganizar: redistribui os capítulos que faltam em N dias (os concluídos ficam). */
    remainingDays: z.number().int().min(1).max(BIBLE_LIMITS.planDays).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nenhum campo' });

export const bibleGoalInputSchema = z
  .object({
    title: optText(80),
    metric: z.enum(BIBLE_GOAL_METRICS),
    period: z.enum(['daily', 'weekly', 'by_date']),
    target: z.number().int().min(1).max(10_000).default(1),
    /** Restringe a um livro (ex.: Provérbios nesta semana). */
    book: bookIdSchema.nullish(),
    planId: z.string().uuid().nullish(),
    days: z.preprocess((v) => (Array.isArray(v) && v.length === 0 ? undefined : v), days.default([0, 1, 2, 3, 4, 5, 6])),
    dueDate: isoDate.nullish(),
    preferredTime: z.string().regex(HHMM).nullish(),
    habitId: z.string().uuid().nullish(),
    missionId: z.string().uuid().nullish(),
  })
  .strict()
  .refine((g) => g.metric !== 'plan_finish' || (!!g.planId && g.period === 'by_date'), { message: 'Escolha o plano e o prazo.', path: ['planId'] })
  .refine((g) => g.period !== 'by_date' || !!g.dueDate, { message: 'Informe o prazo.', path: ['dueDate'] })
  .refine((g) => !(g.habitId && g.missionId), { message: 'Vincule a um hábito OU a uma missão.', path: ['missionId'] })
  .refine((g) => !(g.metric === 'days' && g.period === 'daily'), { message: '"Dias" só faz sentido por semana.', path: ['metric'] })
  .transform((g) => ({ ...g, target: g.metric === 'plan_finish' ? 1 : g.target }));
export type BibleGoalInput = z.output<typeof bibleGoalInputSchema>;

// ------------------------------------------------------------------ visões

export interface PassageVerse {
  v: number;
  text: string;
  /** Versículo sem texto nesta tradução (ex.: omitido nos manuscritos mais antigos); `note` explica. */
  omitted?: boolean;
  note?: string;
}

/** Passagem com texto (a API devolve para IA, versículo do dia e busca). Sempre com referência e tradução. */
export interface PassageView {
  ref: string;
  label: string;
  translation: string;
  verses: PassageVerse[];
}

export interface DailyVerseView {
  date: string;
  /** 0 = passagem principal do dia; 1… = "outra passagem". */
  seq: number;
  theme: VerseTheme;
  context: string | null;
  passage: PassageView;
  favorite: boolean;
}

export interface BiblePrefsView {
  translation: 'BPM';
  showOnHome: boolean;
  verseMode: VerseMode;
  verseIntervalMin: number;
  fontSize: number;
  spacing: Spacing;
  readingTheme: ReadingTheme;
  reminders: Reminder[];
  quietStart: string | null;
  quietEnd: string | null;
  /** A IA pode ler reflexões quando a pessoa pedir (padrão: sim, só sob pedido explícito). */
  shareAi: boolean;
  lastRef: string | null;
  lastReadAt: string | null;
  version: number;
}

export interface MarkView {
  id: string;
  kind: MarkKind;
  ref: string;
  label: string;
  color: HighlightColor | null;
  tags: string[];
  createdAt: string;
  /** Texto da passagem (listas de favoritos). */
  text?: string;
}

export interface ReflectionView {
  id: string;
  kind: ReflectionKind;
  date: string;
  title: string | null;
  content: string;
  ref: string | null;
  label: string | null;
  tags: string[];
  favorite: boolean;
  origin: 'user' | 'ai';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDayView {
  day: number;
  chapters: string[];
  label: string;
  minutes: number;
  completedOn: string | null;
}

export interface PlanView {
  id: string;
  template: PlanTemplate | 'custom';
  title: string;
  description: string | null;
  status: PlanStatus;
  startDate: string;
  pausedOn: string | null;
  completedOn: string | null;
  totalDays: number;
  doneDays: number;
  totalChapters: number;
  percent: number;
  /** Próximo dia a ler (primeiro não concluído). */
  next: PlanDayView | null;
  /** Dias atrás do ritmo sugerido (só informativo; nunca penaliza). */
  behind: number;
  origin: 'user' | 'ai';
  version: number;
  days?: PlanDayView[];
}

export interface ReadingWeekDay {
  date: string;
  minutes: number;
  chapters: number;
}

export interface BibleProgressView {
  /** Capítulos diferentes já lidos (registro do app). */
  chaptersRead: number;
  totalChapters: number;
  /** Por livro: capítulos diferentes lidos. */
  books: { id: BookId; read: number; total: number }[];
  /** Chaves dos capítulos lidos (para o leitor marcar). */
  readKeys: string[];
}

export interface BibleHomeView {
  protocol: typeof BIBLE_PROTOCOL;
  today: string;
  prefs: BiblePrefsView;
  verse: DailyVerseView | null;
  resume: { ref: string; label: string } | null;
  plans: PlanView[];
  week: ReadingWeekDay[];
  weekMinutes: number;
  weekChapters: number;
  totals: { chaptersRead: number; minutes: number; daysWithReading: number };
  reflections: ReflectionView[];
  favorites: MarkView[];
  goals: GoalView[];
  timer: TimerView | null;
  recent: SessionView[];
}

export interface BibleMutation {
  outcome: RewardOutcome;
  [k: string]: unknown;
}

export const isPlanTemplate = (t: unknown): t is PlanTemplate => typeof t === 'string' && (PLAN_TEMPLATES as readonly string[]).includes(t);
