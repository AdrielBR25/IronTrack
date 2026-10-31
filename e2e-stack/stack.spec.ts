// Integração dos contêineres da Railway (Prompt 21.1): navegador → irontrack-web (Caddy) → irontrack-api → Postgres.
// Prova o proxy /api/v1 (mesma origem, cookie, CSRF, corpo grande, IP do cliente), os cabeçalhos e o cache do app,
// as rotas do HashRouter, o PWA offline e o humanoide 3D sob a CSP real.
import { randomBytes } from 'node:crypto';
import { PASSWORD, expectInApp, expectSynced, linkFromMail, loginViaUi, signupViaUi, uniqueEmail, welcome, expect, test } from '../e2e-cloud/helpers';

const ORIGIN = new URL(process.env.STACK_URL ?? 'http://localhost:8090/').origin;
const csrf = { 'x-irontrack-csrf': '1', origin: ORIGIN };

test('saúde do web e da API pelo proxy; respostas da API com os cabeçalhos dela', async ({ request }) => {
  const web = await request.get('/healthz');
  expect(web.status()).toBe(200);
  expect(await web.text()).toBe('ok');
  for (const path of ['/api/v1/health', '/api/v1/ready']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    expect(r.headers()['content-type']).toContain('application/json');
    expect(r.headers()['cache-control']).toBe('no-store');
    expect(r.headers()['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  }
  expect(((await (await request.get('/api/v1/ready')).json()) as { status: string }).status).toBe('ready');
});

test('cabeçalhos de segurança e cache do app; arquivos que não existem', async ({ request }) => {
  const index = await request.get('/');
  expect(index.status()).toBe(200);
  const h = index.headers();
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['strict-transport-security']).toContain('max-age=31536000');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['cache-control']).toBe('no-cache');
  expect(h['server']).toBeUndefined();

  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['cache-control']).toBe('no-cache');
  expect(sw.headers()['content-type']).toContain('javascript');

  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  expect(manifest.headers()['cache-control']).toBe('no-cache');

  const html = await index.text();
  const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
  expect(asset).toBeTruthy();
  const js = await request.get(asset!);
  expect(js.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(js.headers()['content-type']).toContain('javascript');
  expect(js.headers()['content-encoding'] ?? '').toMatch(/zstd|gzip|^$/);

  // arquivo com hash que não existe: 404 de verdade (nunca o HTML com cache de um ano)
  const missing = await request.get('/assets/nao-existe-123.js');
  expect(missing.status()).toBe(404);
  // caminho desconhecido fora de /assets: o app (HashRouter), sem 404
  const deep = await request.get('/qualquer/caminho');
  expect(deep.status()).toBe(200);
  expect(await deep.text()).toContain('<div id="root">');
});

test('proxy fechado: só /api/v1 vai para a API, sempre para o mesmo destino', async ({ request }) => {
  const other = await request.get('/api/qualquer');
  expect(other.status()).toBe(404);
  expect(((await other.json()) as { error: { code: string } }).error.code).toBe('not_found');
  const unknown = await request.get('/api/v1/rota-que-nao-existe');
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['content-type']).toContain('application/json');
  // Host de outro site não muda o destino (não há roteamento por Host nem URL absoluta).
  const hosted = await request.get('/api/v1/health', { headers: { host: 'exemplo.invalid' } });
  expect(hosted.status()).toBe(200);
  expect(((await hosted.json()) as { status: string }).status).toBe('ok');
  // Corpo acima dos limites (proxy 5 MB, API 4 MB) é recusado com 413, sem derrubar nada.
  const big = await request.post('/api/v1/auth/signup', { headers: { ...csrf, 'content-type': 'application/json' }, data: 'x'.repeat(6 * 1024 * 1024) });
  expect(big.status()).toBe(413);
  expect((await request.get('/api/v1/health')).status()).toBe(200);
});

test('cadastro e entrada pelo domínio do web: cookie __Host- HttpOnly, Secure e SameSite=Lax', async ({ page, context }) => {
  const email = await signupViaUi(page);
  await expectSynced(page);
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-irontrack_session');
  expect(cookie).toBeTruthy();
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('irontrack_session');
  const me = await page.request.get('/api/v1/me');
  expect(((await me.json()) as { account: { email: string } }).account.email).toBe(email);
});

