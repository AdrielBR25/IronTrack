// Tela de metas (IronTrack 2.0 F01/P12) no jsdom com o banco fictício: criar, editar, pausar, retomar, arquivar,
// excluir com confirmação, escolha do exercício, progresso, conquistas e atualização após um treino. Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import TrainingGoalsPage from '@/pages/TrainingGoalsPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createGoal } from '@/db/goals';
import { todayISO } from '@/lib/dates';
import { fields, goalRoutine, refOf, ses, set, supino } from './goalFixtures';
import { settings } from './fixtures';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let n = 0;
let root: Root | null = null;
let container: HTMLDivElement;

const $ = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const text = () => document.body.textContent ?? '';
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label) ?? null;
const card = (title: string) => $$('goal-card').find((c) => $('goal-title-text', c)?.textContent === title) ?? null;

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

async function setValue(el: HTMLElement | null, value: string) {
  if (!el) throw new Error('campo ausente');
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <TrainingGoalsPage />
      </MemoryRouter>,
    );
  });
  await waitFor(() => $('goals-page'));
}

const now = () => Date.now() - 60_000;
const supinoToday = (id: string, weight: number) => ses(id, todayISO(), [supino('sup-A', [set(weight, 5)])], { profileId: db.currentProfileId!, startedAt: now() });

beforeEach(async () => {
  setDb(new IronTrackDB(`goals-ui-${++n}`));
  await db.open();
  await db.settings.put(settings({ activeRoutineId: 'gr' }));
  await db.routines.put({ ...goalRoutine(), profileId: db.currentProfileId!});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
});

