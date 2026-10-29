// Utilitários dos E2E da nuvem (Prompt 21). Cada "aparelho" é um contexto de navegador independente (cookies e
// IndexedDB próprios) com um IP próprio (cabeçalho X-Forwarded-For), para os limites por IP não se misturarem.
import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { randomBytes } from 'node:crypto';

export const PASSWORD = 'barra-olimpica-2026';

const ip = () => `10.${[1, 2, 3].map(() => randomBytes(1)[0] % 250).join('.')}`;

/** `test` com IP próprio por teste no contexto padrão (cada teste é um "aparelho" diferente para os limites). */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip() });
    await use(context);
  },
});
export { expect };

export interface Device {
  context: BrowserContext;
  page: Page;
}

export async function newDevice(browser: Browser, info: TestInfo): Promise<Device> {
  const u = info.project.use;
  const context = await browser.newContext({
    ...(u.viewport ? { viewport: u.viewport } : {}),
    ...(u.userAgent ? { userAgent: u.userAgent } : {}),
    ...(u.deviceScaleFactor ? { deviceScaleFactor: u.deviceScaleFactor } : {}),
    ...(u.isMobile !== undefined ? { isMobile: u.isMobile } : {}),
    ...(u.hasTouch !== undefined ? { hasTouch: u.hasTouch } : {}),
    baseURL: u.baseURL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: { 'x-forwarded-for': ip() },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  return { context, page };
}

export const uniqueEmail = (tag = 'user') => `${tag}-${randomBytes(4).toString('hex')}@exemplo.com`;

export async function welcome(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Bem-vindo ao IronTrack' })).toBeVisible();
}

/** Cria conta pela tela e espera o app abrir no modo conta. */
export async function signupViaUi(page: Page, opts: { name?: string; email?: string } = {}): Promise<string> {
  const email = opts.email ?? uniqueEmail();
  await page.goto('./#/conta/criar');
  await page.getByLabel('Nome', { exact: true }).fill(opts.name ?? 'Atleta Teste');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirmar senha', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expectInApp(page);
  return email;
}

export async function loginViaUi(page: Page, email: string, password = PASSWORD) {
  await page.goto('./#/conta/entrar');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}

export async function expectInApp(page: Page) {
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toBeVisible({ timeout: 20_000 });
}

export async function expectSynced(page: Page) {
  // A gravação de um clique termina alguns ms depois dele; sem esta folga o chip ainda mostraria o estado anterior.
  await page.waitForTimeout(300);
  await expect(page.locator('[data-testid="sync-status"]:visible').first()).toHaveAttribute('data-state', 'synced', { timeout: 20_000 });
}

/** Mensagens da caixa de e-mail de teste da API (só existe com API_TEST_MODE). */
export async function mailbox(page: Page, email: string): Promise<{ subject: string; text: string }[]> {
  const r = await page.request.get(`/api/v1/__test__/mailbox?to=${encodeURIComponent(email)}`);
  expect(r.ok()).toBe(true);
  return ((await r.json()) as { messages: { subject: string; text: string }[] }).messages;
}

export async function linkFromMail(page: Page, email: string, contains: string): Promise<string> {
  let link = '';
  await expect
    .poll(async () => {
      const msgs = await mailbox(page, email);
      const m = msgs.reverse().find((x) => x.text.includes(contains));
      link = m ? (m.text.match(/https?:\/\/\S+/)?.[0] ?? '') : '';
      return link;
    })
    .not.toBe('');
  return link.replace(/^https?:\/\/[^/]+\//, './');
}

/** Pede sincronização agora pela tela de detalhes (sem esperar o intervalo automático). */
export async function syncNow(page: Page) {
  await page.goto('./#/conta/sincronizacao');
  await page.getByRole('button', { name: 'Sincronizar agora' }).click();
  await expect(page.getByRole('button', { name: 'Sincronizar agora' })).toBeEnabled({ timeout: 20_000 });
}

/** Lê uma tabela do banco da conta direto do IndexedDB (o que está gravado, não a tela). */
export function readAccountTable<T = Record<string, unknown>>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(async (t) => {
    const ptr = JSON.parse(localStorage.getItem('irontrack.account.v1') ?? 'null') as { id: string } | null;
    if (!ptr) return [];
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(`irontrack-acct-${ptr.id}`);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const all = req.result.transaction(t, 'readonly').objectStore(t).getAll();
        all.onsuccess = () => {
          req.result.close();
          resolve(all.result as never);
        };
      };
    });
  }, table) as Promise<T[]>;
}
