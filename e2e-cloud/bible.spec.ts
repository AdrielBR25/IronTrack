// Fase 05: fluxo principal da Bíblia no celular. Passagem do dia estável ao recarregar, ler um capítulo real,
// favoritar um versículo, marcar como lido, começar um plano e concluir o dia pelo leitor, e escrever uma reflexão.
// O texto vem dos arquivos da tradução (BPM, domínio público) empacotados com o app.
import { expect, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

test('bíblia: passagem do dia, leitor, favorito, plano e diário', async ({ page }) => {
  await signupViaUi(page);
  await page.goto('./#/biblia');
  await expect(page.getByTestId('bible-page')).toBeVisible({ timeout: 20_000 });

  // 1) passagem do dia: referência e tradução visíveis; a mesma depois de recarregar
  const ref = page.getByTestId('bible-verse-ref');
  await expect(ref).toHaveText(/\d+:\d+/);
  const first = await ref.textContent();
  await expect(page.getByTestId('bible-verse')).toContainText('BPM');
  await page.reload();
  await expect(page.getByTestId('bible-verse-ref')).toHaveText(first!, { timeout: 20_000 });

  // 2) leitor: Salmo 23 com texto real e versículos numerados
  await page.goto('./#/biblia/ler?ref=PSA.23');
  await expect(page.getByTestId('bible-text')).toContainText('O SENHOR é o meu pastor', { timeout: 20_000 });
  await expect(page.getByTestId('bible-reader-title')).toContainText('Salmos 23');

  // 3) favoritar o versículo 1
  await page.getByTestId('bible-v-1').click();
  await expect(page.getByTestId('bible-actions')).toContainText('Salmos 23:1');
  await page.getByTestId('bible-act-fav').click();
  await expect(page.getByTestId('bible-actions')).toBeHidden();

  // 4) marcar como lido e ir ao próximo capítulo
  await page.getByTestId('bible-mark-read').click();
  await expect(page.getByTestId('bible-mark-read')).toHaveText(/Lido/);
  await page.getByTestId('bible-next').click();
  await expect(page.getByTestId('bible-reader-title')).toContainText('Salmos 24');

  // 5) favoritos guardados na conta
  await page.goto('./#/biblia/favoritos');
  await expect(page.getByTestId('bible-mark-row')).toContainText('Salmos 23:1', { timeout: 20_000 });

  // 6) plano de Provérbios: começar, ler pelo plano e concluir o dia 1
  await page.goto('./#/biblia/planos');
  await page.getByTestId('bible-template-proverbs').click();
  await page.getByTestId('bible-plan-create').click();
  await expect(page.getByTestId('bible-plan')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('bible-plan-read').click();
  await expect(page.getByTestId('bible-plan-banner')).toContainText('Provérbios 1');
  await expect(page.getByTestId('bible-text')).toContainText('provérbios de Salomão', { timeout: 20_000 });
  await page.getByTestId('bible-plan-day-done').click();
  await expect(page.getByTestId('bible-plan-banner')).toContainText('Dia concluído');
  await page.goto('./#/biblia/planos');
  await expect(page.getByTestId('bible-plan-row').first()).toContainText('1/31 dias');

  // 7) diário: reflexão privada
  await page.goto('./#/biblia/diario');
  await page.getByTestId('bible-journal-new').click();
  await page.getByTestId('bible-journal-text').fill('Grato pelo dia de hoje.');
  await page.getByTestId('bible-journal-save').click();
  await expect(page.getByTestId('bible-reflection-row')).toContainText('Grato pelo dia de hoje.');

  // 8) Início: o cartão da Bíblia mostra a leitura e o plano
  await page.goto('./#/');
  await expect(page.getByTestId('home-bible')).toBeVisible({ timeout: 20_000 });
});