test('CSRF pelo proxy: sem o cabeçalho ou de outra origem é recusado; sair encerra a sessão', async ({ page }) => {
  await signupViaUi(page);
  const noHeader = await page.request.post('/api/v1/auth/logout', { headers: { origin: ORIGIN } });
  expect(noHeader.status()).toBe(403);
  expect(((await noHeader.json()) as { error: { code: string } }).error.code).toBe('csrf_failed');
  const foreign = await page.request.post('/api/v1/auth/logout', { headers: { 'x-irontrack-csrf': '1', origin: 'https://atacante.invalid' } });
  expect(foreign.status()).toBe(403);
  expect((await page.request.get('/api/v1/me')).status()).toBe(200);

  await page.goto('./#/conta');
  await page.getByRole('button', { name: 'Sair desta conta' }).click();
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bem-vindo ao IronTrack' })).toBeVisible({ timeout: 15_000 });
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
});

test('recuperação de senha pelo proxy: link por e-mail, nova senha, entrada com ela', async ({ page, browser }) => {
  const email = await signupViaUi(page);
  const other = await browser.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { 'x-forwarded-for': `10.9.${randomBytes(1)[0]}.${randomBytes(1)[0]}` } });
  const p2 = await other.newPage();
  await p2.goto('./#/conta/esqueci');
  await p2.getByLabel('E-mail da conta').fill(email);
  await p2.getByRole('button', { name: 'Enviar link' }).click();
  await expect(p2.getByText(/Se houver uma conta com esse e-mail/)).toBeVisible();
  const link = await linkFromMail(p2, email, 'redefinir-senha');
  await p2.goto(link);
  await p2.getByLabel('Nova senha', { exact: true }).fill('nova-senha-forte-2027');
  await p2.getByLabel('Confirmar nova senha').fill('nova-senha-forte-2027');
  await p2.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(p2.getByText(/Senha alterada/)).toBeVisible();
  await loginViaUi(p2, email, 'nova-senha-forte-2027');
  await expectInApp(p2);
  // a sessão antiga (primeiro navegador) foi encerrada pela redefinição
  expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  await other.close();
});

test('IP do cliente atrás do proxy: cada IP tem o próprio limite e um IP forjado à esquerda não escapa', async ({ playwright }) => {
  const ip = `203.0.113.${randomBytes(1)[0] % 200 + 20}`;
  const signup = async (xff: string) => {
    const ctx = await playwright.request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { ...csrf, 'x-forwarded-for': xff } });
    const r = await ctx.post('/api/v1/auth/signup', { data: { name: 'Limite', email: uniqueEmail('limite'), password: PASSWORD, acceptTerms: true } });
    await ctx.dispose();
    return r.status();
  };
  // 5 cadastros por hora por IP
  for (let i = 0; i < 5; i++) expect(await signup(ip)).toBe(201);
  expect(await signup(ip)).toBe(429);
  // quem forja um IP à esquerda continua sendo o mesmo cliente (a borda/Caddy acrescentam à direita)
  expect(await signup(`198.51.100.77, ${ip}`)).toBe(429);
  // outro cliente não é afetado
  expect(await signup(`203.0.113.${randomBytes(1)[0] % 10 + 1}`)).toBe(201);
});

test('sincronização entre dois navegadores pelo proxy', async ({ page, browser }, info) => {
  const email = await signupViaUi(page);
  await page.goto('./#/');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('start-workout')).toBeVisible();
  await expectSynced(page);
  const ctx = await browser.newContext({ ...info.project.use, baseURL: ORIGIN, extraHTTPHeaders: { 'x-forwarded-for': `10.8.${randomBytes(1)[0]}.${randomBytes(1)[0]}` } });
  const b = await ctx.newPage();
  await loginViaUi(b, email);
  await expectInApp(b);
  await b.goto('./#/treinos');
  await expect(b.getByText(/ABC/).first()).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});

test('rotas do HashRouter, PWA offline e humanoide 3D sob a CSP real', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await welcome(page);
  await page.getByRole('button', { name: /Usar sem conta/ }).click();
  await page.goto('./#/treinos');
  await expect(page).toHaveURL(/#\/treinos$/);

  // humanoide 3D (three.js / WebGL) na biblioteca de exercícios
  await page.goto('./#/exercicios');
  await page.getByTestId('library-search').fill('Agachamento livre com barra');
  await page.getByTestId('library-item').filter({ hasText: 'Agachamento livre com barra' }).first().getByText('Agachamento livre com barra', { exact: true }).click();
  await expect(page.getByTestId('exercise-visual')).toHaveAttribute('data-status', 'animado');
  await expect(page.getByTestId('humanoid-canvas')).toBeVisible({ timeout: 20_000 });

  // service worker instalado e controlando; o app abre offline
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.context().setOffline(true);
  await page.reload();
  await page.goto('./#/historico');
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
  await page.context().setOffline(false);

  expect(violations).toEqual([]);
});
