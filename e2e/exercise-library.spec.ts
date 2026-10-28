import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, loadSample } from './helpers';

// Biblioteca de exercícios e construtor de fichas (IronTrack 2.0 F01/P17), no Android 360 px e no desktop:
// biblioteca pela tela de Treinos → busca com e sem acento → filtros → favorito → exercício personalizado → adicionar
// à ficha (com configuração) → reordenar sem arrastar → duplicar → substituir com prévia → prévia da ficha → iniciar o
// treino → backup v7 → duas abas → offline → arquivar sem afetar a ficha. Dados fictícios.

const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
const item = (page: Page, name: string) => page.getByTestId('library-item').filter({ has: page.getByText(name, { exact: true }) });
const count = (page: Page) => page.getByTestId('library-count');
const CUSTOM = 'Remada máquina articulada E2E';

async function search(page: Page, q: string) {
  await page.getByTestId('library-search').fill(q);
}

/** No celular os filtros ficam recolhidos atrás de um botão; no desktop ficam sempre à vista. */
async function filters(page: Page) {
  const panel = page.getByTestId('library-filters');
  if (!(await panel.isVisible())) await page.getByTestId('toggle-filters').click();
  await expect(panel).toBeVisible();
  return panel;
}

async function openWorkoutA(page: Page) {
  await page.goto('./#/treinos');
  await page.getByRole('button', { name: /Peito, ombros e tríceps/ }).first().click();
  await expect(page).toHaveURL(/#\/treinos\/[^/]+\/[^/]+$/);
  await expect(page.getByTestId('add-from-library')).toBeVisible();
}

const editorNames = (page: Page) => page.getByTestId('editor-exercise').locator('.truncate.font-semibold').allTextContents();

test('biblioteca: buscar, filtrar, favoritar, criar, montar a ficha, substituir, prévia, treino, backup, abas e offline', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  // 1. Perfil e ficha de exemplo.
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await loadSample(page);

  // 2. Biblioteca pela tela de Treinos (sem novo item de navegação).
  await page.goto('./#/treinos');
  await page.getByTestId('open-library').click();
  await expect(page).toHaveURL(/#\/exercicios$/);
  await expect(count(page)).toHaveText(/^5\d exercícios$/);
  const total = (await count(page).textContent())!.trim();
  await noHorizontalScroll(page);

  // 3. Busca tolerante a acentos e por apelido.
  await search(page, 'eliptico');
  await expect(count(page)).toHaveText('1 exercício');
  await expect(item(page, 'Elíptico')).toBeVisible();
  await search(page, 'TRÍCEPS polia');
  await expect(item(page, 'Tríceps na polia')).toBeVisible();
  await search(page, 'pulldown');
  await expect(item(page, 'Puxada frontal')).toBeVisible();
  await search(page, 'xyzinexistente');
  await expect(page.getByTestId('library-empty')).toContainText('Nenhum exercício encontrado');
  await search(page, '');
  await expect(count(page)).toHaveText(total);

  // 4. Filtros combinados e limpar.
  let panel = await filters(page);
  await panel.getByRole('button', { name: 'Tríceps', exact: true }).click();
  await panel.getByRole('button', { name: 'Polia', exact: true }).click();
  await expect(count(page)).toHaveText('1 exercício');
  await expect(item(page, 'Tríceps na polia')).toBeVisible();
  await noHorizontalScroll(page);
  await panel.getByTestId('clear-filters').click();
  await expect(count(page)).toHaveText(total);

  // 5. Favorito (persistido por perfil).
  await search(page, 'leg press');
  await item(page, 'Leg press').getByRole('button', { name: 'Favoritar Leg press' }).click();
  await expect(item(page, 'Leg press').getByRole('button', { name: 'Remover Leg press dos favoritos' })).toBeVisible();
  await search(page, '');
  await page.getByRole('radio', { name: 'Favoritos' }).click();
  await expect(count(page)).toHaveText('1 exercício');

  // 6. Exercício personalizado: HTML recusado, depois salvo.
  await page.getByTestId('create-custom').click();
  const dlg = page.getByTestId('custom-exercise-dialog');
  await dlg.locator('#cx-name').fill('<b>x</b>');
  await dlg.getByTestId('custom-save').click();
  await expect(dlg).toContainText(/HTML/);
  await dlg.locator('#cx-name').fill(CUSTOM);
  await dlg.locator('#cx-primary').selectOption('costas');
  await dlg.getByRole('button', { name: '✓ Halteres' }).click();
  await dlg.getByRole('button', { name: 'Máquina', exact: true }).click();
  await noHorizontalScroll(page);
  await dlg.getByTestId('custom-save').click();
  const detail = page.getByTestId('exercise-detail');
  await expect(detail).toContainText(CUSTOM);
  await expect(detail.getByTestId('detail-delete')).toBeVisible(); // ainda sem uso
  await page.keyboard.press('Escape');
  await expect(item(page, CUSTOM)).toBeVisible();

  // 7–9. Ficha: adicionar da biblioteca com configuração própria (nova instância com origem).
  await openWorkoutA(page);
  expect(await editorNames(page)).toHaveLength(5);
  await page.getByTestId('add-from-library').click();
  await expect(page.getByTestId('library-destination')).toContainText('Treino A');
  await search(page, 'leg press');
  await item(page, 'Leg press').getByTestId('library-choose').click();
  await expect(page.getByTestId('add-config-header')).toContainText('Leg press');
  await expect(page.locator('#ex-name')).toHaveValue('Leg press');
  await page.locator('#ex-sets').fill('4');
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Adicionar à ficha' }).click();
  await expect(page.getByTestId('add-from-library')).toBeVisible();
  // O personalizado também entra.
  await page.getByTestId('add-from-library').click();
  await search(page, 'E2E');
  await item(page, CUSTOM).getByTestId('library-choose').click();
  await page.getByRole('button', { name: 'Adicionar à ficha' }).click();
  await expect(page.getByTestId('add-from-library')).toBeVisible();
  expect(await editorNames(page)).toEqual(expect.arrayContaining(['Leg press', CUSTOM]));

  // 10. Reordenar sem arrastar (botões) e 11. duplicar.
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Mover Leg press para cima' }).first().click();
  await expect(page.getByTestId('editor-exercise').first()).toContainText('Leg press');
  await expect(page.getByRole('button', { name: 'Mover Leg press para cima' }).first()).toBeDisabled();
  await page.getByRole('button', { name: 'Mais ações para Elevação lateral' }).click();
  await page.getByRole('button', { name: 'Duplicar' }).click();
  await expect(page.getByTestId('editor-exercise')).toHaveCount(8);

  // 12. Substituir com prévia: sugestões com motivo; nova identidade; histórico e metas não são redirecionados.
  await page.getByRole('button', { name: 'Mais ações para Tríceps na polia (corda)' }).click();
  await page.getByRole('button', { name: /Substituir por outro da biblioteca/ }).click();
  await expect(page.getByTestId('library-destination')).toContainText('Tríceps na polia (corda)');
  await expect(page.getByTestId('library-suggestions')).toContainText('Mesmo grupo muscular.');
  await search(page, 'tríceps testa');
  await item(page, 'Tríceps testa').getByTestId('library-choose').click();
  const sub = page.getByTestId('substitute-dialog');
  await expect(sub).toContainText('Tríceps testa');
  await expect(sub).toContainText(/histórico/i);
  await sub.getByTestId('substitute-confirm').click();
  await expect(page.getByTestId('add-from-library')).toBeVisible();
  const names = await editorNames(page);
  expect(names).toContain('Tríceps testa');
  expect(names).not.toContain('Tríceps na polia (corda)');
  await noHorizontalScroll(page);

  // 13. Prévia antes de iniciar → iniciar o treino com a ficha nova.
  await page.getByTestId('open-preview').click();
  const preview = page.getByTestId('workout-preview');
  await expect(preview.getByTestId('preview-exercise')).toHaveCount(8);
  await expect(preview.getByTestId('preview-exercise').first()).toContainText('Leg press');
  await expect(preview.getByTestId('preview-exercise').first()).toContainText(/4 ×/);
  await noHorizontalScroll(page);
  await preview.getByTestId('preview-start').click();
  await expect(page).toHaveURL(/#\/treino$/);
  await expect(page.getByTestId('set-editor')).toContainText('Leg press');

  // 14. Backup v7: personalizados, favoritos e origem na ficha e na sessão.
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup-biblioteca.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.schemaVersion).toBe(7);
  expect(backup.data.customExercises.map((c: { name: string }) => c.name)).toEqual([CUSTOM]);
  expect(backup.data.exerciseFavorites.map((f: { target: string }) => f.target)).toEqual(['catalog:leg-press']);
  const exA = backup.data.routines[0].workouts[0].exercises;
  expect(exA[0]).toMatchObject({ name: 'Leg press', catalogId: 'leg-press', catalogVersion: 1, sets: 4 });
  expect(exA.find((e: { name: string }) => e.name === CUSTOM).customExerciseId).toMatch(/^cx_/);
  expect(backup.data.sessions[0].exercises[0]).toMatchObject({ name: 'Leg press', catalogId: 'leg-press' });

  // 15. Duas abas: favorito marcado na outra aba aparece sozinho.
  await page.goto('./#/exercicios');
  await search(page, 'stiff');
  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByTestId('library-search').fill('stiff');
  await other.getByRole('button', { name: 'Favoritar Stiff' }).click();
  await expect(item(page, 'Stiff').getByRole('button', { name: 'Remover Stiff dos favoritos' })).toBeVisible();
  await other.close();

  // 16. Offline: a biblioteca (catálogo local) abre sem rede.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(count(page)).toHaveText(/exercícios?$/);
  await search(page, 'supino');
  await expect(item(page, 'Supino reto com barra')).toBeVisible();
  await context.setOffline(false);

  // 17. Arquivar o personalizado (em uso: excluir não é oferecido); a ficha continua com ele.
  await search(page, '');
  await page.getByRole('radio', { name: 'Meus' }).click();
  await item(page, CUSTOM).locator('button').first().click();
  await expect(page.getByTestId('exercise-detail')).toContainText(/ficha/);
  await expect(page.getByTestId('detail-delete')).toHaveCount(0);
  await page.getByTestId('detail-archive').click();
  await expect(page.getByTestId('detail-restore')).toBeVisible();
  await page.keyboard.press('Escape');
  await openWorkoutA(page);
  expect(await editorNames(page)).toContain(CUSTOM);
  await noHorizontalScroll(page);
});
