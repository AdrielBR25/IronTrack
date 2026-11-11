// Fase 08 — experiência simplificada: Início enxuto (primeiro acesso, ações rápidas personalizáveis, resumo do dia),
// botão Registrar (+) na barra, menu Mais por categorias com busca e acesso à IA. Sem chamadas pagas: a IA é simulada.
import { expect, loadSampleFicha, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

test('conta nova: boas-vindas curtas, sem cartões zerados, e ações rápidas personalizadas persistem', async ({ page }) => {
  await signupViaUi(page);
  await page.goto('./#/');
  await expect(page.getByTestId('life-home')).toBeVisible({ timeout: 20_000 });
  // Primeiro acesso: três caminhos, sem dashboard cheio de zeros.
  const welcome = page.getByTestId('home-welcome');
  await expect(welcome).toContainText('Vamos organizar sua jornada.');
  await expect(page.getByTestId('home-today')).toHaveCount(0);
  await expect(page.getByTestId('home-nutrition')).toHaveCount(0);
  await expect(page.getByTestId('home-knowledge')).toHaveCount(0);
  await expect(page.getByTestId('home-quick').getByRole('button')).toHaveCount(4);

  // Objetivos: escolher "Ler a Bíblia" troca uma ação rápida; salvar fecha as boas-vindas.
  await welcome.getByRole('button', { name: /Configurar meus objetivos/ }).click();
  const dlg = page.getByTestId('home-layout-dialog');
  await dlg.getByRole('region', { name: 'Objetivos' }).getByRole('button', { name: 'Ler a Bíblia' }).click();
  await page.getByTestId('home-layout-save').click();
  await expect(dlg).toBeHidden();
  await expect(welcome).toBeHidden();
  await expect(page.getByTestId('home-quick')).toContainText('Ler a Bíblia');
  await expect(page.getByTestId('home-today')).toBeVisible();
  await expect(page.getByTestId('home-today-status')).toContainText('Seu dia está livre');

  // Persistência: recarregar mantém a escolha e não volta a mostrar as boas-vindas.
  await page.reload();
  await expect(page.getByTestId('home-quick')).toContainText('Ler a Bíblia', { timeout: 20_000 });
  await expect(page.getByTestId('home-welcome')).toHaveCount(0);

  // Criar o primeiro hábito pelo resumo do dia (formulário curto) e concluir com um toque.
  await page.getByRole('button', { name: 'Criar hábito' }).click();
  await page.getByLabel('Nome do hábito').fill('Alongar');
  await expect(page.getByText('Mais opções (ícone, categoria, horário, XP)')).toBeVisible();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await page.getByRole('button', { name: 'Concluir Alongar' }).click();
  await expect(page.getByTestId('home-today-status')).toContainText('Tudo feito por hoje');
});

test('barra com Registrar (+), Mais por categorias com busca e IA a um toque', async ({ page }) => {
  await signupViaUi(page);
  await loadSampleFicha(page);
  const nav = page.getByRole('navigation', { name: 'Principal' });
  for (const n of ['Início', 'Semana', 'IA', 'Mais']) await expect(nav.getByRole('link', { name: n === 'IA' ? 'Assistente IA' : n })).toBeVisible();

  // Registrar → Refeição abre o formulário da alimentação.
  await page.getByTestId('nav-register').click();
  const sheet = page.getByTestId('register-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /Refeição/ }).click();
  await expect(page).toHaveURL(/#\/alimentacao/);
  await expect(page.getByTestId('meal-editor')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('meal-editor').getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByTestId('meal-editor')).toBeHidden();

  // Registrar → Treino leva ao painel de treino, que inicia em um toque.
  await page.getByTestId('nav-register').click();
  await page.getByTestId('register-sheet').getByRole('button', { name: /Treino/ }).click();
  await expect(page).toHaveURL(/#\/treinar$/);
  await expect(page.getByTestId('start-workout')).toBeVisible();

  // Registrar → Atividade abre o formulário da Minha Semana.
  await page.getByTestId('nav-register').click();
  await page.getByTestId('register-sheet').getByRole('button', { name: /Atividade/ }).click();
  await expect(page.getByTestId('week-add-dialog')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');

  // Mais: categorias (não a lista de todas as rotas), busca e voltar.
  await nav.getByRole('link', { name: 'Mais' }).click();
  await expect(page.getByTestId('life-more')).toBeVisible();
  await expect(page.locator('[data-testid^="more-cat-"]')).toHaveCount(7);
  await page.getByTestId('more-search').fill('recordes');
  await expect(page.getByTestId('more-results')).toContainText('Recordes');
  await page.getByTestId('more-search').fill('');
  await page.getByTestId('more-cat-biblia').click();
  await expect(page.getByTestId('more-category-biblia')).toContainText('Planos de leitura');
  await page.getByTestId('page-back').click();
  await expect(page).toHaveURL(/#\/mais$/);

  // Todos os links do Mais abrem uma tela sem falha.
  for (const cat of ['treinos', 'alimentacao', 'habitos', 'estudos', 'biblia', 'evolucao', 'conta']) {
    await page.goto(`./#/mais/${cat}`);
    const links = page.getByTestId(`more-category-${cat}`).getByRole('link');
    const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(2);
    for (const h of hrefs) {
      await page.goto(`./${h}`);
      await expect(page.locator('main .animate-pulse.h-40')).toHaveCount(0, { timeout: 15_000 });
      expect(await page.getByTestId('route-error').count(), h).toBe(0);
    }
  }

  // IA: o atalho do Início abre a conversa.
  await page.goto('./#/');
  await page.getByTestId('home-ai').click();
  await expect(page).toHaveURL(/#\/assistente$/);
});
