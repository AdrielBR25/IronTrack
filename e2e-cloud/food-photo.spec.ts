// Fase 03: fluxo principal no celular — Fotografar → Analisar → Revisar → Registrar, com a OpenAI SIMULADA local
// (e2e-cloud/server.ts). A foto é uma imagem PNG real gerada no teste (o app decodifica, reduz e converte em JPEG).
import { deflateSync } from 'node:zlib';
import { expect, linkFromMail, signupViaUi, test } from './helpers';

test.use({ serviceWorkers: 'block' });

/** PNG RGB válido (prato "bege" com um círculo escuro), sem dependências. */
function png(w = 640, h = 480): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const inPlate = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (h / 2.4) ** 2;
      raw[i] = inPlate ? 236 : 60;
      raw[i + 1] = inPlate ? 224 : 70;
      raw[i + 2] = inPlate ? 200 : 80;
    }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('foto da refeição: aviso, análise, revisão das porções e registro único no diário', async ({ page }) => {
  const email = await signupViaUi(page);
  // A IA exige e-mail confirmado (mesma regra do Assistente).
  await page.goto(await linkFromMail(page, email, 'verificar-email'));
  await expect(page.getByText('E-mail confirmado.')).toBeVisible();
  await page.goto('./#/alimentacao');
  await expect(page.getByTestId('nutrition-page')).toBeVisible({ timeout: 20_000 });
  const ring = page.getByTestId('kcal-ring');
  await expect(ring).toContainText('0');

  // 1) Abrir: aviso de envio à OpenAI só na primeira vez
  await page.getByTestId('photo-open').click();
  const flow = page.getByTestId('photo-flow');
  await expect(flow.getByTestId('photo-notice')).toContainText('OpenAI');
  await flow.getByTestId('photo-notice-accept').click();

  // 2) Escolher a foto (galeria) → prévia → Analisar
  await flow.getByTestId('photo-gallery-input').setInputFiles({ name: 'prato.png', mimeType: 'image/png', buffer: png() });
  await expect(flow.getByTestId('photo-preview')).toBeVisible();
  await flow.getByTestId('photo-analyze').click();

  // 3) Revisão: alimentos do catálogo, estimativa discreta, molho incerto marcado e bloqueando o registro
  const review = flow.getByTestId('photo-review');
  await expect(review).toBeVisible({ timeout: 20_000 });
  const items = review.getByTestId('photo-item');
  await expect(items).toHaveCount(5);
  await expect(items.filter({ hasText: 'Arroz, tipo 1, cozido' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'Feijão, carioca, cozido' })).toHaveCount(1);
  await expect(review.getByTestId('photo-totals')).toContainText('Estimativa pela foto');
  await expect(review.getByTestId('photo-calorie-notes')).toContainText('óleo');
  await expect(review.getByTestId('photo-confirm')).toBeDisabled();
  await expect(review.getByTestId('photo-confirm-blocked')).toContainText('molho');
  await items.filter({ hasText: 'molho' }).getByRole('button', { name: /Remover/ }).click();
  await expect(items).toHaveCount(4);

  // 4) Corrigir a porção do arroz (150 → 200 g): total recalculado na hora
  const before = await review.getByTestId('photo-totals').locator('p.font-display').innerText();
  await items.filter({ hasText: 'Arroz, tipo 1, cozido' }).getByTestId('photo-qty').fill('200');
  await expect(review.getByTestId('photo-totals').locator('p.font-display')).not.toHaveText(before);
  const total = (await review.getByTestId('photo-totals').locator('p.font-display').innerText()).replace(/\D/g, '');
  await review.getByRole('radio', { name: 'Almoço' }).click();

  // 5) Confirmar com toque duplo: uma refeição só, consumida, no diário do dia
  await review.getByTestId('photo-confirm').dblclick();
  await expect(flow).toHaveCount(0, { timeout: 15_000 });
  const consumed = page.locator('[data-testid="meal-card"][data-status="consumed"]');
  await expect(consumed).toHaveCount(1);
  await expect(ring).toContainText(total);

  // 6) Persistido na conta (e nenhuma duplicata depois de recarregar)
  await page.reload();
  await expect(consumed).toHaveCount(1, { timeout: 20_000 });
  await expect(ring).toContainText(total);
});
