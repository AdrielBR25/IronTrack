import { expect, test } from '@playwright/test';
import { freshStart, loadSample } from './helpers';

test('ficha inválida mostra erros claros', async ({ page }) => {
  await page.goto('./#/treinos');
  const bad = JSON.stringify({ formato: 'irontrack.ficha', versao: 1, nome: 'X', treinos: [{ rotulo: 'A', nome: 'T', exercicios: [{ nome: 'Supino', grupo: 'Peito', series: 0, repeticoes: '12-8' }] }] });
  await page.getByTestId('import-ficha-input').setInputFiles({ name: 'ficha.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
  const errs = page.getByTestId('import-errors');
  await expect(errs).toContainText('Treino 1 › Exercício 1 › series');
  await expect(errs).toContainText('faixa de repetições inválida');
});

test('sem rolagem horizontal em telas pequenas', async ({ page }) => {
  await freshStart(page);
  await loadSample(page);
  for (const path of ['#/', '#/treinos', '#/historico', '#/evolucao', '#/config']) {
    await page.goto(`./${path}`);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `overflow em ${path}`).toBeLessThanOrEqual(0);
  }
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('rotação: pular e reagendar pela agenda', async ({ page }) => {
  await freshStart(page);
  await loadSample(page);
  await page.goto('./#/treinos');
  const next = page.getByLabel('Corrigir próximo treino da sequência');
  await expect(next.locator('option:checked')).toContainText('Treino A');
  await page.getByRole('button', { name: 'Pular' }).click();
  await expect(next.locator('option:checked')).toContainText('Treino B');
  await next.selectOption({ label: 'Treino C · Pernas e abdômen' });
  await expect(next.locator('option:checked')).toContainText('Treino C');
  await expect(page.getByTestId('agenda').locator('button')).toHaveCount(14);
});
