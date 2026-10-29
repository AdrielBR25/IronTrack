// Contas (Prompt 21): entrada, cadastro, confirmação de e-mail, recuperação e troca de senha, sessões, saída,
// exclusão, modo sem conta, temas e acessibilidade básica em 360 px.
import { PASSWORD, expectInApp, linkFromMail, loginViaUi, newDevice, signupViaUi, uniqueEmail, welcome, expect, test } from './helpers';

test.use({ serviceWorkers: 'block' });

test('tela de entrada: entrar, criar conta ou usar sem conta; sem rolagem lateral em 360 px', async ({ page }) => {
  await welcome(page);
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Usar sem conta/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('cadastro: validação acessível e requisitos da senha', async ({ page }) => {
  await page.goto('./#/conta/criar');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  const nome = page.getByLabel('Nome', { exact: true });
  await expect(nome).toHaveAttribute('aria-invalid', 'true');
  await expect(nome).toBeFocused();
  await expect(page.getByText('Para criar a conta, aceite os termos')).toBeVisible();
  await page.getByLabel('Senha', { exact: true }).fill('curta');
  await expect(page.getByRole('list', { name: 'Requisitos da senha' })).toContainText('Pelo menos 10 caracteres');
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar senha', { exact: true }).fill('outra-senha-2026');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page.getByText('As senhas não coincidem.')).toBeVisible();
});

test('criar conta abre o app no modo conta, sincronizado e com e-mail a confirmar', async ({ page }) => {
  const email = await signupViaUi(page);
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'synced', { timeout: 20_000 });
  await page.goto('./#/conta');
  await expect(page.getByRole('heading', { name: 'Minha conta' })).toBeVisible();
  await expect(page.getByRole('main').getByText(email).first()).toBeVisible();
  await expect(page.getByText('Não confirmado')).toBeVisible();
  // nada de senha ou token no armazenamento do navegador
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie);
  expect(stored).not.toContain(PASSWORD);
  expect(stored).not.toMatch(/irontrack_session/);
});

test('confirmação de e-mail pelo link', async ({ page }) => {
  const email = await signupViaUi(page);
  const link = await linkFromMail(page, email, 'verificar-email');
  await page.goto(link);
  await expect(page.getByText('E-mail confirmado.')).toBeVisible();
  await page.goto('./#/conta');
  await expect(page.getByText('Confirmado', { exact: true })).toBeVisible();
});

test('senha errada e cadastro duplicado: mensagens genéricas (sem revelar se o e-mail existe)', async ({ page, browser }, info) => {
  const email = await signupViaUi(page);
  const other = await newDevice(browser, info);
  await loginViaUi(other.page, email, 'senha-errada-2026');
  await expect(other.page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
  await loginViaUi(other.page, uniqueEmail('naoexiste'), 'senha-errada-2026');
  await expect(other.page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
  await other.page.goto('./#/conta/criar');
  await other.page.getByLabel('Nome', { exact: true }).fill('Outra');
  await other.page.getByLabel('E-mail', { exact: true }).fill(email);
  await other.page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await other.page.getByLabel('Confirmar senha', { exact: true }).fill(PASSWORD);
  await other.page.getByRole('checkbox').check();
  await other.page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(other.page.getByRole('alert')).toContainText('Não foi possível criar a conta com esses dados');
  await other.context.close();
});

test('sair e entrar de novo: os dados da conta voltam; sair avisa sobre pendências', async ({ page }) => {
  const email = await signupViaUi(page);
  await page.goto('./#/');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('start-workout')).toBeVisible();
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'synced', { timeout: 20_000 });
  await page.goto('./#/conta');
  await page.getByRole('button', { name: 'Sair desta conta' }).click();
  await expect(page.getByText('Tudo deste aparelho já está na nuvem.')).toBeVisible();
  await page.getByRole('checkbox').check(); // remove a cópia local: os dados têm de voltar da nuvem
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  // sair recarrega o app sozinho na tela de entrada
  await expect(page.getByRole('heading', { name: 'Bem-vindo ao IronTrack' })).toBeVisible({ timeout: 15_000 });
  await loginViaUi(page, email);
  await expectInApp(page);
  await expect(page.getByTestId('start-workout')).toBeVisible({ timeout: 20_000 });
});

