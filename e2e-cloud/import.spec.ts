// Migração para a conta (Prompt 21): dados usados sem conta neste navegador e backup v8 (ex.: do GitHub Pages).
// Detectar → mostrar → perguntar → contagens → prévia → confirmar → importar → verificar. A origem nunca é apagada.
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PASSWORD, expectInApp, expectSynced, newDevice, readAccountTable, signupViaUi, uniqueEmail, welcome, expect, test } from './helpers';

test.use({ serviceWorkers: 'block' });

async function localData(page: Page) {
  await welcome(page);
  await page.getByRole('button', { name: /Usar sem conta/ }).click();
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('start-workout')).toBeVisible();
}

function legacyCount(page: Page, table: string): Promise<number> {
  return page.evaluate(
    (t) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('irontrack');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const c = req.result.transaction(t, 'readonly').objectStore(t).count();
          c.onsuccess = () => {
            req.result.close();
            resolve(c.result);
          };
        };
      }),
    table,
  );
}

async function signupInApp(page: Page) {
  await page.goto('./#/config');
  await page.getByTestId('account-card').getByRole('link', { name: 'Criar conta' }).click();
  const email = uniqueEmail('migra');
  await page.getByLabel('Nome', { exact: true }).fill('Migração');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar senha', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expectInApp(page);
  return email;
}

async function runImport(page: Page) {
  await page.getByRole('button', { name: 'Analisar com a conta' }).click();
  await expect(page.getByRole('heading', { name: 'Prévia da importação' })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-done')).toBeVisible({ timeout: 30_000 });
}

test('perfil local → conta: oferta, contagens, prévia, importação conferida; origem intacta', async ({ page }) => {
  await localData(page);
  await signupInApp(page);
  const offer = page.getByTestId('import-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('1 ficha(s)');
  await offer.getByRole('link', { name: 'Revisar e importar' }).click();
  await expect(page.getByTestId('import-counts')).toContainText('Fichas');
  await page.getByRole('button', { name: 'Revisar e importar' }).click();
  await expect(page.getByTestId('import-counts')).toContainText('Fichas');
  await runImport(page);
  await expect(page.getByTestId('import-done')).toHaveAttribute('data-verified', 'ok');
  await expect(page.getByTestId('import-done')).toContainText('Importação concluída e conferida');
  await expectSynced(page);
  expect(await readAccountTable(page, 'routines')).toHaveLength(1);
  // a origem não foi apagada nem alterada
  expect(await legacyCount(page, 'routines')).toBe(1);
  // a oferta não volta depois de importar
  await page.goto('./#/');
  await expect(page.getByTestId('import-offer')).toHaveCount(0);
});

test('importar de novo não duplica: aviso de importação anterior e registros iguais ignorados', async ({ page }) => {
  await localData(page);
  await signupInApp(page);
  await page.goto('./#/conta/importar');
  for (let i = 0; i < 2; i++) {
    if (i === 1) await page.getByRole('button', { name: 'Fazer outra importação' }).click();
    await page.getByRole('button', { name: 'Revisar e importar' }).click();
    await page.getByRole('button', { name: 'Analisar com a conta' }).click();
    await expect(page.getByRole('heading', { name: 'Prévia da importação' })).toBeVisible({ timeout: 20_000 });
    if (i === 1) await expect(page.getByText(/já foram importados/)).toBeVisible();
    await page.getByTestId('import-confirm').click();
    await expect(page.getByTestId('import-done')).toHaveAttribute('data-verified', 'ok', { timeout: 30_000 });
  }
  const r = await page.request.get('/api/v1/me/export');
  expect(((await r.json()) as { data: { routines: unknown[] } }).data.routines).toHaveLength(1);
});

test('backup v8 (ex.: do GitHub Pages) para uma conta em outro navegador; conflito exige confirmação para substituir', async ({ page, browser }, info) => {
  await localData(page);
  await page.goto('./#/config');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-backup').click()]);
  const backupPath = info.outputPath('backup.json');
  await dl.saveAs(backupPath);
  expect(JSON.parse(readFileSync(backupPath, 'utf8')).schemaVersion).toBe(8);

  const b = await newDevice(browser, info);
  await signupViaUi(b.page);
  await b.page.goto('./#/conta/importar');
  // arquivo em memória: enviado pelo caminho (pasta do teste com acentos), o Chromium não disparava `change`
  const backupFile = { name: 'backup.json', mimeType: 'application/json', buffer: readFileSync(backupPath) };
  await b.page.getByTestId('cloud-import-file').setInputFiles(backupFile);
  await expect(b.page.getByText(/Arquivo backup\.json/)).toBeVisible();
  await runImport(b.page);
  await expect(b.page.getByTestId('import-done')).toHaveAttribute('data-verified', 'ok');
  await expectSynced(b.page);

  // muda a ficha na conta e importa o mesmo arquivo: diferença → mesclar mantém a conta; substituir pede confirmação
  await b.page.goto('./#/config');
  await b.page.locator('#s-name').fill('Nome na conta');
  await b.page.locator('#s-name').blur();
  await expectSynced(b.page);
  await b.page.goto('./#/conta/importar');
  await b.page.getByTestId('cloud-import-file').setInputFiles(backupFile);
  await b.page.getByRole('button', { name: 'Analisar com a conta' }).click();
  await expect(b.page.getByText(/existem na conta com conteúdo diferente/)).toBeVisible({ timeout: 20_000 });
  await b.page.getByLabel(/Substituir:/).check();
  await expect(b.page.getByTestId('import-confirm')).toBeDisabled();
  await b.page.getByLabel(/Confirmo que quero substituir/).check();
  await b.page.getByTestId('import-confirm').click();
  await expect(b.page.getByTestId('import-done')).toHaveAttribute('data-verified', 'ok', { timeout: 30_000 });
  await expect(b.page.getByTestId('import-report')).toContainText('Substituídos');
  await b.context.close();
});

test('fotos ficam só no aparelho e aparecem como "não sincronizadas"', async ({ page }) => {
  await signupViaUi(page);
  // grava uma foto local no banco da conta (como a tela de evolução faria)
  await page.evaluate(async () => {
    const ptr = JSON.parse(localStorage.getItem('irontrack.account.v1')!) as { id: string; dataProfileId: string };
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(`irontrack-acct-${ptr.id}`);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('photos', 'readwrite');
        tx.objectStore('photos').put({ id: 'foto-1', profileId: ptr.dataProfileId, date: '2026-10-29', pose: 'front', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', createdAt: 1 });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
    });
  });
  await page.goto('./#/conta/sincronizacao');
  await page.reload();
  await expect(page.getByTestId('photos-not-synced')).toContainText('1 foto(s) de progresso: não sincronizadas');
  await page.getByRole('button', { name: 'Sincronizar agora' }).click();
  await expectSynced(page);
  const r = await page.request.get('/api/v1/me/export');
  expect(((await r.json()) as { data: { photos: unknown[] } }).data.photos).toEqual([]);
});
