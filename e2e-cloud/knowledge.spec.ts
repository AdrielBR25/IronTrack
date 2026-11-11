// Fase 04: fluxo principal do Conhecimento no navegador. Adicionar um livro, ler com o cronômetro (sobrevive a recarregar
// a página), encerrar informando a página e ver o progresso salvo na conta.
import { expect, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

test('conhecimento: adicionar livro, ler com cronômetro, recarregar e salvar o progresso', async ({ page }) => {
  await signupViaUi(page);
  await page.goto('./#/conhecimento');
  await expect(page.getByTestId('knowledge-page')).toBeVisible({ timeout: 20_000 });

  // 1) biblioteca: adicionar livro
  await page.goto('./#/conhecimento/biblioteca');
  await page.getByTestId('book-add').click();
  await page.getByTestId('book-title').fill('Livro de Teste');
  await page.getByTestId('book-pages').fill('200');
  await page.getByTestId('book-save').click();
  await page.getByTestId('book-card').filter({ hasText: 'Livro de Teste' }).click();
  await expect(page.getByTestId('knowledge-book')).toBeVisible();

  // 2) ler agora: livro já escolhido, cronômetro livre
  await page.getByTestId('book-read').click();
  await expect(page.getByTestId('focus-book')).toHaveValue(/[0-9a-f-]{36}/);
  await page.getByTestId('focus-start').click();
  await expect(page.getByTestId('focus-clock')).toBeVisible();
  await expect(page.getByTestId('focus-title')).toContainText('Livro de Teste');

  // 3) recarregar: a sessão continua (vem do servidor)
  await page.reload();
  await expect(page.getByTestId('focus-clock')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('focus-pause').click();
  await expect(page.getByTestId('focus-resume')).toBeVisible();

  // 4) encerrar informando a página
  await page.getByTestId('focus-finish').click();
  await page.getByTestId('finish-page').fill('20');
  await page.getByTestId('finish-save').click();
  await expect(page.getByTestId('focus-summary')).toContainText('20');

  // 5) progresso salvo na conta
  await page.goto('./#/conhecimento/biblioteca');
  await page.getByTestId('book-card').filter({ hasText: 'Livro de Teste' }).click();
  await expect(page.getByTestId('book-progress')).toContainText('10%');
  await page.reload();
  await expect(page.getByTestId('book-progress')).toContainText('10%', { timeout: 20_000 });
  await expect(page.getByTestId('knowledge-session')).toHaveCount(1);
});
