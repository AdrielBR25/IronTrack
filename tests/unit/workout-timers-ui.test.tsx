// Interface do P11 no jsdom: cronômetro de execução na série (iniciar, pausar, continuar, encerrar, reiniciar com
// confirmação, conflito com duração digitada, conclusão com cronômetro ativo), cardio rápido (unidades, metas,
// equivalências), unilaterais (lado em destaque, alternância só em série pendente), peso corporal × assistência,
// e o treino ativo (sem conclusão dupla, falha de gravação, descanso + cronômetro, editor bloqueado). Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SetEditor, SetFields } from '@/features/workout/SetEditor';
import { SET_TIMER_KEY, setTimerStore } from '@/features/workout/setTimerStore';
import ActiveWorkoutPage from '@/pages/ActiveWorkoutPage';
import WorkoutEditorPage from '@/pages/WorkoutEditorPage';
import { resetModelCapabilityCache } from '@/features/compat/CompatGuard';
import { CAPABILITIES_KEY } from '@/db/modelGuard';
import { IronTrackDB, db, setDb } from '@/db/db';
import * as repo from '@/db/repo';
import { DEFAULT_SETTINGS } from '@/lib/defaults';
import { toMetersFrom } from '@/modules/training';
import type { ExerciseTemplate, SessionExercise, SessionSet } from '@/lib/types';
import { settings } from './fixtures';
import { DIP, LUNGE, PLANK, PULLUP, RUN, modelRoutine, sx } from './modelFixtures';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function () {};

