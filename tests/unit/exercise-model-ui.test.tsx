// Interface do modelo v3 (P10) no jsdom com banco fictício: editor de exercícios (modalidade, campos
// condicionais, validação, exercício antigo, cancelamento), série do treino ativo, detalhe do histórico,
// página Desempenho e privacidade do assistente. Dados fictícios apenas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WorkoutEditorPage from '@/pages/WorkoutEditorPage';
import SessionDetailPage from '@/pages/SessionDetailPage';
import TrainingAnalyticsPage from '@/pages/TrainingAnalyticsPage';
import { SetEditor } from '@/features/workout/SetEditor';
import { IronTrackDB, db, setDb } from '@/db/db';
import { loadContextSources, ASSISTANT_CATEGORIES } from '@/integrations/ai/contextSources';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { addDays, fromISODate, todayISO } from '@/lib/dates';
import type { ExerciseTemplate, SessionExercise, SessionSet } from '@/lib/types';
import { routine, session, settings } from './fixtures';
import { LUNGE, PLANK, PULLUP, RUN, modelSession, sx } from './modelFixtures';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let n = 0;
let root: Root | null = null;
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const byTestId = (id: string) => $(`[data-testid="${id}"]`);
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

/** Espera uma condição assíncrona (gravações no banco disparadas pela interface). */
async function eventually<T>(fn: () => Promise<T | false | null | undefined>, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('eventually: tempo esgotado');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => el.click());
}

async function setValue(el: HTMLElement | null, value: string) {
  if (!el) throw new Error('campo ausente');
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

const button = (label: string) => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label) ?? null;