describe('tela de metas', () => {
  it('sem metas: explica o que dá para acompanhar, sem números inventados', async () => {
    await mount();
    await waitFor(() => text().includes('Nenhuma meta ainda'));
    expect(text()).toContain('Não são enviadas ao assistente de IA');
    expect(text()).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('cria meta de frequência com validação imediata e unidade visível', async () => {
    await mount();
    await click($('new-goal'));
    const form = await waitFor(() => $('goal-form'));
    expect($('goal-target-unit')!.textContent).toMatch(/sess/);
    await setValue($('goal-target'), '0');
    expect(text()).toMatch(/maior que zero|entre 1 e 14/i);
    expect(($('goal-save') as HTMLButtonElement).disabled).toBe(false);
    await setValue($('goal-target'), '3');
    expect(($('goal-title') as HTMLInputElement).value).toMatch(/3/);
    await click($('goal-save', form));
    const c = await waitFor(() => $$('goal-card')[0]);
    expect(c.dataset.state).toBe('ativa');
    expect($('goal-progress-text', c)!.textContent).toContain('0 de 3 sessões nesta semana');
    expect(c.querySelector('[role="progressbar"]')!.getAttribute('aria-valuetext')).toContain('0 de 3');
    expect(await db.goals.count()).toBe(1);
  });

  it('meta de exercício: escolhe pela ficha (ID), mostra referência do histórico e atinge com evidência', async () => {
    await db.sessions.put(ses('antigo', '2026-01-05', [supino('sup-A', [set(70, 5)])], { profileId: db.currentProfileId!}));
    await mount();
    await click($('new-goal'));
    await waitFor(() => $('goal-form'));
    await setValue($('goal-type'), 'max_load');
    const select = $('goal-exercise') as HTMLSelectElement;
    const supinoOpt = [...select.options].find((o) => o.textContent?.startsWith('Supino reto'))!;
    expect(supinoOpt.textContent).toContain('treinos A, B');
    expect([...select.options].some((o) => o.textContent?.startsWith('Prancha'))).toBe(false);
    await setValue(select, supinoOpt.value);
    expect($('goal-target-unit')!.textContent).toBe('kg');
    await waitFor(() => $('goal-history-note')?.textContent?.includes('70'));
    await setValue($('goal-target'), '80');
    await click($('goal-save'));
    const c = await waitFor(() => card('Supino reto: 80 kg') ?? $$('goal-card')[0]);
    const stored = (await db.goals.toArray())[0];
    expect(stored.exercise!.templateIds.sort()).toEqual(['sup-A', 'sup-B']);
    expect(c.dataset.state).toBe('ativa');
    expect($('goal-baseline', c)!.textContent).toContain('70');

    // Um treino concluído depois do início atualiza a tela sozinho (consulta ao vivo).
    await act(async () => {
      await db.sessions.put(supinoToday('hoje', 82.5));
    });
    await waitFor(() => $$('goal-card')[0]?.dataset.state === 'atingida');
    expect($('goal-evidence')!.textContent).toContain('82,5');
    await waitFor(() => $$('achievement').length > 0);
    expect($$('achievement').map((a) => a.dataset.kind)).toEqual(expect.arrayContaining(['primeira_meta', 'recorde_meta']));
    expect(text()).toContain('Sem pontuação e sem comparação');
  });

  it('editar, pausar, retomar, arquivar e restaurar', async () => {
    await createGoal('g', fields({ title: 'Treinar 3x', targetValue: 3, startDate: todayISO() }));
    await mount();
    let c = await waitFor(() => card('Treinar 3x'));
    await click($('goal-edit', c));
    await waitFor(() => $('goal-form'));
    expect(($('goal-type') as HTMLSelectElement).disabled).toBe(true); // tipo não muda na edição
    await setValue($('goal-target'), '4');
    await setValue($('goal-title'), 'Treinar 4x');
    await click($('goal-save'));
    c = await waitFor(() => card('Treinar 4x'));
    expect((await db.goals.get('g'))!).toMatchObject({ targetValue: 4, revision: 2 });

    await click($('goal-pause', c));
    c = await waitFor(() => (card('Treinar 4x')?.dataset.state === 'pausada' ? card('Treinar 4x') : null));
    expect($('goal-state', c)!.textContent).toContain('Pausada');
    await click($('goal-resume', c));
    c = await waitFor(() => (card('Treinar 4x')?.dataset.state === 'ativa' ? card('Treinar 4x') : null));
    await click($('goal-archive', c));
    await waitFor(() => $('toggle-archived'));
    expect(card('Treinar 4x')).toBeNull();
    await click($('toggle-archived'));
    c = await waitFor(() => card('Treinar 4x'));
    expect(c.dataset.state).toBe('arquivada');
    await click($('goal-unarchive', c));
    await waitFor(() => card('Treinar 4x')?.dataset.state === 'ativa');
    expect((await db.goals.get('g'))!.status).toBe('active');
  });

  it('excluir pede confirmação; cancelar mantém e confirmar apaga só a meta', async () => {
    await createGoal('g', fields({ title: 'Apagar', targetValue: 2, startDate: todayISO() }));
    await db.sessions.put(ses('s', todayISO(), [], { profileId: db.currentProfileId!, startedAt: now() }));
    await mount();
    const c = await waitFor(() => card('Apagar'));
    await click($('goal-delete', c));
    const dialog = await waitFor(() => document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]'));
    expect(dialog.textContent).toContain('Treinos e fichas não mudam');
    await click(button('Cancelar', dialog));
    expect(await db.goals.count()).toBe(1);
    await click($('goal-delete', card('Apagar')!));
    const again = await waitFor(() => document.querySelector<HTMLElement>('[role="alertdialog"], [role="dialog"]'));
    await click(button('Excluir', again));
    await waitFor(() => !card('Apagar'));
    expect(await db.goals.count()).toBe(0);
    expect(await db.sessions.count()).toBe(1);
  });

  it('frequência semanal cumprida aparece em texto (não só na cor) e gera conquista', async () => {
    await createGoal('g', fields({ title: 'Treinar 1x', targetValue: 1, startDate: todayISO() }));
    await db.sessions.put(ses('s', todayISO(), [], { profileId: db.currentProfileId!, startedAt: now() }));
    await mount();
    const c = await waitFor(() => card('Treinar 1x'));
    // Meta semanal é recorrente: segue "Em andamento", com a semana cumprida dita em texto.
    expect(c.dataset.state).toBe('ativa');
    expect($('goal-week-met', c)!.textContent).toContain('Cumprida nesta semana');
    expect(c.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('100');
    expect($$('achievement').map((a) => a.dataset.kind)).toContain('frequencia_semanal');
  });

  it('exercício removido da ficha: meta preservada com aviso', async () => {
    await createGoal('g', fields({ type: 'max_load', title: 'Supino 90', targetValue: 90, exercise: refOf(['sup-A', 'sup-B']), startDate: todayISO() }));
    const r = goalRoutine();
    r.workouts = r.workouts.map((w) => ({ ...w, exercises: w.exercises.filter((e) => !e.id.startsWith('sup')) }));
    await db.routines.put({ ...r, profileId: db.currentProfileId!});
    await mount();
    const c = await waitFor(() => card('Supino 90'));
    expect($('goal-availability', c)!.textContent).toContain('não está mais em nenhuma ficha');
    expect($('goal-no-data', c)).toBeTruthy();
    expect(text()).not.toMatch(/NaN|Infinity/);
  });
});
