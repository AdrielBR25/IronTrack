import { expect, test, type Page } from '@playwright/test';
import { freshStart, loadSample } from './helpers';

// Assistente IA (IronTrack 2.0 F01/P05): só o provedor simulado, dados fictícios do app de exemplo.

async function finishOneWorkout(page: Page) {
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toBeVisible();
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await expect(page).toHaveURL(/#\/historico\/.+/);
}

async function openAssistant(page: Page) {
  await page.getByRole('link', { name: 'Assistente IA' }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Assistente IA' })).toBeVisible();
}

async function selectData(page: Page, ...cats: string[]) {
  const selector = page.getByTestId('data-selector');
  if (!(await selector.evaluate((d) => (d as HTMLDetailsElement).open))) await selector.locator('summary').click();
  for (const c of cats) await page.getByTestId(`cat-${c}`).check();
}

async function ask(page: Page, text: string) {
  await page.getByLabel('Sua pergunta').fill(text);
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('share-preview')).toBeVisible();
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Registra pedidos para fora da origem do app (não deve haver nenhum). */
function watchExternalRequests(page: Page, base: string) {
  const origin = new URL(base).origin;
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url());
  });
  return external;
}

test('assistente: navegação, modo simulado e estado inicial', async ({ page }, info) => {
  await freshStart(page);
  await openAssistant(page);
  await expect(page).toHaveURL(/#\/assistente$/);
  await expect(page.getByTestId('demo-banner')).toContainText('Modo de demonstração — respostas simuladas');
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await expect(page.getByTestId('data-indicator')).toContainText('Nenhum dado selecionado');
  await page.getByTestId('data-selector').locator('summary').click();
  for (const c of ['training_summary', 'training_history', 'body_measurements', 'body_evolution', 'profile_preferences']) await expect(page.getByTestId(`cat-${c}`)).not.toBeChecked();
  await expect(page.getByTestId('cat-progress_photos')).toContainText('Indisponível');
  expect(await noHorizontalScroll(page)).toBe(true);
  // Validação: pergunta vazia não abre a prévia.
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('ai-notice')).toContainText('Escreva uma pergunta');
  await expect(page.getByTestId('share-preview')).toBeHidden();
  await page.screenshot({ path: info.outputPath('assistente-inicio.png'), fullPage: true });
  // As outras páginas continuam acessíveis.
  await page.getByRole('link', { name: /Evolução/ }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Evolução' })).toBeVisible();
});

test('assistente: seleção de dados, prévia, cancelar, autorizar e resposta simulada', async ({ page, baseURL }, info) => {
  const external = watchExternalRequests(page, baseURL!);
  await freshStart(page);
  await loadSample(page);
  await finishOneWorkout(page);
  await openAssistant(page);
  await selectData(page, 'training_history', 'body_measurements');
  await expect(page.getByTestId('data-indicator')).toContainText('2 categorias selecionadas');

  await ask(page, 'Como foi minha semana de treinos?');
  const preview = page.getByTestId('share-preview');
  await expect(preview.getByTestId('preview-simulated-note')).toContainText('respostas simuladas');
  await expect(page.getByTestId('preview-provider')).toContainText('Provedor simulado');
  await expect(page.getByTestId('preview-model')).toContainText('Simulado (texto)');
  await expect(page.getByTestId('preview-question')).toHaveText('Como foi minha semana de treinos?');
  await expect(page.getByTestId('preview-data-training_history')).toBeVisible();
  // Dados ausentes: avaliações não existem e nada é inventado.
  await expect(page.getByTestId('preview-no-data')).toContainText('Nenhuma avaliação corporal registrada ainda.');
  await expect(page.getByTestId('preview-excluded')).toContainText('Fotos de progresso: bloqueada');
  await preview.getByText('Ver o conteúdo exato da solicitação').click();
  await expect(page.getByTestId('preview-raw')).toContainText('training_history');
  expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-previa.png') });

  // Cancelar: não executa e o foco volta ao botão de envio.
  await page.getByTestId('preview-cancel').click();
  await expect(preview).toBeHidden();
  await expect(page.getByTestId('ai-send')).toBeFocused();
  await expect(page.getByTestId('chat-user')).toHaveCount(0);

  // Teclado: Esc também fecha sem executar.
  await page.getByTestId('ai-send').click();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(page.getByTestId('chat-user')).toHaveCount(0);

  // Autorizar e executar.
  await ask(page, 'Como foi minha semana de treinos?');
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-running')).toBeVisible();
  const reply = page.getByTestId('chat-assistant');
  await expect(reply).toContainText('[SIMULAÇÃO]');
  await expect(reply).toContainText('não é uma análise real');
  await expect(page.getByTestId('chat-user')).toHaveAttribute('data-status', 'sent');
  await expect(page.getByTestId('chat-running')).toBeHidden();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-resposta.png'), fullPage: true });

  // A conversa não é persistida.
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => !/install/i.test(k))).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  expect(external).toEqual([]);
});

test('assistente: cancelar durante a execução e falha simulada', async ({ page }) => {
  await freshStart(page);
  await openAssistant(page);
  await page.getByTestId('ai-scenario').selectOption('hang');
  await ask(page, 'Pergunta que será cancelada');
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-running')).toBeVisible();
  await page.getByTestId('ai-cancel-run').click();
  await expect(page.getByTestId('chat-user')).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('chat-running')).toBeHidden();

  await page.getByTestId('ai-scenario').selectOption('fail');
  await ask(page, 'Pergunta com falha');
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-user').last()).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('chat-error').last()).toContainText('falhou ao responder');
  await expect(page.getByTestId('chat-assistant')).toHaveCount(0);
});

test('assistente: dados alterados em outra aba invalidam a prévia', async ({ page, context }) => {
  await freshStart(page);
  await loadSample(page);
  await finishOneWorkout(page);
  await openAssistant(page);
  await selectData(page, 'training_history');
  await ask(page, 'Resumo dos treinos');
  await expect(page.getByTestId('preview-data-training_history')).toBeVisible();

  const other = await context.newPage();
  await other.goto('./');
  await finishOneWorkout(other);
  await other.close();

  await expect(page.getByTestId('preview-stale')).toContainText('mudaram');
  await expect(page.getByTestId('preview-authorize')).toHaveCount(0);
  await page.getByTestId('preview-reprepare').click();
  await expect(page.getByTestId('preview-stale')).toHaveCount(0);
  await expect(page.getByTestId('preview-data-training_history').locator('li').filter({ hasText: /^\d{4}-/ })).toHaveCount(2);
});

test('assistente: funciona offline', async ({ page, context }) => {
  await freshStart(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.goto('./#/assistente');
  await expect(page.getByRole('heading', { level: 1, name: 'Assistente IA' })).toBeVisible();
  await selectData(page, 'profile_preferences');
  await ask(page, 'Pergunta offline');
  await expect(page.getByTestId('preview-data-profile_preferences')).toContainText('dias de treino por semana');
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-assistant')).toContainText('[SIMULAÇÃO]');
  await context.setOffline(false);
});
