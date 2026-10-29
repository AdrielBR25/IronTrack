// Tela de planejamento semanal (IronTrack 2.0 F01/P13) no jsdom com banco fictício: estado vazio, criar, editar,
// remover com confirmação, recorrência × exceção, navegação semanal, meta semanal e início de treino (sem avançar a
// rotação e respeitando treino em andamento). Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WeeklyPlannerPage from '@/pages/WeeklyPlannerPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addPlanActivity } from '@/db/planner';
import { createGoal } from '@/db/goals';
import { addDays, todayISO, weekday } from '@/lib/dates';
import { fields } from './goalFixtures';
import { routine, session, settings } from './fixtures';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let n = 0;
let root: Root | null = null;

const $ = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
/** Último botão com o texto (o do diálogo de confirmação vem depois do botão que o abriu). */
const button = (label: string) => [...document.querySelectorAll<HTMLElement>('button')].filter((b) => b.textContent?.trim() === label).at(-1) ?? null;
const dayCell = (date: string) => document.querySelector<HTMLElement>(`[data-testid="week-day"][data-date="${date}"]`);

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
async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => {
    el.click();
  });
}
async function select(el: HTMLElement | null, value: string) {
  if (!el) throw new Error('campo ausente');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/planejamento']}>
        <Routes>
          <Route path="/planejamento" element={<WeeklyPlannerPage />} />
          <Route path="/treino" element={<div data-testid="workout-screen" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await waitFor(() => $('planner-page'));
}

const today = todayISO();
const tomorrow = addDays(today, 1);

beforeEach(async () => {
  setDb(new IronTrackDB(`planner-ui-${++n}`));
  await db.open();
  await db.settings.put(settings({ activeRoutineId: 'r1' }));
  await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
  await db.rotations.put({ routineId: 'r1', nextIndex: 0, updatedAt: 1 });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  db.close();
});

describe('planejamento semanal: tela', () => {
  it('estado vazio: dia de hoje selecionado, sem plano e sem porcentagem inventada', async () => {
    await mount();
    expect($('plan-day')!.dataset.date).toBe(today);
    expect($('plan-day-empty')!.textContent).toMatch(/Sem atividade planejada/);
    expect($('cons-realized')!.textContent).toMatch(/Sem planejamento/);
    expect($$('week-day')).toHaveLength(7);
    expect($('plan-goals')!.textContent).toMatch(/Nenhuma meta de frequência semanal/);
  });

  it('criar (modelo semanal), editar e remover com confirmação', async () => {
    await mount();
    await click($('plan-add'));
    await waitFor(() => $('plan-form'));
    await select($('plan-workout'), 'r1-B');
    await click($('plan-save'));
    await waitFor(() => $('plan-activity'));
    expect($('plan-activity-title')!.textContent).toMatch(/Treino B/);
    const stored = await db.planEntries.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ scope: 'weekly', weekday: weekday(today), routineId: 'r1', workoutId: 'r1-B' });

    await click($('plan-item-edit'));
    await waitFor(() => $('plan-form'));
    await select($('plan-workout'), 'r1-C');
    await click($('plan-save'));
    await waitFor(() => $('plan-activity-title')?.textContent?.includes('Treino C'));

    await click($('plan-item-remove'));
    await waitFor(() => button('Remover'));
    await click(button('Remover'));
    await waitFor(() => $('plan-day-empty'));
    expect(await db.planEntries.count()).toBe(0); // criada hoje: some de vez (nunca valeu no passado)
  });

  it('exceção "só neste dia" não altera o modelo; voltar ao semanal desfaz', async () => {
    await addPlanActivity({ id: 'w', slot: { scope: 'weekly', weekday: weekday(tomorrow) }, activity: { routineId: 'r1', workoutId: 'r1-A' } });
    await mount();
    // amanhã pode estar na semana seguinte (hoje = domingo)
    if (!dayCell(tomorrow)) await click($('week-next'));
    await click(dayCell(tomorrow));
    await waitFor(() => $('plan-day')?.dataset.date === tomorrow);
    expect($('plan-day')!.dataset.state).toBe('futuro');
    await click($('scope-date'));
    await click($('plan-free'));
    await waitFor(() => button('Marcar dia livre'));
    await click(button('Marcar dia livre'));
    await waitFor(() => $('plan-day-empty')?.textContent?.includes('Dia livre'));
    expect($('plan-day-source')!.textContent).toMatch(/exceção/);
    expect((await db.planEntries.get('w'))!.revision).toBe(1);
    await click($('plan-clear-exception'));
    await waitFor(() => button('Voltar ao semanal'));
    await click(button('Voltar ao semanal'));
    await waitFor(() => $('plan-activity'));
    expect(await db.planEntries.count()).toBe(1);
  });

  it('navegação: semana anterior, próxima e voltar para hoje', async () => {
    await mount();
    const range = $('week-range')!.textContent;
    await click($('week-prev'));
    await waitFor(() => $('week-range')!.textContent !== range);
    expect($('plan-edit')).toBeNull(); // dias passados não são editáveis
    await click($('week-today'));
    await waitFor(() => $('week-range')!.textContent === range);
    await click($('week-next'));
    await waitFor(() => $('plan-day')!.dataset.state === 'futuro');
  });

  it('meta semanal aparece com o progresso do motor de metas', async () => {
    await createGoal('g', fields({ title: 'Treinar 3x', targetValue: 3, startDate: addDays(today, -30) }));
    await db.sessions.put({ ...session('s1', { startedAt: Date.now() - 60_000 }), profileId: db.currentProfileId! });
    await mount();
    await waitFor(() => $('plan-goal'));
    expect($('plan-goal-progress')!.textContent).toMatch(/1 de 3 sessões/);
    expect($('cons-sessions')!.textContent).toMatch(/^1/);
  });

  it('iniciar treino planejado: pergunta quando difere da rotação e não avança a rotação', async () => {
    await addPlanActivity({ id: 'p', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: 'r1-B' } });
    await mount();
    await waitFor(() => $('plan-start'));
    expect($('plan-rotation-note')!.textContent).toMatch(/Treino A/);
    await click($('plan-start'));
    await waitFor(() => $('start-planned'));
    await click($('start-planned'));
    await waitFor(() => $('workout-screen'));
    const active = await db.sessions.where('status').equals('active').toArray();
    expect(active.map((s) => s.workoutId)).toEqual(['r1-B']);
    expect((await db.rotations.get('r1'))!.nextIndex).toBe(0);
    expect((await db.planEntries.get('p'))!.revision).toBe(1);
  });

  it('treino em andamento é respeitado: não cria outro', async () => {
    await addPlanActivity({ id: 'p', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: null } });
    await db.sessions.put({ ...session('ativa', { status: 'active', workoutId: 'r1-C', routineId: 'r9', startedAt: Date.now() - 1000 }), profileId: db.currentProfileId! });
    await mount();
    await click(await waitFor(() => $('plan-start')));
    await waitFor(() => $('plan-active-block'));
    expect(await db.sessions.count()).toBe(1);
  });
});
