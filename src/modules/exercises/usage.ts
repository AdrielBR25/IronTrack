// Histórico de uso da biblioteca e "Mais utilizados" (IronTrack 2.0 F01/P18, docs/RECONHECIMENTO_EXERCICIOS.md §9–10).
// Duas evidências diferentes, que nunca se misturam:
//  - presença em ficha: a instância guarda a origem (criada da biblioteca ou associada depois) — "Já está em uma das
//    suas fichas". Não diz que o exercício foi executado;
//  - uso em sessão: a CÓPIA gravada na sessão concluída tem a origem — "Utilizado em uma sessão registrada com esta
//    origem". Só conta exercício com ao menos uma série concluída (não aquecimento); planejado não conta.
// Sem contagem por nome, sem somar históricos de instâncias diferentes por semelhança, sem origem retroativa: uma
// associação feita hoje não transforma sessões antigas em uso do item.
import type { Routine, WorkoutSession } from '@/modules/training';
import { libraryKeyOf } from './instance';
import type { LibraryKey } from './types';

export interface MostUsedEntry {
  key: LibraryKey;
  /** Sessões concluídas distintas em que o item foi executado (uma sessão conta uma vez, mesmo com duas instâncias). */
  sessions: number;
  /** Início da sessão mais recente (ms). */
  lastAt: number;
}

export interface MostUsed {
  ranked: MostUsedEntry[];
  /** Exercícios executados sem origem registrada (contados por exercício executado, sem agrupar por nome). */
  unlinkedExecutions: number;
  /** Sessões concluídas com ao menos um exercício executado sem origem. */
  unlinkedSessions: number;
  /** Sessões concluídas consideradas (do perfil, sem repetidas). */
  sessionsConsidered: number;
}

const executed = (e: WorkoutSession['exercises'][number]) => (e.sets ?? []).some((s) => s.status === 'done' && s.type !== 'warmup');

/**
 * Ranking local pelas sessões CONCLUÍDAS do perfil: identidade de origem registrada na cópia da sessão. Empate: a mais
 * recente primeiro, depois a chave (ordem estável).
 */
export function mostUsed(sessions: readonly WorkoutSession[], profileId?: string | null, limit = 10): MostUsed {
  const seen = new Set<string>();
  const counts = new Map<LibraryKey, MostUsedEntry>();
  let unlinkedExecutions = 0;
  let unlinkedSessions = 0;
  for (const s of sessions) {
    if (s.status !== 'completed' || seen.has(s.id)) continue;
    if (profileId && s.profileId && s.profileId !== profileId) continue;
    seen.add(s.id);
    const keys = new Set<LibraryKey>();
    let loose = 0;
    for (const e of s.exercises ?? []) {
      if (!executed(e)) continue;
      const k = libraryKeyOf(e);
      if (k) keys.add(k);
      else loose++;
    }
    for (const k of keys) {
      const cur = counts.get(k) ?? { key: k, sessions: 0, lastAt: 0 };
      cur.sessions++;
      cur.lastAt = Math.max(cur.lastAt, s.startedAt);
      counts.set(k, cur);
    }
    if (loose) {
      unlinkedExecutions += loose;
      unlinkedSessions++;
    }
  }
  const ranked = [...counts.values()].sort((a, b) => b.sessions - a.sessions || b.lastAt - a.lastAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, limit);
  return { ranked, unlinkedExecutions, unlinkedSessions, sessionsConsidered: seen.size };
}

/** Itens da biblioteca presentes nas fichas do perfil (pela origem da instância), com a quantidade de instâncias. */
export function sheetKeys(routines: readonly Routine[], profileId?: string | null): Map<LibraryKey, number> {
  const out = new Map<LibraryKey, number>();
  for (const r of routines) {
    if (profileId && r.profileId && r.profileId !== profileId) continue;
    for (const w of r.workouts ?? [])
      for (const t of w.exercises ?? []) {
        const k = libraryKeyOf(t);
        if (k) out.set(k, (out.get(k) ?? 0) + 1);
      }
  }
  return out;
}

export const USAGE_LABEL = {
  inSheet: 'Já está em uma das suas fichas.',
  inSession: 'Utilizado em uma sessão registrada com esta origem.',
  unlinked: 'Sem vínculo com a biblioteca',
} as const;
