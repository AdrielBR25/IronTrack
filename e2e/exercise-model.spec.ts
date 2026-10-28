import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { freshStart, setValue } from './helpers';

// Modelo de exercícios v3 (P10) de ponta a ponta, em Android 360 px e desktop: criar exercícios por tempo,
// cardio, unilateral e peso corporal assistido no editor; executar o treino (com recarga no meio); conferir
// histórico e Desempenho; exportar e restaurar o backup v3; funcionar offline; sem rolagem horizontal.
// Dados fictícios apenas.

const FICHA = {
  formato: 'irontrack.ficha',
  versao: 1,
  nome: 'Modalidades E2E',
  treinos: [{ rotulo: 'A', nome: 'Treino Modal', exercicios: [{ nome: 'Agachamento', grupo: 'Quadríceps', series: 1, repeticoes: '8', descanso: 0 }] }],
};

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function addExercise(page: Page, f: { name: string; modality: string; sets: string; extra?: (page: Page) => Promise<void> }) {
  await page.getByTestId('add-exercise').click();
  await page.locator('#ex-name').fill(f.name);
  await page.locator('#ex-modality').selectOption(f.modality);
  await page.locator('#ex-sets').fill(f.sets);
  await page.locator('#ex-rest').fill('0');
  if (f.extra) await f.extra(page);
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Salvar exercício' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('modalidades: editor → treino → histórico → Desempenho → backup v3 → offline', async ({ page, context }, info) => {
  test.setTimeout(150_000);
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);

  // Ficha antiga (sem campos novos) continua sendo importada.
  await page.goto('./#/treinos');
  await page.getByTestId('import-ficha-input').setInputFiles({ name: 'ficha.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(FICHA)) });
  await expect(page.getByText('importada e ativada')).toBeVisible();
  // Sob carga (suíte completa) a lista pode re-renderizar entre achar e clicar: repete até abrir o editor.
  await expect(async () => {
    await page.getByRole('button', { name: /Treino Modal/ }).first().click({ timeout: 5_000 });
    await expect(page.getByTestId('add-exercise')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });

  // 1, 3, 5, 7. Criar exercícios por tempo, cardio, unilateral e peso corporal.
  await addExercise(page, {
    name: 'Prancha',
    modality: 'timed',
    sets: '2',
    extra: async (p) => {
      await expect(p.locator('#ex-reps')).toHaveCount(0);
      await p.locator('#ex-duration').fill('30');
      await p.locator('#ex-loadmode').selectOption('corporal');
    },
  });
  await addExercise(page, {
    name: 'Corrida',
    modality: 'cardio',
    sets: '1',
    extra: async (p) => {
      await expect(p.locator('#ex-laterality')).toHaveCount(0);
      await p.locator('#ex-duration').fill('20');
      await p.locator('#ex-distance').fill('3');
      await expect(p.locator('#ex-distance-unit')).toHaveValue('km');
      await p.screenshot({ path: test.info().outputPath('editor-cardio.png') });
    },
  });
  await addExercise(page, {
    name: 'Afundo',
    modality: 'resistance',
    sets: '2',
    extra: async (p) => {
      await p.locator('#ex-laterality').selectOption('unilateral');
      await p.locator('#ex-reps').fill('10');
    },
  });
  await addExercise(page, {
    name: 'Barra assistida',
    modality: 'bodyweight',
    sets: '1',
    extra: async (p) => {
      await p.locator('#ex-loadmode').selectOption('assistida');
      await expect(p.locator('#ex-weight')).toHaveCount(0);
      await p.locator('#ex-reps').fill('8');
    },
  });
  const list = page.getByTestId('editor-exercise');
  await expect(list).toHaveCount(5);
  await expect(list.nth(1)).toContainText('2 × 30 s');
  await expect(list.nth(2)).toContainText('20:00 · 3 km');
  await expect(list.nth(3)).toContainText('unilateral');
  await noHorizontalScroll(page);

  // 2, 4, 6, 8. Executar o treino.
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  const editor = page.getByTestId('set-editor');
  await expect(editor).toContainText('Agachamento');
  await page.getByTestId('complete-set').click();

  await expect(editor).toContainText('Prancha');
  await expect(page.getByTestId('input-duration')).toHaveValue('30');
  await expect(page.getByTestId('input-reps')).toHaveCount(0);
  await setValue(page, 'input-duration', '40');
  await page.getByTestId('complete-set').click();
  await expect(editor).toContainText('Série 2 de 2');
  await setValue(page, 'input-duration', '');
  await expect(page.getByTestId('complete-set')).toBeDisabled();
  await expect(page.getByTestId('set-errors')).toContainText('Informe a duração');
  await setValue(page, 'input-duration', '35');
  await page.getByTestId('complete-set').click();

  await expect(editor).toContainText('Corrida');
  await expect(page.getByTestId('input-duration')).toHaveValue('20');
  await setValue(page, 'input-distance', '3,5');
  await page.getByTestId('complete-set').click();

  await expect(editor).toContainText('Afundo');
  await editor.getByRole('radio', { name: 'Direito' }).click();
  await expect(editor.getByRole('radio', { name: 'Direito' })).toHaveAttribute('aria-checked', 'true');
  await setValue(page, 'input-weight', '16');
  await page.screenshot({ path: info.outputPath('serie-unilateral.png') });
  await page.getByTestId('complete-set').click();
  await noHorizontalScroll(page);

  // Retomar o treino depois de recarregar: dados preservados, lado da próxima série não preenchido.
  await page.reload();
  await expect(editor).toContainText('Afundo');
  await expect(editor).toContainText('Série 2 de 2');
  await expect(editor.getByRole('radio', { name: 'Esquerdo' })).toHaveAttribute('aria-checked', 'false');
  await expect(editor.getByRole('radio', { name: 'Direito' })).toHaveAttribute('aria-checked', 'false');
  await editor.getByRole('radio', { name: 'Esquerdo' }).click();
  await page.getByTestId('complete-set').click();

  await expect(editor).toContainText('Barra assistida');
  await expect(page.getByTestId('input-weight')).toHaveCount(0);
  await setValue(page, 'input-assistance', '20');
  await page.getByTestId('complete-set').click();
  await page.getByTestId('confirm-finish').click();

  // 9. Histórico.
  await expect(page).toHaveURL(/#\/historico\/.+/);
  const detail = page.locator('main');
  for (const t of ['40 s', '35 s', '3,5 km', '20:00', 'Direito', 'Esquerdo', 'Assist.', '20 kg']) await expect(detail).toContainText(t);
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('historico.png'), fullPage: true });

  // 10. Desempenho.
  await page.goto('./#/evolucao/desempenho');
  const select = page.getByTestId('exercise-select');
  await select.selectOption({ label: 'Prancha (1)' });
  await expect(page.getByTestId('timed-metrics')).toContainText('Maior duração');
  await expect(page.getByTestId('timed-metrics')).toContainText('40 s');
  await page.getByTestId('modality-metrics').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('desempenho-tempo.png') });
  await select.selectOption({ label: 'Corrida (1)' });
  await expect(page.getByTestId('cardio-metrics')).toContainText('3,5 km');
  await select.selectOption({ label: 'Afundo (1)' });
  await expect(page.getByTestId('side-metrics')).toContainText('Direito');
  await page.getByTestId('side-metrics').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('desempenho-lados.png') });
  await select.selectOption({ label: 'Barra assistida (1)' });
  await expect(page.getByTestId('bodyweight-metrics')).toContainText('Menor assistência');
  await noHorizontalScroll(page);

  // 11. Exportar backup v3 com os campos novos.
  await page.goto('./#/config');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const file = info.outputPath('backup.json');
  await download.saveAs(file);
  const backup = JSON.parse(readFileSync(file, 'utf8'));
  expect(backup.schemaVersion).toBe(4); // P12: backup v4 (metas); os campos do modelo v3 continuam iguais
  const sets = backup.data.sessions[0].exercises.flatMap((e: { sets: unknown[] }) => e.sets);
  expect(sets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ durationSec: 40 }),
      expect.objectContaining({ distance: 3500 }),
      expect.objectContaining({ side: 'direito' }),
      expect.objectContaining({ assistanceKg: 20 }),
    ]),
  );

  // 12. Apagar o treino e restaurar pelo backup (mesclagem): os campos novos voltam.
  await page.goto('./#/historico');
  await page.getByTestId('history-item').first().click();
  await page.getByRole('button', { name: /Excluir este treino/ }).click();
  await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(page.getByText('Nenhum treino concluído ainda')).toBeVisible();
  await page.goto('./#/config');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Restaurar backup' }).click()]);
  await chooser.setFiles({ name: 'irontrack-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByTestId('merge-summary')).toContainText('1 a adicionar');
  await page.getByTestId('backup-merge').click();
  await expect(page.getByText('Backup mesclado')).toBeVisible();
  await page.goto('./#/historico');
  await page.getByTestId('history-item').first().click();
  await expect(page.locator('main')).toContainText('3,5 km');

  // 13. Offline: histórico e um novo treino por tempo continuam funcionando.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('main')).toContainText('40 s');
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await page.getByTestId('complete-set').click(); // Agachamento
  await expect(editor).toContainText('Prancha');
  await expect(page.getByTestId('input-duration')).toHaveValue('40');
  await page.getByTestId('complete-set').click();
  await expect(editor).toContainText('Série 2 de 2');
  await context.setOffline(false);
});
