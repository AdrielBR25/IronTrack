// Cenários complementares do modo nuvem (Prompt 21): links inválidos, saída com pendências, cancelamento da importação,
// oferta de importação lembrada, service worker fora da API e duas abas da mesma conta.
import type { Page } from '@playwright/test';
import { expectInApp, expectSynced, signupViaUi, syncNow, welcome, expect, test } from './helpers';

async function warmSettings(page: Page) {
  // Carrega a tela de Ajustes antes de ficar offline (sem service worker, a parte carregada sob demanda não viria).
  await page.goto('./#/config');
  await expect(page.locator('#s-name')).toBeVisible();
}

async function setName(page: Page, name: string) {
  await page.evaluate(() => (location.hash = '#/config'));
  await page.locator('#s-name').fill(name);
  await page.locator('#s-name').blur();
}

test.describe('sem service worker', () => {
  test.use({ serviceWorkers: 'block' });

  test('links de confirmação e de nova senha inválidos: mensagem clara, nada é alterado', async ({ page }) => {
    await welcome(page);
    await page.goto('./#/conta/verificar-email?token=token-inexistente-0000000000000000');
    await expect(page.getByText(/O link é inválido, expirou ou já foi usado/)).toBeVisible();
    await page.goto('./#/conta/redefinir-senha?token=token-inexistente-0000000000000000');
    await page.getByLabel('Nova senha', { exact: true }).fill('nova-senha-forte-2027');
    await page.getByLabel('Confirmar nova senha').fill('nova-senha-forte-2027');
    await page.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(page.getByText(/O link é inválido, expirou ou já foi usado/)).toBeVisible();
    await page.goto('./#/conta/redefinir-senha');
    await expect(page.getByText(/Link incompleto/)).toBeVisible();
  });

  test('sair com alterações pendentes: aviso com a quantidade; cancelar mantém a conta aberta', async ({ page }) => {
    await signupViaUi(page);
    await warmSettings(page);
    await page.goto('./#/conta');
    await expect(page.getByRole('button', { name: 'Sair desta conta' })).toBeVisible();
    await page.context().setOffline(true);
    await setName(page, 'Alteração ainda no aparelho');
    await page.evaluate(() => (location.hash = '#/conta'));
    await page.getByRole('button', { name: 'Sair desta conta' }).click();
    await expect(page.getByRole('dialog').getByText(/Há \d+ alteração\(ões\) deste aparelho que ainda não chegaram à nuvem/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.context().setOffline(false);
    await expectSynced(page);
    const r = await page.request.get('/api/v1/me/export');
    expect(((await r.json()) as { data: { settings: { userName: string } | null } }).data.settings?.userName).toBe('Alteração ainda no aparelho');
  });

  test('cancelar a importação na prévia: nada entra na conta e a origem fica intacta', async ({ page }) => {
    await welcome(page);
    await page.getByRole('button', { name: /Usar sem conta/ }).click();
    await page.getByTestId('load-sample').click();
    await expect(page.getByTestId('start-workout')).toBeVisible();
    await page.goto('./#/config');
    await page.getByTestId('account-card').getByRole('link', { name: 'Criar conta' }).click();
    await page.getByLabel('Nome', { exact: true }).fill('Cancela');
    await page.getByLabel('E-mail', { exact: true }).fill(`cancela-${Date.now()}@exemplo.com`);
    await page.getByLabel('Senha', { exact: true }).fill('barra-olimpica-2026');
    await page.getByLabel('Confirmar senha', { exact: true }).fill('barra-olimpica-2026');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Criar conta' }).click();
    await expectInApp(page);
    await page.goto('./#/conta/importar');
    await page.getByRole('button', { name: 'Revisar e importar' }).click();
    await page.getByRole('button', { name: 'Analisar com a conta' }).click();
    await expect(page.getByRole('heading', { name: 'Prévia da importação' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Revisar e importar' })).toBeVisible();
    const r = await page.request.get('/api/v1/me/export');
    expect(((await r.json()) as { data: { routines: unknown[] } }).data.routines).toHaveLength(0);
    // a oferta continua disponível (nada foi importado)
    await page.goto('./#/');
    await expect(page.getByTestId('import-offer')).toBeVisible();
  });

  test('"Agora não" na oferta de importação fica lembrado neste aparelho', async ({ page }) => {
    await welcome(page);
    await page.getByRole('button', { name: /Usar sem conta/ }).click();
    await page.getByTestId('load-sample').click();
    await expect(page.getByTestId('start-workout')).toBeVisible();
    await page.goto('./#/config');
    await page.getByTestId('account-card').getByRole('link', { name: 'Criar conta' }).click();
    await page.getByLabel('Nome', { exact: true }).fill('Depois');
    await page.getByLabel('E-mail', { exact: true }).fill(`depois-${Date.now()}@exemplo.com`);
    await page.getByLabel('Senha', { exact: true }).fill('barra-olimpica-2026');
    await page.getByLabel('Confirmar senha', { exact: true }).fill('barra-olimpica-2026');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Criar conta' }).click();
    await expectInApp(page);
    const offer = page.getByTestId('import-offer');
    await expect(offer).toBeVisible();
    await offer.getByRole('button', { name: 'Agora não' }).click();
    await expect(offer).toHaveCount(0);
    await page.reload();
    await expectInApp(page);
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('import-offer')).toHaveCount(0);
    // importar continua possível pela conta
    await page.goto('./#/conta/importar');
    await expect(page.getByRole('button', { name: 'Revisar e importar' })).toBeVisible();
  });

  test('duas abas da mesma conta: a alteração de uma aparece na outra e as duas ficam sincronizadas', async ({ page, context }) => {
    await signupViaUi(page);
    const tab2 = await context.newPage();
    await tab2.goto('./#/config');
    await expectInApp(tab2);
    await setName(page, 'Nome pela aba 1');
    await expectSynced(page);
    await syncNow(tab2);
    await expectSynced(tab2);
    await tab2.goto('./#/config');
    await expect(tab2.locator('#s-name')).toHaveValue('Nome pela aba 1');
    const r = await page.request.get('/api/v1/me/export');
    expect(((await r.json()) as { data: { settings: { userName: string } | null } }).data.settings?.userName).toBe('Nome pela aba 1');
  });
});

test('service worker do PWA não atende a API: /api devolve JSON do servidor, não a página do app', async ({ page }) => {
  await welcome(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const res = await page.evaluate(async () => {
    const ok = await fetch('/api/v1/health');
    const missing = await fetch('/api/v1/rota-que-nao-existe');
    return { ok: ok.status, okType: ok.headers.get('content-type'), missing: missing.status, missingType: missing.headers.get('content-type'), body: await missing.text() };
  });
  expect(res.ok).toBe(200);
  expect(res.okType).toContain('application/json');
  expect(res.missing).toBe(404);
  expect(res.missingType).toContain('application/json');
  expect(res.body).not.toContain('<html');
});