beforeEach(async () => {
  setDb(new IronTrackDB(`model-ui-${++n}`));
  await db.open();
  await db.settings.put(settings());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('editor de exercícios', () => {
  const OLD_WITH_EXTRA = { ...routine().workouts[0].exercises[0], campoFuturo: 'preservar' } as ExerciseTemplate;

  async function openEditor() {
    const r = routine();
    r.workouts[0].exercises = [OLD_WITH_EXTRA];
    await db.routines.put(r);
    await render(
      <MemoryRouter initialEntries={[`/treinos/${r.id}/${r.workouts[0].id}`]}>
        <Routes>
          <Route path="/treinos/:routineId/:workoutId" element={<WorkoutEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => byTestId('add-exercise'));
    return r;
  }
  const saved = async (r: { id: string }) => (await db.routines.get(r.id))!.workouts[0].exercises;

  it('novo exercício: só os campos da modalidade aparecem e trocar de modalidade não perde o que foi digitado', async () => {
    const r = await openEditor();
    await click(byTestId('add-exercise'));
    await waitFor(() => $('#ex-modality'));
    await setValue($('#ex-name'), 'Prancha');
    // Sem modalidade: experiência de antes (repetições e carga).
    expect($('#ex-reps')).not.toBeNull();
    expect($('#ex-duration')).toBeNull();
    await setValue($('#ex-reps'), '10-15');
    await setValue($('#ex-modality'), 'timed');
    expect($('#ex-reps')).toBeNull();
    expect($('#ex-weight')).toBeNull();
    expect($('#ex-duration')).not.toBeNull();
    expect($('#ex-distance')).toBeNull();
    await setValue($('#ex-duration'), '45');
    await setValue($('#ex-modality'), 'cardio');
    expect($('#ex-distance')).not.toBeNull();
    expect($('#ex-laterality')).toBeNull();
    await setValue($('#ex-modality'), 'timed');
    expect(($('#ex-duration') as HTMLInputElement).value).toBe('45');
    await setValue($('#ex-modality'), '');
    expect(($('#ex-reps') as HTMLInputElement).value).toBe('10-15');
    await setValue($('#ex-modality'), 'timed');
    await setValue($('#ex-loadmode'), 'corporal');
    await click(button('Salvar exercício'));
    const exs = await eventually(async () => {
      const list = await saved(r);
      return list.length === 2 && list;
    });
    expect(exs).toHaveLength(2);
    expect(exs[1]).toMatchObject({ name: 'Prancha', modality: 'timed', loadMode: 'corporal', targetDurationSec: 45 });
    expect(exs[1]).not.toHaveProperty('distanceUnit');
  });

  it('cardio: unidade explícita, distância convertida para metros e validação de valores', async () => {
    const r = await openEditor();
    await click(byTestId('add-exercise'));
    await waitFor(() => $('#ex-modality'));
    await setValue($('#ex-name'), 'Bicicleta');
    await setValue($('#ex-modality'), 'cardio');
    await setValue($('#ex-distance-unit'), 'mi');
    await setValue($('#ex-distance'), '0');
    await click(button('Salvar exercício'));
    expect(text()).toContain('Distância planejada: maior que zero');
    expect(await saved(r)).toHaveLength(1);
    await setValue($('#ex-distance'), '2');
    await setValue($('#ex-duration'), '20');
    await click(button('Salvar exercício'));
    const exs = await eventually(async () => {
      const list = await saved(r);
      return list.length === 2 && list;
    });
    expect(exs[1]).toMatchObject({ modality: 'cardio', distanceUnit: 'mi', targetDistance: 3218.688, targetDurationSec: 1200 });
  });

  it('unilateral e grupos secundários; peso corporal assistido', async () => {
    const r = await openEditor();
    await click(byTestId('add-exercise'));
    await waitFor(() => $('#ex-modality'));
    await setValue($('#ex-name'), 'Afundo');
    await setValue($('#ex-modality'), 'resistance');
    await setValue($('#ex-laterality'), 'unilateral');
    const chip = [...document.querySelectorAll<HTMLElement>('[aria-pressed]')].find((b) => b.textContent === 'Costas')!;
    await click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    await click(button('Salvar exercício'));
    expect(await eventually(async () => (await saved(r))[1])).toMatchObject({ modality: 'resistance', laterality: 'unilateral', secondaryMuscles: ['Costas'] });
  });

  it('exercício antigo: editar sem mexer na modalidade mantém o registro sem campos novos e preserva campos desconhecidos', async () => {
    const r = await openEditor();
    await click($('[aria-label^="Editar"]'));
    await waitFor(() => $('#ex-modality'));
    expect(($('#ex-modality') as HTMLSelectElement).value).toBe('');
    await setValue($('#ex-notes'), 'só observação');
    await click(button('Salvar exercício'));
    const ex = await eventually(async () => {
      const [e] = await saved(r);
      return e.notes === 'só observação' && e;
    });
    expect(ex).toMatchObject({ notes: 'só observação', campoFuturo: 'preservar', repMin: OLD_WITH_EXTRA.repMin, repMax: OLD_WITH_EXTRA.repMax });
    for (const k of ['modality', 'laterality', 'loadMode', 'secondaryMuscles', 'distanceUnit', 'targetDurationSec', 'targetDistance']) expect(ex).not.toHaveProperty(k);
  });

  it('cancelar não grava nada', async () => {
    const r = await openEditor();
    const before = await saved(r);
    await click(byTestId('add-exercise'));
    await waitFor(() => $('#ex-modality'));
    await setValue($('#ex-name'), 'Rascunho');
    await setValue($('#ex-modality'), 'cardio');
    await click($('[aria-label="Fechar"]'));
    expect(await saved(r)).toEqual(before);
  });
});

describe('série do treino ativo', () => {
  const ex = (t: ExerciseTemplate, set: Partial<SessionSet>): SessionExercise => sx(t, [{ status: 'pending', ...set }]);
  async function mountSet(e: SessionExercise) {
    const onPatch = vi.fn();
    const onComplete = vi.fn();
    await render(<SetEditor ex={e} set={e.sets[0]} settings={{ ...DEFAULT_SETTINGS, id: 'settings' }} onPatch={onPatch} onComplete={onComplete} onSkip={() => undefined} />);
    return { onPatch, onComplete };
  }
  const has = (id: string) => !!byTestId(id);

  it('tempo: só duração; sem duração não conclui e explica', async () => {
    await mountSet(ex(PLANK, {}));
    expect([has('input-duration'), has('input-reps'), has('input-weight'), has('input-distance')]).toEqual([true, false, false, false]);
    expect((byTestId('complete-set') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId('set-errors')!.textContent).toContain('Informe a duração');
  });

  it('cardio: duração e distância na unidade do exercício', async () => {
    const { onPatch } = await mountSet(ex(RUN, { durationSec: 1800, distance: 5000 }));
    expect([has('input-duration'), has('input-distance'), has('input-reps')]).toEqual([true, true, false]);
    expect((byTestId('input-distance') as HTMLInputElement).value).toBe('5');
    expect(text()).toContain('Distância (km)');
    await setValue(byTestId('input-distance'), '7,5');
    expect(onPatch).toHaveBeenLastCalledWith({ distance: 7500 });
    expect((byTestId('complete-set') as HTMLButtonElement).disabled).toBe(false);
  });

  it('unilateral: seletor de lado simples (tocar de novo limpa) e concluir', async () => {
    const { onPatch, onComplete } = await mountSet(ex(LUNGE, { reps: 10, weight: 20 }));
    const left = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent === 'Esquerdo')!;
    await click(left);
    expect(onPatch).toHaveBeenLastCalledWith({ side: 'esquerdo' });
    await click(byTestId('complete-set'));
    expect(onComplete).toHaveBeenCalled();
  });

  it('assistido: campo de assistência, sem campo de carga; carga + assistência bloqueia', async () => {
    await mountSet(ex(PULLUP, { reps: 8, assistanceKg: 20, weight: 5 }));
    expect([has('input-assistance'), has('input-weight')]).toEqual([true, false]);
    expect(byTestId('set-errors')!.textContent).toContain('não as duas');
  });

  it('exercício antigo: mesmos campos de antes (peso e repetições)', async () => {
    const old = session('x').exercises[0];
    old.sets[0].status = 'pending';
    await mountSet(old);
    expect([has('input-weight'), has('input-reps'), has('input-duration'), has('set-errors')]).toEqual([true, true, false, false]);
  });
});

describe('histórico e Desempenho', () => {
  const daysAgo = (d: number) => fromISODate(addDays(todayISO(), -d)).getTime() + 10 * 3600_000;

  it('detalhe da sessão mostra duração, distância, lado e assistência; sessão antiga como antes; nada é gravado', async () => {
    await db.sessions.bulkPut([modelSession('m1', daysAgo(1)), session('velho', { startedAt: daysAgo(2) })]);
    const before = JSON.stringify(await db.sessions.toArray());
    await render(
      <MemoryRouter initialEntries={['/historico/m1']}>
        <Routes>
          <Route path="/historico/:id" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => text().includes('Prancha'));
    for (const t of ['Duração', '1:00', '45 s', 'Distância', '5 km', 'Lado', 'Esquerdo', 'Assist.', 'Carga adic.', 'Por tempo', 'unilateral']) expect(text()).toContain(t);
    expect(text()).not.toMatch(/NaN|undefined/);
    await act(async () => root?.unmount());
    root = null;
    await render(
      <MemoryRouter initialEntries={['/historico/velho']}>
        <Routes>
          <Route path="/historico/:id" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => text().includes('Supino'));
    const headers = [...document.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Série', 'Carga', 'Reps', 'RIR/RPE']);
    expect(JSON.stringify(await db.sessions.toArray())).toBe(before);
  });

  it('Desempenho usa os registros novos: tempo, cardio, lados e peso corporal', async () => {
    await db.sessions.bulkPut([modelSession('a', daysAgo(20)), modelSession('b', daysAgo(10)), modelSession('c', daysAgo(1))]);
    await render(
      <MemoryRouter>
        <TrainingAnalyticsPage />
      </MemoryRouter>,
    );
    const select = await waitFor(() => byTestId('exercise-select') as HTMLSelectElement | null);
    await setValue(select, 'prancha');
    await waitFor(() => byTestId('timed-metrics'));
    expect(byTestId('timed-metrics')!.textContent).toContain('Maior duração');
    expect(byTestId('modality-note')!.textContent).toContain('Exercício por tempo');
    await setValue(select, 'corrida');
    await waitFor(() => byTestId('cardio-metrics'));
    expect(byTestId('cardio-metrics')!.textContent).toContain('15 km');
    await setValue(select, 'afundo');
    await waitFor(() => byTestId('side-metrics'));
    expect(byTestId('side-metrics')!.textContent).toContain('Diferença registrada');
    await setValue(select, 'barra');
    await waitFor(() => byTestId('bodyweight-metrics'));
    expect(byTestId('bodyweight-metrics')!.textContent).toContain('Menor assistência');
    expect(text()).not.toMatch(/NaN|Infinity/);
  });
});

describe('privacidade', () => {
  it('o contexto do assistente não leva duração, distância, lado, assistência nem modalidade', async () => {
    await db.sessions.bulkPut([modelSession('a', Date.now() - 86_400_000)]);
    const loaded = await loadContextSources(ASSISTANT_CATEGORIES);
    const sources = JSON.stringify(loaded);
    expect(sources).toContain('Prancha');
    // Só a duração do treino inteiro (campo anterior ao P10) aparece; nada por série nem metadados de modalidade.
    for (const k of ['distance', 'side', 'assistanceKg', 'modality', 'laterality', 'loadMode', 'secondaryMuscles', 'distanceUnit', 'targetDurationSec']) expect(sources).not.toContain(`"${k}"`);
    const sets = (loaded.trainingSessions ?? []).flatMap((x) => x.exercises.flatMap((e) => e.sets));
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) expect(Object.keys(set).sort()).toEqual(['reps', 'rir', 'rpe', 'status', 'type', 'weight']);
  });
});
