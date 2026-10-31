// Hotfix 21.2: IA real pela conta com diagnóstico do provedor. Catálogo com estados, "Testar" sem custo, códigos de erro
// separados (chave recusada, faturamento, modelo, rede, e-mail não confirmado) e a tela: "conectado ao servidor" nunca
// vira "Claude disponível" sem confirmação do provedor; consentimento e prévia exata continuam antes de qualquer envio.
// Servidor SIMULADO (transporte falso): nenhuma rede, nenhuma chave real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AIAssistantPage from '@/pages/AIAssistantPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createAssistantService, type AssistantComposition } from '@/integrations/ai/assistantService';
import { createAccountTransport, createGatewayTransport } from '@/integrations/ai/gatewayTransport';
import { gatewayErrorCode, parseGatewayCatalog, type GatewayTransport } from '@/modules/ai/adapters/GatewayAIProvider';
import { assistantStatus, providerHealthInfo, testResultText } from '@/features/assistant/assistantModel';
import { forgetAssistantSession } from '@/features/assistant/assistantSession';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROTOCOL = 'irontrack.ai-gateway.v1';
type PStatus = string;
const catalogOf = (status: PStatus, available: boolean, models: Record<string, string> = {}) => ({
  protocol: PROTOCOL,
  providers: [
    {
      id: 'anthropic',
      displayName: 'Anthropic Claude',
      available,
      status,
      ...(status === 'ok' ? { checkedAt: '2026-10-31T12:00:00.000Z' } : {}),
      models: [
        { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', maxInputChars: 24000, maxOutputTokens: 1024, status: models['claude-haiku-5-5'] ?? 'unverified' },
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', maxInputChars: 24000, maxOutputTokens: 1024, status: models['claude-sonnet-5-5'] ?? 'unverified' },
      ],
    },
  ],
});
const errBody = (code: string) => ({ error: { code, message: 'frase fixa' } });

describe('contrato do catálogo e dos erros (sem tela)', () => {
  it('lê estado do provedor e dos modelos; valores fora da lista são ignorados', () => {
    const [p] = parseGatewayCatalog(catalogOf('billing', true, { 'claude-sonnet-5-5': 'unavailable' }));
    expect(p).toMatchObject({ status: 'billing', available: true, modelStatus: { 'claude-haiku-5-5': 'unverified', 'claude-sonnet-5-5': 'unavailable' } });
    const odd = catalogOf('qualquer-coisa', true, { 'claude-haiku-5-5': 'talvez' });
    const [q] = parseGatewayCatalog(odd);
    expect(q.status).toBeUndefined();
    expect(q.modelStatus).toEqual({ 'claude-sonnet-5-5': 'unverified' });
    // gateway P06 (sem diagnóstico): continua aceito
    const [g] = parseGatewayCatalog({ protocol: PROTOCOL, providers: [{ id: 'anthropic', displayName: 'A', available: true, models: [{ id: 'm', displayName: 'M', maxInputChars: 10, maxOutputTokens: 10 }] }] });
    expect(g.status).toBeUndefined();
  });

  it('códigos novos do servidor viram códigos próprios; e-mail não confirmado não derruba a conexão como "acesso negado"', () => {
    expect(gatewayErrorCode(503, errBody('provider_auth_failed'))).toBe('provider_auth_failed');
    expect(gatewayErrorCode(503, errBody('provider_billing'))).toBe('provider_billing');
    expect(gatewayErrorCode(503, errBody('provider_forbidden'))).toBe('provider_forbidden');
    expect(gatewayErrorCode(503, errBody('model_unavailable'))).toBe('model_unavailable');
    expect(gatewayErrorCode(502, errBody('provider_unreachable'))).toBe('provider_unreachable');
    expect(gatewayErrorCode(429, errBody('provider_rate_limited'))).toBe('rate_limited');
    expect(gatewayErrorCode(403, errBody('email_not_verified'))).toBe('email_not_verified');
    expect(gatewayErrorCode(401, errBody('unauthenticated'))).toBe('access_denied');
    expect(assistantStatus({ mode: 'remote', gatewayStatus: 'connected', providerAvailable: true, lastRunErrorCode: 'email_not_verified' })).toBe('email_unverified');
    expect(assistantStatus({ mode: 'remote', gatewayStatus: 'connected', providerAvailable: true, lastRunErrorCode: 'provider_billing' })).toBe('provider_unavailable');
  });

  it('textos: "não testada" nunca diz disponível; chave ausente orienta ANTHROPIC_API_KEY na Railway; nenhum texto pede a chave no app', () => {
    const unverified = providerHealthInfo('unverified', 'Anthropic Claude');
    expect(`${unverified.label} ${unverified.text}`).not.toMatch(/dispon[ií]vel/i);
    expect(unverified.label).toContain('ainda não testada');
    const missing = providerHealthInfo('missing_key', 'Anthropic Claude');
    expect(missing.text).toContain('ANTHROPIC_API_KEY');
    expect(missing.text).toContain('Railway');
    expect(missing.text).toContain('nunca é colada neste app');
    for (const s of ['ok', 'auth_failed', 'billing', 'rate_limited', 'network', 'forbidden', 'invalid_key_format'] as const) expect(providerHealthInfo(s, 'Anthropic Claude').label.length).toBeGreaterThan(5);
    expect(testResultText({ result: 'ok', status: 'ok' }, 'Anthropic Claude', 'Claude Haiku 5.5')).toContain('Nenhum token foi cobrado');
    expect(testResultText({ result: 'model_unavailable' }, 'Anthropic Claude', 'Claude Sonnet 5.5')).toContain('não está liberado');
  });

  it('transporte: "Testar" só pela conta (POST /api/v1/ai/test com anti-CSRF); o gateway P06 recusa a rota', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await createAccountTransport({ fetchImpl })({ method: 'POST', path: '/v1/test', body: { provider: 'anthropic' } });
    expect(calls[0].url).toBe('/api/v1/ai/test');
    expect((calls[0].init.headers as Record<string, string>)['x-irontrack-csrf']).toBe('1');
    expect(calls[0].init).toMatchObject({ credentials: 'same-origin', redirect: 'error', mode: 'same-origin' });
    const gw = createGatewayTransport({ origin: 'https://gateway.exemplo', token: 'x'.repeat(43), fetchImpl });
    await expect(gw({ method: 'POST', path: '/v1/test', body: {} })).rejects.toMatchObject({ code: 'request_invalid' });
  });
});

