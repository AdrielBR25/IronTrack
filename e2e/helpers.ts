import { expect, type Page } from '@playwright/test';

export async function freshStart(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

export async function loadSample(page: Page) {
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('start-workout')).toBeVisible();
}

export async function setValue(page: Page, testId: string, value: string) {
  const input = page.getByTestId(testId);
  await input.click();
  await input.fill(value);
  await input.blur();
}
