// Consolidação de agendas nas telas (IronTrack 2.0 F01/P15), no jsdom com banco fictício: importação (prévia, modos,
// confirmar, cancelar, desfazer), central "Revisar divergências", preferências de exibição (só apresentação, por
// perfil, entre abas), visão inicial Semana/Mês com prioridade dos links, Início e Treinos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import WeeklyPlannerPage from '@/pages/WeeklyPlannerPage';
import LegacyImportPage from '@/pages/LegacyImportPage';
import HomePage from '@/pages/HomePage';
import WorkoutsPage from '@/pages/WorkoutsPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addPlanActivity, listPlanEntries } from '@/db/planner';
import { readLastImport } from '@/db/legacyImport';
import { readSnapshot } from '@/lib/backup';
import { todayISO, weekday } from '@/lib/dates';
import { CALENDAR_PREFS_KEY } from '@/features/calendar/calendarPrefs';
import { planForDate } from '@/modules/planner';
import { routine, settings } from './fixtures';

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
const button = (text: RegExp, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('button')].find((b) => text.test(b.textContent ?? '')) ?? null;

function Where() {
  const l = useLocation();
  return <span data-testid="where" data-path={l.pathname} data-search={l.search} />;
}

async function mount(path: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/treinos" element={<WorkoutsPage />} />
          <Route path="/planejamento" element={<WeeklyPlannerPage />} />
          <Route path="/planejamento/importar" element={<LegacyImportPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}
async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
}

const today = todayISO();
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const dump = async () => JSON.stringify(await readSnapshot());
const nonPlan = async () => JSON.stringify({ ...(await readSnapshot()), planEntries: [] });

beforeEach(async () => {
  localStorage.clear();
  setDb(new IronTrackDB(`consolidation-ui-${++n}`));
  await db.open();
  await db.settings.put(settings({ activeRoutineId: 'r1', trainingDays: ALL_DAYS }));
  await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
  await db.rotations.put({ routineId: 'r1', nextIndex: 0, updatedAt: 1 });
});
afterEach(async () => {
  await unmount();
  db.close();
});

