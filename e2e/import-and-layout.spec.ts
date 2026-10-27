import { expect, test } from '@playwright/test';
import { freshStart, loadSample } from './helpers';

test('ficha inválida mostra erros claros', async ({ page }) => {
  await page.goto('./#/treinos');
  const bad = JSON.stringify({ formato: 'irontrack.ficha', versao: 1, nome: 'X', treinos: [{ rotulo: 'A', nome: 'T', exercicios: [{ nome: 'Supino', grupo: 'Peito', series: 0, repeticoes: '12-8' }] }] });
  await page.getByTestId('import-ficha-input').setInputFiles({ name: 'ficha.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
  const errs = page.getByTestId('import-errors');
  await expect(errs).toContainText('Treino 1 › Exercício 1 › series');
  await expect(errs).toContainText('faixa de repetições inválida');
});

/** Elementos visíveis que saem da largura da tela sem estar dentro de um contêiner com rolagem/corte. */
async function overflowing(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const W = window.innerWidth;
    const out: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const rc = el.getBoundingClientRect();
      if (rc.width === 0 || (rc.right <= W + 0.5 && rc.left >= -1.5)) continue;
      let a = el.parentElement;
      let clipped = false;
      while (a) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX)) {
          const ar = a.getBoundingClientRect();
          if (ar.right <= W + 0.5 && ar.left >= -0.5) {
            clipped = true;
            break;
          }
        }
        a = a.parentElement;
      }
      if (!clipped) out.push(`${el.tagName}.${String(el.className).slice(0, 40)}`);
    }
    return { out, scroll: document.documentElement.scrollWidth - W };
  });
}

test('sem rolagem horizontal em telas pequenas (inclusive com avisos na tela)', async ({ page }) => {
  await freshStart(page);
  await loadSample(page);
  expect(await overflowing(page)).toEqual({ out: [], scroll: 0 });
  for (const path of ['#/', '#/treinos', '#/historico', '#/evolucao', '#/config']) {
    await page.goto(`./${path}`);
    await page.waitForTimeout(300);
    expect(await overflowing(page), `overflow em ${path}`).toEqual({ out: [], scroll: 0 });
  }
  await page.goto('./#/');
  await page.getByTestId('start-workout').click();
  await expect(page.getByTestId('set-editor')).toBeVisible();
  expect(await overflowing(page)).toEqual({ out: [], scroll: 0 });
  await page.getByTestId('complete-set').click();
  await expect(page.getByTestId('rest-panel')).toBeVisible();
  expect(await overflowing(page)).toEqual({ out: [], scroll: 0 });
});

test('rotação: pular e reagendar pela agenda', async ({ page }) => {
  await freshStart(page);
  await loadSample(page);
  await page.goto('./#/treinos');
  const next = page.getByLabel('Corrigir próximo treino da sequência');
  await expect(next.locator('option:checked')).toContainText('Treino A');
  await page.getByRole('button', { name: 'Pular' }).click();
  await expect(next.locator('option:checked')).toContainText('Treino B');
  await next.selectOption({ label: 'Treino C · Pernas e abdômen' });
  await expect(next.locator('option:checked')).toContainText('Treino C');
  await expect(page.getByTestId('agenda').locator('button')).toHaveCount(14);
});
