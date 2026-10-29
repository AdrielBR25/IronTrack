import { expect, test, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createGateway, type Gateway, type GatewayLogEvent } from '../services/ai-gateway/src/gateway.ts';
import { issueCredential, revokeCredential } from '../services/ai-gateway/src/credentials.ts';
import { freshStart, loadSample, storageOutsideAux } from './helpers';

// Assistente remoto (IronTrack 2.0 F01/P06) contra o GATEWAY REAL rodando localmente, com um
// "provedor" simulado também local (formato da Messages API da Anthropic). Sem internet, sem chave
// real e sem custo. Token de acesso e chave falsa gerados na execução. Dados fictícios.

const token = randomBytes(32).toString('base64url');
const fakeKey = `sk-ant-e2e-${randomBytes(16).toString('hex')}`;
let upstream: Server;
let gatewayServer: Server;
let gatewayUrl = '';
let upstreamBodies: Record<string, unknown>[] = [];
let upstreamMode: 'ok' | 'hang' = 'ok';
let upstreamClosed = 0;
let logs: GatewayLogEvent[] = [];
let gateway: Gateway;
let baseConfig: Record<string, unknown>;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const readJson = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(JSON.parse(d)));
  });

test.beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const body = await readJson(req);
    upstreamBodies.push(body);
    if (upstreamMode === 'hang') {
      res.on('close', () => upstreamClosed++);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Resposta do provedor simulado local.' }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 8 } }));
  });
  const upstreamUrl = await listen(upstream);
  baseConfig = {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: ['http://localhost:4173'],
    clients: [{ id: 'e2e', tokenSha256: createHash('sha256').update(token).digest('hex'), enabled: true }],
    limits: { requestsPerMinute: 100, upstreamTimeoutMs: 20_000 },
    providers: {
      anthropic: { enabled: true, displayName: 'Anthropic Claude', apiKeyEnv: 'ANTHROPIC_API_KEY', apiVersion: '2026-10-21', baseUrl: upstreamUrl, models: [{ id: 'modelo-e2e', displayName: 'Modelo E2E', maxInputChars: 20_000, maxOutputTokens: 600 }] },
      openai: { enabled: true, displayName: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'modelo-o', displayName: 'Modelo O', maxInputChars: 20_000, maxOutputTokens: 600 }] },
    },
  };
  const gw = createGateway({
    config: baseConfig,
    env: { ANTHROPIC_API_KEY: fakeKey },
    logger: (e) => logs.push(e),
  });
  gateway = gw;
  gatewayServer = gw.server;
  gatewayUrl = await listen(gatewayServer);
});