describe('Importar agenda antiga', () => {
  it('abre pela tela Planejamento, mostra a prévia no modo seguro (padrão) e só grava depois de confirmar', async () => {
    const before = await dump();
    await mount('/planejamento');
    await waitFor(() => $('open-import'));
    expect($('open-import')!.getAttribute('href')).toBe('/planejamento/importar');
    await click($('open-import'));
    await waitFor(() => $('import-overview'));
    expect($('mode-empty')!.closest('[role="radio"]')!.getAttribute('aria-checked')).toBe('true');
    expect($('ov-routine')!.textContent).toBe('Rotina r1');
    expect($('ov-create')!.textContent).toBe('7');
    expect($$('import-item').filter((i) => i.dataset.action === 'create')).toHaveLength(7);
    expect($$('import-item-proposal')[0].textContent).toMatch(/próximo da rotação/);
    expect(await dump()).toBe(before); // prévia não grava
    await click($('import-confirm'));
    await waitFor(() => $('import-confirm-dialog'));
    expect(await dump()).toBe(before); // abrir a confirmação não grava
    await click($('import-apply'));
    await waitForDb(async () => (await listPlanEntries()).length === 7);
    const rec = await readLastImport();
    expect(rec!.status).toBe('applied');
    await waitFor(() => $('import-last'));
    await waitFor(() => $('ov-create')!.textContent === '0'); // reimportar: nada a criar
    expect($('import-confirm')!.hasAttribute('disabled')).toBe(true);
  });

  it('cancelar volta ao planejamento sem gravar; "só visualizar" não oferece gravação', async () => {
    const before = await dump();
    await mount('/planejamento/importar');
    await waitFor(() => $('import-overview'));
    await click($('mode-view'));
    await waitFor(() => $('import-view-only'));
    expect($('import-confirm')).toBeNull();
    await click($('import-cancel'));
    await waitFor(() => $('where')!.dataset.path === '/planejamento');
    expect(await dump()).toBe(before);
  });

  it('revisar conflitos: cada conflito tem decisão; padrão manter; "usar a agenda antiga" substitui só aquele dia', async () => {
    await addPlanActivity({ id: 'hoje-b', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: 'r1-B' } });
    await mount('/planejamento/importar');
    await waitFor(() => $('import-overview'));
    expect($('ov-conflicts')!.textContent).toBe('1');
    const key = `weekday:${weekday(today)}`;
    const conflictItem = () => $$('import-item').find((i) => i.dataset.key === key)!;
    expect(conflictItem().dataset.outcome).toBe('keep');
    expect($('import-decision', conflictItem())).toBeNull(); // no modo padrão não há decisão: conflito fica como está
    await click($('mode-review'));
    await waitFor(() => $('import-decision', conflictItem()));
    expect(($('decision-keep', conflictItem()) as HTMLInputElement).checked).toBe(true);
    await click($('decision-legacy', conflictItem()));
    await waitFor(() => conflictItem().dataset.outcome === 'replace');
    await click($('import-confirm'));
    await waitFor(() => $('import-confirm-dialog'));
    expect($('import-confirm-dialog')!.textContent).toMatch(/usar a agenda antiga no lugar do planejamento atual/);
    await click($('import-apply'));
    await waitForDb(async () => (await listPlanEntries()).length === 7);
    expect(planForDate(await listPlanEntries(), today).entries.map((e) => e.workoutId)).toEqual([null]);
  });

  it('desfazer pede confirmação, remove só o importado e preserva o resto', async () => {
    await mount('/planejamento/importar');
    await waitFor(() => $('import-overview'));
    await click($('import-confirm'));
    await waitFor(() => $('import-apply'));
    await click($('import-apply'));
    await waitForDb(async () => (await listPlanEntries()).length === 7);
    const others = await nonPlan();
    await waitFor(() => $('import-undo'));
    await click($('import-undo'));
    await waitFor(() => $('import-undo-dialog'));
    expect($('import-undo-dialog')!.dataset.ok).toBe('true');
    await click($('import-undo-apply'));
    await waitForDb(async () => (await listPlanEntries()).length === 0);
    expect(await nonPlan()).toBe(others);
    await waitFor(() => $('import-last')?.dataset.status === 'undone');
  });

  it('desfazer bloqueado quando o dia foi alterado depois (mostra os motivos e não reverte)', async () => {
    await mount('/planejamento/importar');
    await waitFor(() => $('import-overview'));
    await click($('import-confirm'));
    await waitFor(() => $('import-apply'));
    await click($('import-apply'));
    await waitForDb(async () => (await listPlanEntries()).length === 7);
    await addPlanActivity({ id: 'depois', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: 'r1-C' } });
    await click(await waitFor(() => $('import-undo')));
    await waitFor(() => $('import-undo-dialog'));
    expect($('import-undo-dialog')!.dataset.ok).toBe('false');
    expect($('import-undo-problems')!.textContent).toMatch(/alterado depois da importação/);
    expect($('import-undo-apply')).toBeNull();
    expect(await listPlanEntries()).toHaveLength(8);
  });

  it('a prévia se atualiza (com aviso) quando o planejamento muda em outra aba', async () => {
    await mount('/planejamento/importar');
    await waitFor(() => $('import-overview'));
    await addPlanActivity({ id: 'outra-aba', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: 'r1-C' } });
    await waitFor(() => $('import-refreshed'));
    expect($('ov-conflicts')!.textContent).toBe('1');
  });
});

describe('Central "Revisar divergências"', () => {
  beforeEach(async () => {
    await addPlanActivity({ id: 'hoje-b', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: 'r1-B' } });
  });

  it('agrupa, explica origem e impacto; "manter" é só visual; "usar a agenda antiga só neste dia" grava a exceção', async () => {
    await mount('/planejamento');
    await waitFor(() => $('open-conflict-center'));
    expect($('open-conflict-center')!.dataset.warnings).toBe('1');
    await click($('open-conflict-center'));
    await waitFor(() => $('conflict-center'));
    const g = $$('conflict-group').find((x) => x.dataset.kind === 'plan_vs_legacy_workout')!;
    expect(g.dataset.severity).toBe('warning');
    expect(g.textContent).toMatch(/Origem:.*Agenda anterior/);
    expect(g.textContent).toMatch(/Impacto:/);
    const before = await dump();
    await click($('cc-keep', g));
    await waitFor(() => $('conflict-kept-note'));
    expect($('conflict-kept-note')!.textContent).toMatch(/Nada foi alterado/);
    expect(await dump()).toBe(before);
    await click($('cc-restore'));
    await click(await waitFor(() => $('cc-use-legacy')));
    await waitFor(() => button(/^Usar só neste dia$/));
    await click(button(/^Usar só neste dia$/));
    await waitForDb(async () => planForDate(await listPlanEntries(), today).source === 'exception');
    expect(planForDate(await listPlanEntries(), today).entries.map((e) => e.workoutId)).toEqual([null]); // próximo da rotação, nunca treino fixo
    await waitFor(() => $('open-conflict-center')!.dataset.warnings === '0');
  });

  it('"Ver o dia" seleciona o dia; ocultar observações informativas é preferência visual e avisos continuam', async () => {
    await mount('/planejamento');
    await click(await waitFor(() => $('open-conflict-center')));
    await waitFor(() => $('conflict-center'));
    await click($('cc-open'));
    await waitFor(() => $('plan-day')!.dataset.date === today);
    await click($('cc-hide-info'));
    await waitFor(() => $('cc-show-info'));
    expect($$('conflict-group').every((x) => x.dataset.severity === 'warning')).toBe(true);
    expect($$('conflict-group').length).toBeGreaterThan(0);
  });
});

