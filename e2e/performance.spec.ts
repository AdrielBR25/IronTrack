import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, setValue } from './helpers';

// Desempenho por exercício (P19): área #/desempenho e detalhe por identidade, em Android 360 px e desktop. Dados
// fictícios carregados pela restauração de backup (mesclar), o mesmo caminho que o usuário usa.

const DAY = 86_400_000;
const CATALOG = 'supino-reto-barra';

const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

async function exportBackup(page: Page, path: string) {
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  await download.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function chooseBackup(page: Page, backup: unknown) {
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
}

type Set = Record<string, unknown>;
const done = (over: Set): Set => ({ type: 'normal', status: 'done', weight: null, reps: null, ...over });

/** Sessões fictícias: supino (instância da ficha de exemplo, com origem só nas duas últimas), outra instância do mesmo
 * item do catálogo no treino B, remada antiga sem vínculo, corrida, prancha e rosca estável. */
function fakeSessions(profileId: string, supinoTpl: string) {
  const now = Date.now();
  let k = 0;
  const ex = (templateId: string | undefined, name: string, sets: Set[], over: Record<string, unknown> = {}) => ({
    id: `e2e-perf-x${++k}`,
    exerciseKey: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    ...(templateId ? { templateId } : {}),
    name,
    muscleGroup: 'Peito',
    category: 'compound',
    equipment: 'barbell',
    repMin: 8,
    repMax: 10,
    restSec: 90,
    plannedSets: sets.length,
    sets: sets.map((s, i) => ({ id: `e2e-perf-s${k}-${i}`, completedAt: now, ...s })),
    ...over,
  });
  const session = (id: string, daysAgo: number, label: 'A' | 'B', exercises: unknown[]) => {
    const startedAt = now - daysAgo * DAY;
    return { id, profileId, routineId: 'e2e-rotina-antiga', workoutId: `e2e-rotina-antiga-${label}`, workoutLabel: label, workoutName: `Treino ${label}`, status: 'completed', startedAt, finishedAt: startedAt + 3_600_000, durationSec: 3600, exercises, updatedAt: startedAt + 3_600_000 };
  };
  const bench = (load: number, linked: boolean, extra: Set[] = []) =>
    ex(supinoTpl, 'Supino reto com barra', [done({ type: 'warmup', weight: 20, reps: 12 }), done({ weight: load, reps: 10 }), done({ weight: load, reps: 10 }), ...extra], {
      modality: 'resistance',
      loadMode: 'externa',
      ...(linked ? { catalogId: CATALOG } : {}),
    });
  const curl = () => ex('e2e-tpl-rosca', 'Rosca direta', [done({ weight: 20, reps: 10 }), done({ weight: 20, reps: 10 })], { muscleGroup: 'Bíceps' });
  const run = (dur: number, dist: number) =>
    ex('e2e-tpl-corrida', 'Corrida', [done({ durationSec: dur, distance: dist })], { modality: 'cardio', equipment: 'other', distanceUnit: 'km', muscleGroup: 'Cardio' });
  const plank = (sec: number) => ex('e2e-tpl-prancha', 'Prancha', [done({ durationSec: sec }), done({ durationSec: sec - 10 })], { modality: 'timed', equipment: 'bodyweight', loadMode: 'corporal', muscleGroup: 'Abdômen' });
  const row = (load: number) => ex(undefined, 'Remada antiga', [done({ weight: load, reps: 10 })], { muscleGroup: 'Costas' });
  return [
    session('e2e-perf-1', 40, 'A', [bench(40, false), curl(), row(30), plank(40)]),
    session('e2e-perf-2', 33, 'A', [bench(40, false), curl(), row(32), run(1800, 5000)]),
    session('e2e-perf-3', 26, 'A', [bench(42, false), curl(), plank(50)]),
    session('e2e-perf-4', 19, 'A', [bench(42, true), curl(), run(1700, 5000)]),
    // Última: uma série incompleta (sem repetições) para a comparação série a série.
    session('e2e-perf-5', 12, 'A', [bench(44, true, [done({ weight: 44, reps: null })]), curl(), plank(60), run(1650, 5000)]),
    session('e2e-perf-6', 5, 'B', [ex('e2e-tpl-supino-b', 'Supino reto com barra', [done({ weight: 60, reps: 5 })], { modality: 'resistance', catalogId: CATALOG })]),
  ];
}

async function seed(page: Page, path: string) {
  const backup = await exportBackup(page, path);
  const supino = backup.data.routines[0].workouts[0].exercises.find((e: { name: string }) => e.name === 'Supino reto com barra');
  backup.data.sessions.push(...fakeSessions(backup.profile.id, supino.id));
  await chooseBackup(page, backup);
  await page.getByTestId('backup-merge').click();
  await expect(page.getByText('Backup mesclado')).toBeVisible();
  return supino.id as string;
}

async function finishOneWorkout(page: Page) {
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toBeVisible();
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).not.toHaveURL(/#\/treino$/);
}

const exerciseLink = (page: Page, name: string, scope = 'perf-tracked') => page.getByTestId(scope).getByTestId('perf-exercise').filter({ hasText: name });

test('desempenho: resumo, períodos, detalhe, gráfico, recordes, comparação, modalidades, biblioteca, histórico e metas', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  const tpl = await seed(page, info.outputPath('backup.json'));

  // Meta ligada ao supino da ficha (criada pela tela de metas); o desempenho só a mostra.
  await page.goto('./#/metas');
  await page.getByTestId('new-goal').click();
  await page.getByTestId('goal-type').selectOption('max_load');
  const option = page.getByTestId('goal-exercise').locator('option', { hasText: 'Supino reto com barra' }).first();
  await page.getByTestId('goal-exercise').selectOption((await option.getAttribute('value'))!);
  await setValue(page, 'goal-target', '50');
  await setValue(page, 'goal-title', 'Supino 50');
  await page.getByTestId('goal-save').click();
  await expect(page.getByTestId('goal-form')).toBeHidden();

  // 1–2. Abrir pela tela Treinos e ver o resumo.
  await page.goto('./#/treinos');
  await page.getByTestId('workouts-open-performance').click();
  await expect(page).toHaveURL(/#\/desempenho$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Desempenho e recordes');
  await expect(page.getByRole('radio', { name: 'Últimos 90 dias' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('perf-stat-sessions')).toContainText('6');
  await expect(page.getByTestId('perf-stat-records')).toContainText(/Recordes\s*[1-9]/);
  // A navegação continua com 6 itens e "Evolução" fica ativa.
  const nav = page.getByRole('navigation', { name: 'Principal' }).locator('visible=true');
  await expect(nav.getByRole('link')).toHaveCount(6);
  await expect(nav.getByRole('link', { name: 'Evolução' })).toHaveClass(/text-primary/);
  await noHorizontalScroll(page);

  // 3. Filtrar período (pelo teclado, sem recarregar).
  const radio7 = page.getByRole('radio', { name: 'Últimos 7 dias' });
  await radio7.focus();
  await page.keyboard.press('Enter');
  await expect(radio7).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('perf-stat-sessions')).toContainText('1');
  await page.getByRole('radio', { name: 'Todo o histórico' }).click();
  await expect(page.getByTestId('perf-stat-sessions')).toContainText('6');
  await expect(page.locator('body')).not.toContainText(/NaN|Infinity|undefined/);
  await noHorizontalScroll(page);

  // 14. Instâncias separadas: o supino do treino A e o do treino B são linhas diferentes; a visão agregada é identificada.
  await expect(exerciseLink(page, 'Supino reto com barra')).toHaveCount(2);
  await expect(page.getByTestId('perf-aggregates')).toContainText('Visão agregada de instâncias vinculadas a este exercício.');
  // 18. Estabilidade (opcional, pode ser ocultada).
  await expect(page.getByTestId('perf-stability-list')).toContainText('Rosca direta');
  await page.getByTestId('perf-stability-toggle').click();
  await expect(page.getByTestId('perf-stability-list')).toHaveCount(0);
  await page.getByTestId('perf-stability-toggle').click();

  // 4. Abrir o exercício (rota com a identidade codificada, sem o nome).
  await exerciseLink(page, 'Supino reto com barra').filter({ hasText: 'Treino A' }).click();
  await expect(page).toHaveURL(new RegExp(`#/desempenho/exercicio/i%3A${tpl}\\?periodo=all$`));
  await expect(page.getByTestId('perf-detail-title')).toHaveText('Supino reto com barra');
  await expect(page.getByTestId('perf-identity-kind')).toHaveText('Instância da ficha');

  // 5–7. Métrica, gráfico e alternativa textual.
  await page.getByRole('radio', { name: '1RM estimado' }).click();
  const chart = page.getByTestId('perf-chart');
  await expect(chart.locator('svg.recharts-surface')).toBeVisible();
  await expect(page.getByTestId('perf-evolution')).toContainText('epley-1a12-v1');
  await page.getByRole('radio', { name: 'Carga máxima' }).click();
  await chart.getByRole('group', { name: /^Gráfico:/ }).focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('perf-chart-active')).toContainText('44 kg');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('perf-chart-active')).toContainText('42 kg');
  await page.getByTestId('perf-chart-table').locator('summary').click();
  await expect(page.getByTestId('perf-chart-table').locator('tbody tr')).toHaveCount(5);
  await noHorizontalScroll(page);

  // 8–9. Recorde e sessão de origem (aquecimento de 20 kg nunca vira recorde).
  const record = page.getByTestId('perf-record-carga_maxima');
  await expect(record).toContainText('44 kg');
  await record.getByRole('link', { name: 'Abrir sessão de origem' }).click();
  await expect(page).toHaveURL(/#\/historico\/e2e-perf-5$/);
  await page.goBack();
  await expect(page.getByTestId('perf-detail-title')).toBeVisible();

  // 10–12. Comparar duas sessões; diferenças; dados ausentes (série incompleta e série ausente).
  await page.getByTestId('compare-a').selectOption('e2e-perf-3');
  await page.getByTestId('compare-b').selectOption('e2e-perf-5');
  await expect(page.getByTestId('compare-row-carga')).toContainText('+2 kg');
  await expect(page.getByTestId('compare-row-carga')).toContainText('+4,8%');
  await expect(page.getByTestId('compare-summary')).toContainText('Carga máxima maior');
  await expect(page.getByTestId('compare-set-row')).toHaveCount(3);
  await expect(page.getByTestId('compare-set-row').nth(2)).toHaveAttribute('data-state', 'ausente_a');
  await expect(page.getByTestId('compare-set-row').nth(2)).toContainText('ausente');
  await noHorizontalScroll(page);

  // 17. Observações com critério; 21. metas relacionadas (só leitura).
  await expect(page.getByTestId('perf-note').first()).toContainText('Critério');
  await expect(page.getByTestId('perf-related-goals')).toContainText('Supino 50');

  // 13. Exercício antigo sem origem: separado, identificado como histórico sem vínculo.
  await page.goto('./#/desempenho?periodo=all');
  await exerciseLink(page, 'Remada antiga').click();
  await expect(page.getByTestId('perf-identity-kind')).toHaveText('Histórico sem vínculo');
  await expect(page.locator('main')).toContainText('Sem origem registrada');

  // 15. Cardio: distância, duração e ritmo.
  await page.goto('./#/desempenho?periodo=all');
  await exerciseLink(page, 'Corrida').click();
  await expect(page.getByRole('radio', { name: 'Distância' })).toBeVisible();
  await page.getByRole('radio', { name: 'Ritmo' }).click();
  await expect(page.getByTestId('perf-chart')).toContainText('min');
  await expect(page.getByTestId('perf-detail-records')).toContainText('Melhor ritmo');
  await noHorizontalScroll(page);

  // 16. Duração (exercício por tempo).
  await page.goto('./#/desempenho?periodo=all');
  await exerciseLink(page, 'Prancha').click();
  await expect(page.getByTestId('perf-record-duracao')).toContainText('1:00');

  // 19. Abrir pela biblioteca (visão agregada do item do catálogo).
  await page.goto('./#/exercicios');
  await page.getByTestId('library-search').fill('supino reto com barra');
  await page.getByTestId('library-item').filter({ has: page.getByText('Supino reto com barra', { exact: true }) }).first().getByText('Supino reto com barra', { exact: true }).click();
  const detail = page.getByTestId('exercise-detail');
  await expect(detail.getByTestId('detail-performance')).toBeVisible();
  await detail.getByTestId('detail-performance-recordes').click();
  await expect(page).toHaveURL(new RegExp(`#/desempenho/exercicio/c%3A${CATALOG}\\?periodo=all&ver=recordes$`));
  await expect(page.getByTestId('perf-aggregate-notice')).toHaveText('Visão agregada de instâncias vinculadas a este exercício.');
  await page.getByTestId('perf-identity').locator('summary').click();
  await expect(page.getByTestId('perf-members').getByRole('link')).toHaveCount(2);

  // 20. Abrir pelo histórico.
  await page.goto('./#/historico');
  await page.getByTestId('history-open-performance').click();
  await expect(page).toHaveURL(/#\/desempenho$/);
  await page.goto('./#/historico/e2e-perf-4');
  await page.getByTestId('session-open-performance').first().click();
  await expect(page.getByTestId('perf-detail-title')).toHaveText('Supino reto com barra');

  // Metas intactas (nada foi alterado pelo desempenho).
  await page.goto('./#/metas');
  await expect(page.getByTestId('goal-card').filter({ hasText: 'Supino 50' })).toBeVisible();
  await noHorizontalScroll(page);
});

test('desempenho: outra aba conclui treino, backup e restauração, offline', async ({ page, context }, info) => {
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await loadSample(page);
  await seed(page, info.outputPath('seed.json'));

  // 22–23. Uma aba mostra os gráficos enquanto a outra conclui um treino.
  const other = await context.newPage();
  await other.goto('./#/desempenho?periodo=7d');
  await expect(other.getByTestId('perf-stat-sessions')).toContainText('1');
  await finishOneWorkout(page);
  await expect(other.getByTestId('perf-stat-sessions')).toContainText('2');
  await other.close();

  // 24–26. Exportar, substituir pelo backup e conferir o desempenho restaurado.
  const backup = await exportBackup(page, info.outputPath('backup.json'));
  expect(backup.schemaVersion).toBe(8);
  await page.goto('./#/desempenho?periodo=all');
  await expect(page.getByTestId('perf-stat-sessions')).toContainText('7');
  await chooseBackup(page, backup);
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await expect(page.getByText('Backup restaurado')).toBeVisible();
  await page.goto('./#/desempenho?periodo=all');
  await expect(page.getByTestId('perf-stat-sessions')).toContainText('7');
  await exerciseLink(page, 'Rosca direta').click();
  await expect(page.getByTestId('perf-record-carga_maxima')).toContainText('20 kg');

  // 27. Offline: a área continua funcionando só com os dados locais.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('perf-detail-title')).toHaveText('Rosca direta');
  await page.goto('./#/desempenho?periodo=all');
  await expect(page.getByTestId('perf-stat-sessions')).toContainText('7');
  // 28. Sem rolagem horizontal.
  await noHorizontalScroll(page);
  await context.setOffline(false);
});
