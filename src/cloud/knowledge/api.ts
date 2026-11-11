// Cliente do Conhecimento (Fase 04): /api/v1/knowledge/*. O servidor guarda e calcula tudo (PostgreSQL, por conta);
// o app exibe, manda o cronômetro e reenvia com ids de cliente para não duplicar. Usa a mesma invalidação do RPG:
// encerrar uma sessão atualiza missões, XP e o Início.
import type { RewardOutcome } from '@shared/life/protocol.ts';
import type {
  BookView,
  GoalView,
  KnowledgeDashboardView,
  KnowledgeStatsView,
  NoteKind,
  NoteView,
  SessionKind,
  SessionView,
  SubjectView,
  TimerView,
  TopicStatus,
} from '@shared/knowledge/protocol.ts';
import { apiRequest } from '../api';
import { emitReward, invalidateLife, lifeApi } from '../life/api';

export interface KMutation {
  outcome: RewardOutcome;
  id?: string;
  existed?: boolean;
  [k: string]: unknown;
}

const enc = encodeURIComponent;
const tz = () => `tz=${enc(lifeApi.deviceTz())}`;

async function mutation<T extends KMutation>(p: Promise<T>): Promise<T> {
  const r = await p;
  emitReward(r.outcome);
  invalidateLife();
  return r;
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16).padStart(8, '0').slice(-8)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`);

export const knowledgeApi = {
  dashboard: () => apiRequest<KnowledgeDashboardView>('GET', `/knowledge/dashboard?${tz()}`),
  stats: (from: string, to: string) => apiRequest<{ stats: KnowledgeStatsView }>('GET', `/knowledge/stats?from=${from}&to=${to}&${tz()}`),
  books: () => apiRequest<{ books: BookView[] }>('GET', `/knowledge/books?${tz()}`),
  book: (id: string) => apiRequest<{ book: BookView; sessions: SessionView[]; notes: NoteView[] }>('GET', `/knowledge/books/${enc(id)}?${tz()}`),
  createBook: (b: Record<string, unknown>) => mutation(apiRequest<KMutation & { book: BookView }>('POST', `/knowledge/books?${tz()}`, b, { timeoutMs: 30_000 })),
  updateBook: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<KMutation & { book: BookView }>('PATCH', `/knowledge/books/${enc(id)}?${tz()}`, { version, patch }, { timeoutMs: 30_000 })),
  deleteBook: (id: string) => mutation(apiRequest<KMutation>('DELETE', `/knowledge/books/${enc(id)}?${tz()}`)),
  subjects: (archived = false) => apiRequest<{ subjects: SubjectView[] }>('GET', `/knowledge/subjects?${tz()}${archived ? '&archived=1' : ''}`),
  subject: (id: string) => apiRequest<{ subject: SubjectView; sessions: SessionView[]; notes: NoteView[] }>('GET', `/knowledge/subjects/${enc(id)}?${tz()}`),
  createSubject: (s: Record<string, unknown>) => mutation(apiRequest<KMutation>('POST', `/knowledge/subjects?${tz()}`, s)),
  updateSubject: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<KMutation>('PATCH', `/knowledge/subjects/${enc(id)}?${tz()}`, { version, patch })),
  deleteSubject: (id: string) => mutation(apiRequest<KMutation>('DELETE', `/knowledge/subjects/${enc(id)}?${tz()}`)),
  addTopics: (subjectId: string, topics: { title: string }[]) => mutation(apiRequest<KMutation>('POST', `/knowledge/subjects/${enc(subjectId)}/topics?${tz()}`, { topics })),
  updateTopic: (id: string, patch: { title?: string; status?: TopicStatus; notes?: string | null; position?: number }) => mutation(apiRequest<KMutation>('PATCH', `/knowledge/topics/${enc(id)}?${tz()}`, { patch })),
  deleteTopic: (id: string) => mutation(apiRequest<KMutation>('DELETE', `/knowledge/topics/${enc(id)}?${tz()}`)),
  notes: (f: { bookId?: string; subjectId?: string }) => apiRequest<{ notes: NoteView[] }>('GET', `/knowledge/notes?${f.bookId ? `bookId=${enc(f.bookId)}` : `subjectId=${enc(f.subjectId ?? '')}`}`),
  createNote: (n: { bookId?: string | null; subjectId?: string | null; topicId?: string | null; kind: NoteKind; content: string; page?: number | null }) => apiRequest<{ note: NoteView }>('POST', '/knowledge/notes', n).then((r) => (invalidateLife(), r)),
  updateNote: (id: string, p: { content?: string; kind?: NoteKind; page?: number | null }) => apiRequest<{ note: NoteView }>('PATCH', `/knowledge/notes/${enc(id)}`, p).then((r) => (invalidateLife(), r)),
  deleteNote: (id: string) => apiRequest<{ ok: true }>('DELETE', `/knowledge/notes/${enc(id)}`).then((r) => (invalidateLife(), r)),
  sessions: (from: string, to: string, kind?: SessionKind) => apiRequest<{ sessions: SessionView[] }>('GET', `/knowledge/sessions?from=${from}&to=${to}${kind ? `&kind=${kind}` : ''}&${tz()}`),
  logSession: (s: Record<string, unknown>) => mutation(apiRequest<KMutation & { session: SessionView | null }>('POST', `/knowledge/sessions?${tz()}`, { clientId: newId(), ...s })),
  updateSession: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<KMutation>('PATCH', `/knowledge/sessions/${enc(id)}?${tz()}`, { version, patch })),
  deleteSession: (id: string) => mutation(apiRequest<KMutation>('DELETE', `/knowledge/sessions/${enc(id)}?${tz()}`)),
  goals: (archived = false) => apiRequest<{ goals: GoalView[] }>('GET', `/knowledge/goals?${tz()}${archived ? '&archived=1' : ''}`),
  createGoal: (g: Record<string, unknown>) => mutation(apiRequest<KMutation>('POST', `/knowledge/goals?${tz()}`, g)),
  updateGoal: (id: string, version: number, patch: Record<string, unknown>) => mutation(apiRequest<KMutation>('PATCH', `/knowledge/goals/${enc(id)}?${tz()}`, { version, patch })),
  deleteGoal: (id: string) => mutation(apiRequest<KMutation>('DELETE', `/knowledge/goals/${enc(id)}?${tz()}`)),
  goalToRoutine: (id: string, r: Record<string, unknown>) => mutation(apiRequest<KMutation>('POST', `/knowledge/goals/${enc(id)}/routine?${tz()}`, r)),
  // Cronômetro
  timer: () => apiRequest<{ timer: TimerView | null; serverNow: number }>('GET', '/knowledge/timer', undefined, { timeoutMs: 10_000 }),
  startTimer: (s: Record<string, unknown>) => apiRequest<KMutation & { timer: TimerView; serverNow: number }>('POST', `/knowledge/timer?${tz()}`, s, { timeoutMs: 10_000 }),
  timerEvents: (id: string, events: { type: string; at?: string }[]) => apiRequest<KMutation & { timer: TimerView; serverNow: number }>('POST', `/knowledge/timer/${enc(id)}/events?${tz()}`, { events }, { timeoutMs: 10_000 }),
  finishTimer: (id: string, f: Record<string, unknown>) => mutation(apiRequest<KMutation & { session: SessionView | null; excludedSec: number }>('POST', `/knowledge/timer/${enc(id)}/finish?${tz()}`, f, { timeoutMs: 20_000 })),
  discardTimer: (id: string) => apiRequest<KMutation>('DELETE', `/knowledge/timer/${enc(id)}?${tz()}`).then((r) => (invalidateLife(), r)),
};
