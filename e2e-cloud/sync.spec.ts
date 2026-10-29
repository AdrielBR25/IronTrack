// Sincronização entre dois navegadores independentes (Prompt 21): propagação, offline, conflitos explícitos e
// resolução, treino finalizado × alterado, sessão expirada durante a sincronização.
import type { Page } from '@playwright/test';
import { expectInApp, expectSynced, loginViaUi, newDevice, readAccountTable, signupViaUi, syncNow, expect, test } from './helpers';

test.use({ serviceWorkers: 'block' });

async function setUserName(page: Page, name: string) {
  // Navegação pelo hash (funciona offline, sem recarregar a página).
  await page.evaluate(() => (location.hash = '#/config'));
  const input = page.locator('#s-name');
  await input.fill(name);
  await input.blur();
}

async function twoDevices(page: Page, browser: import('@playwright/test').Browser, info: import('@playwright/test').TestInfo) {
  const email = await signupViaUi(page);
  const b = await newDevice(browser, info);
  await loginViaUi(b.page, email);
  await expectInApp(b.page);
  // Os testes bloqueiam o service worker; carrega a tela de Ajustes antes de ficar offline (sem o SW, a parte da tela
  // carregada sob demanda não viria da rede offline; no app instalado ela vem do cache do PWA).
  for (const p of [page, b.page]) {
    await p.goto('./#/config');
    await expect(p.locator('#s-name')).toBeVisible();
  }
  return { email, b };
}

test('ficha criada num aparelho aparece no outro', async ({ page, browser }, info) => {
  const { b } = await twoDevices(page, browser, info);
  await page.goto('./#/');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('start-workout')).toBeVisible();
  await expectSynced(page);
  await syncNow(b.page);
  await b.page.goto('./#/treinos');
  await expect(b.page.getByText(/ABC/).first()).toBeVisible();
  expect((await readAccountTable(b.page, 'routines')).length).toBe(1);
  await b.context.close();
});

test('offline: alterações ficam pendentes (nunca "Sincronizado") e sobem ao reconectar', async ({ page, browser }, info) => {
  const { b } = await twoDevices(page, browser, info);
  await page.context().setOffline(true);
  await setUserName(page, 'Nome offline');
  const chip = page.locator('[data-testid="sync-status"]:visible').first();
  await expect(chip).toHaveAttribute('data-state', /offline|pending/, { timeout: 20_000 });
  await page.waitForTimeout(2500);
  await expect(chip).not.toHaveAttribute('data-state', 'synced');
  await page.context().setOffline(false);
  await expect(chip).toHaveAttribute('data-state', 'synced', { timeout: 30_000 });
  await syncNow(b.page);
  await b.page.goto('./#/config');
  await expect(b.page.locator('#s-name')).toHaveValue('Nome offline');
  await b.context.close();
});