test.afterAll(async () => {
  for (const s of [gatewayServer, upstream]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

test.beforeEach(() => {
  gateway.reload(baseConfig);
  upstreamBodies = [];
  upstreamMode = 'ok';
  logs = [];
});

async function openAssistant(page: Page) {
  await page.getByRole('link', { name: 'Assistente IA' }).filter({ visible: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Assistente IA' })).toBeVisible();
}

/** Ajuste P20: o endereço do servidor fica nas configurações avançadas (salvo no aparelho), não na conexão. */
async function setGatewayAddress(page: Page, url: string) {
  const adv = page.getByTestId('gateway-advanced');
  if (!(await adv.evaluate((d) => (d as HTMLDetailsElement).open))) await adv.locator('summary').click();
  await page.getByTestId('gateway-url').fill(url);
  await page.getByTestId('gateway-url-save').click();
  await expect(page.getByTestId('gateway-origin')).toHaveText(url);
  await adv.locator('summary').click();
}

/** Provedor → (endereço, se mudou) → token → Conectar. */
async function connect(page: Page, tok = token, url = gatewayUrl, provider = 'anthropic') {
  await page.getByTestId('mode-remote').check();
  await page.getByTestId(`provider-${provider}`).check();
  if ((await page.getByTestId('gateway-origin').textContent()) !== url) await setGatewayAddress(page, url);
  await page.getByTestId('gateway-token').fill(tok);
  await page.getByTestId('gateway-connect').click();
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('assistente remoto: gateway local real, seleção explícita, prévia com destino e consentimento', async ({ page }, info) => {
  const gatewayRequests: string[] = [];
  page.on('request', (r) => r.url().startsWith(gatewayUrl) && gatewayRequests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await freshStart(page);
  await loadSample(page);
  await openAssistant(page);

  // Padrão: simulado, sem chamadas ao gateway.
  await expect(page.getByTestId('mode-simulated')).toBeChecked();
  await expect(page.getByTestId('demo-banner')).toBeVisible();

  // Token errado: recusado pelo servidor.
  await connect(page, randomBytes(32).toString('base64url'));
  await expect(page.getByTestId('gateway-error')).toContainText('recusou o acesso');
  await expect(page.getByTestId('remote-banner')).toContainText('sai do aparelho');

  // Token certo: catálogo; o provedor é o escolhido no passo 1, o modelo não é escolhido sozinho.
  await page.getByTestId('gateway-token').fill(token);
  await page.getByTestId('gateway-connect').click();
  await expect(page.getByTestId('gateway-connected')).toBeVisible();
  await expect(page.getByTestId('ai-remote-model')).toHaveValue('');
  // OpenAI permitido no gateway, mas sem chave no servidor: sem modelos funcionais.
  await page.getByTestId('provider-openai').check();
  await expect(page.getByTestId('provider-no-key')).toBeVisible();
  await expect(page.getByTestId('ai-remote-model')).toBeDisabled();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-remoto-conectado.png'), fullPage: true });

  await page.getByTestId('provider-anthropic').check();
  await page.getByTestId('ai-remote-model').selectOption('modelo-e2e');
  const selector = page.getByTestId('data-selector');
  await selector.locator('summary').click();
  await page.getByTestId('cat-profile_preferences').check();
  await page.getByLabel('Sua pergunta').fill('Quantos dias por semana eu treino?');
  await page.getByTestId('ai-send').click();

  const preview = page.getByTestId('share-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('preview-remote-note')).toContainText('Compartilhamento externo');
  await expect(page.getByTestId('preview-destination')).toHaveText(`${gatewayUrl} → Anthropic Claude`);
  await expect(page.getByTestId('preview-model')).toContainText('Modelo E2E');
  await preview.getByText('Ver o conteúdo exato da solicitação').click();
  await expect(page.getByTestId('preview-raw')).toContainText('Quantos dias por semana eu treino?');
  expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-remoto-previa.png') });
  // Até aqui: só o catálogo (duas tentativas de conexão), nenhuma geração.
  expect(gatewayRequests.filter((r) => r.endsWith('/v1/generate'))).toEqual([]);
  expect(upstreamBodies).toHaveLength(0);

  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-assistant')).toContainText('Resposta do provedor simulado local.');
  await expect(page.getByTestId('chat-remote-badge')).toContainText('Anthropic Claude');
  await expect(page.getByTestId('chat-user')).toHaveAttribute('data-status', 'sent');
  expect(upstreamBodies).toHaveLength(1);
  const sent = JSON.stringify(upstreamBodies[0]);
  expect(sent).toContain('Quantos dias por semana eu treino?');
  expect(upstreamBodies[0]).toMatchObject({ model: 'modelo-e2e', max_tokens: 512 });
  // Logs do gateway sem conteúdo.
  const logText = JSON.stringify(logs);
  expect(logText).not.toContain('Quantos dias');
  expect(logText).not.toContain(token);
  expect(logText).not.toContain(fakeKey);
  // Nada guardado no navegador além da origem do servidor (configurações avançadas).
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  const stored = await storageOutsideAux(page);
  expect(stored.other).toEqual([]);
  expect(stored.auxText).not.toContain('Quantos dias');
  expect(stored.auxText).not.toContain(token);
  expect(await page.evaluate(() => localStorage.getItem('irontrack.aiGateway.v1'))).toBe(JSON.stringify({ v: 1, origin: gatewayUrl }));
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-remoto-resposta.png'), fullPage: true });

  // Recarregar esquece o token: volta ao modo simulado. O endereço continua resolvido (não é digitado de novo).
  await page.reload();
  await expect(page.getByTestId('mode-simulated')).toBeChecked();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await page.getByTestId('mode-remote').check();
  await expect(page.getByTestId('gateway-origin')).toHaveText(gatewayUrl);
  await expect(page.getByTestId('no-gateway')).toHaveCount(0);
  await expect(page.getByTestId('gateway-token')).toHaveValue('');
});

test('assistente remoto: cancelamento, gateway indisponível e simulado intacto', async ({ page }) => {
  await freshStart(page);
  await openAssistant(page);

  // Gateway fora do ar (porta fechada).
  const closed = createServer();
  const closedUrl = await listen(closed);
  await new Promise((r) => closed.close(r));
  await connect(page, token, closedUrl);
  await expect(page.getByTestId('gateway-error')).toContainText('Não foi possível contatar o servidor seguro');

  // Gateway disponível, provedor sem resposta: cancelar fecha a conexão com o provedor.
  upstreamMode = 'hang';
  await connect(page, token, gatewayUrl);
  await page.getByTestId('ai-remote-model').selectOption('modelo-e2e');
  await page.getByLabel('Sua pergunta').fill('Pergunta que será cancelada');
  await page.getByTestId('ai-send').click();
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-running')).toContainText('Anthropic Claude');
  await expect.poll(() => upstreamBodies.length).toBe(1);
  await page.getByTestId('ai-cancel-run').click();
  await expect(page.getByTestId('chat-user')).toHaveAttribute('data-status', 'cancelled');
  await expect.poll(() => upstreamClosed).toBeGreaterThan(0);

  // Desconectar e voltar ao simulado: funciona como antes, sem rede.
  await page.getByTestId('gateway-disconnect').click();
  await page.getByTestId('mode-simulated').check();
  await page.getByLabel('Sua pergunta').fill('Pergunta simulada');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('preview-simulated-note')).toBeVisible();
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-assistant').last()).toContainText('[SIMULAÇÃO]');
});

test('assistente remoto: token revogado no gateway em execução é recusado, esquecido e substituído pelo novo (P07)', async ({ page }) => {
  await freshStart(page);
  await openAssistant(page);
  await connect(page);
  await expect(page.getByTestId('gateway-connected')).toBeVisible();
  await page.getByTestId('ai-remote-model').selectOption('modelo-e2e');

  // Operador rotaciona: emite um token novo e revoga o antigo; o gateway recarrega sem reiniciar.
  const issued = issueCredential(baseConfig, 'e2e');
  const legacyKeyId = `legacy-${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  expect(gateway.reload(revokeCredential(issued.config, legacyKeyId)).ok).toBe(true);

  await page.getByLabel('Sua pergunta').fill('Pergunta com token revogado');
  await page.getByTestId('ai-send').click();
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-user')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('chat-error')).toContainText('revogado ou expirado');
  await expect(page.getByTestId('gateway-error')).toContainText('esquecido nesta página');
  expect(upstreamBodies).toHaveLength(0);
  expect(logs.some((l) => l.status === 401 && l.route === 'POST /v1/generate')).toBe(true);

  // Novo token: conecta e funciona.
  await page.getByTestId('gateway-token').fill(issued.token);
  await page.getByTestId('gateway-connect').click();
  await expect(page.getByTestId('gateway-connected')).toBeVisible();
  await page.getByTestId('ai-remote-model').selectOption('modelo-e2e');
  await page.getByLabel('Sua pergunta').fill('Pergunta com token novo');
  await page.getByTestId('ai-send').click();
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-assistant').last()).toContainText('Resposta do provedor simulado local.');
  expect(logs.find((l) => l.status === 200 && l.route === 'POST /v1/generate')?.keyId).toBe(issued.keyId);
  // Nenhum token aparece nos logs nem no armazenamento do navegador.
  expect(JSON.stringify(logs)).not.toContain(issued.token);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain(issued.token);
  expect(stored).not.toContain(token);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('assistente (P20): passo a passo, estados da conexão, testar, metas no contexto, sessão mantida ao navegar', async ({ page }, info) => {
  await freshStart(page);
  await loadSample(page);
  await openAssistant(page);
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'local');

  // Modo remoto sem servidor configurado: estado e mensagem próprios; provedor escolhido antes.
  await page.getByTestId('mode-remote').check();
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'no_gateway');
  await expect(page.getByTestId('no-gateway')).toBeVisible();
  await page.getByTestId('provider-anthropic').check();

  // Token errado → falha de autenticação; gateway fechado → inacessível.
  await connect(page, randomBytes(32).toString('base64url'));
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'auth_failure');
  const closed = createServer();
  const closedUrl = await listen(closed);
  await new Promise((r) => closed.close(r));
  await connect(page, token, closedUrl);
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'gateway_unreachable');

  // Certo: conectado com o provedor escolhido; testar conexão só lê o catálogo.
  await connect(page, token, gatewayUrl);
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('provider-anthropic')).toBeChecked();
  await page.getByTestId('gateway-test').click();
  await expect(page.getByTestId('gateway-test-result')).toContainText('Conexão ok');
  await page.getByTestId('ai-remote-model').selectOption('modelo-e2e');
  await expect(page.getByTestId('setup-confirm')).toContainText('Anthropic Claude');
  await page.getByTestId('setup-start-chat').click();
  await expect(page.getByLabel('Sua pergunta')).toBeFocused();
  expect(upstreamBodies).toHaveLength(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-passo-a-passo.png'), fullPage: true });

  // Metas na lista de dados (sem metas cadastradas: sem dados, nada inventado).
  const selector = page.getByTestId('data-selector');
  await selector.locator('summary').click();
  await expect(page.getByTestId('cat-training_goals')).toBeVisible();

  // Pergunta sobre exercício do catálogo: resposta local, nada vai ao gateway.
  await page.getByLabel('Sua pergunta').fill('Quais músculos o Leg press trabalha?');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('chat-local-badge')).toBeVisible();
  expect(upstreamBodies).toHaveLength(0);
  // "Perguntar à IA mesmo assim" segue o fluxo normal: prévia e autorização.
  await page.getByTestId('chat-ask-ai').click();
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('share-preview')).toBeVisible();
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-remote-badge')).toBeVisible();
  expect(upstreamBodies).toHaveLength(1);

  // Navegar e voltar: conexão e conversa continuam (só na memória); recarregar esquece.
  await page.getByRole('link', { name: 'Início' }).filter({ visible: true }).first().click();
  await openAssistant(page);
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('chat-remote-badge')).toBeVisible();
  const stored = await storageOutsideAux(page);
  expect(stored.other).toEqual([]);
  expect(stored.auxText).not.toContain(token);
  await page.getByTestId('ai-clear').click();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'local');
});

test('conexão simplificada (ajuste P20): provedores, links oficiais, sem servidor, chave × token, cancelar, desconectar, offline', async ({ page, context }, info) => {
  // As páginas oficiais são simuladas localmente (sem internet): confere o destino exato e a ausência de Referer.
  const opened: { url: string; referer?: string }[] = [];
  for (const host of ['platform.openai.com', 'console.anthropic.com', 'aistudio.google.com'])
    await context.route(`https://${host}/**`, (r) => {
      opened.push({ url: r.request().url(), referer: r.request().headers()['referer'] });
      return r.fulfill({ status: 200, contentType: 'text/html', body: '<title>página oficial (simulada)</title>' });
    });
  await freshStart(page);
  await openAssistant(page);
  await page.getByTestId('mode-remote').check();

  // Sem servidor: mensagem clara, token e conexão bloqueados, avançado recolhido.
  await expect(page.getByTestId('no-gateway')).toContainText('Para conectar uma IA real, é necessário configurar o servidor seguro do IronTrack.');
  await expect(page.getByTestId('gateway-advanced')).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('gateway-token')).toBeDisabled();

  const presets = [
    ['openai', 'OpenAI', 'https://platform.openai.com/api-keys'],
    ['anthropic', 'Anthropic / Claude', 'https://console.anthropic.com/settings/keys'],
    ['gemini', 'Google Gemini', 'https://aistudio.google.com/app/apikey'],
  ] as const;
  for (const [id, name, url] of presets) {
    await page.getByTestId(`provider-${id}`).check();
    await expect(page.getByTestId('selected-provider')).toContainText(name);
    const link = page.getByTestId('get-api-key');
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('target', '_blank');
    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe(url);
    await popup.close();
  }
  expect(opened.map((o) => o.url)).toEqual(presets.map((p) => p[2]));
  expect(opened.every((o) => !o.referer)).toBe(true);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('conexao-sem-servidor.png'), fullPage: true });

  // Configurar o servidor (avançado): a API do provedor é recusada; o gateway local é aceito.
  await page.getByTestId('open-advanced').click();
  await page.getByTestId('gateway-url').fill('https://api.openai.com');
  await page.getByTestId('gateway-url-save').click();
  await expect(page.getByTestId('gateway-url-message')).toContainText('API do provedor');
  await setGatewayAddress(page, gatewayUrl);
  await expect(page.getByTestId('no-gateway')).toHaveCount(0);

  // Chave de provedor no campo do token: recusada e limpa, nada enviado.
  const gwRequests: string[] = [];
  page.on('request', (r) => r.url().startsWith(gatewayUrl) && gwRequests.push(r.url()));
  await page.getByTestId('provider-anthropic').check();
  await page.getByTestId('gateway-token').fill(fakeKey);
  await page.getByTestId('gateway-connect').click();
  await expect(page.getByTestId('gateway-error')).toContainText('não o token do servidor');
  await expect(page.getByTestId('gateway-token')).toHaveValue('');
  expect(gwRequests).toEqual([]);

  // Mostrar/ocultar.
  await page.getByTestId('gateway-token').fill(token);
  await expect(page.getByTestId('gateway-token')).toHaveAttribute('type', 'password');
  await page.getByTestId('gateway-token-toggle').click();
  await expect(page.getByTestId('gateway-token')).toHaveAttribute('type', 'text');
  await page.getByTestId('gateway-token-toggle').click();

  // Conectar → modelo → pronto; desconectar limpa o token.
  await page.getByTestId('gateway-connect').click();
  await expect(page.getByTestId('gateway-connected')).toBeVisible();
  await page.getByTestId('ai-remote-model').selectOption('modelo-e2e');
  await expect(page.getByTestId('setup-confirm')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('conexao-pronta.png'), fullPage: true });
  await page.getByTestId('gateway-disconnect').click();
  await expect(page.getByTestId('gateway-token')).toHaveValue('');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain(token);
  expect(stored).not.toContain(fakeKey);

  // Offline: conectar falha com mensagem clara; o modo local continua respondendo.
  await context.setOffline(true);
  await page.getByTestId('gateway-token').fill(token);
  await page.getByTestId('gateway-connect').click();
  await expect(page.getByTestId('ai-status')).toHaveAttribute('data-status', 'gateway_unreachable');
  await page.getByTestId('mode-simulated').check();
  await page.getByLabel('Sua pergunta').fill('Pergunta offline');
  await page.getByTestId('ai-send').click();
  await page.getByTestId('preview-authorize').click();
  await expect(page.getByTestId('chat-assistant').last()).toContainText('[SIMULAÇÃO]');
  await context.setOffline(false);

  // Esquecer o endereço volta a "sem servidor".
  await page.getByTestId('mode-remote').check();
  await page.getByTestId('gateway-advanced').locator('summary').click();
  await page.getByTestId('gateway-url-forget').click();
  await expect(page.getByTestId('no-gateway')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('irontrack.aiGateway.v1'))).toBeNull();
});

test('conexão simplificada (ajuste P20): cancelar uma conexão em andamento', async ({ page }) => {
  // Servidor que nunca responde ao catálogo.
  const stuck = createServer(() => undefined);
  const stuckUrl = await listen(stuck);
  try {
    await freshStart(page);
    await openAssistant(page);
    await connect(page, token, stuckUrl);
    await expect(page.getByTestId('gateway-cancel')).toBeVisible();
    await page.getByTestId('gateway-cancel').click();
    await expect(page.getByTestId('gateway-connect')).toBeVisible();
    await expect(page.getByTestId('gateway-connected')).toHaveCount(0);
    await expect(page.getByTestId('gateway-error')).toHaveText('');
  } finally {
    stuck.closeAllConnections();
    await new Promise((r) => stuck.close(r));
  }
});