// ---------------------------------------------------------------- tela

let n = 0;
let root: Root | null = null;
let container: HTMLDivElement;
let comp: AssistantComposition;
let server: {
  catalog: () => unknown;
  test: (body: { provider: string; model?: string }) => { status: number; body: unknown };
  generate: (body: { model: string; messages: { content: string }[] }) => { status: number; body: unknown };
  seen: { path: string; body?: unknown }[];
};

const transport: GatewayTransport = async (req) => {
  const body = 'body' in req ? req.body : undefined;
  server.seen.push({ path: req.path, ...(body !== undefined ? { body } : {}) });
  if (req.path === '/v1/models') return { status: 200, body: server.catalog() };
  if (req.path === '/v1/test') return server.test(body as { provider: string; model?: string });
  return server.generate(body as { model: string; messages: { content: string }[] });
};

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: tempo esgotado');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function setValue(el: HTMLElement | null, value: string) {
  if (!el) throw new Error('elemento ausente');
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => {
    el.click();
  });
}

async function mount() {
  comp = createAssistantService({ latencyMs: 10, accountTransportFactory: () => transport });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AIAssistantPage deps={{ composition: comp, accountMode: true }} />
      </MemoryRouter>,
    );
  });
  await click($('mode-remote'));
  await click($('connect-account'));
  await waitFor(() => $('gateway-connected'));
}

async function ask(question: string) {
  const q = document.querySelector<HTMLTextAreaElement>('textarea');
  await setValue(q, question);
  await click($('ai-send'));
  await waitFor(() => $('share-preview'));
}

beforeEach(async () => {
  localStorage.clear();
  setDb(new IronTrackDB(`ai-account-diag-${++n}`));
  await db.open();
  let state: { status: string; available: boolean; models: Record<string, string> } = { status: 'unverified', available: true, models: {} };
  server = {
    seen: [],
    catalog: () => catalogOf(state.status, state.available, state.models),
    test: (b) => {
      if (b.model === 'claude-sonnet-5-5') {
        state = { ...state, models: { ...state.models, 'claude-sonnet-5-5': 'unavailable' } };
        return { status: 200, body: { provider: 'anthropic', model: b.model, result: 'model_unavailable', status: state.status, modelStatus: 'unavailable', paid: false } };
      }
      state = { status: 'ok', available: true, models: { ...state.models, [b.model ?? 'claude-haiku-5-5']: 'ok' } };
      return { status: 200, body: { provider: 'anthropic', model: b.model ?? 'claude-haiku-5-5', result: 'ok', status: 'ok', modelStatus: 'ok', checkedAt: '2026-10-31T12:00:00.000Z', paid: false } };
    },
    generate: (b) => ({ status: 200, body: { provider: 'anthropic', model: b.model, output: { type: 'text', text: 'Resposta do Claude (simulada).' }, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } }),
  };
  (server as { reset?: (s: typeof state) => void }).reset = (s) => (state = s);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  forgetAssistantSession();
  db.close();
});

const reset = (s: { status: string; available: boolean; models?: Record<string, string> }) => (server as unknown as { reset: (x: unknown) => void }).reset({ models: {}, ...s });

