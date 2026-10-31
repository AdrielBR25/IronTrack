// IA pela conta e proteções da API vistas do navegador (Prompt 21).
import { linkFromMail, newDevice, signupViaUi, uniqueEmail, expect, test } from './helpers';

test.use({ serviceWorkers: 'block' });

const ORIGIN = 'http://localhost:4174';

test('IA pela conta: sem token nem endereço; só provedores habilitados; e-mail confirmado exigido', async ({ page }) => {
  const email = await signupViaUi(page);
  await page.goto('./#/assistente');
  await page.getByTestId('mode-remote').check();
  await expect(page.getByTestId('gateway-token')).toHaveCount(0);
  await page.getByTestId('connect-account').click();
  await expect(page.getByTestId('provider-anthropic')).toBeVisible();
  await expect(page.getByTestId('provider-openai')).toHaveCount(0); // desabilitado no servidor
  await expect(page.getByTestId('admin-keys-help')).toContainText('ANTHROPIC_API_KEY');
  // sem e-mail confirmado o servidor recusa a geração
  const r = await page.request.post('/api/v1/ai/generate', { data: { provider: 'anthropic', model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'oi' }], maxOutputTokens: 50 }, headers: { 'x-irontrack-csrf': '1', origin: ORIGIN } });
  expect(r.status()).toBe(403);
  // confirma e pergunta de verdade (provedor simulado local), passando pela prévia e autorização
  await page.goto(await linkFromMail(page, email, 'verificar-email'));
  await expect(page.getByText('E-mail confirmado.')).toBeVisible();
  await page.goto('./#/assistente');
  await page.getByTestId('mode-remote').check();
  if (await page.getByTestId('connect-account').isVisible()) await page.getByTestId('connect-account').click();
  // Hotfix 21.2: servidor no ar não é "Claude disponível": antes do teste, a chave aparece como ainda não testada
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-health', 'unverified');
  await expect(page.getByTestId('ai-status')).toContainText('ainda não testada');
  // modelo que a chave não libera: o "Testar" (sem custo) marca indisponível
  await page.getByTestId('ai-remote-model').selectOption('claude-sonnet-5-5');
  await page.getByTestId('gateway-test').click();
  await expect(page.getByTestId('gateway-test-result')).toHaveAttribute('data-result', 'model_unavailable');
  await expect(page.locator('[data-testid="ai-remote-model"] option[value="claude-sonnet-5-5"]')).toBeDisabled();
  await page.getByTestId('ai-remote-model').selectOption('claude-haiku-5-5');
  await page.getByTestId('gateway-test').click();
  await expect(page.getByTestId('gateway-test-result')).toHaveAttribute('data-result', 'ok');
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-health', 'ok');
  await expect(page.getByTestId('ai-status')).toContainText('Anthropic Claude disponível');
  const selector = page.getByTestId('data-selector');
  await selector.locator('summary').click();
  await page.getByTestId('cat-profile_preferences').check();
  await page.getByLabel('Sua pergunta').fill('Como foi minha semana?');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('share-preview')).toBeVisible();
  await expect(page.getByTestId('preview-destination')).toContainText('Servidor do IronTrack (sua conta)');
  await page.getByTestId('preview-raw').locator('summary').click();
  await expect(page.getByTestId('preview-raw')).toContainText('Como foi minha semana?');
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-assistant')).toContainText('Resposta do provedor simulado', { timeout: 20_000 });
  const usage = await page.request.get('/api/v1/ai/usage');
  expect(((await usage.json()) as { requestsUsed: number }).requestsUsed).toBe(1);
});

test('API: alteração sem o cabeçalho anti-CSRF ou de outra origem é recusada', async ({ page }) => {
  await signupViaUi(page);
  const noHeader = await page.request.patch('/api/v1/me', { data: { name: 'X' }, headers: { origin: ORIGIN } });
  expect(noHeader.status()).toBe(403);
  const evil = await page.request.patch('/api/v1/me', { data: { name: 'X' }, headers: { origin: 'https://site-malicioso.exemplo', 'x-irontrack-csrf': '1' } });
  expect(evil.status()).toBe(403);
  const ok = await page.request.patch('/api/v1/me', { data: { name: 'Nome novo' }, headers: { origin: ORIGIN, 'x-irontrack-csrf': '1' } });
  expect(ok.status()).toBe(200);
});

test('API: uma conta não lê nem grava dados de outra (o ID enviado pelo cliente não autoriza nada)', async ({ page, browser }, info) => {
  await signupViaUi(page);
  const a = JSON.parse((await page.evaluate(() => localStorage.getItem('irontrack.account.v1')))!) as { id: string };
  const b = await newDevice(browser, info);
  await signupViaUi(b.page);
  const pull = await b.page.request.get(`/api/v1/sync/pull?cursor=0&accountId=${a.id}`);
  expect(pull.status()).toBe(409);
  const push = await b.page.request.post('/api/v1/sync/push', {
    data: { protocol: 'irontrack.sync.v1', deviceId: crypto.randomUUID(), accountId: a.id, ops: [{ opId: crypto.randomUUID(), collection: 'settings', entityId: 'settings', kind: 'put', baseVersion: 0, doc: { id: 'settings', userName: 'invasor' } }] },
    headers: { origin: ORIGIN, 'x-irontrack-csrf': '1' },
  });
  expect(push.status()).toBe(409);
  const exported = await page.request.get('/api/v1/me/export');
  expect(JSON.stringify(await exported.json())).not.toContain('invasor');
  await b.context.close();
});

test('API: cookie de sessão HttpOnly, cabeçalhos de segurança e respostas sem cache', async ({ page }) => {
  await signupViaUi(page);
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name.includes('irontrack_session'))!;
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('irontrack_session');
  const r = await page.request.get('/api/v1/me');
  const h = r.headers();
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['cache-control']).toContain('no-store');
  expect(JSON.stringify(await r.json())).not.toMatch(/password|hash|token/i);
});

test('API: muitas tentativas de entrada são limitadas, com mensagem clara', async ({ browser }, info) => {
  const d = await newDevice(browser, info);
  const email = uniqueEmail('limite');
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await d.page.request.post('/api/v1/auth/login', { data: { email, password: 'errada-1234567' }, headers: { origin: ORIGIN, 'x-irontrack-csrf': '1' } });
    last = r.status();
    if (last === 429) break;
  }
  expect(last).toBe(429);
  await d.page.goto('./#/conta/entrar');
  await d.page.getByLabel('E-mail', { exact: true }).fill(email);
  await d.page.getByLabel('Senha', { exact: true }).fill('errada-1234567');
  await d.page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(d.page.getByRole('alert')).toContainText('Muitas tentativas');
  await d.context.close();
});

test('saúde e prontidão da API', async ({ request }) => {
  expect((await (await request.get('/api/v1/health')).json()).status).toBe('ok');
  expect((await (await request.get('/api/v1/ready')).json()).status).toBe('ready');
});

test('telas da conta sem rolagem lateral em 360 px', async ({ page }) => {
  await signupViaUi(page);
  for (const r of ['./#/conta', './#/conta/sincronizacao', './#/conta/importar', './#/config']) {
    await page.goto(r);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), r).toBe(true);
  }
});
