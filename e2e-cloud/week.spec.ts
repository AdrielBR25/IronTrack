// Fase 06: fluxo principal da integração no celular. Início personalizável → Minha Semana (criar atividade, ajustar o
// horário, ver o conflito, marcar como concluída) → Minha Evolução (indicadores sem IA).
import { expect, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

test('minha semana: criar, ajustar horário, conflito, concluir e ver a evolução', async ({ page }) => {
  await signupViaUi(page);
  await page.goto('./#/');
  await expect(page.getByTestId('life-home')).toBeVisible({ timeout: 20_000 });

  // Início: personalizar (salva na conta) e voltar.
  await page.getByTestId('home-customize').click();
  await expect(page.getByTestId('home-layout-dialog')).toBeVisible();
  await page.getByRole('switch', { name: 'Mostrar Conquistas' }).click();
  await page.getByTestId('home-layout-save').click();
  await expect(page.getByTestId('home-layout-dialog')).toBeHidden();

  // Minha Semana pela barra inferior.
  await page.getByRole('navigation').getByRole('link', { name: 'Semana' }).click();
  await expect(page.getByTestId('week-page')).toBeVisible({ timeout: 20_000 });

  const add = async (title: string, time: string) => {
    await page.getByTestId('week-add').click();
    const d = page.getByTestId('week-add-dialog');
    await d.getByLabel('Título').fill(title);
    await d.getByLabel('Início').fill(time);
    await d.getByLabel('Duração (min)').fill('60');
    await page.getByTestId('week-add-save').click();
    await expect(d).toBeHidden();
  };
  await add('Estudar inglês', '07:00');
  const item = page.getByTestId('week-item').filter({ hasText: 'Estudar inglês' });
  await expect(item).toHaveAttribute('data-status', 'planned');

  // Ajustar o horário para 08:00.
  await item.getByRole('button', { name: /Estudar inglês/ }).click();
  const dlg = page.getByTestId('week-item-dialog');
  await dlg.getByLabel('Início').fill('08:00');
  await page.getByTestId('week-save-time').click();
  await expect(dlg).toBeHidden();
  await expect(item).toContainText('08:00');

  // Outra atividade no mesmo horário: a agenda aponta o conflito.
  await add('Caminhada', '08:30');
  await expect(page.getByTestId('week-conflict').first()).toBeVisible();

  // Concluir: só porque a pessoa marcou (o horário passar não conclui nada).
  await item.getByRole('button', { name: /Estudar inglês/ }).click();
  await page.getByTestId('week-mark-done').click();
  await expect(item).toHaveAttribute('data-status', 'done');
  await page.reload();
  await expect(page.getByTestId('week-item').filter({ hasText: 'Estudar inglês' })).toHaveAttribute('data-status', 'done', { timeout: 20_000 });

  // Minha Evolução: indicadores calculados pelo app; conta nova mostra "Sem dados", nunca desempenho ruim.
  await page.getByRole('navigation').getByRole('link', { name: 'Evolução' }).click();
  await expect(page.getByTestId('evolution-page')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('evolution-metric').first()).toBeVisible();
  await expect(page.getByText('sem IA', { exact: false }).first()).toBeVisible();
});
