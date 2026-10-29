// Calendário unificado (IronTrack 2.0 F01/P14) nas telas, no jsdom com banco fictício: Planejamento (semana, mês,
// avisos, agenda anterior), Início (hoje, próxima atividade, rotação, treino em andamento) e Treinos (agenda de 14
// dias, diálogo que separa os modelos). Confere que nada é gravado só por exibir e que a rotação não avança.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WeeklyPlannerPage from '@/pages/WeeklyPlannerPage';
import HomePage from '@/pages/HomePage';
import WorkoutsPage from '@/pages/WorkoutsPage';
import { DB_SCHEMA_VERSION, IronTrackDB, db, setDb } from '@/db/db';
import { addPlanActivity, setPlanMarker } from '@/db/planner';
import { startSession } from '@/db/repo';
import { readSnapshot } from '@/lib/backup';
import { BACKUP_SCHEMA_VERSION } from '@/lib/backupFormat';
import { addDays, todayISO, weekday } from '@/lib/dates';
import { routine, session, settings } from './fixtures';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;

let n = 0;
let root: Root | null = null;

const $ = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

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
async function waitForDb(fn: () => Promise<boolean>, timeout = 3000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error('waitForDb: tempo esgotado');
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

async function mount(path: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/treinos" element={<WorkoutsPage />} />
          <Route path="/planejamento" element={<WeeklyPlannerPage />} />
          <Route path="/treino" element={<div data-testid="workout-screen" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const today = todayISO();
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** Tudo que está gravado (para provar que exibir não grava nada). */
const dump = async () => JSON.stringify(await readSnapshot());

beforeEach(async () => {
  setDb(new IronTrackDB(`calendar-ui-${++n}`));
  await db.open();
  // Agenda anterior: todos os dias são de treino (o teste funciona em qualquer dia da semana). Rotação no A.
  await db.settings.put(settings({ activeRoutineId: 'r1', trainingDays: ALL_DAYS }));
  await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
  await db.rotations.put({ routineId: 'r1', nextIndex: 0, updatedAt: 1 });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  db.close();
});

const planToday = (workoutId: string | null) => addPlanActivity({ id: 'w-hoje', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId } });

describe('Planejamento: calendário unificado', () => {
  it('sem planejamento, a agenda anterior aparece como sugestão (não como planejada) e exibir não grava nada', async () => {
    const before = await dump();
    await mount('/planejamento');
    await waitFor(() => $('plan-day'));
    expect($('plan-day')!.dataset.origin).toBe('legacy');
    expect($('plan-day')!.dataset.status).toBe('suggested');
    expect($('plan-day-empty')!.textContent).toMatch(/Sem atividade planejada/);
    expect($('plan-legacy')!.dataset.defines).toBe('true');
    expect($('plan-legacy-text')!.textContent).toMatch(/Treino A/);
    expect($('sum-suggestions')!.textContent).toMatch(/não contam como planejadas/);
    expect($('cons-realized')!.textContent).toMatch(/Sem planejamento/);
    const cell = $$('week-day').find((c) => c.dataset.date === today)!;
    expect(cell.getAttribute('aria-label')).toMatch(/sugestão da agenda anterior/);
    expect(await dump()).toBe(before);
  });

  it('planejamento diferente da agenda anterior: aviso compreensível, manter não grava e detalhes comparam as fontes', async () => {
    await planToday('r1-B');
    await mount('/planejamento');
    await waitFor(() => $('conflict-message'));
    expect($('plan-day')!.dataset.origin).toBe('plan_recurring');
    expect($('conflict-message')!.textContent).toBe('Seu planejamento indica Treino B (Treino B), mas a agenda anterior sugere Treino A (Treino A).');
    expect($('plan-legacy')!.dataset.defines).toBe('false');
    expect($$('week-day').find((c) => c.dataset.date === today)!.dataset.warning).toBe('true');
    expect($('conflict-legacy')!.getAttribute('href')).toBe('/treinos');
    const before = await dump();
    await click($('conflict-keep'));
    await waitFor(() => !$('conflict-message'));
    await click($('conflict-details'));
    await waitFor(() => $('conflict-detail-list'));
    expect($$('conflict-item').map((i) => i.dataset.kind)).toEqual(expect.arrayContaining(['plan_vs_legacy_workout', 'rotation_differs']));
    expect(await dump()).toBe(before); // "manter" não grava nada
    expect($('plan-edit-model')!.textContent).toMatch(/só o planejamento semanal/);
  });

  it('previsão da rotação identificada: hoje é o próximo da rotação; daqui a 7 dias é previsão', async () => {
    await planToday(null);
    await mount('/planejamento');
    await waitFor(() => $('plan-forecast-note'));
    expect($('plan-forecast-note')!.dataset.certainty).toBe('current');
    expect($('plan-activity-title')!.textContent).toMatch(/Treino A \(próximo da rotação agora\)/);
    await click($('week-next'));
    const next = addDays(today, 7);
    await click($$('week-day').find((c) => c.dataset.date === next)!);
    await waitFor(() => $('plan-day')?.dataset.date === next);
    expect($('plan-forecast-note')!.dataset.certainty).toBe('forecast');
    expect($('plan-forecast-note')!.textContent).toMatch(/Previsão baseada na rotação atual/);
    expect($('plan-activity-title')!.textContent).toMatch(/Treino B \(previsão\)/);
  });

  it('visão mensal: alternar, navegar entre meses, selecionar um dia e voltar para hoje', async () => {
    await planToday('r1-A');
    await mount('/planejamento');
    await waitFor(() => $('view-month'));
    await click($('view-month'));
    await waitFor(() => $('month-grid'));
    const days = $$('month-day');
    expect(days.length % 7).toBe(0);
    expect(days.find((d) => d.dataset.date === today)!.getAttribute('aria-current')).toBe('date');
    expect($('month-summary')).not.toBeNull();
    const label = $('month-label')!.textContent;
    await click($('month-next'));
    await waitFor(() => $('month-label')!.textContent !== label);
    const first = $$('month-day').find((d) => d.dataset.date?.endsWith('-01') && d.getAttribute('aria-label')?.includes('fora do mês') === false)!;
    await click(first);
    await waitFor(() => $('plan-day')?.dataset.date === first.dataset.date);
    await click($('month-today'));
    await waitFor(() => $('plan-day')?.dataset.date === today);
    expect($('month-label')!.textContent).toBe(label);
    await click($('view-week'));
    await waitFor(() => $('week-strip'));
  });

  it('?data= abre o dia pedido (usado pela Início e pela Treinos)', async () => {
    const d = addDays(today, 3);
    await mount(`/planejamento?data=${d}`);
    await waitFor(() => $('plan-day'));
    expect($('plan-day')!.dataset.date).toBe(d);
  });
});

describe('Início: visão unificada', () => {
  it('sem planejamento mostra a sugestão da agenda anterior, a rotação e a próxima atividade', async () => {
    await mount('/');
    await waitFor(() => $('home-today'));
    expect($('home-today')!.dataset.origin).toBe('legacy');
    expect($('home-today-origin')!.textContent).toMatch(/Sugestão da agenda anterior/);
    expect($('home-rotation')!.textContent).toMatch(/Treino A/);
    expect($('home-next')!.textContent).toMatch(/Sugestão da agenda anterior/);
    expect($('home-next')!.textContent).toMatch(/previsão baseada na rotação atual/);
    expect($$('home-week-day')).toHaveLength(7);
  });

  it('com planejamento: mostra o planejado, o aviso de divergência e pede a escolha antes de iniciar (rotação intacta)', async () => {
    await planToday('r1-B');
    await mount('/');
    await waitFor(() => $('home-conflict'));
    expect($('home-today')!.dataset.origin).toBe('plan_recurring');
    expect($('home-today')!.textContent).toMatch(/Planejado para hoje/);
    expect($('home-conflict')!.getAttribute('href')).toBe(`/planejamento?data=${today}`);
    expect($('home-week-text')!.textContent).toMatch(/planejamento semanal/);
    await click($('start-workout'));
    await waitFor(() => $('plan-start-choice'));
    await click($('start-planned'));
    await waitFor(() => $('workout-screen'));
    const active = await db.sessions.where('status').equals('active').first();
    expect(active?.workoutId).toBe('r1-B');
    expect((await db.rotations.get('r1'))!.nextIndex).toBe(0);
    expect(await db.planEntries.count()).toBe(1);
  });

  it('descanso planejado: "Dia de descanso" pelo planejamento e treinar mesmo assim usa o próximo da rotação', async () => {
    await setPlanMarker({ id: 'rest', slot: { scope: 'weekly', weekday: weekday(today) }, kind: 'rest', expected: '' });
    await mount('/');
    await waitFor(() => $('home-today'));
    expect($('home-today')!.dataset.status).toBe('rest');
    expect($('home-today')!.textContent).toMatch(/Planejamento semanal/);
    expect($('home-conflict')!.textContent).toMatch(/Seu planejamento indica descanso, mas a agenda anterior sugere Treino A/);
    expect($('start-workout')!.textContent).toMatch(/TREINAR MESMO ASSIM \(A\)/);
  });

  it('treino em andamento tem prioridade e nada novo é iniciado', async () => {
    await planToday('r1-B');
    await startSession('r1', 'r1-C');
    await mount('/');
    await waitFor(() => $('continue-workout'));
    expect($('start-workout')).toBeNull();
    expect(await db.sessions.count()).toBe(1);
  });

  it('sessão concluída hoje aparece como fato; sessão de outro perfil é ignorada', async () => {
    const at = new Date();
    at.setHours(0, 30, 0, 0);
    await db.sessions.put(session('feita', { profileId: db.currentProfileId!, workoutId: 'r1-A', workoutLabel: 'A', startedAt: at.getTime(), finishedAt: at.getTime() + 60_000 }));
    await db.sessions.put(session('alheia', { profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workoutId: 'r1-B', workoutLabel: 'B', startedAt: at.getTime() + 1000, finishedAt: at.getTime() + 61_000 }));
    await mount('/');
    await waitFor(() => $('home-done'));
    expect($('home-done')!.textContent).toBe('Treino A feito ✓');
  });
});

describe('Treinos: agenda unificada', () => {
  it('14 dias pela visão unificada; o diálogo separa planejamento e agenda anterior; reagendar não toca o planejamento', async () => {
    await planToday('r1-B');
    await mount('/treinos');
    await waitFor(() => $$('agenda-day').length === 14);
    const cell = $$('agenda-day').find((c) => c.dataset.date === today)!;
    expect(cell.dataset.origin).toBe('plan_recurring');
    expect(cell.dataset.warning).toBe('true');
    expect(cell.getAttribute('aria-label')).toMatch(/planejamento semanal/);
    const tomorrow = $$('agenda-day').find((c) => c.dataset.date === addDays(today, 1))!;
    expect(tomorrow.dataset.origin).toBe('legacy');
    await click(cell);
    await waitFor(() => $('agenda-day-dialog'));
    expect($('agenda-edit-plan')).not.toBeNull();
    expect($('agenda-legacy-edit')!.textContent).toMatch(/O planejamento semanal não muda/);
    const plan = JSON.stringify(await db.planEntries.toArray());
    const marcar = [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes('Marcar como descanso'))!;
    await click(marcar);
    await waitForDb(async () => (await db.overrides.count()) === 1);
    expect(await db.overrides.toArray()).toEqual([{ routineId: 'r1', date: today, kind: 'rest' }]);
    expect(JSON.stringify(await db.planEntries.toArray())).toBe(plan);
    expect((await db.rotations.get('r1'))!.nextIndex).toBe(0);
  });

  it('rotação: controles continuam (próximo e pular) e afirmam o que alteram', async () => {
    await mount('/treinos');
    await waitFor(() => $$('agenda-day').length === 14);
    expect(document.body.textContent).toMatch(/Estes controles alteram só a rotação/);
    const pular = [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Pular')!;
    await click(pular);
    await waitForDb(async () => (await db.rotations.get('r1'))!.nextIndex === 1);
  });
});

describe('persistência', () => {
  it('o calendário não cria tabela própria (P16: só a de decisões lembradas; P17 acrescenta a biblioteca: Dexie v6, backup v7)', () => {
    expect(DB_SCHEMA_VERSION).toBe(6);
    expect(BACKUP_SCHEMA_VERSION).toBe(8);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['bodyEntries', 'calendarDecisions', 'customExercises', 'exerciseFavorites', 'goals', 'overrides', 'photos', 'planEntries', 'profiles', 'rotations', 'routines', 'sessions', 'settings']);
  });
});