let n = 0;
let root: Root | null = null;
let clock = 1_800_000_000_000;
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const byTestId = (id: string) => $(`[data-testid="${id}"]`);
const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label) ?? null;

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 3000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - start > timeout) throw new Error('waitFor: tempo esgotado');
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
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function advance(ms: number) {
  clock += ms;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(async () => {
  localStorage.clear();
  setTimerStore.sync();
  resetModelCapabilityCache();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  setDb(new IronTrackDB(`timers-ui-${++n}`));
  await db.open();
  await db.settings.put(settings());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const ex = (t: ExerciseTemplate, set: Partial<SessionSet>, more: Partial<SessionSet>[] = []): SessionExercise => sx(t, [{ status: 'pending', ...set }, ...more]);

async function mountSet(e: SessionExercise, set = e.sets[0], withSession = true) {
  const onPatch = vi.fn();
  const onComplete = vi.fn();
  await render(
    <SetEditor
      ex={e}
      set={set}
      settings={{ ...DEFAULT_SETTINGS, id: 'settings' }}
      onPatch={onPatch}
      onComplete={onComplete}
      onSkip={() => undefined}
      sessionId={withSession ? 'sess-1' : undefined}
    />,
  );
  // O botão de concluir fica ativo 300 ms depois de a série aparecer (proteção contra toque duplo).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
  return { onPatch, onComplete };
}

describe('cronômetro de execução na série', () => {
  it('iniciar → pausar (estado evidente) → continuar → encerrar grava a duração medida', async () => {
    const e = ex(PLANK, {});
    const { onPatch } = await mountSet(e);
    expect(byTestId('set-timer-display')!.textContent).toBe('00:00');
    await click(byTestId('set-timer-start'));
    expect(byTestId('set-timer')!.dataset.status).toBe('running');
    await advance(20_400);
    await click(byTestId('set-timer-pause'));
    expect(byTestId('set-timer-status')!.textContent).toBe('PAUSADO');
    expect(byTestId('set-timer-display')!.textContent).toBe('00:20');
    await advance(60_000); // pausado não conta
    await click(byTestId('set-timer-resume'));
    await advance(32_000);
    await click(byTestId('set-timer-stop'));
    expect(onPatch).toHaveBeenLastCalledWith({ durationSec: 52 });
    expect(JSON.parse(localStorage.getItem(SET_TIMER_KEY)!)).toMatchObject({ status: 'stopped', appliedSec: 52 });
  });

  it('duração digitada diferente: pede confirmação; "Manter" não altera a série', async () => {
    const e = ex(PLANK, { durationSec: 60, plannedDurationSec: 45 });
    const { onPatch } = await mountSet(e);
    await click(byTestId('set-timer-start'));
    await advance(41_000);
    await click(byTestId('set-timer-stop'));
    await waitFor(() => byTestId('duration-keep'));
    expect(text()).toContain('Substituir a duração da série?');
    await click(byTestId('duration-keep'));
    expect(onPatch).not.toHaveBeenCalled();
    // Ainda dá para usar a medida depois, pelo botão.
    await click(byTestId('set-timer-use'));
    await click(await waitFor(() => byTestId('duration-use-measured')));
    expect(onPatch).toHaveBeenLastCalledWith({ durationSec: 41 });
  });

  it('valor igual à meta (pré-preenchido) é substituído sem perguntar', async () => {
    const { onPatch } = await mountSet(ex(PLANK, { durationSec: 45, plannedDurationSec: 45 }));
    await click(byTestId('set-timer-start'));
    await advance(50_000);
    await click(byTestId('set-timer-stop'));
    expect(onPatch).toHaveBeenLastCalledWith({ durationSec: 50 });
    expect(byTestId('duration-keep')).toBeNull();
  });

  it('concluir com o cronômetro ativo pede escolha; cancelar não muda nada', async () => {
    const e = ex(PLANK, {});
    const { onPatch, onComplete } = await mountSet(e);
    await click(byTestId('set-timer-start'));
    await advance(33_000);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100)); // redesenho do botão (duração medida habilita concluir)
    });
    await click(byTestId('complete-set'));
    await click(await waitFor(() => byTestId('finish-cancel')));
    expect(onComplete).not.toHaveBeenCalled();
    expect(onPatch).not.toHaveBeenCalled();
    expect(byTestId('set-timer')!.dataset.status).toBe('running');
    await click(byTestId('complete-set'));
    await click(await waitFor(() => byTestId('finish-with-timer')));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ durationSec: 33 });
  });

  it('reiniciar exige confirmação', async () => {
    await mountSet(ex(PLANK, {}));
    await click(byTestId('set-timer-start'));
    await advance(5_000);
    await click(byTestId('set-timer-pause'));
    await click(byTestId('set-timer-reset'));
    await click(await waitFor(() => button('Cancelar')));
    expect(byTestId('set-timer')!.dataset.status).toBe('paused');
    await click(byTestId('set-timer-reset'));
    await click(await waitFor(() => button('Reiniciar')));
    expect(byTestId('set-timer')!.dataset.status).toBe('idle');
    expect(localStorage.getItem(SET_TIMER_KEY)).toBeNull();
  });

  it('outra série com cronômetro: não inicia um segundo, mostra qual está em uso', async () => {
    setTimerStore.start({ sessionId: 'sess-1', exerciseId: 'outro', setId: 'x' });
    await mountSet(ex(PLANK, {}));
    expect(byTestId('set-timer-other')).not.toBeNull();
    expect(byTestId('set-timer-start')).toBeNull();
  });

  it('fora do treino ativo (sem sessão) não há cronômetro; exercícios sem duração também não', async () => {
    await mountSet(ex(PLANK, {}), undefined, false);
    expect(byTestId('set-timer')).toBeNull();
    await act(async () => root?.unmount());
    await mountSet(ex(LUNGE, { reps: 10, weight: 20 }));
    expect(byTestId('set-timer')).toBeNull();
  });
});

