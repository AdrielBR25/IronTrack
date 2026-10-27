// Gera os ícones PNG do PWA a partir do desenho SVG (uso: node scripts/gen-icons.mjs).
import { chromium } from 'playwright';

const mark = (bg, fg, pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" ${pad ? '' : 'rx="14"'} fill="${bg}"/>
  <g transform="translate(32 32) scale(${pad ? 0.72 : 1}) translate(-32 -32)" fill="${fg}">
    <rect x="10" y="22" width="7" height="20" rx="2"/><rect x="18" y="17" width="7" height="30" rx="2"/>
    <rect x="39" y="17" width="7" height="30" rx="2"/><rect x="47" y="22" width="7" height="20" rx="2"/>
    <rect x="25" y="29" width="14" height="6" rx="1.5"/>
  </g>
</svg>`;

const targets = [
  ['public/pwa-192.png', 192, mark('#a3e635', '#0b0d0c', false)],
  ['public/pwa-512.png', 512, mark('#a3e635', '#0b0d0c', false)],
  ['public/pwa-maskable-512.png', 512, mark('#a3e635', '#0b0d0c', true)],
  ['public/apple-touch-icon.png', 180, mark('#a3e635', '#0b0d0c', true)],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, svg] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('ok', file);
}
await browser.close();
