// Fontes de contexto do assistente (IronTrack 2.0 F01/P05): lê do banco local SOMENTE as categorias
// que o usuário selecionou e converte cada registro num resumo mínimo e tipado, antes de chegar ao
// módulo de IA. Só leitura: nenhuma função daqui grava, atualiza ou apaga registros.
// IDs internos, profileId, observações livres, dobras avulsas e fotos não são copiados.
// As fórmulas de treino e de evolução corporal são as dos domínios, sem alteração.
import { liveQuery } from 'dexie';
import { getSettings } from '@/db/db';
import { completedSessionsSince, recentCompletedSessions } from '@/db/repo';
import { listBodyEntries, recentBodyEntries } from '@/db/body';
import { GOAL_LABEL } from '@/lib/defaults';
import { addDays, fromISODate, todayISO } from '@/lib/dates';
import type { BodyEntry, WorkoutSession } from '@/lib/types';
import { consistency, sessionVolume, setsByMuscle, validSetCount } from '@/modules/training';
import { metricChanges } from '@/modules/body';
import {
  BODY_CONTEXT_FIELDS,
  DEFAULT_CONTEXT_LIMITS,
  buildAIContext,
  type AIContextCategory,
  type AIContextSources,
  type BodyEntrySource,
  type TrainingSessionSource,
} from '@/modules/ai';

/** Categorias que o assistente oferece. Fotos de progresso ficam fora (bloqueadas no módulo de IA). */
export const ASSISTANT_CATEGORIES = ['training_summary', 'training_history', 'body_measurements', 'body_evolution', 'profile_preferences'] as const satisfies readonly AIContextCategory[];
export type AssistantCategory = (typeof ASSISTANT_CATEGORIES)[number];

/** Janela do resumo de treinos, em dias (inclui hoje). */
export const SUMMARY_PERIOD_DAYS = 28;

const has = (cats: readonly AIContextCategory[], c: AIContextCategory) => cats.includes(c);

function toSessionSource(s: WorkoutSession): TrainingSessionSource {
  return {
    status: s.status,
    startedAt: s.startedAt,
    durationSec: s.durationSec,
    workoutLabel: s.workoutLabel,
    workoutName: s.workoutName,
    exercises: s.exercises.map((e) => ({
      name: e.name,
      muscleGroup: e.muscleGroup,
      sets: e.sets.map((x) => ({ type: x.type, status: x.status, weight: x.weight, reps: x.reps, rpe: x.rpe, rir: x.rir })),
    })),
  };
}

function toBodySource(e: BodyEntry): BodyEntrySource {
  const out: BodyEntrySource = { date: e.date };
  for (const f of BODY_CONTEXT_FIELDS) if (typeof e[f] === 'number') out[f] = e[f] as number;
  return out;
}

/**
 * Lê só o necessário para as categorias pedidas:
 * - resumo: treinos concluídos dos últimos 28 dias (pelo índice de data) e os dias de treino;
 * - histórico: os 12 treinos concluídos mais recentes;
 * - medidas: as 12 avaliações mais recentes;
 * - evolução: todas as avaliações (a variação vai da primeira à última), reduzidas às variações;
 * - preferências: unidade, dias de treino e objetivo.
 * Categoria sem registros fica sem fonte (o ContextBuilder a lista como "sem dados"): nada é inventado.
 */
export async function loadContextSources(categories: readonly AIContextCategory[], today: string = todayISO()): Promise<AIContextSources> {
  const out: AIContextSources = {};
  const needSettings = has(categories, 'training_summary') || has(categories, 'profile_preferences');
  const settings = needSettings ? await getSettings() : undefined;

  if (has(categories, 'training_summary') && settings) {
    const from = addDays(today, -(SUMMARY_PERIOD_DAYS - 1));
    const list = await completedSessionsSince(fromISODate(from).getTime());
    if (list.length) {
      out.trainingSummary = {
        periodDays: SUMMARY_PERIOD_DAYS,
        sessions: list.length,
        totalSets: list.reduce((a, s) => a + validSetCount(s), 0),
        totalVolumeKg: list.reduce((a, s) => a + sessionVolume(s), 0),
        consistencyPct: consistency(list, today, settings.trainingDays).pct,
        muscleGroups: setsByMuscle(list, from, addDays(today, 1)).map((g) => ({ name: g.group, sets: g.sets })),
      };
    }
  }
  if (has(categories, 'training_history')) {
    const list = await recentCompletedSessions(DEFAULT_CONTEXT_LIMITS.maxSessions);
    if (list.length) out.trainingSessions = list.map(toSessionSource);
  }
  if (has(categories, 'body_measurements')) {
    const list = await recentBodyEntries(DEFAULT_CONTEXT_LIMITS.maxBodyEntries);
    if (list.length) out.bodyEntries = list.map(toBodySource);
  }
  if (has(categories, 'body_evolution')) {
    const changes = metricChanges(await listBodyEntries());
    if (changes.length)
      out.bodyEvolution = changes.map((c) => ({ metric: { key: c.metric.key, label: c.metric.label, unit: c.metric.unit }, first: c.first, last: c.last, delta: c.delta, verdict: c.verdict }));
  }
  if (has(categories, 'profile_preferences') && settings) {
    out.profilePreferences = { weightUnit: settings.weightUnit, trainingDays: [...settings.trainingDays], goal: GOAL_LABEL[settings.goal] };
  }
  return out;
}

/**
 * Impressão digital do contexto efetivo: o JSON exato que o ContextBuilder montaria com estas fontes.
 * Duas leituras com a mesma impressão produzem o mesmo contexto (logo, a mesma solicitação).
 */
export function contextFingerprint(sources: AIContextSources, categories: readonly AIContextCategory[]): string {
  return JSON.stringify(buildAIContext(sources, categories).data);
}

/**
 * Observa as fontes das categorias escolhidas enquanto a prévia está aberta. Usa o liveQuery do
 * Dexie: a leitura só se repete quando uma tabela consultada muda, inclusive por outra aba do app
 * (o Dexie propaga as gravações entre abas). Devolve a função que encerra a observação.
 */
export function watchContextSources(categories: readonly AIContextCategory[], onChange: (sources: AIContextSources) => void, onError?: () => void): () => void {
  const sub = liveQuery(() => loadContextSources(categories)).subscribe({ next: onChange, error: () => onError?.() });
  return () => sub.unsubscribe();
}
