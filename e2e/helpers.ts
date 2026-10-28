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

/**
 * Estado auxiliar documentado em localStorage (P11, docs/CRONOMETROS_E_CONCORRENCIA.md): marca de capacidade,
 * fotografia dos campos de modalidade e cronômetro de execução. Não guarda conversas nem credenciais.
 */
export const AUX_STORAGE_KEYS = ['irontrack.capabilities.v1', 'irontrack.modelSnapshot.v1', 'irontrack.setTimer.v1'];

/** Chaves do localStorage fora do aviso de instalação e do estado auxiliar documentado; e o texto do auxiliar. */
export async function storageOutsideAux(page: Page): Promise<{ other: string[]; auxText: string }> {
  return page.evaluate((aux) => {
    const keys = Object.keys(localStorage);
    return {
      other: keys.filter((k) => !/install/i.test(k) && !aux.includes(k)),
      auxText: aux.map((k) => localStorage.getItem(k) ?? '').join('\n'),
    };
  }, AUX_STORAGE_KEYS);
}
