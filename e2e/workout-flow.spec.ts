import { expect, test } from '@playwright/test';
import { freshStart, loadSample, setValue } from './helpers';
import { readFileSync } from 'node:fs';

test('fluxo completo: ficha → treino → descanso → histórico → backup', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);

  // Iniciar treino (A é o primeiro da rotação)
  await expect(page.getByText(/Treino\s*A/).first()).toBeVisible();
  await page.getByTestId('start-workout').click();
  await expect(page).toHaveURL(/#\/treino$/);
  const editor = page.getByTestId('set-editor');
  await expect(editor).toContainText('Supino reto com barra');
  await expect(editor).toContainText('Aquecimento 1');

  // Teclado numérico no celular
  await expect(page.getByTestId('input-weight')).toHaveAttribute('inputmode', 'decimal');
  await expect(page.getByTestId('input-reps')).toHaveAttribute('inputmode', 'numeric');

  // Área de toque do botão principal
  const box = await page.getByTestId('complete-set').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(48);

  // Aquecimento: concluir → descanso de 60 s
  await page.getByTestId('complete-set').click();
  await expect(page.getByTestId('rest-panel')).toBeVisible();
  await expect(page.getByTestId('rest-remaining')).toHaveText(/^(1:00|0:59)$/);

  await page.getByTestId('rest-skip').click();
  await expect(editor).toContainText('Série 1 de 3');

  // Série 1: peso e reps com os botões e digitação
  await setValue(page, 'input-weight', '52,5');
  await page.getByRole('button', { name: 'Diminuir Repetições' }).click();
  await expect(page.getByTestId('input-reps')).toHaveValue('9');
  await page.getByTestId('complete-set').click();
  await expect(page.getByTestId('rest-remaining')).toHaveText(/^2:(30|29)$/);
  await page.getByTestId('rest-skip').click();
  await expect(editor).toContainText('Série 2 de 3');
  await expect(page.getByTestId('input-weight')).toHaveValue('52,5');

  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();

  // Fechar e reabrir: sessão recuperada
  await page.reload();
  await expect(page.getByTestId('set-editor')).toContainText('Série 3 de 3');
  await expect(page.getByTestId('set-row-done')).toHaveCount(3);

  // Editar / desfazer uma série concluída
  const row = page.getByTestId('set-row-done').nth(2);
  // Rola a lista para a linha ficar acima do painel fixo da série atual.
  await row.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
  await row.click();
  await page.getByTestId('undo-set').click();
  await expect(page.getByTestId('set-row-done')).toHaveCount(2);
  await expect(page.getByTestId('set-editor')).toContainText('Série 2 de 3');
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();

  // Finalizar
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);
  await expect(page.getByText('Supino reto com barra')).toBeVisible();

  // Histórico persiste após recarregar
  await page.goto('./#/historico');
  await page.reload();
  await expect(page.getByTestId('history-item')).toHaveCount(1);

  // Rotação avançou para B
  await page.goto('./#/');
  await expect(page.getByTestId('start-workout')).toBeVisible();
  await expect(page.locator('main')).toContainText(/Treino\s*B|Próximo: Treino B/);

  // Exportar backup
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.app).toBe('irontrack');
  expect(backup.data.sessions).toHaveLength(1);

  // Apagar tudo e restaurar
  await page.getByRole('button', { name: 'Apagar todos os dados' }).click();
  await page.getByRole('button', { name: 'Apagar tudo' }).click();
  await page.goto('./#/historico');
  await expect(page.getByText('Nenhum treino concluído ainda')).toBeVisible();

  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await page.getByTestId('backup-replace').click();
  await page.getByRole('button', { name: 'Substituir', exact: true }).click();
  await page.goto('./#/historico');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await page.goto('./#/');
  await expect(page.locator('main')).toContainText(/Treino\s*B|Próximo: Treino B/);
});

test('cronômetro: contagem correta após tela bloqueada, ajustes e aviso de fim', async ({ page }) => {
  await page.clock.install();
  await freshStart(page);
  await loadSample(page);
  await page.getByTestId('start-workout').click();
  await page.getByTestId('complete-set').click();
  await expect(page.getByTestId('rest-remaining')).toHaveText(/^(1:00|0:59)$/);
  // Simula app em segundo plano: a página fica oculta e o tempo passa sem ticks.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(30_000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByTestId('rest-remaining')).toHaveText(/^0:(30|29)$/);
  await page.getByRole('button', { name: '+15' }).click();
  await expect(page.getByTestId('rest-remaining')).toHaveText(/^0:(45|44)$/);
  await page.getByRole('button', { name: 'Pausar' }).click();
  await page.clock.fastForward(20_000);
  await expect(page.getByTestId('rest-remaining')).toHaveText(/^0:(45|44)$/);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await page.clock.fastForward(46_000);
  await expect(page.getByTestId('rest-panel')).toContainText('Descanso terminado');
  await page.getByTestId('rest-skip').click();
  await expect(page.getByTestId('set-editor')).toContainText('Série 1 de 3');
  // Recarregar durante o descanso mantém a contagem
  await page.getByTestId('complete-set').click();
  await page.clock.fastForward(50_000);
  await page.reload();
  await expect(page.getByTestId('rest-remaining')).toHaveText(/^1:(40|39)$/);
});
