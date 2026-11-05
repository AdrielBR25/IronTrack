// Fase 07 — varredura de homologação no celular (360 px) e no desktop: cada tela principal do Life abre sem erro de
// JavaScript, sem a tela de falha, sem rolagem horizontal (elemento vazando da tela) e com o menu ao alcance.
import { expect, loadSampleFicha, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

const ROUTES: [string, string][] = [
  ['/', 'Início'],
  ['/semana', 'Minha Semana'],
  ['/minha-evolucao', 'Minha Evolução'],
  ['/missoes', 'Missões'],
  ['/jornada', 'Jornada'],
  ['/treinar', 'Treinar'],
  ['/treinos', 'Fichas'],
  ['/historico', 'Histórico'],
  ['/alimentacao', 'Alimentação'],
  ['/alimentacao/planejar', 'Planejamento alimentar'],
  ['/alimentacao/metas', 'Metas nutricionais'],
  ['/conhecimento', 'Conhecimento'],
  ['/conhecimento/foco', 'Foco'],
  ['/biblia', 'Bíblia'],
  ['/biblia/ler', 'Leitor da Bíblia'],
  ['/biblia/planos', 'Planos bíblicos'],
  ['/assistente', 'IA'],
  ['/assistente/privacidade', 'Privacidade da IA'],
  ['/mais', 'Mais'],
  ['/conta', 'Conta'],
  ['/config', 'Ajustes'],
];

async function sweep(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const problems: string[] = [];
  for (const [path, label] of ROUTES) {
    await page.goto(`./#${path}`);
    // tela carregada: o esqueleto de carregamento some e nada mostra a tela de falha
    await expect(page.locator('main .animate-pulse.h-40')).toHaveCount(0, { timeout: 15_000 });
    await page.waitForTimeout(400);
    if (await page.getByTestId('route-error').count()) problems.push(`${label}: tela de falha`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${label}: rolagem horizontal de ${overflow}px`);
  }
  expect(errors, 'erros de JavaScript').toEqual([]);
  expect(problems).toEqual([]);
}

test('todas as telas principais abrem no celular sem erro nem rolagem horizontal', async ({ page }) => {
  await signupViaUi(page);
  await loadSampleFicha(page); // com dados: treino, agenda e evolução têm o que mostrar
  await sweep(page);
  // barra inferior visível e utilizável na tela mais longa
  await page.goto('./#/mais');
  const nav = page.getByRole('navigation', { name: 'Principal' });
  await expect(nav.getByRole('link', { name: 'Semana' })).toBeVisible();
  await nav.getByRole('link', { name: 'Semana' }).click();
  await expect(page).toHaveURL(/#\/semana$/);
});

test('todas as telas principais abrem no desktop sem erro @desktop', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await signupViaUi(page);
  await sweep(page);
});
