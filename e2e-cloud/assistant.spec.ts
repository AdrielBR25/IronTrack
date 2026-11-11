// Fase 00: Assistente IA central no navegador, com a OpenAI SIMULADA localmente (nenhuma chamada real).
// Aviso de primeira configuração → chat em streaming com Markdown → histórico salvo na conta → proposta de ficha
// aprovada → ficha aparece no app pela sincronização.
import { expect, linkFromMail, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

test('assistente central: aviso único, streaming, histórico salvo e ficha criada só depois da aprovação', async ({ page }) => {
  const email = await signupViaUi(page);
  await page.goto(await linkFromMail(page, email, 'verificar-email'));
  await expect(page.getByText('E-mail confirmado.')).toBeVisible();

  await page.goto('./#/assistente');
  await expect(page.getByTestId('assistant-chat')).toBeVisible();
  // aviso de processamento de dados na primeira vez, com acesso aos detalhes
  await expect(page.getByTestId('assistant-notice')).toContainText('OpenAI');
  await page.getByTestId('assistant-notice-accept').click();
  await expect(page.getByTestId('assistant-notice')).toHaveCount(0);

  await page.getByTestId('assistant-input').fill('Oi!');
  await page.getByTestId('assistant-send').click();
  const reply = page.getByTestId('assistant-reply').last();
  await expect(reply).toContainText('Olá! Sou a OpenAI simulada do teste.', { timeout: 20_000 });
  // Markdown virou elemento, não texto com asteriscos
  await expect(reply.locator('strong')).toHaveText('OpenAI simulada');

  // pergunta sem dados: a IA consulta e diz que não há registros
  await page.getByTestId('assistant-input').fill('Como foi minha evolução no supino?');
  await page.getByTestId('assistant-send').click();
  await expect(page.getByTestId('assistant-reply').last()).toContainText('não há treinos de supino registrados', { timeout: 20_000 });
  await expect(page.getByTestId('assistant-reply').last()).toContainText('Analisando a evolução do exercício');

  // proposta de ficha: nada é criado antes de aprovar
  await page.getByTestId('assistant-input').fill('Crie uma ficha full body para mim');
  await page.getByTestId('assistant-send').click();
  const card = page.getByTestId('assistant-proposal').last();
  await expect(card).toHaveAttribute('data-status', 'pending', { timeout: 20_000 });
  await expect(card.getByTestId('assistant-proposal-preview')).toContainText('Agachamento livre (Quadríceps) — 3×6–8');
  await card.getByTestId('assistant-proposal-approve').click();
  await expect(card).toHaveAttribute('data-status', 'applied', { timeout: 20_000 });
  await expect(page.getByTestId('assistant-event').last()).toContainText('Ficha "Full body IA" criada');

  // a ficha chega ao aparelho pela sincronização
  await card.getByRole('link', { name: 'Ver fichas' }).click();
  await expect(page.getByText('Full body IA').first()).toBeVisible({ timeout: 20_000 });

  // histórico persistido na conta: recarrega e reabre a conversa
  await page.goto('./#/assistente');
  await page.reload();
  await page.getByTestId('assistant-open-list').click();
  await expect(page.getByTestId('assistant-conversation-item')).toHaveCount(1);
  await page.getByTestId('assistant-conversation-item').first().locator('button').first().click();
  await expect(page.getByTestId('assistant-user').first()).toHaveText(/Oi!/);
  await expect(page.getByTestId('assistant-proposal').last()).toHaveAttribute('data-status', 'applied');
  // sem aviso de novo
  await expect(page.getByTestId('assistant-notice')).toHaveCount(0);

  // privacidade: detalhes permanentes e apagar tudo
  await page.goto('./#/assistente/privacidade');
  await expect(page.getByTestId('assistant-privacy')).toContainText('API da OpenAI');
  await page.getByTestId('assistant-delete-conversations').click();
  await page.getByRole('button', { name: 'Apagar', exact: true }).click();
  await expect(page.getByText('1 conversa(s) apagada(s).')).toBeVisible();
});