describe('tela da IA pela conta', () => {
  it('conectar não afirma que o Claude está disponível; Testar (sem custo) confirma; a resposta real aparece depois da prévia e da autorização', async () => {
    await mount();
    // ao conectar: só o catálogo (nenhum teste, nenhuma geração)
    expect(server.seen.map((s) => s.path)).toEqual(['/v1/models']);
    expect($('ai-status')!.dataset.health).toBe('unverified');
    expect($('ai-status')!.textContent).toContain('chave configurada, ainda não testada');
    expect($('ai-status')!.textContent).not.toMatch(/Anthropic Claude disponível/);
    expect($('provider-health-anthropic')!.textContent).toBe('chave configurada, ainda não testada');

    await setValue($('ai-remote-model'), 'claude-haiku-5-5');
    await click($('gateway-test'));
    await waitFor(() => $('gateway-test-result')!.dataset.result === 'ok');
    expect(server.seen.find((s) => s.path === '/v1/test')!.body).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect($('gateway-test-result')!.textContent).toContain('Nenhum token foi cobrado');
    expect($('ai-status')!.dataset.health).toBe('ok');
    expect($('ai-status')!.textContent).toContain('Anthropic Claude disponível');

    await ask('Como foi meu treino de pernas?');
    // consentimento: nada foi enviado ainda; a prévia mostra o conteúdo exato e o destino
    expect(server.seen.some((s) => s.path === '/v1/generate')).toBe(false);
    expect($('preview-destination')!.textContent).toContain('Servidor do IronTrack (sua conta)');
    expect($('preview-raw')!.textContent).toContain('Como foi meu treino de pernas?');
    await click($('preview-authorize'));
    await waitFor(() => document.querySelector('[data-testid="chat-assistant"]'));
    expect(document.querySelector('[data-testid="chat-assistant"]')!.textContent).toContain('Resposta do Claude (simulada).');
    const sent = server.seen.find((s) => s.path === '/v1/generate')!.body as { provider: string; model: string; messages: { content: string }[] };
    expect(sent).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    expect(JSON.stringify(sent)).toContain('Como foi meu treino de pernas?');
  });

  it('modelo que a chave não libera: Testar marca "indisponível" e o envio é bloqueado sem chamar o servidor', async () => {
    await mount();
    await setValue($('ai-remote-model'), 'claude-sonnet-5-5');
    await click($('gateway-test'));
    await waitFor(() => $('gateway-test-result')!.dataset.result === 'model_unavailable');
    expect($('gateway-test-result')!.textContent).toContain('não está liberado');
    const opt = document.querySelector<HTMLOptionElement>('[data-testid="ai-remote-model"] option[value="claude-sonnet-5-5"]')!;
    expect(opt.disabled).toBe(true);
    expect(opt.textContent).toContain('indisponível');
  });

  it('chave ausente: estado claro com a orientação para a Railway; modelo bloqueado e nada enviado', async () => {
    reset({ status: 'missing_key', available: false });
    await mount();
    expect($('ai-status')!.dataset.health).toBe('missing_key');
    expect($('ai-status')!.textContent).toContain('ANTHROPIC_API_KEY');
    expect($('ai-status')!.textContent).toContain('Railway');
    expect(($('ai-remote-model') as HTMLSelectElement).disabled).toBe(true);
    expect($('ai-remote-model')!.textContent).toContain('sem chave no servidor');
  });

  it('faturamento na pergunta real: mensagem própria e estado atualizado sem esconder o problema', async () => {
    await mount();
    server.generate = () => ({ status: 503, body: errBody('provider_billing') });
    await setValue($('ai-remote-model'), 'claude-haiku-5-5');
    await ask('Pergunta qualquer');
    await click($('preview-authorize'));
    await waitFor(() => document.querySelector('[data-testid="chat-user"][data-status="failed"]'));
    expect(document.body.textContent).toContain('falta de créditos ou problema de faturamento');
    expect($('ai-status')!.dataset.health).toBe('billing');
  });

  it('chave recusada na pergunta real: provedor fica indisponível; e-mail não confirmado não desconecta a conta', async () => {
    await mount();
    server.generate = () => ({ status: 503, body: errBody('provider_auth_failed') });
    await setValue($('ai-remote-model'), 'claude-haiku-5-5');
    await ask('Pergunta qualquer');
    await click($('preview-authorize'));
    await waitFor(() => $('ai-status')!.dataset.health === 'auth_failed');
    expect($('ai-status')!.textContent).toContain('recusou a chave');
    expect(document.body.textContent).toContain('inválida ou revogada');

    server.test = () => ({ status: 403, body: { error: { code: 'email_not_verified', message: 'x' } } });
    await click($('gateway-test'));
    await waitFor(() => $('gateway-test-result')!.textContent!.includes('Confirme seu e-mail'));
    expect($('gateway-connected')).not.toBeNull();
  });
});