describe('cardio rápido', () => {
  it('unidade de digitação m/km/mi com conversão correta, equivalências, ritmo e metas', async () => {
    const e = ex(RUN, { durationSec: 1500, distance: 4000, plannedDurationSec: 1800, plannedDistance: 5000 });
    const { onPatch } = await mountSet(e);
    expect(byTestId('set-timer')).not.toBeNull(); // cronômetro opcional também no cardio
    expect(byTestId('distance-equivalents')!.textContent).toBe('4.000 m = 4 km = 2,49 mi · ritmo 6:15 /km');
    const mi = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent === 'mi')!;
    await click(mi);
    expect(text()).toContain('Distância (mi)');
    await setValue(byTestId('input-distance'), '3,1');
    expect(onPatch).toHaveBeenLastCalledWith({ distance: toMetersFrom(3.1, 'mi') });
    expect(toMetersFrom(3.1, 'mi')).toBeCloseTo(4988.966, 3);
    const m = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent === 'm')!;
    await click(m);
    await setValue(byTestId('input-distance'), '800');
    expect(onPatch).toHaveBeenLastCalledWith({ distance: 800 });
    await click(byTestId('use-target-duration'));
    expect(onPatch).toHaveBeenLastCalledWith({ durationSec: 1800 });
    await click(byTestId('use-target-distance'));
    expect(onPatch).toHaveBeenLastCalledWith({ distance: 5000 });
  });

  it('validação: sem duração e sem distância não conclui', async () => {
    await mountSet(ex(RUN, {}));
    expect((byTestId('complete-set') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId('set-errors')!.textContent).toContain('Informe a duração ou a distância');
  });
});

describe('unilaterais', () => {
  it('lado em destaque; ausente aparece como "não informado" (nunca bilateral)', async () => {
    await mountSet(ex(LUNGE, { reps: 10, weight: 20 }));
    expect(byTestId('side-badge')!.textContent).toBe('Lado não informado');
  });

  it('alternância rápida só na série pendente: D → E, e sugere o oposto da última concluída', async () => {
    const e = ex(LUNGE, { reps: 10, weight: 20, side: 'direito' });
    const { onPatch } = await mountSet(e);
    expect(byTestId('side-badge')!.textContent).toBe('Lado: Direito');
    await click(byTestId('toggle-side'));
    expect(onPatch).toHaveBeenLastCalledWith({ side: 'esquerdo' });
    await act(async () => root?.unmount());
    const e2 = sx(LUNGE, [
      { status: 'done', reps: 10, weight: 20, side: 'esquerdo' },
      { status: 'pending', reps: 10, weight: 20 },
    ]);
    const r2 = await mountSet(e2, e2.sets[1]);
    await click(byTestId('toggle-side'));
    expect(r2.onPatch).toHaveBeenLastCalledWith({ side: 'direito' });
    expect(r2.onPatch).toHaveBeenCalledTimes(1); // nada duplicado, nada mais alterado
  });

  it('série concluída (edição) permite corrigir o lado, sem atalho de alternância', async () => {
    const e = sx(LUNGE, [{ status: 'done', reps: 10, weight: 20, side: 'direito' }]);
    const onPatch = vi.fn();
    await render(<SetFields compact ex={e} set={e.sets[0]} settings={{ ...DEFAULT_SETTINGS, id: 'settings' }} onPatch={onPatch} />);
    expect(byTestId('toggle-side')).toBeNull();
    const left = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((b) => b.textContent === 'Esquerdo')!;
    await click(left);
    expect(onPatch).toHaveBeenLastCalledWith({ side: 'esquerdo' });
  });
});

describe('peso corporal × assistência', () => {
  it('carga adicional e assistência têm rótulos e explicações diferentes', async () => {
    await mountSet(ex(DIP, { reps: 8 }));
    expect(text()).toContain('Carga adicional (+kg)');
    expect(text()).toContain('colete, cinto ou anilha');
    expect(text()).not.toContain('Assistência');
    await act(async () => root?.unmount());
    await mountSet(ex(PULLUP, { reps: 8 }));
    expect(text()).toContain('Assistência (−kg)');
    expect(text()).toContain('Assistência é ajuda, não carga');
    expect(byTestId('input-weight')).toBeNull();
  });
});

// ---------- Treino ativo ----------

