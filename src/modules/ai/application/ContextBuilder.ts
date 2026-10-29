// Monta o contexto que pode acompanhar uma solicitação de IA, só com dados entregues
// explicitamente por quem chama e só nas categorias selecionadas. Nunca consulta o banco.
// Cada campo de saída é copiado de uma lista fechada: IDs internos, perfil, nome do usuário,
// observações livres e fotos não têm como entrar. Testável sem IndexedDB.
import { tsToISODate } from '@/lib/dates';
import { AIError } from '../domain/errors';
import { AI_CONTEXT_CATEGORIES, isBlockedCategory, isContextCategory, type AIContextCategory } from '../domain/permissions';

// ----- Entradas (estruturais: aceitam os registros do app, mas só os campos listados são lidos)

export interface TrainingSummarySource {
  periodDays?: number;
  sessions?: number;
  totalSets?: number;
  totalVolumeKg?: number;
  consistencyPct?: number;
  muscleGroups?: readonly { name: string; sets: number }[];
}

export interface TrainingSessionSource {
  status?: string;
  startedAt: number;
  durationSec?: number;
  workoutLabel?: string;
  workoutName?: string;
  exercises: readonly {
    name: string;
    muscleGroup?: string;
    sets: readonly { type?: string; status?: string; weight?: number | null; reps?: number | null; rpe?: number | null; rir?: number | null }[];
  }[];
}

/** Medidas numéricas que podem ir para o contexto. Dobras e circunferências avulsas ficam de fora. */
export const BODY_CONTEXT_FIELDS = [
  'weightKg',
  'bodyFatPct',
  'fatMassKg',
  'leanMassKg',
  'leanPct',
  'waistCm',
  'abdomenCm',
  'hipCm',
  'armCm',
  'thighCm',
  'waistHipRatio',
  'bmi',
  'skinfoldSumMm',
] as const;
export type BodyContextField = (typeof BODY_CONTEXT_FIELDS)[number];

export type BodyEntrySource = { date: string } & { [K in BodyContextField]?: number | null };

export interface BodyEvolutionSource {
  metric: { key: string; label: string; unit: string };
  first: number;
  last: number;
  delta: number;
  verdict?: string;
}

export interface ProfilePreferencesSource {
  weightUnit?: string;
  trainingDays?: readonly number[];
  goal?: string;
}

/** P20: meta de treino já medida pelo motor das metas (o módulo de IA não recalcula nada). */
export interface TrainingGoalSource {
  title: string;
  type: string;
  target: number;
  unit: string;
  current?: number | null;
  /** 0–1. */
  fraction?: number;
  state?: string;
  deadline?: string | null;
  exercise?: string | null;
}

/** Dados que quem chama escolheu oferecer. Nada aqui é buscado automaticamente. */
export interface AIContextSources {
  trainingSummary?: TrainingSummarySource;
  trainingSessions?: readonly TrainingSessionSource[];
  bodyEntries?: readonly BodyEntrySource[];
  bodyEvolution?: readonly BodyEvolutionSource[];
  profilePreferences?: ProfilePreferencesSource;
  trainingGoals?: readonly TrainingGoalSource[];
}

// ----- Saída

export interface TrainingSummaryContext {
  periodDays?: number;
  sessions?: number;
  totalSets?: number;
  totalVolumeKg?: number;
  consistencyPct?: number;
  muscleGroups?: { name: string; sets: number }[];
}

export interface TrainingSessionContext {
  date: string;
  workout?: string;
  durationMin?: number;
  exercises: { name: string; muscleGroup?: string; sets: { type: string; weightKg?: number; reps?: number; rpe?: number; rir?: number }[] }[];
}

export type BodyMeasurementContext = { date: string } & { [K in BodyContextField]?: number };

export interface BodyEvolutionContext {
  metric: string;
  unit: string;
  first: number;
  last: number;
  delta: number;
  verdict?: string;
}

export interface ProfilePreferencesContext {
  weightUnit?: 'kg' | 'lb';
  trainingDaysPerWeek?: number;
  goal?: string;
}

export interface TrainingGoalContext {
  title: string;
  type?: string;
  target: number;
  unit?: string;
  current?: number;
  progressPct?: number;
  state?: string;
  deadline?: string;
  exercise?: string;
}

export interface AIContextData {
  training_summary?: TrainingSummaryContext;
  training_history?: TrainingSessionContext[];
  body_measurements?: BodyMeasurementContext[];
  body_evolution?: BodyEvolutionContext[];
  profile_preferences?: ProfilePreferencesContext;
  training_goals?: TrainingGoalContext[];
}

export type ContextExclusionReason = 'not_selected' | 'blocked' | 'no_data';

