// Fase 02: fluxo principal da alimentação no navegador. Registrar uma refeição pela busca (TACO), planejar outra
// (planejada NÃO entra no consumo), marcar "Comi" e ver o diário do dia completo, com tudo salvo na conta.
import { expect, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

test('alimentação: registrar, planejar, marcar consumida e completar o diário do dia', async ({ page }) => {
  await signupViaUi(page);
  await page.goto('./#/alimentacao');
  const ring = page.getByTestId('kcal-ring');
  await expect(page.getByTestId('nutrition-page')).toBeVisible({ timeout: 20_000 });
  await expect(ring).toContainText('0');
  await expect(page.getByTestId('diary-status')).toContainText('Registre 2 refeição(ões)');

  // 1) registro rápido: busca no catálogo, quantidade em gramas, total ao vivo
  await page.getByTestId('quick-log').click();
  const editor = page.getByTestId('meal-editor');
  await editor.getByRole('radio', { name: 'Café da manhã' }).click();
  await editor.getByLabel('Buscar alimento').fill('banana prata');
  await editor.getByTestId('food-result').filter({ hasText: 'Banana, prata, crua' }).first().getByRole('button').first().click();
  await editor.getByRole('button', { name: /Revisar 1 alimento/ }).click();
  await editor.getByLabel(/Quantidade de Banana, prata, crua/).fill('200');
  await expect(editor.getByTestId('editor-total')).toContainText('196');
  await editor.getByTestId('save-meal').click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('[data-testid="meal-card"][data-status="consumed"]')).toHaveCount(1);
  await expect(ring).toContainText('196');

  // 2) planejar o almoço: aparece separado e não soma no consumo
  await page.getByTestId('quick-log').click();
  await editor.getByRole('radio', { name: 'Almoço' }).click();
  await editor.getByRole('radio', { name: 'Planejar' }).click();
  await editor.getByLabel('Buscar alimento').fill('arroz cozido');
  await editor.getByTestId('food-result').filter({ hasText: 'Arroz, tipo 1, cozido' }).first().getByRole('button').first().click();
  await editor.getByRole('button', { name: /Revisar 1 alimento/ }).click();
  await editor.getByLabel(/Quantidade de Arroz, tipo 1, cozido/).fill('150');
  await editor.getByTestId('save-meal').click();
  await expect(editor).toHaveCount(0);
  const planned = page.locator('[data-testid="meal-card"][data-status="planned"]');
  await expect(planned).toHaveCount(1);
  await expect(ring).toContainText('196');

  // 3) "Comi": passa a contar no consumo e completa o diário (2 refeições consumidas)
  await planned.getByRole('button', { name: /Marcar .* como consumida/ }).click();
  await expect(page.locator('[data-testid="meal-card"][data-status="consumed"]')).toHaveCount(2);
  await expect(ring).toContainText('388');
  await expect(page.getByTestId('diary-status')).toContainText('Diário do dia registrado');

  // 4) persistido na conta
  await page.reload();
  await expect(page.locator('[data-testid="meal-card"][data-status="consumed"]')).toHaveCount(2, { timeout: 20_000 });
  await expect(ring).toContainText('388');
});
