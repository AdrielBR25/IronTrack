// Cliente da integração Life (Fase 06): Minha Semana, painel inicial e Minha Evolução. Quem monta a agenda e calcula
// os indicadores é o servidor (registros de todos os módulos); o app só exibe e grava atividades/ajustes da agenda.
import type { EvolutionPeriod, EvolutionView, HomeLayoutView, OverrideInput, TodayView, WeekAgendaView } from '@shared/planner/protocol.ts';
import { apiRequest } from '../api';
import { invalidateLife } from '../life/api';

const enc = encodeURIComponent;
const after = async <T>(p: Promise<T>) => {
  const r = await p;
  invalidateLife();
  return r;
};

export const plannerApi = {
  week: (start?: string, days = 7) => apiRequest<WeekAgendaView>('GET', `/planner/week?days=${days}${start ? `&start=${enc(start)}` : ''}`),
  today: () => apiRequest<TodayView>('GET', '/planner/today'),
  addItem: (x: { clientId: string; date: string; startTime?: string | null; durationMin?: number | null; title: string; category: string; notes?: string | null }) => after(apiRequest<{ id: string; created: boolean }>('POST', '/planner/items', x)),
  patchItem: (id: string, patch: Record<string, unknown>, version?: number) => after(apiRequest<{ id: string; version: number }>('PATCH', `/planner/items/${enc(id)}`, { ...(version ? { version } : {}), patch })),
  removeItem: (id: string) => after(apiRequest<void>('DELETE', `/planner/items/${enc(id)}`)),
  override: (o: OverrideInput) => after(apiRequest<{ ok: true }>('POST', '/planner/overrides', o)),
  reorder: (date: string, keys: string[]) => after(apiRequest<{ ok: true }>('POST', '/planner/reorder', { date, keys })),
  layout: () => apiRequest<HomeLayoutView>('GET', '/planner/home-layout'),
  saveLayout: (cards: HomeLayoutView['cards'], version: number) => after(apiRequest<HomeLayoutView>('PATCH', '/planner/home-layout', { cards, version })),
  evolution: (period: EvolutionPeriod, offset = 0) => apiRequest<EvolutionView>('GET', `/insights/evolution?period=${period}&offset=${offset}`),
};
