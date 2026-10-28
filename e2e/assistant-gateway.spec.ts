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

async function connect(page: Page, tok = token, url = gatewayUrl) {
  await page.getByTestId('mode-remote').check();
  await page.getByTestId('gateway-url').fill(url);
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

  // Token certo: catálogo; nada escolhido automaticamente.
  await page.getByTestId('gateway-token').fill(token);
  await page.getByTestId('gateway-connect').click();
  await expect(page.getByTestId('gateway-origin')).toHaveText(gatewayUrl);
  await expect(page.getByTestId('ai-provider')).toHaveValue('');
  await expect(page.getByTestId('ai-provider').locator('option', { hasText: 'OpenAI' })).toBeDisabled();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-remoto-conectado.png'), fullPage: true });

  await page.getByTestId('ai-provider').selectOption('anthropic');
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
  // Nada guardado no navegador.
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  const stored = await storageOutsideAux(page);
  expect(stored.other).toEqual([]);
  expect(stored.auxText).not.toContain('Quantos dias');
  expect(stored.auxText).not.toContain(token);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistente-remoto-resposta.png'), fullPage: true });

  // Recarregar esquece o gateway e o token: volta ao modo simulado.
  await page.reload();
  await expect(page.getByTestId('mode-simulated')).toBeChecked();
  await expect(page.getByTestId('chat-empty')).toBeVisible();
});

test('assistente remoto: cancelamento, gateway indisponível e simulado intacto', async ({ page }) => {
  await freshStart(page);
  await openAssistant(page);

  // Gateway fora do ar (porta fechada).
  const closed = createServer();
  const closedUrl = await listen(closed);
  await new Promise((r) => closed.close(r));
  await connect(page, token, closedUrl);
  await expect(page.getByTestId('gateway-error')).toContainText('Não foi possível contatar o gateway');

  // Gateway disponível, provedor sem resposta: cancelar fecha a conexão com o provedor.
  upstreamMode = 'hang';
  await page.getByTestId('gateway-url').fill(gatewayUrl);
  await page.getByTestId('gateway-connect').click();
  await page.getByTestId('ai-provider').selectOption('anthropic');
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
  await expect(page.getByTestId('gateway-origin')).toHaveText(gatewayUrl);
  await page.getByTestId('ai-provider').selectOption('anthropic');
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
  await expect(page.getByTestId('gateway-origin')).toHaveText(gatewayUrl);
  await page.getByTestId('ai-provider').selectOption('anthropic');
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