test('desconexão durante o treino: séries registradas offline chegam ao outro aparelho', async ({ page, browser }, info) => {
  const { b } = await twoDevices(page, browser, info);
  await page.goto('./#/');
  await page.getByTestId('load-sample').click();
  await expectSynced(page);
  await page.getByTestId('start-workout').click();
  await expect(page).toHaveURL(/#\/treino$/);
  await page.context().setOffline(true);
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await expect(page.getByTestId('set-row-done')).toHaveCount(2);
  await page.context().setOffline(false);
  await page.goto('./#/conta/sincronizacao');
  await expectSynced(page);
  await syncNow(b.page);
  const sessions = await readAccountTable<{ status: string; exercises: { sets: { status: string }[] }[] }>(b.page, 'sessions');
  expect(sessions).toHaveLength(1);
  expect(sessions[0].exercises.flatMap((e) => e.sets).filter((s) => s.status === 'done')).toHaveLength(2);
  await b.context.close();
});

test('mesmo campo alterado nos dois aparelhos: conflito explícito, "manter deste aparelho" vale para os dois', async ({ page, browser }, info) => {
  const { b } = await twoDevices(page, browser, info);
  await setUserName(page, 'Base');
  await expectSynced(page);
  await syncNow(b.page);
  await b.page.context().setOffline(true);
  await setUserName(page, 'Nome do aparelho A');
  await expectSynced(page);
  await setUserName(b.page, 'Nome do aparelho B');
  await b.page.context().setOffline(false);
  await syncNow(b.page);
  await expect(b.page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'conflict', { timeout: 20_000 });
  const card = b.page.getByTestId('sync-conflict');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Configurações');
  // nada foi sobrescrito: cada aparelho ainda tem o seu valor
  await expect.poll(async () => (await readAccountTable<{ userName: string }>(b.page, 'settings'))[0]?.userName).toBe('Nome do aparelho B');
  await card.getByRole('button', { name: 'Manter deste aparelho' }).click();
  await expectSynced(b.page);
  await syncNow(page);
  await page.goto('./#/config');
  await expect(page.locator('#s-name')).toHaveValue('Nome do aparelho B');
  await b.context.close();
});

test('conflito resolvido com "usar a da nuvem"', async ({ page, browser }, info) => {
  const { b } = await twoDevices(page, browser, info);
  await setUserName(page, 'Base');
  await expectSynced(page);
  await syncNow(b.page);
  await b.page.context().setOffline(true);
  await setUserName(page, 'Valor da nuvem');
  await expectSynced(page);
  await setUserName(b.page, 'Valor local');
  await b.page.context().setOffline(false);
  await syncNow(b.page);
  await b.page.getByTestId('sync-conflict').getByRole('button', { name: 'Usar a da nuvem' }).click();
  await expectSynced(b.page);
  await b.page.goto('./#/config');
  await expect(b.page.locator('#s-name')).toHaveValue('Valor da nuvem');
  await b.context.close();
});

test('treino finalizado num aparelho e alterado no outro: conflito; "manter os dois" preserva tudo', async ({ page, browser }, info) => {
  const { b } = await twoDevices(page, browser, info);
  await page.goto('./#/');
  await page.getByTestId('load-sample').click();
  await page.getByTestId('start-workout').click();
  await page.getByTestId('complete-set').click();
  await page.getByTestId('rest-skip').click();
  await page.goto('./#/conta/sincronizacao');
  await expectSynced(page);
  await expect
    .poll(async () => ((await (await page.request.get('/api/v1/me/export')).json()) as { data: { sessions: unknown[] } }).data.sessions.length, { timeout: 20_000 })
    .toBe(1);
  await syncNow(b.page);
  await expect.poll(async () => (await readAccountTable(b.page, 'sessions')).length).toBe(1);
  // B continua o treino offline; A finaliza
  await b.page.context().setOffline(true);
  await b.page.goto('./#/treino');
  await b.page.getByTestId('complete-set').click();
  await b.page.getByTestId('rest-skip').click();
  await page.goto('./#/treino');
  await page.getByTestId('open-finish').click();
  await page.getByTestId('confirm-finish').click();
  await page.goto('./#/conta/sincronizacao');
  // espera o servidor ter o treino finalizado (o chip pode ainda mostrar o estado anterior à gravação)
  await expect
    .poll(async () => ((await (await page.request.get('/api/v1/me/export')).json()) as { data: { sessions: { status: string }[] } }).data.sessions[0]?.status, { timeout: 20_000 })
    .toBe('completed');
  await expectSynced(page);
  await b.page.context().setOffline(false);
  await syncNow(b.page);
  const card = b.page.getByTestId('sync-conflict');
  await expect(card).toContainText('Treinos registrados');
  await expect(card).toContainText('status');
  await card.getByRole('button', { name: 'Manter os dois' }).click();
  await expectSynced(b.page);
  await syncNow(page);
  const sessions = await readAccountTable<{ id: string; status: string }>(page, 'sessions');
  expect(sessions).toHaveLength(2);
  await b.context.close();
});

test('sessão expirada durante a sincronização: nada se perde e tudo sobe depois de entrar', async ({ page }) => {
  const email = await signupViaUi(page);
  await page.context().clearCookies();
  await setUserName(page, 'Alteração com sessão expirada');
  await page.goto('./#/conta/sincronizacao');
  await page.getByRole('button', { name: 'Sincronizar agora' }).click();
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'auth_required', { timeout: 20_000 });
  await expect(page.getByText(/1 alteração\(ões\) aguardando envio/)).toBeVisible();
  await page.locator('[data-testid="sync-status"]:visible').first().click();
  await expect(page.getByRole('heading', { name: 'Entrar de novo' })).toBeVisible();
  await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue(email);
  await page.getByLabel('Senha', { exact: true }).fill('barra-olimpica-2026');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expectSynced(page);
  const r = await page.request.get('/api/v1/me/export');
  expect(((await r.json()) as { data: { settings: { userName: string } } }).data.settings.userName).toBe('Alteração com sessão expirada');
});

test('o app abre offline com os dados da conta (sem servidor)', async ({ page }) => {
  await signupViaUi(page);
  await page.goto('./#/');
  await page.getByTestId('load-sample').click();
  await expectSynced(page);
  // servidor fora: a API não responde, mas o app abre com os dados do aparelho
  await page.route('**/api/**', (r) => r.abort('internetdisconnected'));
  await page.reload();
  await expect(page.getByTestId('start-workout')).toBeVisible();
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).not.toHaveAttribute('data-state', 'synced', { timeout: 10_000 });
});
