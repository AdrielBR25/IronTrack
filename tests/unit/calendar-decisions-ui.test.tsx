// Decisões lembradas nas telas (IronTrack 2.0 F01/P16), no jsdom com banco fictício: "Manter planejamento e lembrar"
// na central e no aviso do dia, persistência ao reabrir, consistência Início/Treinos/Planejamento, "Decisões lembradas"
// (voltar a mostrar, remover, abrir o dia) e o desfazer parcial da importação com prévia por item.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import WeeklyPlannerPage from '@/pages/WeeklyPlannerPage';
import LegacyImportPage from '@/pages/LegacyImportPage';
import HomePage from '@/pages/HomePage';
import WorkoutsPage from '@/pages/WorkoutsPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { addPlanActivity, listPlanEntries, updatePlanActivity } from '@/db/planner';
import { readLastImport } from '@/db/legacyImport';
import { readSnapshot } from '@/lib/backup';
import { addDays, todayISO, weekday } from '@/lib/dates';
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
/** Treinos: abre o dia de hoje na agenda de 14 dias (o aviso do dia fica no diálogo). */
async function openTodayInTreinos() {
  await mount('/treinos');
  await waitFor(() => $$('agenda-day').length === 14);
  await click($$('agenda-day').find((c) => c.dataset.date === today)!);
  return waitFor(() => $('agenda-day-dialog'));
}
async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
}

const today = todayISO();
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

beforeEach(async () => {
  localStorage.clear();
  setDb(new IronTrackDB(`calendar-decisions-ui-${++n}`));
  await db.open();
  await db.settings.put(settings({ activeRoutineId: 'r1', trainingDays: ALL_DAYS }));
  await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
  await db.rotations.put({ routineId: 'r1', nextIndex: 0, updatedAt: 1 });
});
afterEach(async () => {
  await unmount();
  db.close();
});


const nonDecision = async () => JSON.stringify({ ...(await readSnapshot()), calendarDecisions: [] });

describe('Manter planejamento e lembrar', () => {
  beforeEach(async () => {
    await addPlanActivity({ id: 'hoje-b', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: 'r1-B' } });
  });

  it('na central: grava só a decisão, o aviso some e continua sumido ao reabrir; Início e Treinos concordam', async () => {
    const before = await nonDecision();
    await mount('/planejamento');
    await click(await waitFor(() => $('open-conflict-center')));
    await waitFor(() => $('conflict-center'));
    const g = $$('conflict-group').find((x) => x.dataset.kind === 'plan_vs_legacy_workout')!;
    expect($('cc-display-actions', g)!.textContent).toMatch(/não altera treinos/);
    expect($('cc-plan-actions', g)!.textContent).toMatch(/Alteração de planejamento/);
    await click($('cc-remember', g));
    await waitForDb(async () => (await db.calendarDecisions.count()) === 1);
    expect(await nonDecision()).toBe(before);
    await waitFor(() => $('open-conflict-center')?.dataset.warnings === '0');
    await waitFor(() => $('cc-remembered-count'));
    await unmount();
    await mount('/planejamento');
    await waitFor(() => $('open-conflict-center')?.dataset.warnings === '0');
    await unmount();
    await mount('/');
    await waitFor(() => $('home-remembered'));
    expect($('home-conflict')).toBeNull();
    await unmount();
    await openTodayInTreinos();
    const notice = await waitFor(() => $('conflict-notice'));
    expect(notice.dataset.warning).toBe('false');
    expect($('conflict-remembered')).not.toBeNull();
  });

  it('no aviso do dia (Treinos): lembrar e voltar a mostrar', async () => {
    await openTodayInTreinos();
    await waitFor(() => $('conflict-notice')?.dataset.warning === 'true');
    await click($('conflict-remember'));
    await waitFor(() => $('conflict-notice')?.dataset.warning === 'false');
    await click(await waitFor(() => $('conflict-show-again')));
    await waitFor(() => $('conflict-notice')?.dataset.warning === 'true');
    expect((await db.calendarDecisions.toArray())[0]).toMatchObject({ decision: 'show', revision: 2 });
  });

  it('mudança relevante no planejamento: o aviso volta sozinho', async () => {
    await mount('/');
    await waitFor(() => $('home-conflict'));
    await unmount();
    await openTodayInTreinos();
    await click(await waitFor(() => $('conflict-remember')));
    await waitFor(() => $('conflict-notice')?.dataset.warning === 'false');
    const e = (await listPlanEntries())[0];
    await updatePlanActivity({ id: e.id, expectedRevision: e.revision, activity: { routineId: 'r1', workoutId: 'r1-C' } });
    await waitFor(() => $('conflict-notice')?.dataset.warning === 'true');
  });
});

