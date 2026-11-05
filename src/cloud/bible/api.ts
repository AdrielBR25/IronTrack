// Cliente da área Bíblia (Fase 05): /api/v1/bible/*. O servidor guarda tudo por conta (preferências, favoritos,
// reflexões, capítulos lidos, planos, metas e o histórico do versículo do dia). O TEXTO bíblico não vem daqui: ele está
// empacotado com o app (ver text.ts) e funciona sem conexão.
import type { GoalView, SessionView, TimerView } from '@shared/knowledge/protocol.ts';
import type { BibleHomeView, BiblePrefsView, BibleProgressView, DailyVerseView, MarkKind, MarkView, PlanView, PrefsPatch, ReadingWeekDay, ReflectionKind, ReflectionView } from '@shared/bible/protocol.ts';
import type { RewardOutcome } from '@shared/life/protocol.ts';
import { apiRequest } from '../api';
import { emitReward, invalidateLife, lifeApi } from '../life/api';
import { newId } from '../knowledge/api';

export interface BMutation {
  outcome: RewardOutcome;
  [k: string]: unknown;
}

const enc = encodeURIComponent;
const tz = () => `tz=${enc(lifeApi.deviceTz())}`;
const P = '/bible';

async function mutation<T extends BMutation>(p: Promise<T>): Promise<T> {
  const r = await p;
  emitReward(r.outcome);
  invalidateLife();
  return r;
}
const plain = <T>(p: Promise<T>) => p.then((r) => (invalidateLife(), r));

export interface PlanPreview {
  title: string;
  description: string | null;
  days: number;
  chapters: number;
  first: string[][];
}

