import { expect, test, type Browser } from '@playwright/test';
import { freshStart } from './helpers';

// Gera um "Relatório Comparativo Antropométrico" com dados fictícios, no mesmo
// formato de tabela (datas em colunas e diferenças entre elas).
async function makeReport(browser: Browser, dates: string[], rows: [string, string[]][]): Promise<Buffer> {
  const page = await browser.newPage();
  const cell = (s: string) => `<td class="v">${s}</td>`;
  const delta = (i: number) => (i ? `<td class="d">( -1,00 )</td>` : '');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font:12px Arial;margin:40px} td{padding:4px 0} .l{width:170px} .v{width:90px;text-align:center} .d{width:60px;text-align:center;color:#888}
  </style>
  <h2>Relatório Comparativo Antropométrico</h2>
  <p>Nome: Pessoa Teste</p>
  <table><tr><td class="l">Data</td>${dates.map((d, i) => delta(i).replace(/\(.*\)/, '') + `<td class="v">${d}</td>`).join('')}</tr>
  ${rows
    .map(([label, values]) => (values.length ? `<tr><td class="l">${label}</td>${values.map((v, i) => delta(i) + cell(v)).join('')}</tr>` : `<tr><td class="l"><b>${label}</b></td></tr>`))
    .join('')}
  </table>`;
  await page.setContent(html);
  const pdf = await page.pdf({ format: 'A4' });
  await page.close();
  return pdf;
}

const ROWS: [string, string[]][] = [
  ['Peso', ['90,00 kg', '88,50 kg', '87,20 kg']],
  ['Massa Gorda', ['22,50 kg', '20,00 kg', '18,00 kg']],
  ['% Massa Gorda', ['25,00%', '22,60%', '20,64%']],
  ['Massa Magra', ['67,50 kg', '68,50 kg', '69,20 kg']],
  ['Circunferências', []],
  ['Cintura', ['95,00 cm', '93,00 cm', '91,50 cm']],
  ['Braço relaxado direito', ['36,00 cm', '36,50 cm', '37,00 cm']],
  ['Pregas Cutâneas', []],
  ['Abdominal', ['40,00 mm', '35,00 mm', '30,00 mm']],
  ['Tríceps', ['15,00 mm', '13,00 mm', '12,00 mm']],
];

test('importa o PDF de medidas e, no PDF seguinte, só o mês novo', async ({ page, browser }) => {
  const first = await makeReport(browser, ['10/01/2030', '12/02/2030', '15/03/2030'], ROWS);
  const second = await makeReport(
    browser,
    ['12/02/2030', '15/03/2030', '20/04/2030'],
    ROWS.map(([l, v]) => [l, v.length ? [...v.slice(1), v[2].replace(/^\d+/, (n) => String(Number(n) - 1))] : []]),
  );

  await freshStart(page);
  await page.goto('./#/evolucao');
  await page.getByRole('tab', { name: 'Corpo' }).click();

  const upload = async (buf: Buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Importar PDF' }).click();
    await (await chooser).setFiles({ name: 'relatorio.pdf', mimeType: 'application/pdf', buffer: buf });
  };

  await upload(first);
  await expect(page.getByText('3 avaliações importadas')).toBeVisible();
  await expect(page.getByTestId('body-entry')).toHaveCount(3);
  const evo = page.getByTestId('body-evolution');
  await expect(evo).toContainText('Você perdeu 4,5 kg de gordura e ganhou 1,7 kg de massa magra');
  await expect(page.getByTestId('tile-waistCm')).toContainText('91,5 cm');
  await expect(page.getByText('Massa magra × massa gorda')).toBeVisible();
  await expect(page.getByText('Onde a gordura mais baixou')).toBeVisible();

  // Reenvia um PDF com 2 meses repetidos e 1 novo
  await upload(second);
  await expect(page.getByText('1 avaliação importada')).toBeVisible();
  await expect(page.getByTestId('body-entry')).toHaveCount(4);
  await expect(page.getByTestId('tile-waistCm')).toContainText('90,5 cm');

  // O mesmo PDF de novo não duplica nada
  await upload(second);
  await expect(page.getByText('Nada novo neste PDF')).toBeVisible();
  await expect(page.getByTestId('body-entry')).toHaveCount(4);

  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(scroll).toBeLessThanOrEqual(0);
});