describe('Preferências de exibição e visão inicial', () => {
  it('só apresentação: nada gravado no banco; por perfil no localStorage; metas ocultas continuam acessíveis', async () => {
    const before = await dump();
    await mount('/planejamento');
    await click(await waitFor(() => $('open-calendar-prefs')));
    await waitFor(() => $('calendar-prefs'));
    await click($('pref-showGoals'));
    await waitFor(() => $('goals-hidden'));
    await click($('pref-showLegacy'));
    await waitFor(() => $('plan-legacy-hidden'));
    expect(await dump()).toBe(before);
    const stored = JSON.parse(localStorage.getItem(CALENDAR_PREFS_KEY)!);
    expect(stored.profiles[db.currentProfileId!]).toMatchObject({ showGoals: false, showLegacy: false });
    expect(Object.keys(stored.profiles)).toEqual([db.currentProfileId]);
  });

  it('visão padrão Mês; ?visao=semana e ?visao=mes prevalecem; ?data= abre o dia; a alternância manual continua', async () => {
    localStorage.setItem(CALENDAR_PREFS_KEY, JSON.stringify({ v: 1, profiles: { [db.currentProfileId!]: { defaultView: 'month' } } }));
    await mount('/planejamento');
    await waitFor(() => $('month-grid'));
    await waitFor(() => $('month-day-summary'));
    await click($('view-week'));
    await waitFor(() => $('week-strip'));
    await unmount();
    await mount('/planejamento?visao=semana');
    await waitFor(() => $('week-strip'));
    expect($('month-grid')).toBeNull();
    await unmount();
    localStorage.clear();
    const date = '2026-12-15';
    await mount(`/planejamento?data=${date}&visao=mes`);
    await waitFor(() => $('month-grid'));
    expect($('month-grid')!.dataset.month).toBe('2026-12');
    expect($('plan-day')!.dataset.date).toBe(date);
  });

  it('mudança feita em outra aba chega por evento de armazenamento', async () => {
    await mount('/planejamento');
    await waitFor(() => $('week-strip'));
    expect($('goals-hidden')).toBeNull();
    await act(async () => {
      localStorage.setItem(CALENDAR_PREFS_KEY, JSON.stringify({ v: 1, profiles: { [db.currentProfileId!]: { showGoals: false } } }));
      window.dispatchEvent(new StorageEvent('storage', { key: CALENDAR_PREFS_KEY }));
    });
    await waitFor(() => $('goals-hidden'));
  });

  it('armazenamento corrompido: valem os padrões', async () => {
    localStorage.setItem(CALENDAR_PREFS_KEY, '{lixo');
    await mount('/planejamento');
    await waitFor(() => $('week-strip'));
    expect($('goals-hidden')).toBeNull();
  });
});

describe('Início e Treinos depois da importação', () => {
  it('Início mostra a origem e não repete a atividade; Treinos oferece a importação e mantém a agenda de 14 dias', async () => {
    await mount('/planejamento/importar');
    await click(await waitFor(() => $('import-confirm')));
    await click(await waitFor(() => $('import-apply')));
    await waitForDb(async () => (await listPlanEntries()).length === 7);
    await unmount();
    await mount('/');
    await waitFor(() => $('home-today-source'));
    expect($('home-today')!.dataset.origin).toBe('plan_recurring');
    expect($('home-today-source')!.textContent).toMatch(/Planejado · Planejamento semanal · treino pela rotação/);
    expect($('home-today-source')!.textContent).toMatch(/A agenda anterior indica o mesmo/);
    expect($('home-conflict')).toBeNull();
    await unmount();
    await mount('/treinos');
    await waitFor(() => $('treinos-open-import'));
    expect($('treinos-open-import')!.getAttribute('href')).toBe('/planejamento/importar');
    expect($$('agenda-day')).toHaveLength(14);
  });
});
