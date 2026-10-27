import { expect, test } from '@playwright/test';
import { freshStart, loadSample } from './helpers';

test('PWA: manifesto, service worker e funcionamento offline', async ({ page, context }) => {
  await freshStart(page);
  const manifest: { name?: string; start_url?: string } | null = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
    return href ? (await fetch(href)).json() : null;
  });
  expect(manifest?.name).toContain('IronTrack');
  expect(manifest?.start_url).toBe('/IronTrack/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await loadSample(page);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('start-workout')).toBeVisible();
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toBeVisible();
  await page.getByTestId('complete-set').click();
  await expect(page.getByTestId('rest-panel')).toBeVisible();
  await page.goto('./#/evolucao');
  await expect(page.getByRole('heading', { name: 'Evolução' })).toBeVisible();
  await context.setOffline(false);
});