export interface AIContext {
  data: AIContextData;
  /** Categorias que de fato entraram. */
  included: AIContextCategory[];
  excluded: { category: AIContextCategory; reason: ContextExclusionReason }[];
  /** Itens antigos foram descartados para caber no limite. */
  truncated: boolean;
  /** Tamanho do contexto serializado, em caracteres. */
  chars: number;
}

export interface ContextLimits {
  maxGoals: number;
  maxSessions: number;
  maxExercisesPerSession: number;
  maxSetsPerExercise: number;
  maxBodyEntries: number;
  maxEvolutionMetrics: number;
  maxMuscleGroups: number;
  maxTextLength: number;
  maxContextChars: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  maxGoals: 10,
  maxSessions: 12,
  maxExercisesPerSession: 15,
  maxSetsPerExercise: 8,
  maxBodyEntries: 12,
  maxEvolutionMetrics: 20,
  maxMuscleGroups: 20,
  maxTextLength: 60,
  maxContextChars: 12_000,
};

// ----- Higienização

const DATA_URL = /data:[a-z0-9.+-]*\/?[a-z0-9.+-]*[;,]/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Texto curto e sem conteúdo embutido: descarta data URLs e mascara UUIDs. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || DATA_URL.test(v)) return undefined;
  const t = v.replace(UUID, '[id]').replace(/\s+/g, ' ').trim().slice(0, max);
  return t || undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined;
}

/** Remove chaves `undefined` para o objeto serializado ficar mínimo. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function summary(s: TrainingSummarySource, lim: ContextLimits): TrainingSummaryContext | undefined {
  const muscleGroups = (s.muscleGroups ?? []).slice(0, lim.maxMuscleGroups).flatMap((g) => {
    const name = text(g.name, lim.maxTextLength);
    const sets = num(g.sets);
    return name && sets !== undefined ? [{ name, sets }] : [];
  });
  const out = compact<TrainingSummaryContext>({
    periodDays: num(s.periodDays),
    sessions: num(s.sessions),
    totalSets: num(s.totalSets),
    totalVolumeKg: num(s.totalVolumeKg),
    consistencyPct: num(s.consistencyPct),
    muscleGroups: muscleGroups.length ? muscleGroups : undefined,
  });
  return Object.keys(out).length ? out : undefined;
}

function sessions(list: readonly TrainingSessionSource[], lim: ContextLimits): TrainingSessionContext[] {
  return list
    .filter((s) => (s.status === undefined || s.status === 'completed') && Number.isFinite(s.startedAt))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, lim.maxSessions)
    .map((s) => {
      const label = [text(s.workoutLabel, 8), text(s.workoutName, lim.maxTextLength)].filter(Boolean).join(' · ');
      const exercises = (s.exercises ?? []).slice(0, lim.maxExercisesPerSession).flatMap((e) => {
        const name = text(e.name, lim.maxTextLength);
        if (!name) return [];
        const sets = (e.sets ?? [])
          .filter((x) => x.status === undefined || x.status === 'done')
          .slice(0, lim.maxSetsPerExercise)
          .map((x) => compact({ type: text(x.type, 12) ?? 'normal', weightKg: num(x.weight), reps: num(x.reps), rpe: num(x.rpe), rir: num(x.rir) }));
        return [compact({ name, muscleGroup: text(e.muscleGroup, lim.maxTextLength), sets })];
      });
      const durationMin = num(s.durationSec) !== undefined ? Math.round((s.durationSec as number) / 60) : undefined;
      return compact<TrainingSessionContext>({ date: tsToISODate(s.startedAt), workout: label || undefined, durationMin, exercises });
    });
}

function bodyEntries(list: readonly BodyEntrySource[], lim: ContextLimits): BodyMeasurementContext[] {
  return list
    .filter((e) => typeof e.date === 'string' && ISO_DATE.test(e.date))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, lim.maxBodyEntries)
    .map((e) => {
      const out: BodyMeasurementContext = { date: e.date };
      for (const f of BODY_CONTEXT_FIELDS) {
        const v = num(e[f]);
        if (v !== undefined) out[f] = v;
      }
      return out;
    })
    .filter((e) => Object.keys(e).length > 1);
}

function evolution(list: readonly BodyEvolutionSource[], lim: ContextLimits): BodyEvolutionContext[] {
  return list.slice(0, lim.maxEvolutionMetrics).flatMap((c) => {
    const metric = text(c.metric?.label, lim.maxTextLength);
    const unit = text(c.metric?.unit, 8) ?? '';
    const first = num(c.first);
    const last = num(c.last);
    const delta = num(c.delta);
    if (!metric || first === undefined || last === undefined || delta === undefined) return [];
    return [compact<BodyEvolutionContext>({ metric, unit, first, last, delta, verdict: text(c.verdict, 12) })];
  });
}

function preferences(p: ProfilePreferencesSource, lim: ContextLimits): ProfilePreferencesContext | undefined {
  const days = Array.isArray(p.trainingDays) ? new Set(p.trainingDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)).size : undefined;
  const out = compact<ProfilePreferencesContext>({
    weightUnit: p.weightUnit === 'kg' || p.weightUnit === 'lb' ? p.weightUnit : undefined,
    trainingDaysPerWeek: days,
    goal: text(p.goal, lim.maxTextLength),
  });
  return Object.keys(out).length ? out : undefined;
}

function goals(list: readonly TrainingGoalSource[], lim: ContextLimits): TrainingGoalContext[] {
  return list.slice(0, lim.maxGoals).flatMap((g) => {
    const title = text(g.title, lim.maxTextLength);
    const target = num(g.target);
    if (!title || target === undefined) return [];
    const fraction = num(g.fraction);
    return [
      compact<TrainingGoalContext>({
        title,
        type: text(g.type, lim.maxTextLength),
        target,
        unit: text(g.unit, 16),
        current: num(g.current),
        progressPct: fraction !== undefined ? Math.round(Math.max(0, Math.min(1, fraction)) * 100) : undefined,
        state: text(g.state, 24),
        deadline: typeof g.deadline === 'string' && ISO_DATE.test(g.deadline) ? g.deadline : undefined,
        exercise: text(g.exercise, lim.maxTextLength),
      }),
    ];
  });
}

const SOURCE_OF: Record<Exclude<AIContextCategory, 'progress_photos'>, keyof AIContextSources> = {
  training_summary: 'trainingSummary',
  training_history: 'trainingSessions',
  body_measurements: 'bodyEntries',
  body_evolution: 'bodyEvolution',
  profile_preferences: 'profilePreferences',
  training_goals: 'trainingGoals',
};

/** Normaliza a seleção: rejeita categoria desconhecida (falha segura), remove repetidas, ordena. */
export function normalizeCategories(selected: readonly unknown[] = []): AIContextCategory[] {
  if (!Array.isArray(selected) || !selected.every(isContextCategory)) throw new AIError('context_invalid');
  const set = new Set(selected as AIContextCategory[]);
  return AI_CONTEXT_CATEGORIES.filter((c) => set.has(c));
}

