import { expect, test, type Page } from '@playwright/test';
import { freshStart, loadSample, setValue } from './helpers';

// Preenchimento série a série pelo último treino, comparação com a mesma série e série em partes
// (docs/SERIES_POR_PARTES.md).

async function completeAndSkipRest(page: Page) {
  await page.getByTestId('complete-set').click();
  const skip = page.getByTestId('rest-skip');
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function finish(page: Page) {
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);
}

test('mesma série do último treino: preenchimento, comparação e série em partes', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  const editor = page.getByTestId('set-editor');

  // 1º treino: 35 → 45 → 50 kg.
  await page.getByTestId('start-workout').click();
  await expect(editor).toContainText('Aquecimento 1');
  await completeAndSkipRest(page);
  for (const [kg, reps] of [
    ['35', '10'],
    ['45', '8'],
    ['50', '6'],
  ]) {
    await setValue(page, 'input-weight', kg);
    await setValue(page, 'input-reps', reps);
    await completeAndSkipRest(page);
  }
  await finish(page);

  // 2º treino do mesmo treino A.
  await page.goto('./#/treinos');
  await page.getByRole('button', { name: 'Opções do treino A' }).first().click();
  await page.getByRole('button', { name: 'Iniciar este treino agora' }).click();
  await expect(page).toHaveURL(/#\/treino$/);
  await expect(editor).toContainText('Aquecimento 1');
  await completeAndSkipRest(page);

  // Série 1 vem com a série 1 do último treino.
  await expect(editor).toContainText('Série 1 de 3');
  await expect(page.getByTestId('input-weight')).toHaveValue('35');
  await expect(page.getByTestId('input-reps')).toHaveValue('10');
  await expect(editor).toContainText('Anterior: 35×10');
  await completeAndSkipRest(page);

  // Concluir a série 1 não copia 35 kg para a série 2: ela continua com 45 × 8.
  await expect(editor).toContainText('Série 2 de 3');
  await expect(page.getByTestId('input-weight')).toHaveValue('45');
  await expect(page.getByTestId('input-reps')).toHaveValue('8');
  await expect(editor).toContainText('Anterior: 45×8');

  // 35 kg na série 1 igual à série 1 da última vez: sem badge de diferença (antes mostrava −15 kg).
  await expect(page.getByTestId('set-weight-delta')).toHaveCount(0);

  // Série 2 em partes: 8 × 45 kg e mais 4 × 50 kg.
  await page.getByTestId('add-segment').click();
  await setValue(page, 'segment-weight', '50');
  await expect(page.getByTestId('complete-set')).toBeDisabled();
  await expect(page.getByTestId('set-errors')).toContainText('Informe as repetições de cada parte.');
  await setValue(page, 'segment-reps', '4');
  await page.screenshot({ path: info.outputPath('serie-em-partes.png') });
  await completeAndSkipRest(page);

  await expect(page.getByTestId('set-row-done').nth(2)).toContainText('45×8 + 50×4');
  await expect(editor).toContainText('Série 3 de 3');
  await expect(page.getByTestId('input-weight')).toHaveValue('50');

  // Série 3 com 52,5: +2,5 kg comparado à série 3 da última vez (50), não à mais pesada nem à primeira.
  await setValue(page, 'input-weight', '52,5');
  await completeAndSkipRest(page);
  // O cartão do exercício concluído recolhe; abre de novo para ver as séries.
  await page.getByRole('button', { name: /Supino reto com barra .* 3\/3/ }).click();
  await expect(page.getByTestId('set-weight-delta')).toHaveCount(1);
  await expect(page.getByTestId('set-weight-delta')).toContainText('+2,5');
  await finish(page);

  // Histórico mostra as partes.
  await expect(page.locator('main')).toContainText('45 kg + 50 kg');
});