test('recuperação de senha: link por e-mail, nova senha, sessões antigas encerradas', async ({ page, browser }, info) => {
  const email = await signupViaUi(page);
  const other = await newDevice(browser, info);
  await other.page.goto('./#/conta/esqueci');
  await other.page.getByLabel('E-mail da conta').fill(email);
  await other.page.getByRole('button', { name: 'Enviar link' }).click();
  await expect(other.page.getByText(/Se houver uma conta com esse e-mail/)).toBeVisible();
  const link = await linkFromMail(other.page, email, 'redefinir-senha');
  await other.page.goto(link);
  await other.page.getByLabel('Nova senha', { exact: true }).fill('nova-senha-forte-2027');
  await other.page.getByLabel('Confirmar nova senha').fill('nova-senha-forte-2027');
  await other.page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(other.page.getByText(/Senha alterada/)).toBeVisible();
  // o link é de uso único (sai da tela antes, para ela abrir de novo)
  await other.page.goto('./#/conta/entrar');
  await other.page.goto(link);
  await other.page.getByLabel('Nova senha', { exact: true }).fill('mais-uma-senha-2028');
  await other.page.getByLabel('Confirmar nova senha').fill('mais-uma-senha-2028');
  await other.page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(other.page.getByRole('alert')).toContainText('inválido, expirou ou já foi usado');
  // a sessão do primeiro aparelho foi encerrada
  await page.goto('./#/conta/sincronizacao');
  await page.getByRole('button', { name: 'Sincronizar agora' }).click();
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'auth_required', { timeout: 20_000 });
  await loginViaUi(page, email, 'nova-senha-forte-2027');
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'synced', { timeout: 20_000 });
  await other.context.close();
});

test('alterar senha em Minha conta', async ({ page }) => {
  const email = await signupViaUi(page);
  await page.goto('./#/conta');
  await page.getByRole('button', { name: 'Alterar senha' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Senha atual').fill(PASSWORD);
  await dlg.getByLabel('Nova senha', { exact: true }).fill('outra-senha-forte-2027');
  await dlg.getByLabel('Confirmar nova senha').fill('outra-senha-forte-2027');
  await dlg.getByRole('button', { name: 'Alterar senha' }).click();
  await expect(page.getByText(/Senha alterada/)).toBeVisible();
  const r = await page.request.post('/api/v1/auth/login', { data: { email, password: 'outra-senha-forte-2027' }, headers: { 'x-irontrack-csrf': '1', origin: 'http://localhost:4174' } });
  expect(r.status()).toBe(200);
});

test('sessões ativas: dois aparelhos, encerrar o outro pede nova entrada nele', async ({ page, browser }, info) => {
  const email = await signupViaUi(page);
  const b = await newDevice(browser, info);
  await loginViaUi(b.page, email);
  await expectInApp(b.page);
  await page.goto('./#/conta');
  await expect(page.getByText('Este aparelho', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Encerrar', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Encerrar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Encerrar', exact: true })).toHaveCount(0);
  await b.page.goto('./#/conta/sincronizacao');
  await b.page.getByRole('button', { name: 'Sincronizar agora' }).click();
  await expect(b.page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'auth_required', { timeout: 20_000 });
  await b.context.close();
});

test('excluir conta: confirmação forte; depois não é possível entrar', async ({ page }) => {
  const email = await signupViaUi(page);
  await page.goto('./#/conta');
  await page.getByRole('button', { name: 'Excluir conta' }).click();
  const dlg = page.getByRole('dialog');
  const confirm = dlg.getByRole('button', { name: 'Excluir definitivamente' });
  await expect(confirm).toBeDisabled();
  await dlg.getByLabel('Sua senha').fill(PASSWORD);
  await dlg.getByLabel('Digite "EXCLUIR" para confirmar').fill('EXCLUIR');
  await confirm.click();
  await welcome(page);
  await loginViaUi(page, email);
  await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
});

test('usar sem conta: app local como antes; Ajustes oferece entrar ou criar conta', async ({ page }) => {
  await welcome(page);
  await page.getByRole('button', { name: /Usar sem conta/ }).click();
  await expect(page.getByTestId('load-sample')).toBeVisible();
  await expect(page.getByTestId('sync-status')).toHaveCount(0);
  await page.goto('./#/config');
  await expect(page.getByTestId('account-card')).toContainText('Usando sem conta');
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).toContain('irontrack');
  expect(dbs.some((n) => n?.startsWith('irontrack-acct-'))).toBe(false);
});

test('tema claro e escuro na tela de entrada @desktop', async ({ browser }, info) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ baseURL: info.project.use.baseURL, colorScheme });
    const p = await ctx.newPage();
    await welcome(p);
    expect(await p.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(colorScheme === 'dark');
    const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe('');
    await ctx.close();
  }
});

test('exportar meus dados: arquivo no formato de backup, só com os dados da conta', async ({ page }) => {
  await signupViaUi(page);
  await page.goto('./#/');
  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('start-workout')).toBeVisible();
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'synced', { timeout: 20_000 });
  await page.goto('./#/conta');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar meus dados' }).click()]);
  const file = JSON.parse(await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'))) as { app: string; schemaVersion: number; data: { routines: unknown[]; photos: unknown[] } };
  expect(file).toMatchObject({ app: 'irontrack', schemaVersion: 8 });
  expect(file.data.routines.length).toBe(1);
  expect(file.data.photos).toEqual([]);
});