export const bibleApi = {
  home: () => apiRequest<BibleHomeView>('GET', `${P}/home?${tz()}`),
  prefs: () => apiRequest<{ prefs: BiblePrefsView }>('GET', `${P}/prefs`),
  updatePrefs: (patch: PrefsPatch, version?: number) => plain(apiRequest<{ prefs: BiblePrefsView }>('PATCH', `${P}/prefs`, { patch, ...(version ? { version } : {}) })),
  position: (ref: string) => apiRequest<{ ok: true }>('POST', `${P}/position`, { ref }),
  search: (q: string, book?: string | null) => apiRequest<{ kind: 'text' | 'ref' | 'invalid'; total?: number; hits?: { ref: string; label: string; text: string }[]; message?: string }>('GET', `${P}/search?q=${enc(q)}${book ? `&book=${book}` : ''}`),
  verse: () => apiRequest<{ verse: DailyVerseView }>('GET', `${P}/verse?${tz()}`),
  anotherVerse: () => plain(apiRequest<{ verse: DailyVerseView }>('POST', `${P}/verse/another?${tz()}`, {})),
  verseHistory: () => apiRequest<{ verses: DailyVerseView[] }>('GET', `${P}/verse/history`),
  marks: (f: { kind?: MarkKind; book?: string; chapter?: number; tag?: string; text?: boolean } = {}) =>
    apiRequest<{ marks: MarkView[] }>('GET', `${P}/marks?${[f.kind && `kind=${f.kind}`, f.book && `book=${f.book}`, f.chapter && `chapter=${f.chapter}`, f.tag && `tag=${enc(f.tag)}`, f.text && 'text=1'].filter(Boolean).join('&')}`),
  addMark: (m: { kind: MarkKind; ref: string; color?: string | null; tags?: string[] }) => plain(apiRequest<{ mark: MarkView; created: boolean }>('POST', `${P}/marks`, m)),
  updateMark: (id: string, p: { color?: string | null; tags?: string[] }) => plain(apiRequest<{ mark: MarkView }>('PATCH', `${P}/marks/${enc(id)}`, p)),
  deleteMark: (id: string) => plain(apiRequest<{ ok: true }>('DELETE', `${P}/marks/${enc(id)}`)),
  reflections: (f: { q?: string; kind?: ReflectionKind; tag?: string; favorite?: boolean; book?: string; chapter?: number } = {}) =>
    apiRequest<{ reflections: ReflectionView[] }>('GET', `${P}/reflections?${[f.q && `q=${enc(f.q)}`, f.kind && `kind=${f.kind}`, f.tag && `tag=${enc(f.tag)}`, f.favorite && 'favorite=1', f.book && `book=${f.book}`, f.chapter && `chapter=${f.chapter}`].filter(Boolean).join('&')}`),
  createReflection: (r: { kind: ReflectionKind; title?: string | null; content: string; ref?: string | null; tags?: string[]; favorite?: boolean; date?: string | null }) =>
    plain(apiRequest<{ reflection: ReflectionView; existed: boolean }>('POST', `${P}/reflections?${tz()}`, { clientId: newId(), ...r })),
  updateReflection: (id: string, version: number, patch: Record<string, unknown>) => plain(apiRequest<{ reflection: ReflectionView }>('PATCH', `${P}/reflections/${enc(id)}?${tz()}`, { version, patch })),
  deleteReflection: (id: string) => plain(apiRequest<{ ok: true }>('DELETE', `${P}/reflections/${enc(id)}`)),
  progress: () => apiRequest<{ progress: BibleProgressView }>('GET', `${P}/progress`),
  markRead: (chapters: string[], planId?: string | null) => mutation(apiRequest<BMutation & { added: string[] }>('POST', `${P}/read?${tz()}`, { chapters, ...(planId ? { planId } : {}) })),
  unmarkRead: (chapter: string) => mutation(apiRequest<BMutation & { removed: boolean }>('DELETE', `${P}/read/${enc(chapter)}?${tz()}`)),
  stats: (from: string, to: string) => apiRequest<{ stats: { from: string; to: string; days: ReadingWeekDay[] } }>('GET', `${P}/stats?from=${from}&to=${to}&${tz()}`),
  sessions: () => apiRequest<{ sessions: SessionView[] }>('GET', `${P}/sessions?${tz()}`),
  logSession: (s: { date: string; minutes: number; span: string; note?: string | null }) => mutation(apiRequest<BMutation & { session: SessionView | null }>('POST', `${P}/sessions?${tz()}`, { clientId: newId(), ...s })),
  deleteSession: (id: string) => mutation(apiRequest<BMutation>('DELETE', `${P}/sessions/${enc(id)}?${tz()}`)),
  startTimer: (s: Record<string, unknown>) => apiRequest<BMutation & { timer: TimerView; serverNow: number }>('POST', `${P}/timer?${tz()}`, s, { timeoutMs: 10_000 }),
  finishTimer: (id: string, f: Record<string, unknown>) => mutation(apiRequest<BMutation & { session: SessionView | null; excludedSec: number }>('POST', `${P}/timer/${enc(id)}/finish?${tz()}`, f, { timeoutMs: 20_000 })),
  plans: (all = false) => apiRequest<{ plans: PlanView[] }>('GET', `${P}/plans?${tz()}${all ? '&all=1' : ''}`),
  plan: (id: string) => apiRequest<{ plan: PlanView }>('GET', `${P}/plans/${enc(id)}?${tz()}`),
  previewPlan: (x: Record<string, unknown>) => apiRequest<PlanPreview>('POST', `${P}/plans/preview`, x),
  createPlan: (x: Record<string, unknown>) => mutation(apiRequest<BMutation & { plan: PlanView }>('POST', `${P}/plans?${tz()}`, { id: newId(), ...x })),
  updatePlan: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<BMutation & { plan: PlanView }>('PATCH', `${P}/plans/${enc(id)}?${tz()}`, { version, patch })),
  deletePlan: (id: string) => mutation(apiRequest<BMutation>('DELETE', `${P}/plans/${enc(id)}?${tz()}`)),
  completeDay: (id: string, day: number) => mutation(apiRequest<BMutation & { plan: PlanView; added: string[]; already: boolean }>('POST', `${P}/plans/${enc(id)}/days/${day}?${tz()}`, {})),
  uncompleteDay: (id: string, day: number) => mutation(apiRequest<BMutation & { plan: PlanView }>('DELETE', `${P}/plans/${enc(id)}/days/${day}?${tz()}`)),
  goals: () => apiRequest<{ goals: GoalView[] }>('GET', `${P}/goals?${tz()}`),
  createGoal: (g: Record<string, unknown>) => mutation(apiRequest<BMutation & { id: string }>('POST', `${P}/goals?${tz()}`, g)),
  updateGoal: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<BMutation>('PATCH', `${P}/goals/${enc(id)}?${tz()}`, { version, patch })),
  deleteGoal: (id: string) => mutation(apiRequest<BMutation>('DELETE', `${P}/goals/${enc(id)}?${tz()}`)),
};
