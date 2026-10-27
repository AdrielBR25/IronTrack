// Página de análise de desempenho (P08) no jsdom com o banco fictício (fake-indexeddb).
// Verifica estados vazios, filtros e que a página só lê dados. Dados fictícios apenas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import TrainingAnalyticsPage from '@/pages/TrainingAnalyticsPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addDays, fromISODate, todayISO } from '@/lib/dates';
import type { SessionExercise, WorkoutSession } from '@/lib/types';
import { session, settings } from './fixtures';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// O jsdom não tem ResizeObserver (usado pelos gráficos responsivos); os gráficos ficam com tamanho zero.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let n = 0;
let root: Root | null = null;
let container: HTMLDivElement;

const daysAgo = (d: number) => fromISODate(addDays(todayISO(), -d)).getTime() + 10 * 3600_000;

function exercise(key: string, name: string, sets: [number | null, number][], equipment: SessionExercise['equipment'] = 'barbell'): SessionExercise {
  return {
    id: `${key}-${++n}`,
    exerciseKey: key,
    name,
    muscleGroup: key === 'barra' ? 'Costas' : 'Peito',
    category: 'compound',
    equipment,
    repMin: 6,
    repMax: 10,
    restSec: 90,
    plannedSets: sets.length,
    sets: sets.map(([weight, reps], i) => ({ id: `s${n}-${i}`, type: 'normal', status: 'done', weight, reps })),
  };
}

const workout = (id: string, ago: number, exercises: SessionExercise[], over: Partial<WorkoutSession> = {}) => session(id, { startedAt: daysAgo(ago), exercises, ...over });

async function dump() {
  return JSON.stringify(await Promise.all([db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos, db.profiles].map((t) => t.toArray())));
}

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const text = () => document.body.textContent ?? '';

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: tempo esgotado');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <TrainingAnalyticsPage />
      </MemoryRouter>,
    );
  });
  await waitFor(() => $('analytics-page'));
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => {
    el.click();
  });
}

const radio = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent === label) ?? null;

beforeEach(async () => {
  setDb(new IronTrackDB(`analytics-ui-${++n}`));
  await db.open();
  await db.settings.put(settings());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
});

describe('análise de desempenho: estados vazios', () => {
  it('sem treinos: explica o motivo, sem números inventados', async () => {
    await mount();
    expect(text()).toContain('Conclua seu primeiro treino para ver a análise de desempenho.');
    expect(text()).not.toMatch(/NaN|Infinity/);
  });

  it('só um treino em andamento: continua vazio (não conta como concluído)', async () => {
    await db.sessions.put(workout('ativo', 0, [exercise('supino', 'Supino', [[60, 8]])], { status: 'active' }));
    await mount();
    expect(text()).toContain('Conclua seu primeiro treino');
  });

  it('um treino: indicadores sem tendência nem comparação, e sem NaN', async () => {
    await db.sessions.put(workout('w1', 1, [exercise('supino', 'Supino', [[60, 8], [60, 8]])]));
    await mount();
    await waitFor(() => $('stat-sessions'));
    expect($('stat-sessions')!.textContent).toContain('1');
    expect($('stat-sessions')!.textContent).toContain('sem comparação equivalente');
    expect($('stat-frequency')!.textContent).toContain('—');
    expect($('exercise-trend')!.textContent).toContain('Dados insuficientes');
    expect(text()).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('exercício só de peso corporal: mede repetições, sem quilos', async () => {
    await db.sessions.bulkPut([1, 4, 8, 12, 16].map((d, i) => workout(`b${d}`, d, [exercise('barra', 'Barra fixa', [[null, 10 - i]], 'bodyweight')])));
    await mount();
    await waitFor(() => $('exercise-trend'));
    expect(text()).toContain('Exercício sem carga registrada');
    const metric = document.querySelector('[aria-label="Métrica do exercício"]')!;
    expect([...metric.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual(['Repetições']);
    expect(text()).not.toMatch(/NaN|Infinity/);
  });
});

describe('análise de desempenho: filtros', () => {
  beforeEach(async () => {
    const list: WorkoutSession[] = [];
    for (let i = 0; i < 12; i++)
      list.push(
        workout(`w${i}`, 80 - i * 7, [exercise('supino', 'Supino', [[60 + i * 2.5, 8], [60 + i * 2.5, 8]]), exercise('remada', 'Remada', [[50, 10]])]),
      );
    await db.sessions.bulkPut(list);
  });

  it('troca de período sem recarregar e sem gravar nada', async () => {
    const before = await dump();
    await mount();
    await waitFor(() => $('stat-sessions'));
    expect(radio('30 dias')!.getAttribute('aria-checked')).toBe('true');
    expect($('period-range')!.textContent).toContain('30 dias');
    await click(radio('7 dias'));
    expect(radio('7 dias')!.getAttribute('aria-checked')).toBe('true');
    expect($('period-range')!.textContent).toContain('7 dias');
    await click(radio('Tudo'));
    expect($('stat-sessions')!.textContent).toMatch(/^Sessões12/);
    expect($$('insight').length).toBeGreaterThan(0);
    expect(await dump()).toBe(before);
  });

  it('seleção de exercício atualiza a evolução', async () => {
    await mount();
    await click(radio('90 dias'));
    const select = (await waitFor(() => $('exercise-select'))) as HTMLSelectElement;
    expect(select.value).toBe('remada');
    expect($('exercise-trend')!.textContent).toContain('Estável');
    await act(async () => {
      select.value = 'supino';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect($('exercise-trend')!.textContent).toContain('Evolução positiva');
    expect($('record-history')!.textContent).toContain('antes');
  });
});
