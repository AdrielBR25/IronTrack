// Biblioteca de exercícios e construtor de fichas (IronTrack 2.0 F01/P17) no jsdom com o banco fictício: busca,
// filtros, favoritos (inclusive gravados por outra aba), personalizados, adicionar à ficha com sugestão anterior,
// substituição com prévia, mover sem arrastar, duplicar e prévia da ficha. Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExerciseLibraryPage from '@/pages/ExerciseLibraryPage';
import WorkoutEditorPage from '@/pages/WorkoutEditorPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createGoal } from '@/db/goals';
import { createCustomExercise, setFavorite } from '@/db/library';
import { favoriteId } from '@/modules/exercises';
import { fields, refOf } from './goalFixtures';
import { routine, settings } from './fixtures';

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
const $$ = (id: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const byLabel = (label: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label) ?? null;
const itemNames = () => $$('library-item').map((c) => c.querySelector('.font-semibold')?.textContent);
const item = (name: string) => $$('library-item').find((c) => c.querySelector('.font-semibold')?.textContent === name) ?? null;
const count = () => $('library-count')?.textContent?.trim();

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
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function mount(url = '/exercicios') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/exercicios" element={<ExerciseLibraryPage />} />
          <Route path="/treinos/:routineId/:workoutId" element={<WorkoutEditorPage />} />
          <Route path="/treinos" element={<p data-testid="workouts-page">Treinos</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}
const mountLibrary = async (url?: string) => {
  await mount(url);
  await waitFor(() => $('library-count'));
};

beforeEach(async () => {
  setDb(new IronTrackDB(`library-ui-${++n}`));
  await db.open();
  await db.settings.put(settings({ activeRoutineId: 'r1' }));
  await db.routines.put({ ...routine(), profileId: db.currentProfileId! });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  db.close();
});

describe('biblioteca', () => {
  it('lista o catálogo, busca sem acento e filtra por grupo; limpar filtros volta tudo', async () => {
    await mountLibrary();
    const total = count();
    expect(total).toMatch(/^1\d\d exercícios$/);
    await setValue($('library-search'), 'triceps barra reta');
    await waitFor(() => count() === '1 exercício');
    expect(itemNames()).toEqual(['Tríceps na polia']);
    await setValue($('library-search'), 'xyz inexistente');
    await waitFor(() => $('library-empty'));
    await click(button('Limpar busca e filtros'));
    await waitFor(() => count() === total);
    await click(button('Tríceps', $('library-filters')!));
    await waitFor(() => count() !== total);
    expect(itemNames()).toContain('Tríceps testa');
    expect(itemNames()).not.toContain('Supino reto com barra');
    await click($('clear-filters'));
    await waitFor(() => count() === total);
    expect($('clear-filters')).toBeNull();
  });

  it('favoritar persiste; favorito gravado por outra aba aparece sozinho; aba Favoritos', async () => {
    await mountLibrary();
    await click(byLabel('Favoritar Leg press'));
    await waitFor(() => byLabel('Remover Leg press dos favoritos'));
    expect((await db.exerciseFavorites.toArray()).map((f) => f.target)).toEqual(['catalog:leg-press']);
    // Outra aba (mesmo banco) favorita o Stiff.
    const tabB = new IronTrackDB(db.name);
    await tabB.open();
    const pid = db.currentProfileId!;
    await tabB.exerciseFavorites.put({ id: favoriteId(pid, 'catalog:stiff'), profileId: pid, target: 'catalog:stiff', createdAt: 1 });
    tabB.close();
    await waitFor(() => byLabel('Remover Stiff dos favoritos'));
    await click(button('Favoritos'));
    await waitFor(() => count() === '2 exercícios');
    expect(itemNames()).toEqual(['Leg press', 'Stiff']);
  });

  it('cria personalizado validado (HTML recusado), mostra em Meus, arquiva e restaura', async () => {
    await mountLibrary();
    await click($('create-custom'));
    const dlg = await waitFor(() => $('custom-exercise-dialog'));
    await setValue(dlg.querySelector('#cx-name') as HTMLElement, '<b>Remada</b>');
    // O formulário começa com halteres; troca para máquina.
    await click(button('✓ Halteres', dlg));
    await click(button('Máquina', dlg));
    await click($('custom-save'));
    await waitFor(() => /HTML/.test(dlg.textContent ?? ''));
    expect(await db.customExercises.count()).toBe(0);
    await setValue(dlg.querySelector('#cx-name') as HTMLElement, 'Remada máquina articulada');
    await setValue(dlg.querySelector('#cx-primary') as HTMLElement, 'costas');
    await click($('custom-save'));
    await waitFor(() => $('exercise-detail'));
    const saved = (await db.customExercises.toArray())[0];
    expect(saved).toMatchObject({ name: 'Remada máquina articulada', primaryMuscle: 'costas', equipment: ['maquina'], profileId: db.currentProfileId });
    expect(saved.id).toMatch(/^cx_/);
    // Não usado em nenhuma ficha: a exclusão definitiva é oferecida.
    await waitFor(() => $('detail-delete'));
    await click($('detail-archive'));
    await waitFor(() => $('detail-restore'));
    expect((await db.customExercises.get(saved.id))!.archivedAt).not.toBeNull();
    await click($('detail-restore'));
    await waitFor(() => $('detail-archive'));
    expect((await db.customExercises.get(saved.id))!.archivedAt).toBeNull();
  }, 10_000);
});

describe('construtor de fichas', () => {
  it('adicionar da biblioteca à ficha: formulário preenchido, nova instância com origem, volta ao editor', async () => {
    await mountLibrary('/exercicios?para=r1/r1-A');
    expect($('library-destination')?.textContent).toMatch(/Treino A/);
    await setValue($('library-search'), 'leg press');
    await waitFor(() => count() === '2 exercícios');
    await click($('library-choose', item('Leg press')!));
    await waitFor(() => $('add-config-header'));
    expect((document.querySelector('#ex-name') as HTMLInputElement).value).toBe('Leg press');
    expect((document.querySelector('#ex-sets') as HTMLInputElement).value).toBe('3');
    expect($('config-suggestion')).toBeNull();
    await click(button('Adicionar à ficha'));
    await waitFor(() => $('add-from-library'));
    const w = (await db.routines.get('r1'))!.workouts[0];
    expect(w.exercises).toHaveLength(3);
    expect(w.exercises[2]).toMatchObject({ name: 'Leg press', catalogId: 'leg-press', catalogVersion: 1, muscleGroup: 'Quadríceps' });
    expect(w.exercises[2].targetWeight).toBeUndefined();
    await waitFor(() => $$('editor-exercise').length === 3);
    expect($$('editor-exercise')[2].textContent).toMatch(/Leg press/);
  });

  it('configuração anterior é só sugestão (sem carga) e precisa ser aplicada', async () => {
    const r = (await db.routines.get('r1'))!;
    r.workouts[1].exercises.push({ id: 'lp-b', name: 'Leg press', muscleGroup: 'Quadríceps', category: 'compound', equipment: 'machine', sets: 5, repMin: 10, repMax: 15, restSec: 100, warmupSets: 1, targetWeight: 200, catalogId: 'leg-press', catalogVersion: 1 });
    r.updatedAt += 1;
    await db.routines.put(r);
    await mountLibrary('/exercicios?para=r1/r1-A');
    await setValue($('library-search'), 'leg press');
    await waitFor(() => count() === '2 exercícios');
    await click($('library-choose', item('Leg press')!));
    const sug = await waitFor(() => $('config-suggestion'));
    expect(sug.textContent).toMatch(/5 × 10–15 · descanso 100 s/);
    expect(sug.textContent).toMatch(/A carga não é copiada/);
    expect((document.querySelector('#ex-sets') as HTMLInputElement).value).toBe('3');
    await click($('apply-suggestion'));
    await waitFor(() => (document.querySelector('#ex-sets') as HTMLInputElement).value === '5');
    expect((document.querySelector('#ex-rest') as HTMLInputElement).value).toBe('100');
    expect((document.querySelector('#ex-weight') as HTMLInputElement | null)?.value ?? '').toBe('');
    await click(button('Adicionar à ficha'));
    await waitFor(() => $('add-from-library'));
    const added = (await db.routines.get('r1'))!.workouts[0].exercises[2];
    expect(added).toMatchObject({ sets: 5, repMin: 10, repMax: 15, restSec: 100, catalogId: 'leg-press' });
    expect(added.targetWeight).toBeUndefined();
    expect(added.id).not.toBe('lp-b');
  });

  it('substituir: prévia do que muda, metas ficam no exercício antigo, nova identidade', async () => {
    await createGoal('g1', fields({ type: 'max_load', title: 'Meta', targetValue: 90, exercise: refOf(['r1-A-e1'], { routineId: 'r1', name: 'Exercício r1-A1' }) }));
    await mountLibrary('/exercicios?para=r1/r1-A&substituir=r1-A-e1');
    expect($('library-destination')?.textContent).toMatch(/Exercício r1-A1/);
    await waitFor(() => $('library-suggestions'));
    await setValue($('library-search'), 'prancha isometrica');
    await waitFor(() => count() === '1 exercício');
    await click($('library-choose', item('Prancha')!));
    const dlg = await waitFor(() => $('substitute-dialog'));
    await waitFor(() => $('substitute-goals', dlg));
    expect($('substitute-goals')!.textContent).toMatch(/1 meta continua ligada/);
    expect(dlg.textContent).toMatch(/histórico/i);
    await click($('substitute-confirm'));
    await waitFor(() => $('add-from-library'));
    const ex = (await db.routines.get('r1'))!.workouts[0].exercises;
    expect(ex.map((e) => e.name)).toEqual(['Prancha', 'Exercício r1-A2']);
    expect(ex[0].id).not.toBe('r1-A-e1');
    expect(ex[0]).toMatchObject({ catalogId: 'prancha', modality: 'timed', sets: 3 });
    expect((await db.goals.get('g1'))!.exercise!.templateIds).toEqual(['r1-A-e1']);
  });

  it('editor: mover sem arrastar, duplicar e prévia antes de iniciar', async () => {
    await mount('/treinos/r1/r1-A');
    await waitFor(() => $('add-from-library'));
    await click(byLabel('Mover Exercício r1-A2 para cima'));
    await waitFor(() => $$('editor-exercise')[0]?.textContent?.includes('Exercício r1-A2'));
    expect((await db.routines.get('r1'))!.workouts[0].exercises.map((e) => e.id)).toEqual(['r1-A-e2', 'r1-A-e1']);
    await click(byLabel('Mais ações para Exercício r1-A1'));
    await click(button('Duplicar'));
    await waitFor(() => $$('editor-exercise').length === 3);
    const ids = (await db.routines.get('r1'))!.workouts[0].exercises.map((e) => e.id);
    expect(ids.slice(0, 2)).toEqual(['r1-A-e2', 'r1-A-e1']);
    expect(ids[2]).not.toBe('r1-A-e1');
    await click($('open-preview'));
    const prev = await waitFor(() => $('workout-preview'));
    expect($$('preview-exercise', prev)).toHaveLength(3);
    expect($('preview-start', prev)).toBeTruthy();
    // A prévia não grava nada nem inicia treino.
    expect(await db.sessions.count()).toBe(0);
  });
});

describe('isolamento', () => {
  it('personalizado e favorito criados pela API aparecem; nada de outro perfil', async () => {
    await createCustomExercise('cx_aaaaaaaa-1111', { name: 'Meu exercício', modality: 'bodyweight', primaryMuscle: 'abdomen', secondaryMuscles: [], equipment: ['peso_corporal'], laterality: 'bilateral', loadMode: 'corporal', mechanics: null });
    await setFavorite('custom:cx_aaaaaaaa-1111', true);
    const mine = (await db.customExercises.toArray())[0];
    await db.customExercises.put({ ...mine, id: 'cx_bbbbbbbb-2222', name: 'De outro perfil', profileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    await mountLibrary();
    await click(button('Meus'));
    await waitFor(() => count() === '1 exercício');
    expect(itemNames()).toEqual(['Meu exercício']);
    expect(byLabel('Remover Meu exercício dos favoritos')).toBeTruthy();
  });
});