/**
 * Constrói o contexto tipado e mínimo. Só entram as categorias selecionadas que não estão
 * bloqueadas e têm dados; o resto é listado em `excluded`. Se passar do limite, descarta os itens
 * mais antigos do histórico e das avaliações; se ainda não couber, falha com `context_invalid`.
 */
export function buildAIContext(sources: AIContextSources = {}, selected: readonly unknown[] = [], limits: Partial<ContextLimits> = {}): AIContext {
  const lim = { ...DEFAULT_CONTEXT_LIMITS, ...limits };
  const categories = normalizeCategories(selected);
  const data: AIContextData = {};
  const excluded: AIContext['excluded'] = [];

  for (const category of AI_CONTEXT_CATEGORIES) {
    if (!categories.includes(category)) {
      const offered = category === 'progress_photos' ? false : sources[SOURCE_OF[category]] !== undefined;
      if (offered) excluded.push({ category, reason: 'not_selected' });
      continue;
    }
    if (isBlockedCategory(category) || category === 'progress_photos') {
      excluded.push({ category, reason: 'blocked' });
      continue;
    }
    if (category === 'training_summary') data.training_summary = sources.trainingSummary && summary(sources.trainingSummary, lim);
    if (category === 'training_history') data.training_history = sources.trainingSessions && sessions(sources.trainingSessions, lim);
    if (category === 'body_measurements') data.body_measurements = sources.bodyEntries && bodyEntries(sources.bodyEntries, lim);
    if (category === 'body_evolution') data.body_evolution = sources.bodyEvolution && evolution(sources.bodyEvolution, lim);
    if (category === 'profile_preferences') data.profile_preferences = sources.profilePreferences && preferences(sources.profilePreferences, lim);
    if (category === 'training_goals') data.training_goals = sources.trainingGoals && goals(sources.trainingGoals, lim);
    const value = data[category];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete data[category];
      excluded.push({ category, reason: 'no_data' });
    }
  }

  let truncated = false;
  let chars = JSON.stringify(data).length;
  while (chars > lim.maxContextChars) {
    // Descarta primeiro o histórico mais antigo, depois as avaliações mais antigas.
    if (data.training_history && data.training_history.length > 1) data.training_history.pop();
    else if (data.body_measurements && data.body_measurements.length > 1) data.body_measurements.pop();
    else throw new AIError('context_invalid');
    truncated = true;
    chars = JSON.stringify(data).length;
  }

  const included = AI_CONTEXT_CATEGORIES.filter((c) => c in data);
  return { data, included, excluded, truncated, chars: Object.keys(data).length ? chars : 0 };
}