async function openWorkout() {
  const r = modelRoutine();
  r.workouts[0].exercises = [structuredClone(PLANK), structuredClone(LUNGE)];
  await repo.addRoutine(r);
  const s = await repo.startSession(r.id, r.workouts[0].id);
  await render(
    <MemoryRouter initialEntries={['/treino']}>
      <Routes>
        <Route path="/treino" element={<ActiveWorkoutPage />} />
        <Route path="/" element={<p>início</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => byTestId('set-editor'));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 320));
  });
  return s;
}
const stored = async (id: string) => (await db.sessions.get(id))!;

describe('treino ativo', () => {
  it('toque duplo em concluir: uma série concluída, nenhuma duplicada', async () => {
    const s = await openWorkout();
    const btn = byTestId('complete-set')!;
    await act(async () => {
      btn.click();
      btn.click();
    });
    await waitFor(async () => false as never, 50).catch(() => undefined);
    const after = await stored(s.id);
    const plank = after.exercises[0];
    expect(plank.sets.filter((x) => x.status === 'done')).toHaveLength(1);
    expect(plank.sets).toHaveLength(s.exercises[0].sets.length);
  });

  it('descanso e cronômetro de execução ao mesmo tempo, independentes', async () => {
    const s = await openWorkout();
    const plank = s.exercises[0];
    // Cronômetro rodando na 3ª série enquanto a 1ª é concluída (o descanso começa para a 2ª).
    setTimerStore.start({ sessionId: s.id, exerciseId: plank.id, setId: plank.sets[2].id });
    await click(byTestId('complete-set'));
    await waitFor(() => byTestId('rest-panel'));
    const chip = await waitFor(() => byTestId('set-timer-chip'));
    expect(chip.dataset.status).toBe('running');
    await click(button('Pausar'));
    expect(byTestId('set-timer-chip')!.dataset.status).toBe('paused');
    expect(byTestId('rest-panel')!.textContent).toContain('Descansando'); // descanso segue rodando
    const restBefore = (await stored(s.id)).rest;
    expect(restBefore).toBeTruthy();
    await click(byTestId('rest-skip'));
    await waitFor(async () => !(await stored(s.id)).rest || null).catch(() => undefined);
    expect(setTimerStore.get().state?.status).toBe('paused'); // pular o descanso não mexe no cronômetro
  });

  it('falha de gravação: avisa, mantém os dados na tela e tenta de novo', async () => {
    const s = await openWorkout();
    const spy = vi.spyOn(repo, 'saveSessionGuarded').mockRejectedValueOnce(new Error('disco cheio'));
    await setValue(byTestId('input-duration'), '61');
    const status = await waitFor(() => (byTestId('save-status')?.textContent?.includes('não salvo') ? byTestId('save-status') : null));
    expect((byTestId('input-duration') as HTMLInputElement).value).toBe('61');
    spy.mockRestore();
    await click(status);
    await waitFor(() => byTestId('save-status')?.dataset.state === 'saved');
    expect((await stored(s.id)).exercises[0].sets[0].durationSec).toBe(61);
  });
});

describe('editor de fichas em app desatualizado', () => {
  it('dados já usados por um modelo mais novo: salvar exercício é bloqueado', async () => {
    localStorage.setItem(CAPABILITIES_KEY, JSON.stringify({ exerciseModel: 99 }));
    const r = modelRoutine();
    await db.routines.put(r);
    const spy = vi.spyOn(repo, 'saveRoutineKeepPointer');
    await render(
      <MemoryRouter initialEntries={[`/treinos/${r.id}/${r.workouts[0].id}`]}>
        <Routes>
          <Route path="/treinos/:routineId/:workoutId" element={<WorkoutEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => byTestId('add-exercise'));
    await click(byTestId('add-exercise'));
    const name = await waitFor(() => $('#ex-name'));
    await setValue(name, 'Novo');
    await click(button('Salvar exercício'));
    expect(spy).not.toHaveBeenCalled();
    expect((await db.routines.get(r.id))!.workouts[0].exercises).toHaveLength(r.workouts[0].exercises.length);
  });
});
