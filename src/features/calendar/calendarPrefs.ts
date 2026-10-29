import { useCallback, useSyncExternalStore } from 'react';

// Preferências de exibição do calendário (IronTrack 2.0 F01/P15, docs/CONSOLIDACAO_AGENDAS.md §8). SÓ apresentação:
// nunca alteram planejamento, sessões, rotação, metas ou backups de treino. Estado de interface deste aparelho, por
// perfil, em localStorage (`irontrack.calendarPrefs.v1`): não vai para o IndexedDB nem para o backup, e outras abas
// recebem a mudança pelo evento `storage`. Se o armazenamento falhar, valem os padrões (tudo visível, semana).

export const CALENDAR_PREFS_KEY = 'irontrack.calendarPrefs.v1';

export interface CalendarPrefs {
  /** Sugestões da agenda anterior nos dias sem planejamento. */
  showLegacy: boolean;
  /** Treino previsto pela rotação ("Treino B (previsão)"); oculto, aparece "pela rotação". */
  showForecasts: boolean;
  /** Marcas de sessões concluídas na grade (o dia selecionado sempre mostra os registros). */
  showSessions: boolean;
  /** Cartão de metas da semana. */
  showGoals: boolean;
  /** Observações informativas (avisos relevantes sempre aparecem). */
  showInfo: boolean;
  /** Visão ao abrir o Planejamento sem link explícito (`?visao=` tem prioridade). */
  defaultView: 'week' | 'month';
}

export const DEFAULT_CALENDAR_PREFS: CalendarPrefs = { showLegacy: true, showForecasts: true, showSessions: true, showGoals: true, showInfo: true, defaultView: 'week' };

const BOOL_KEYS = ['showLegacy', 'showForecasts', 'showSessions', 'showGoals', 'showInfo'] as const;

/** Aceita qualquer coisa (arquivo antigo, outra versão, lixo) e devolve preferências válidas. */
export function sanitizePrefs(raw: unknown): CalendarPrefs {
  const out = { ...DEFAULT_CALENDAR_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of BOOL_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  if (r.defaultView === 'week' || r.defaultView === 'month') out.defaultView = r.defaultView;
  return out;
}

type Stored = { v: 1; profiles: Record<string, CalendarPrefs> };

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): Stored {
  try {
    const raw = storage()?.getItem(CALENDAR_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
    if (parsed && parsed.v === 1 && parsed.profiles && typeof parsed.profiles === 'object') return { v: 1, profiles: parsed.profiles };
  } catch {
    /* corrompido: padrões */
  }
  return { v: 1, profiles: {} };
}

/** Mudanças que o armazenamento recusou (modo privado, cota): valem só enquanto a página está aberta. */
const memory = new Map<string, CalendarPrefs>();

export function readCalendarPrefs(profileId: string | undefined): CalendarPrefs {
  if (profileId && memory.has(profileId)) return memory.get(profileId)!;
  return sanitizePrefs(profileId ? readAll().profiles[profileId] : null);
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * Grava a mudança por cima do que está gravado AGORA (relê antes de escrever), então uma preferência alterada em
 * outra aba não é sobrescrita por esta. Devolve false se o armazenamento falhar (a mudança vale só nesta tela).
 */
export function writeCalendarPrefs(profileId: string, patch: Partial<CalendarPrefs>): boolean {
  const all = readAll();
  const next = sanitizePrefs({ ...readCalendarPrefs(profileId), ...patch });
  all.profiles[profileId] = next;
  try {
    const s = storage();
    if (!s) throw new Error('sem armazenamento');
    s.setItem(CALENDAR_PREFS_KEY, JSON.stringify(all));
    memory.delete(profileId);
    return true;
  } catch {
    memory.set(profileId, next);
    return false;
  } finally {
    cache.clear();
    notify();
  }
}

const cache = new Map<string, CalendarPrefs>();
function snapshot(profileId: string | undefined): CalendarPrefs {
  const k = profileId ?? '';
  let v = cache.get(k);
  if (!v) {
    v = readCalendarPrefs(profileId);
    cache.set(k, v);
  }
  return v;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === CALENDAR_PREFS_KEY) {
      cache.clear();
      cb();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

/** Preferências do perfil atual, atualizadas ao vivo (inclusive por outra aba). */
export function useCalendarPrefs(profileId: string | undefined): [CalendarPrefs, (patch: Partial<CalendarPrefs>) => boolean] {
  const prefs = useSyncExternalStore(subscribe, () => snapshot(profileId));
  const set = useCallback((patch: Partial<CalendarPrefs>) => (profileId ? writeCalendarPrefs(profileId, patch) : false), [profileId]);
  return [prefs, set];
}
