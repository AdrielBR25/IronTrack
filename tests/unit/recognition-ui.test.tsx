// Telas do Prompt 18 (IronTrack 2.0 F01/P18) no jsdom com o banco fictício: reconhecimento assistido (resumo,
// sugestões explicadas, confirmação, desfazer, lote com revisão), "Mais utilizados", adição múltipla, resumo do
// construtor e substituição múltipla com prévia. Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ExerciseLibraryPage from '@/pages/ExerciseLibraryPage';
import ExerciseRecognitionPage from '@/pages/ExerciseRecognitionPage';
import WorkoutEditorPage from '@/pages/WorkoutEditorPage';
import BulkReplacePage from '@/pages/BulkReplacePage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { readSnapshot } from '@/lib/backup';
import type { ExerciseTemplate, Routine } from '@/lib/types';
import { session, settings } from './fixtures';

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
const button = (label: string | RegExp, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLElement>('button')].find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''))) ?? null;
const text = (id: string) => $(id)?.textContent ?? '';

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
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => {
    el.click();
  });
}
async function setValue(el: HTMLElement | null, value: string) {
  if (!el) throw new Error('campo ausente');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(url: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/exercicios" element={<ExerciseLibraryPage />} />
          <Route path="/exercicios/reconhecer" element={<ExerciseRecognitionPage />} />
          <Route path="/treinos/:routineId/:workoutId" element={<WorkoutEditorPage />} />
          <Route path="/treinos/:routineId/:workoutId/substituir" element={<BulkReplacePage />} />
          <Route path="/treinos" element={<p data-testid="workouts-page">Treinos</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const tpl = (id: string, name: string, over: Partial<ExerciseTemplate> = {}): ExerciseTemplate => ({ id, name, muscleGroup: 'Peito', category: 'compound', equipment: 'barbell', sets: 3, repMin: 8, repMax: 12, restSec: 90, warmupSets: 0, ...over });
const legacyRoutine = (): Routine => ({
  id: 'r1',
  name: 'Rotina antiga',
  workouts: [
    { id: 'wA', label: 'A', name: 'Peito e tríceps', exercises: [tpl('a1', 'Supino inclinado', { equipment: 'dumbbell', targetWeight: 22, notes: 'devagar' }), tpl('a2', 'Exercício do professor'), tpl('a3', 'Tríceps testa', { muscleGroup: 'Tríceps' })] },
    { id: 'wB', label: 'B', name: 'Pernas', exercises: [tpl('b1', 'Leg press', { muscleGroup: 'Quadríceps', equipment: 'machine' })] },
  ],
  createdAt: 1,
  updatedAt: 1,
});
const ex = async (wid: string, id: string) => (await db.routines.get('r1'))!.workouts.find((w) => w.id === wid)!.exercises.find((e) => e.id === id);

beforeEach(async () => {
  setDb(new IronTrackDB(`recognition-ui-${++n}`));
  await db.open();
  await db.settings.put(settings({ activeRoutineId: 'r1' }));
  await db.routines.put({ ...legacyRoutine(), profileId: db.currentProfileId! });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  db.close();
});

describe('reconhecimento assistido', () => {
  it('resumo, agrupamento e sugestões explicadas; abrir a tela não grava nada', async () => {
    const before = await readSnapshot();
    await mount('/exercicios/reconhecer');
    await waitFor(() => $('recognition-summary'));
    expect(text('count-unlinked')).toMatch(/^4/);
    expect(text('count-workouts')).toMatch(/^2/);
    expect(text('count-suggested')).toMatch(/^3/);
    expect(text('count-manual')).toMatch(/^1/);
    expect(text('count-linked')).toMatch(/^0/);
    expect(document.body.textContent).toMatch(/Ficha A — Peito e tríceps/);
    const first = $$('legacy-exercise')[0];
    expect(first.textContent).toMatch(/Supino inclinado/);
    expect(first.textContent).toMatch(/Sem associação\./);
    expect(first.textContent).toMatch(/Correspondência forte.*Sugestão:.*Supino inclinado com halteres/);
    expect(first.textContent).toMatch(/mesmo grupo muscular/);
    expect($('recognition-none', $$('legacy-exercise')[1])).not.toBeNull();
    expect(await readSnapshot()).toEqual(before);
  });

  it('associar mostra o que muda e o que fica; confirmar grava só a origem; desfazer remove só a origem', async () => {
    const original = await ex('wA', 'a1');
    await mount('/exercicios/reconhecer');
    await waitFor(() => $$('legacy-link').length);
    await click($('legacy-link', $$('legacy-exercise')[0]));
    const dlg = await waitFor(() => $('link-confirm'));
    expect(dlg.textContent).toMatch(/O que será alterado/);
    expect(dlg.textContent).toMatch(/Referência de origem/);
    expect(dlg.textContent).toMatch(/O que permanece igual/);
    expect(dlg.textContent).toMatch(/Nome atual na ficha · ID da instância · Séries · Repetições · Carga · Descanso · Observações · Metas · Sessões antigas · Histórico · Analytics/);
    await click($('link-confirm-button'));
    await settle();
    await waitFor(() => !$('link-confirm'));
    expect(await ex('wA', 'a1')).toEqual({ ...original, catalogId: 'supino-inclinado-halteres', catalogVersion: 1 });
    await waitFor(() => text('count-linked').startsWith('1'));
    await click($('toggle-linked'));
    await click(await waitFor(() => $('linked-unlink')));
    await click(await waitFor(() => button('Desfazer associação')));
    await settle();
    await waitFor(() => text('count-linked').startsWith('0'));
    expect(await ex('wA', 'a1')).toEqual(original);
  });

  it('escolher outro: busca manual abre a confirmação com o item escolhido', async () => {
    await mount('/exercicios/reconhecer');
    await waitFor(() => $$('legacy-choose').length);
    await click($('legacy-choose', $$('legacy-exercise')[1]));
    await waitFor(() => $('library-picker'));
    await setValue($('picker-search'), 'supino maquina');
    const pick = await waitFor(() => $$('picker-item').find((b) => /Supino máquina/.test(b.textContent ?? '')));
    await click(pick);
    const dlg = await waitFor(() => $('link-confirm'));
    expect(dlg.textContent).toMatch(/Exercício do professor/);
    expect(dlg.textContent).toMatch(/Supino máquina/);
    await click($('link-confirm-button'));
    await waitFor(() => text('count-linked').startsWith('1'));
    expect(await ex('wA', 'a2')).toMatchObject({ name: 'Exercício do professor', catalogId: 'supino-maquina' });
  });

  it('lote: nada selecionado automaticamente; revisar, confirmar um, pular outro, resumo e aplicar', async () => {
    await mount('/exercicios/reconhecer');
    await waitFor(() => $('toggle-batch'));
    await click($('toggle-batch'));
    const boxes = $$('legacy-select') as HTMLInputElement[];
    expect(boxes.every((b) => !b.checked)).toBe(true);
    expect(($('batch-review') as HTMLButtonElement).disabled).toBe(true);
    await click(boxes[0]);
    await click(boxes[2]);
    await click($('batch-review'));
    await waitFor(() => $('batch-dialog'));
    expect(text('batch-dialog')).toMatch(/Revisar 1 de 2/);
    expect(text('batch-dialog')).toMatch(/Supino inclinado com halteres/);
    await click($('batch-confirm-one'));
    await waitFor(() => /Revisar 2 de 2/.test(text('batch-dialog')));
    await click($('batch-skip'));
    await waitFor(() => $('batch-summary'));
    expect(text('batch-summary')).toMatch(/Supino inclinado → Supino inclinado com halteres/);
    expect(text('batch-summary')).toMatch(/Tríceps testa: pulado/);
    expect(await ex('wA', 'a1')).not.toHaveProperty('catalogId');
    await click($('batch-apply'));
    await waitFor(() => $('batch-result'));
    expect(text('batch-result')).toMatch(/Supino inclinado: Associado\./);
    expect((await ex('wA', 'a1'))!.catalogId).toBe('supino-inclinado-halteres');
    expect((await ex('wA', 'a3'))!.catalogId).toBeUndefined();
  });

  it('filtro por treino (vindo do editor)', async () => {
    await mount('/exercicios/reconhecer?treino=r1/wB');
    await waitFor(() => $('recognition-summary'));
    expect(text('count-unlinked')).toMatch(/^1/);
    expect($$('legacy-exercise').map((e) => e.querySelector('.font-semibold')?.textContent)).toEqual(['Leg press']);
  });
});

describe('biblioteca: mais utilizados e adição múltipla', () => {
  it('"Mais utilizados" conta só sessões concluídas com origem; ficha não conta como sessão', async () => {
    const r = (await db.routines.get('r1'))!;
    r.workouts[1].exercises[0] = { ...r.workouts[1].exercises[0], catalogId: 'leg-press', catalogVersion: 1 };
    await db.routines.put(r);
    await mount('/exercicios');
    await waitFor(() => $('toggle-most-used'));
    await click($('toggle-most-used'));
    await waitFor(() => $('most-used-empty'));
    // Uma sessão concluída com a origem registrada + uma em andamento.
    const s = session('s1', { profileId: db.currentProfileId! });
    s.exercises[0] = { ...s.exercises[0], catalogId: 'stiff' };
    await db.sessions.put(s);
    await db.sessions.put({ ...session('s2', { profileId: db.currentProfileId!, status: 'in_progress' as never }), exercises: [{ ...s.exercises[0], catalogId: 'leg-press' }] });
    const list = await waitFor(() => $('most-used')?.querySelector('[data-testid="library-item"]') && $('most-used'));
    expect(list.textContent).toMatch(/Stiff/);
    expect(list.textContent).toMatch(/1 sessão concluída/);
    expect(list.textContent).not.toMatch(/Leg press/);
  });

  it('o detalhe distingue "está numa ficha" de "usado numa sessão registrada"', async () => {
    const r = (await db.routines.get('r1'))!;
    r.workouts[1].exercises[0] = { ...r.workouts[1].exercises[0], catalogId: 'leg-press', catalogVersion: 1 };
    await db.routines.put(r);
    await mount('/exercicios');
    await waitFor(() => $('library-search'));
    await setValue($('library-search'), 'leg press');
    const card = await waitFor(() => $$('library-item').find((c) => c.querySelector('.font-semibold')?.textContent === 'Leg press'));
    await click(card.querySelector('button'));
    const usage = await waitFor(() => $('detail-usage'));
    expect(usage.textContent).toBe('Já está em uma das suas fichas.');
  });

  it('seleção múltipla: ordem dos toques, confirmação explícita, IDs próprios, sem carga, uma gravação', async () => {
    await mount('/exercicios?para=r1/wA&varios=1');
    await waitFor(() => $('toggle-multi'));
    await setValue($('library-search'), 'peck deck');
    await click(await waitFor(() => byLabel('Selecionar Voador (peck deck)')));
    await setValue($('library-search'), 'supino maquina');
    await click(await waitFor(() => byLabel('Selecionar Supino máquina')));
    await click($('add-many-open'));
    const dlg = await waitFor(() => $('add-many-dialog'));
    expect([...dlg.querySelectorAll('li span.block')].map((e) => e.textContent)).toEqual(['Voador (peck deck)', 'Supino máquina']);
    expect(text('add-many-sets')).toMatch(/6 .*não é volume executado/);
    // Repetir só com ação explícita.
    await click(byLabel('Adicionar Voador (peck deck) outra vez'));
    expect(dlg.querySelectorAll('li').length).toBe(3);
    await click(byLabel('Tirar Voador (peck deck) da seleção'));
    expect(await ex('wA', 'a1')).toBeDefined();
    await click($('add-many-confirm'));
    await waitFor(() => $('editor-summary'));
    const w = (await db.routines.get('r1'))!.workouts[0];
    expect(w.exercises.map((e) => e.name)).toEqual(['Supino inclinado', 'Exercício do professor', 'Tríceps testa', 'Voador (peck deck)', 'Supino máquina']);
    expect(new Set(w.exercises.map((e) => e.id)).size).toBe(5);
    expect(w.exercises.slice(3).every((e) => e.targetWeight === undefined && e.catalogId)).toBe(true);
  });
});

describe('construtor de fichas', () => {
  it('resumo com total, séries planejadas (estimativa) e exercícios sem vínculo; atalhos', async () => {
    await mount('/treinos/r1/wA');
    const sum = await waitFor(() => $('editor-summary'));
    expect(sum.textContent).toMatch(/3 exercícios/);
    expect(sum.textContent).toMatch(/9 séries planejadas \(estimativa\)/);
    expect(sum.textContent).toMatch(/3 sem vínculo com a biblioteca/);
    expect($('add-many')).not.toBeNull();
    expect($('bulk-replace')).not.toBeNull();
    expect(text('open-recognition-editor')).toMatch(/Reconhecer 3 antigos/);
  });

  it('desfazer associação pelo menu do exercício (confirmação explícita)', async () => {
    const r = (await db.routines.get('r1'))!;
    r.workouts[0].exercises[0] = { ...r.workouts[0].exercises[0], catalogId: 'supino-inclinado-halteres', catalogVersion: 1 };
    await db.routines.put(r);
    await mount('/treinos/r1/wA');
    await waitFor(() => $$('exercise-actions').length === 3);
    await click($$('exercise-actions')[0]);
    await click(await waitFor(() => $('unlink-origin')));
    await click(await waitFor(() => button('Desfazer associação')));
    await settle();
    await waitFor(() => /3 sem vínculo/.test(text('editor-summary')));
    expect((await ex('wA', 'a1'))!.catalogId).toBeUndefined();
    expect((await ex('wA', 'a1'))!.targetWeight).toBe(22);
  });

  it('substituição múltipla: seleção, substitutos, prévia com metas e nova identidade, confirmação única', async () => {
    await mount('/treinos/r1/wA/substituir');
    await waitFor(() => $$('bulk-select').length === 3);
    expect(($('bulk-next-choose') as HTMLButtonElement).disabled).toBe(true);
    await click($$('bulk-select')[0]);
    await click($$('bulk-select')[2]);
    await click($('bulk-next-choose'));
    await waitFor(() => $$('bulk-pick').length === 2);
    for (const [i, q, name] of [
      [0, 'supino maquina', 'Supino máquina'],
      [1, 'triceps corda', 'Tríceps corda'],
    ] as const) {
      await click($$('bulk-pick')[i]);
      await waitFor(() => $('library-picker'));
      await setValue($('picker-search'), q);
      await click(await waitFor(() => $$('picker-item').find((b) => b.querySelector('.font-semibold')?.textContent === name)));
      await waitFor(() => !$('library-picker'));
    }
    await click($('bulk-next-preview'));
    await waitFor(() => $$('bulk-preview-row').length === 2);
    expect(text('bulk-goal-note')).toMatch(/As metas vinculadas ao exercício anterior continuarão vinculadas a ele\./);
    expect(text('bulk-final-order')).toMatch(/Supino máquina.*Exercício do professor.*Tríceps corda/);
    expect($$('bulk-preview-row')[0].textContent).toMatch(/Descartado: carga planejada/);
    const newIds = $$('bulk-new-id').map((e) => e.textContent);
    expect(await ex('wA', 'a1')).toBeDefined();
    await click($('bulk-confirm'));
    await waitFor(() => $('editor-summary'));
    const w = (await db.routines.get('r1'))!.workouts[0];
    expect(w.exercises.map((e) => e.id)).toEqual([newIds[0], 'a2', newIds[1]]);
    expect(w.exercises.map((e) => e.name)).toEqual(['Supino máquina', 'Exercício do professor', 'Tríceps corda']);
    expect((await db.routines.get('r1'))!.workouts[1]).toEqual(legacyRoutine().workouts[1]);
  });
});