describe('Decisões lembradas', () => {
  beforeEach(async () => {
    await addPlanActivity({ id: 'hoje-b', slot: { scope: 'weekly', weekday: weekday(today) }, activity: { routineId: 'r1', workoutId: 'r1-B' } });
  });

  it('lista dia, tipo, decisão e situação; abrir o dia, voltar a mostrar e remover', async () => {
    await mount('/planejamento?decisoes=1');
    await waitFor(() => $('decisions-empty'));
    const g = await waitFor(() => $$('conflict-group').find((x) => x.dataset.kind === 'plan_vs_legacy_workout'));
    await click($('cc-remember', g));
    const item = await waitFor(() => $('decision-item'));
    expect(item.dataset.status).toBe('active');
    expect(item.dataset.date).toBe(today);
    expect(item.textContent).toMatch(/Manter o planejamento/);
    expect($('decision-status', item)!.textContent).toMatch(/Valendo/i);
    await click($('decision-open-day', item));
    await waitFor(() => $('plan-day')?.dataset.date === today);
    await click($('decision-show-again'));
    await waitFor(() => $('decision-item')?.dataset.status === 'showing');
    await waitFor(() => $('open-conflict-center')?.dataset.warnings === '1');
    await click(await waitFor(() => $('decisions-cleanup')));
    await waitFor(() => $('decisions-empty'));
    expect(await db.calendarDecisions.count()).toBe(0);
  });

  it('decisão sem efeito nunca aparece como ativa; registros ilegíveis são informados e removíveis', async () => {
    const pid = db.currentProfileId!;
    await db.calendarDecisions.put({ id: `${pid}~lixo`, profileId: pid, conflictId: 'lixo' } as never);
    const cid = `plan_vs_legacy_workout|${addDays(today, -7)}|`;
    await db.calendarDecisions.put({ id: `${pid}~${cid}`, profileId: pid, conflictId: cid, conflictType: 'plan_vs_legacy_workout', scope: 'conflict_day', date: addDays(today, -7), subject: null, decision: 'keep_plan', severity: 'warning', sourceFingerprint: 'abc', summary: 'antiga', createdAt: 1, updatedAt: 1, revision: 1 });
    await mount('/planejamento?decisoes=1');
    const item = await waitFor(() => $('decision-item'));
    expect(item.dataset.status).toBe('expired');
    await waitFor(() => $('decisions-invalid'));
    await click($('decisions-remove-invalid'));
    await waitForDb(async () => (await db.calendarDecisions.count()) === 1);
    await click(await waitFor(() => $('decision-remove')));
    await waitForDb(async () => (await db.calendarDecisions.count()) === 0);
  });
});

describe('Desfazer parcial da importação', () => {
  it('mostra os itens por situação e desfaz só os seguros, preservando o dia alterado', async () => {
    await mount('/planejamento/importar');
    await click(await waitFor(() => $('import-confirm')));
    await click(await waitFor(() => $('import-apply')));
    await waitForDb(async () => (await listPlanEntries()).length === 7);
    const e = (await listPlanEntries()).find((x) => x.scope === 'weekly' && x.weekday === weekday(today))!;
    await updatePlanActivity({ id: e.id, expectedRevision: e.revision, activity: { routineId: 'r1', workoutId: 'r1-C' } });
    await click(await waitFor(() => $('import-undo')));
    const dialog = await waitFor(() => $('import-undo-dialog'));
    expect(dialog.dataset.ok).toBe('false');
    expect(dialog.dataset.safe).toBe('6');
    expect($$('undo-item', $('undo-modified')!).map((x) => x.dataset.status)).toEqual(['modified']);
    expect($$('undo-item', $('undo-safe')!)).toHaveLength(6);
    expect($('import-undo-apply')).toBeNull();
    await click($('import-undo-partial'));
    await waitForDb(async () => (await listPlanEntries()).length === 1);
    expect((await listPlanEntries())[0]).toMatchObject({ id: e.id, workoutId: 'r1-C' });
    await waitFor(() => $('import-last')?.dataset.status === 'partial');
    expect((await readLastImport())!.status).toBe('partial');
    expect($('import-undo')!.textContent).toMatch(/Rever itens pendentes/);
  });

  it('cancelar não desfaz nada', async () => {
    await mount('/planejamento/importar');
    await click(await waitFor(() => $('import-confirm')));
    await click(await waitFor(() => $('import-apply')));
    await waitForDb(async () => (await listPlanEntries()).length === 7);
    await click(await waitFor(() => $('import-undo')));
    await click(await waitFor(() => $('import-undo-cancel')));
    expect(await listPlanEntries()).toHaveLength(7);
    expect((await readLastImport())!.status).toBe('applied');
  });
});
