// Telas de desempenho (IronTrack 2.0 F01/P19) no jsdom com banco fictício: vazio, resumo, períodos, detalhe,
// gráfico com teclado e tabela, recordes, comparação, exercícios antigos separados, metas só lidas, histórico,
// biblioteca, backup (formato v7 inalterado), concorrência (atualização ao vivo) e privacidade. Dados fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import PerformancePage from '@/pages/PerformancePage';
import ExercisePerformancePage from '@/pages/ExercisePerformancePage';
import SessionDetailPage from '@/pages/SessionDetailPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createGoal } from '@/db/goals';
import { BACKUP_SCHEMA_VERSION, exportBackup, readSnapshot, restoreBackupReplace } from '@/lib/backup';
import { OWNED_COLLECTIONS } from '@/lib/types';
import type { SessionExercise, SessionSet, WorkoutSession } from '@/lib/types';
import { buildPerformanceIndex, identityPath } from '@/modules/performance';
import { createTrainingAnalytics } from '@/modules/analytics';
import { settings } from './fixtures';
import { fields, refOf } from './goalFixtures';

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
let container: HTMLDivElement;
const DAY = 86_400_000;

const $ = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
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

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => {
    el.click();
  });
}

async function setSelect(el: HTMLElement | null, value: string) {
  if (!(el instanceof HTMLSelectElement)) throw new Error('select ausente');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function mount(path: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/desempenho" element={<PerformancePage />} />
          <Route path="/desempenho/exercicio/:identidade" element={<ExercisePerformancePage />} />
          <Route path="/historico/:id" element={<SessionDetailPage />} />
          <Route path="*" element={<p>outra tela</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

let seq = 0;
const st = (over: Partial<SessionSet> = {}): SessionSet => ({ id: `s${++seq}`, type: 'normal', status: 'done', weight: null, reps: null, ...over });
const bench = (load: number, reps: number, over: Partial<SessionExercise> = {}): SessionExercise => ({
  id: `x${++seq}`,
  exerciseKey: 'supino-reto',
  templateId: 'gr-A-sup',
  name: 'Supino reto',
  muscleGroup: 'Peito',
  category: 'compound',
  equipment: 'barbell',
  repMin: 8,
  repMax: 10,
  restSec: 90,
  plannedSets: 2,
  modality: 'resistance',
  loadMode: 'externa',
  sets: [st({ type: 'warmup', weight: 20, reps: 10 }), st({ weight: load, reps }), st({ weight: load, reps })],
  ...over,
});
function ses(id: string, daysAgo: number, exercises: SessionExercise[], over: Partial<WorkoutSession> = {}): WorkoutSession {
  // Meio-dia local do dia de calendário (hoje − daysAgo): o filtro de período conta dias locais, então um horário
  // relativo ao relógio (agora − Nd − 1h) mudava de dia entre 00:00 e 01:00 e o teste falhava conforme a hora.
  const day = new Date(Date.now() - daysAgo * DAY);
  day.setHours(12, 0, 0, 0);
  const startedAt = Math.min(day.getTime(), Date.now() - 60_000);
  return { id, profileId: db.currentProfileId!, routineId: 'gr', workoutId: 'gr-A', workoutLabel: 'A', workoutName: 'Treino A', status: 'completed', startedAt, finishedAt: startedAt + 3_600_000, exercises, updatedAt: startedAt, ...over };
}

async function seed() {
  await db.sessions.bulkPut([
    ses('s1', 20, [bench(40, 10), bench(30, 12, { templateId: undefined, exerciseKey: 'remada', name: 'Remada antiga', muscleGroup: 'Costas' })]),
    ses('s2', 13, [bench(40, 10)]),
    ses('s3', 6, [bench(42, 10)]),
    ses('s4', 1, [bench(44, 10, { catalogId: 'supino-reto-barra' })]),
    ses('ativa', 0, [bench(90, 10)], { status: 'active' }),
  ]);
}

beforeEach(async () => {
  setDb(new IronTrackDB(`perf-ui-${++n}`));
  await db.open();
  await db.settings.put(settings({ activeRoutineId: 'gr' }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
});

describe('área de desempenho', () => {
  it('sem treinos concluídos: estado vazio claro', async () => {
    await mount('/desempenho');
    await waitFor(() => $('perf-empty'));
    expect(text()).toContain('Conclua seu primeiro treino');
  });

  it('resumo, recordes recentes, exercícios separados (antigo sem vínculo à parte) e visão agregada identificada', async () => {
    await seed();
    await mount('/desempenho?periodo=30d');
    await waitFor(() => $('perf-stat-sessions'));
    expect($('perf-stat-sessions')!.textContent).toContain('4'); // a sessão ativa não conta
    // s3 e s4 superam carga, volume e 1RM com 2+ sessões anteriores: 3 recordes cada.
    expect($('perf-stat-records')!.textContent).toMatch(/Recordes6/);
    const names = $$('perf-exercise', $('perf-tracked')!).map((e) => e.textContent);
    expect(names.some((t) => t?.includes('Supino reto'))).toBe(true);
    expect(names.some((t) => t?.includes('Remada antiga') && t.includes('sem vínculo'))).toBe(true);
    expect($('perf-aggregates')!.textContent).toContain('Visão agregada de instâncias vinculadas a este exercício.');
    expect(text()).not.toMatch(/NaN|Infinity|undefined/);
    // Recorde com sessão de origem.
    expect($('perf-record-session')!.closest('a')!.getAttribute('href')).toBe('/historico/s4');
  });

  it('filtro de período troca o resumo sem recarregar', async () => {
    await seed();
    await mount('/desempenho?periodo=7d');
    await waitFor(() => $('perf-stat-sessions'));
    expect($('perf-stat-sessions')!.textContent).toContain('2');
    await click([...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.includes('Todo o histórico'))!);
    await waitFor(() => $('perf-stat-sessions')?.textContent?.includes('4'));
  });

  it('ocultar observações de estabilidade', async () => {
    await seed();
    await mount('/desempenho');
    await waitFor(() => $('perf-stability-list'));
    await click($('perf-stability-toggle'));
    expect($('perf-stability-list')).toBeNull();
  });

  it('atualiza ao vivo quando uma sessão é concluída ou excluída (outra aba grava no mesmo banco)', async () => {
    await seed();
    await mount('/desempenho?periodo=all');
    await waitFor(() => $('perf-stat-sessions')?.textContent?.includes('4'));
    await act(async () => {
      await db.sessions.update('ativa', { status: 'completed' });
    });
    await waitFor(() => $('perf-stat-sessions')?.textContent?.includes('5'));
    await act(async () => {
      await db.sessions.delete('s4');
      await db.sessions.delete('ativa');
    });
    await waitFor(() => $('perf-stat-sessions')?.textContent?.includes('3'));
  });
});

describe('detalhe por exercício', () => {
  const instance = `${identityPath('i:gr-A-sup')}?periodo=all`;

  it('nome, origem, identidade, gráfico com tabela e teclado, recordes com sessão de origem', async () => {
    await seed();
    await mount(instance);
    await waitFor(() => $('perf-detail-title'));
    expect($('perf-detail-title')!.textContent).toBe('Supino reto');
    expect($('perf-identity-kind')!.textContent).toBe('Instância da ficha');
    expect($('perf-identity')!.textContent).toContain('i:gr-A-sup');
    expect($('perf-chart-table')!.querySelectorAll('tbody tr')).toHaveLength(4);
    const group = $('perf-chart')!.querySelector<HTMLElement>('[role="group"]')!;
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect($('perf-chart-active')!.textContent).toMatch(/44 kg/);
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect($('perf-chart-active')!.textContent).toMatch(/42 kg/);
    const load = $('perf-record-carga_maxima')!;
    expect(load.textContent).toContain('44 kg');
    expect(load.querySelector('a')!.getAttribute('href')).toBe('/historico/s4');
    expect(text()).toContain('epley-1a12-v1');
  });

  it('comparação de duas sessões: diferenças, percentuais e série a série; aquecimento fora', async () => {
    await seed();
    await mount(instance);
    await waitFor(() => $('compare-result'));
    await setSelect($('compare-a'), 's2');
    await setSelect($('compare-b'), 's3');
    expect($('compare-row-carga')!.textContent).toMatch(/\+2 kg/);
    expect($('compare-row-carga')!.textContent).toContain('+5%');
    expect($('compare-summary')!.textContent).toContain('Carga máxima maior');
    expect($$('compare-set-row').map((r) => r.dataset.state)).toEqual(['comparavel', 'comparavel']);
    expect($('compare-sets')!.textContent).toContain('Aquecimentos e drops ficam fora (1 na anterior, 1 na comparada)');
  });

  it('exercício antigo sem origem: identidade histórica, sem visão agregada e sem metas', async () => {
    await seed();
    const idx = buildPerformanceIndex(await db.sessions.toArray());
    const legacy = [...idx.identities.values()].find((h) => h.name === 'Remada antiga')!;
    await mount(`${identityPath(legacy.identity.key)}?periodo=all`);
    await waitFor(() => $('perf-detail-title'));
    expect($('perf-identity-kind')!.textContent).toBe('Histórico sem vínculo');
    expect(text()).toContain('Sem origem registrada');
    expect($('perf-aggregate-links')).toBeNull();
  });

  it('identidade inválida ou sem histórico: estado vazio, sem erro', async () => {
    await mount(`${identityPath('c:nunca-usado')}`);
    await waitFor(() => $('perf-detail-empty'));
    expect(text()).toContain('Sessões antigas não são associadas automaticamente');
    await act(async () => root?.unmount());
    await mount('/desempenho/exercicio/supino%20reto');
    await waitFor(() => $('perf-detail-empty'));
    expect(text()).toContain('Endereço de exercício inválido');
  });

  it('metas relacionadas aparecem só leitura; nada é alterado', async () => {
    await seed();
    const goal = await createGoal('meta-1', fields({ type: 'max_load', title: 'Supino 50', exercise: refOf(['gr-A-sup']), targetValue: 50 }));
    await mount(instance);
    await waitFor(() => $('perf-related-goals'));
    expect($('perf-related-goals')!.textContent).toContain('Supino 50');
    expect(await db.goals.get('meta-1')).toEqual(goal);
  });

  it('histórico: o detalhe da sessão abre o desempenho da identidade daquela cópia', async () => {
    await seed();
    await mount('/historico/s3');
    await waitFor(() => $('session-open-performance'));
    expect($('session-open-performance')!.getAttribute('href')).toBe(`${identityPath('i:gr-A-sup')}?periodo=all&sessao=s3`);
  });
});

describe('persistência, backup e privacidade', () => {
  it('nenhuma tabela nova, backup continua v7 e o desempenho restaurado é idêntico', async () => {
    await seed();
    expect(db.verno).toBe(6);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['calendarDecisions', 'customExercises', 'exerciseFavorites', 'goals', 'overrides', 'photos', 'planEntries', 'profiles', 'rotations', 'routines', 'sessions', 'settings', 'bodyEntries'].sort());
    expect(OWNED_COLLECTIONS).not.toContain('performance');
    const backup = await exportBackup();
    expect(BACKUP_SCHEMA_VERSION).toBe(8);
    expect(backup.schemaVersion).toBe(8);
    expect(Object.keys(backup.data).sort()).toEqual(Object.keys(await readSnapshot()).sort());
    const before = buildPerformanceIndex((await readSnapshot()).sessions, { profileId: db.currentProfileId });
    await db.sessions.clear();
    await restoreBackupReplace(backup);
    const after = buildPerformanceIndex((await readSnapshot()).sessions, { profileId: db.currentProfileId });
    expect([...after.identities.keys()].sort()).toEqual([...before.identities.keys()].sort());
    expect(after.identities.get('i:gr-A-sup')!.records).toEqual(before.identities.get('i:gr-A-sup')!.records);
  });

  it('o analytics legado continua agrupando por nome, como antes (não muda com o desempenho)', async () => {
    await seed();
    const sessions = await db.sessions.where('status').equals('completed').toArray();
    const report = createTrainingAnalytics(sessions).report('all', new Date().toISOString().slice(0, 10));
    expect(report.exercises.map((e) => e.key).sort()).toEqual(['remada', 'supino-reto']);
  });

  it('o módulo e as telas de desempenho não usam rede, armazenamento, IA nem gateway', () => {
    const root = resolve(process.cwd(), 'src');
    const files = [
      ...readdirSync(join(root, 'modules/performance')).map((f) => join(root, 'modules/performance', f)),
      ...readdirSync(join(root, 'features/performance')).map((f) => join(root, 'features/performance', f)),
      join(root, 'pages/PerformancePage.tsx'),
      join(root, 'pages/ExercisePerformancePage.tsx'),
      join(root, 'hooks/usePerformance.ts'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(src, f).not.toMatch(/\b(fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|https?:\/\/)/);
      expect(src, f).not.toMatch(/@\/modules\/ai|@\/integrations|gateway|ContextBuilder/i);
    }
  });
});
