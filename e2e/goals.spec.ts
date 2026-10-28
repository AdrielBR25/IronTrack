import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample, setValue } from './helpers';

// Metas de treinamento (IronTrack 2.0 F01/P12), no Android 360 px e no desktop: perfil → ficha → meta → treino →
// progresso → meta atingida → conquista → backup → restauração → offline → duas abas. Dados fictícios.

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const goalCard = (page: Page, title: string) => page.getByTestId('goal-card').filter({ has: page.getByTestId('goal-title-text').getByText(title, { exact: true }) });

async function createLoadGoal(page: Page, target: string, title: string) {
  await page.getByTestId('new-goal').click();
  await expect(page.getByTestId('goal-form')).toBeVisible();
  await page.getByTestId('goal-type').selectOption('max_load');
  const option = page.getByTestId('goal-exercise').locator('option', { hasText: 'Supino reto com barra' }).first();
  await page.getByTestId('goal-exercise').selectOption((await option.getAttribute('value'))!);
  await expect(page.getByTestId('goal-target-unit')).toHaveText('kg');
  await setValue(page, 'goal-target', target);
  await setValue(page, 'goal-title', title);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId('goal-save').click();
  await expect(page.getByTestId('goal-form')).toBeHidden();
}

async function createWeeklyGoal(page: Page) {
  await page.getByTestId('new-goal').click();
  await page.getByTestId('goal-type').selectOption('weekly_frequency');
  await expect(page.getByTestId('goal-target-unit')).toContainText('sess');
  await setValue(page, 'goal-target', '0');
  await expect(page.getByTestId('goal-form')).toContainText(/entre 1 e 14|maior que zero/i);
  await setValue(page, 'goal-target', '1');
  await setValue(page, 'goal-title', 'Treinar 1x por semana');
  await page.getByTestId('goal-save').click();
  await expect(page.getByTestId('goal-form')).toBeHidden();
}

/** Conclui o aquecimento e uma série com a carga informada, e finaliza o treino. */
async function quickWorkout(page: Page, weight: string) {
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toContainText('Supino reto com barra');
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await expect(page.getByTestId('set-editor')).toContainText('Série 1 de 3');
  await setValue(page, 'input-weight', weight);
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);
}

test('metas: criar, treinar, atingir, conquista, backup, restauração, offline e duas abas', async ({ page, context }, info) => {
  // 1. Perfil local (criado na primeira abertura) e 2. ficha de exemplo.
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto('./#/config');
  const name = page.getByTestId('profile-name');
  await name.fill('Perfil de metas');
  await name.blur();
  await page.goto('./#/');
  await loadSample(page);

  // 3. Metas: pela tela de Evolução, sem novo item de navegação.
  await page.goto('./#/evolucao');
  await page.getByTestId('open-goals').click();
  await expect(page).toHaveURL(/#\/metas$/);
  await expect(page.getByTestId('goals-page')).toContainText('Nenhuma meta ainda');
  await createLoadGoal(page, '50', 'Supino 50 kg');
  await createWeeklyGoal(page);
  const load = goalCard(page, 'Supino 50 kg');
  await expect(load).toHaveAttribute('data-state', 'ativa');
  await expect(load.getByTestId('goal-no-data')).toBeVisible();
  await expect(goalCard(page, 'Treinar 1x por semana').getByTestId('goal-progress-text')).toContainText('0 de 1 sessões nesta semana');
  expect(await noHorizontalScroll(page)).toBe(true);

  // 4–5. Treino concluído com 52,5 kg; 6–7. progresso atualizado e meta atingida com evidência.
  await quickWorkout(page, '52,5');
  await page.goto('./#/metas');
  await expect(load).toHaveAttribute('data-state', 'atingida');
  await expect(load.getByTestId('goal-evidence')).toContainText('52,5');
  await expect(goalCard(page, 'Treinar 1x por semana').getByTestId('goal-week-met')).toContainText('Cumprida nesta semana');
  await expect(load.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

  // 8. Conquistas locais, sem pontuação.
  const achievements = page.getByTestId('achievements');
  await expect(achievements.getByTestId('achievement').filter({ hasText: 'Primeira meta atingida' })).toBeVisible();
  await expect(achievements.locator('[data-kind="frequencia_semanal"]')).toBeVisible();
  await expect(achievements).toContainText('Sem pontuação');
  expect(await noHorizontalScroll(page)).toBe(true);

  // Linha da meta na análise do exercício (mesmos dados, sem recálculo à parte).
  await page.goto('./#/evolucao/desempenho');
  await expect(page.getByTestId('related-goals').first()).toBeVisible();

  // 9. Exportar backup (v4, com as metas).
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup-metas.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.schemaVersion).toBe(6); // P13: v5 (planejamento); P16: v6 (decisões); metas continuam iguais
  expect(backup.data.goals).toHaveLength(2);

  // 10. Apagar tudo e restaurar; 11. metas de volta, ainda atingidas.
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await page.goto('./#/metas');
  await expect(page.getByTestId('goals-page')).toContainText('Nenhuma meta ainda');
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await expect(page.getByTestId('restore-preview')).toContainText('Metas');
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await page.goto('./#/metas');
  await expect(goalCard(page, 'Supino 50 kg')).toHaveAttribute('data-state', 'atingida');
  await expect(page.getByTestId('goal-card')).toHaveCount(2);

  // 12. Offline: a tela de metas abre e calcula tudo no aparelho.
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(goalCard(page, 'Supino 50 kg')).toHaveAttribute('data-state', 'atingida');
  await context.setOffline(false);

  // 13. Duas abas: edição aberta numa aba enquanto a outra pausa a meta → nada é sobrescrito em silêncio.
  const other = await context.newPage();
  await other.goto(page.url());
  const weeklyA = goalCard(page, 'Treinar 1x por semana');
  await weeklyA.getByTestId('goal-edit').click();
  await expect(page.getByTestId('goal-form')).toBeVisible();
  await goalCard(other, 'Treinar 1x por semana').getByTestId('goal-pause').click();
  await expect(goalCard(other, 'Treinar 1x por semana')).toHaveAttribute('data-state', 'pausada');
  await expect(page.getByTestId('goal-changed-elsewhere')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  await expect(goalCard(page, 'Treinar 1x por semana')).toHaveAttribute('data-state', 'pausada');
  // Arquivar na outra aba atualiza esta aba sozinha.
  await goalCard(other, 'Supino 50 kg').getByTestId('goal-archive').click();
  await expect(page.getByTestId('toggle-archived')).toContainText('Arquivadas (1)');
  await other.close();

  // 14. Sem rolagem horizontal.
  await page.getByTestId('toggle-archived').click();
  expect(await noHorizontalScroll(page)).toBe(true);
});
