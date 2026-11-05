// Cliente do RPG (Fase 01): /api/v1/life/*. O app só exibe e registra atividades; quem calcula XP, nível, missões e
// conquistas é o servidor (PostgreSQL). Depois de cada mutação, o resultado (`outcome`) alimenta as animações.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  AchievementView,
  DashboardView,
  HabitView,
  MissionEntryView,
  MissionView,
  ProfileView,
  RewardOutcome,
  RoutineView,
  XpEventView,
} from '@shared/life/protocol.ts';
import { apiRequest } from '../api';

export interface MutationResult {
  outcome: RewardOutcome;
  profile: ProfileView;
  id?: string;
  completed?: boolean;
}

const deviceTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  } catch {
    return 'America/Sao_Paulo';
  }
};

const enc = encodeURIComponent;

export const lifeApi = {
  dashboard: () => apiRequest<DashboardView>('GET', `/life/dashboard?tz=${enc(deviceTz())}`),
  /** Sem animação/invalidação automáticas (quem chama decide: ver LifeSyncWatcher). */
  reconcile: () => apiRequest<MutationResult>('POST', '/life/reconcile', {}),
  patchProfile: (p: { timezone?: string; selectedTitle?: string | null; weeklyWorkoutTarget?: number | null }) => mutation(apiRequest<MutationResult>('PATCH', '/life/profile', p)),
  habits: (archived = false) => apiRequest<{ habits: HabitView[] }>('GET', `/life/habits${archived ? '?archived=1' : ''}`),
  createHabit: (h: Record<string, unknown>) => mutation(apiRequest<MutationResult>('POST', '/life/habits', h)),
  updateHabit: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<MutationResult>('PATCH', `/life/habits/${enc(id)}`, { version, patch })),
  logHabit: (id: string, amount: number, date?: string) => mutation(apiRequest<MutationResult>('POST', `/life/habits/${enc(id)}/log`, { amount, ...(date ? { date } : {}) })),
  habitHistory: (id: string) => apiRequest<{ logs: { date: string; amount: number; completed: boolean }[] }>('GET', `/life/habits/${enc(id)}/history`),
  routines: (archived = false) => apiRequest<{ routines: RoutineView[] }>('GET', `/life/routines${archived ? '?archived=1' : ''}`),
  createRoutine: (r: Record<string, unknown>) => mutation(apiRequest<MutationResult>('POST', '/life/routines', r)),
  updateRoutine: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<MutationResult>('PATCH', `/life/routines/${enc(id)}`, { version, patch })),
  checkItem: (routineId: string, itemId: string, done: boolean) => mutation(apiRequest<MutationResult>('POST', `/life/routines/${enc(routineId)}/items/${enc(itemId)}/check`, { done })),
  missions: (scope: 'current' | 'history' = 'current') => apiRequest<{ missions: MissionView[] }>('GET', `/life/missions${scope === 'history' ? '?scope=history' : ''}`),
  mission: (id: string) => apiRequest<{ mission: MissionView; entries: MissionEntryView[] }>('GET', `/life/missions/${enc(id)}`),
  createMission: (m: Record<string, unknown>) => mutation(apiRequest<MutationResult>('POST', '/life/missions', m)),
  updateMission: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<MutationResult>('PATCH', `/life/missions/${enc(id)}`, { version, patch })),
  addEntry: (id: string, amount: number, note?: string) => mutation(apiRequest<MutationResult>('POST', `/life/missions/${enc(id)}/entries`, { amount, ...(note ? { note } : {}) })),
  deleteEntry: (id: string, entryId: string) => mutation(apiRequest<MutationResult>('DELETE', `/life/missions/${enc(id)}/entries/${enc(entryId)}`)),
  setRest: (date: string, rest: boolean) => mutation(apiRequest<MutationResult>('POST', `/life/days/${enc(date)}/rest`, { rest })),
  xp: (limit = 100) => apiRequest<{ events: XpEventView[] }>('GET', `/life/xp?limit=${limit}`),
  achievements: () => apiRequest<{ achievements: AchievementView[] }>('GET', '/life/achievements'),
  deviceTz,
};

// ------------------------------------------------------------------ invalidação + animações

let version = 0;
const listeners = new Set<() => void>();
/** Qualquer tela do RPG recarrega quando algo muda (mutação daqui, aprovação da IA, treino sincronizado). */
export function invalidateLife(): void {
  version++;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useLifeVersion = () => useSyncExternalStore(subscribe, () => version);

const rewardListeners = new Set<(o: RewardOutcome) => void>();
export const onReward = (l: (o: RewardOutcome) => void) => {
  rewardListeners.add(l);
  return () => {
    rewardListeners.delete(l);
  };
};
export function emitReward(o: RewardOutcome | null | undefined): void {
  if (!o) return;
  if (o.xpGained > 0 || o.levelUp || o.missionsCompleted.length || o.achievements.length) rewardListeners.forEach((l) => l(o));
}

async function mutation(p: Promise<MutationResult>): Promise<MutationResult> {
  const r = await p;
  emitReward(r.outcome);
  invalidateLife();
  return r;
}

/** Carrega um recurso do RPG e recarrega a cada invalidação. */
export function useLifeQuery<T>(load: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const v = useLifeVersion();
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [n, setN] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    loadRef
      .current()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}
