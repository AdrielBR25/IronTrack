// Ajuste do Prompt 20: conexão simplificada com provedores pré-configurados. Confere provedores e links oficiais,
// host automático (aparelho → publicação → nenhum), ausência de gateway, token × chave de provedor, mostrar/ocultar,
// colar, cancelamento, desconexão, modelo indisponível, limpeza de credenciais e privacidade.
// Gateway SIMULADO (fetch falso). Tokens e chaves fictícios, gerados na execução.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AIAssistantPage from '@/pages/AIAssistantPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createAssistantService, type AssistantComposition } from '@/integrations/ai/assistantService';
import { GATEWAY_ENDPOINT_KEY, checkGatewayOrigin, forgetGatewayOrigin, resolveGatewayEndpoint, saveGatewayOrigin } from '@/integrations/ai/gatewayEndpoint';
import { PROVIDER_PRESETS, isOfficialKeysUrl, presetById, providerKeyKind } from '@/integrations/ai/providerPresets';
import { checkAccessToken } from '@/features/assistant/RemoteSetup';
import { assistantStatus } from '@/features/assistant/assistantModel';
import { forgetAssistantSession } from '@/features/assistant/assistantSession';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
const TOKEN = rnd(43);
const FAKE_OPENAI_KEY = `sk-proj-${rnd(60)}`;
const FAKE_ANTHROPIC_KEY = `sk-ant-api03-${rnd(40)}`;
const FAKE_GEMINI_KEY = `AIza${rnd(35)}`;
const GW = 'https://gateway.exemplo';
const CATALOG = {
  protocol: 'irontrack.ai-gateway.v1',
  providers: [
    { id: 'anthropic', displayName: 'Anthropic Claude', available: true, models: [{ id: 'modelo-c', displayName: 'Modelo C', maxInputChars: 20000, maxOutputTokens: 800 }] },
    { id: 'openai', displayName: 'OpenAI', available: true, models: [{ id: 'modelo-o', displayName: 'Modelo O', maxInputChars: 20000, maxOutputTokens: 800 }] },
    { id: 'gemini', displayName: 'Google Gemini', available: false, models: [{ id: 'modelo-g', displayName: 'Modelo G', maxInputChars: 20000, maxOutputTokens: 800 }] },
  ],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let n = 0;
let root: Root | null = null;
let container: HTMLDivElement;
let comp: AssistantComposition;
let requests: { url: string; auth?: string }[] = [];
let catalogResponse: (signal?: AbortSignal | null) => Promise<Response>;
let onGenerate: () => Promise<Response>;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, auth: (init?.headers as Record<string, string>)?.authorization });
  if (url === `${GW}/v1/models`) return catalogResponse(init?.signal);
  if (url === `${GW}/v1/generate`) return onGenerate();
  return json(404, { error: { code: 'not_found' } });
}) as unknown as typeof fetch;

async function mount() {
  comp = createAssistantService({ latencyMs: 10, fetchImpl });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AIAssistantPage deps={{ composition: comp }} />
      </MemoryRouter>,
    );
  });
}

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];

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

const setClipboard = (readText: () => Promise<string>) => Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true });

async function connect(provider = 'anthropic', tok = TOKEN) {
  await click($('mode-remote'));
  await click($(`provider-${provider}`));
  await setValue($('gateway-token'), tok);
  await click($('gateway-connect'));
}

beforeEach(async () => {
  localStorage.clear();
  setDb(new IronTrackDB(`assistant-connect-${++n}`));
  await db.open();
  requests = [];
  catalogResponse = async () => json(200, CATALOG);
  onGenerate = async () => json(200, {});
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (navigator as { clipboard?: unknown }).clipboard;
  forgetGatewayOrigin();
  forgetAssistantSession();
  db.close();
});

describe('provedores pré-configurados', () => {
  it('três provedores, com as páginas oficiais de chaves e as APIs oficiais pedidas', () => {
    expect(PROVIDER_PRESETS.map((p) => [p.id, p.name, p.keysUrl, p.apiBase])).toEqual([
      ['openai', 'OpenAI', 'https://platform.openai.com/api-keys', 'https://api.openai.com/v1'],
      ['anthropic', 'Anthropic / Claude', 'https://console.anthropic.com/settings/keys', 'https://api.anthropic.com'],
      ['gemini', 'Google Gemini', 'https://aistudio.google.com/app/apikey', 'https://generativelanguage.googleapis.com'],
    ]);
    for (const p of PROVIDER_PRESETS) {
      expect(isOfficialKeysUrl(p.keysUrl)).toBe(true);
      expect(p.steps.length).toBeGreaterThan(0);
    }
  });

  it('link de chave só vale para a página oficial, em HTTPS, sem parâmetros nem fragmento', () => {
    expect(isOfficialKeysUrl('https://platform.openai.com/api-keys?email=x')).toBe(false);
    expect(isOfficialKeysUrl('https://platform.openai.com/api-keys#k')).toBe(false);
    expect(isOfficialKeysUrl('http://platform.openai.com/api-keys')).toBe(false);
    expect(isOfficialKeysUrl('https://platform.openai.com.evil.example/api-keys')).toBe(false);
    expect(isOfficialKeysUrl('https://user@console.anthropic.com/settings/keys')).toBe(false);
  });

  it('reconhece chave de provedor (formato) e não confunde com o token do gateway', () => {
    expect(providerKeyKind(FAKE_OPENAI_KEY)).toBe('OpenAI');
    expect(providerKeyKind(FAKE_ANTHROPIC_KEY)).toBe('Anthropic');
    expect(providerKeyKind(FAKE_GEMINI_KEY)).toBe('Google Gemini');
    expect(providerKeyKind(TOKEN)).toBeNull();
    // Mesmo um token do gateway que por acaso comece com "sk-" ou "AIza" (43 caracteres) não é tomado por chave.
    expect(providerKeyKind(`sk-${rnd(40)}`)).toBeNull();
    expect(providerKeyKind(`AIza${rnd(39)}`)).toBeNull();
  });

  it('validação do token: vazio, chave de provedor, formato e ok', () => {
    expect(checkAccessToken('   ')).toMatchObject({ ok: false, error: expect.stringContaining('Cole o token') });
    expect(checkAccessToken(FAKE_OPENAI_KEY)).toMatchObject({ ok: false, providerKey: true, error: expect.stringContaining('chave de API da OpenAI') });
    expect(checkAccessToken('curto demais')).toMatchObject({ ok: false, error: expect.stringContaining('Formato inválido') });
    expect(checkAccessToken(` ${TOKEN} `)).toEqual({ ok: true, token: TOKEN });
  });
});

describe('host automático', () => {
  it('sem configuração: nenhum gateway', () => {
    expect(resolveGatewayEndpoint()).toBeNull();
  });

  it('configuração pública da publicação (VITE_AI_GATEWAY_URL) é usada quando válida', () => {
    vi.stubEnv('VITE_AI_GATEWAY_URL', 'https://ia.exemplo.dev/');
    expect(resolveGatewayEndpoint()).toEqual({ origin: 'https://ia.exemplo.dev', source: 'build' });
    vi.stubEnv('VITE_AI_GATEWAY_URL', 'http://ia.exemplo.dev');
    expect(resolveGatewayEndpoint()).toBeNull();
    vi.stubEnv('VITE_AI_GATEWAY_URL', 'https://api.anthropic.com');
    expect(resolveGatewayEndpoint()).toBeNull();
  });

  it('endereço do aparelho tem prioridade; inválido ou adulterado é ignorado; esquecer volta à publicação', () => {
    vi.stubEnv('VITE_AI_GATEWAY_URL', 'https://ia.exemplo.dev');
    expect(saveGatewayOrigin('https://meu.gateway.exemplo').ok).toBe(true);
    expect(resolveGatewayEndpoint()).toEqual({ origin: 'https://meu.gateway.exemplo', source: 'device' });
    expect(JSON.parse(localStorage.getItem(GATEWAY_ENDPOINT_KEY)!)).toEqual({ v: 1, origin: 'https://meu.gateway.exemplo' });
    localStorage.setItem(GATEWAY_ENDPOINT_KEY, JSON.stringify({ v: 1, origin: 'http://inseguro.exemplo' }));
    expect(resolveGatewayEndpoint()?.source).toBe('build');
    localStorage.setItem(GATEWAY_ENDPOINT_KEY, '{lixo');
    expect(resolveGatewayEndpoint()?.source).toBe('build');
    forgetGatewayOrigin();
    expect(localStorage.getItem(GATEWAY_ENDPOINT_KEY)).toBeNull();
    expect(resolveGatewayEndpoint()).toEqual({ origin: 'https://ia.exemplo.dev', source: 'build' });
  });

  it('nunca aceita a API do provedor como gateway, nem caminho, usuário ou parâmetros', () => {
    for (const bad of ['https://api.openai.com/v1', 'https://api.openai.com', 'https://generativelanguage.googleapis.com', 'https://u:p@gw.exemplo', 'https://gw.exemplo/?t=1', 'ftp://gw.exemplo'])
      expect(checkGatewayOrigin(bad).ok).toBe(false);
    expect(checkGatewayOrigin('http://localhost:8787')).toEqual({ ok: true, origin: 'http://localhost:8787' });
  });
});

describe('tela: fluxo Provedor → chave/token → Conectar → Modelo', () => {
  it('sem gateway: mensagem clara, conexão bloqueada e nenhuma requisição', async () => {
    await mount();
    await click($('mode-remote'));
    expect($('no-gateway')?.textContent).toContain('Para conectar uma IA real, é necessário configurar o servidor seguro do IronTrack.');
    expect($('ai-status')?.dataset.status).toBe('no_gateway');
    await click($('provider-openai'));
    expect(($('gateway-connect') as HTMLButtonElement).disabled).toBe(true);
    expect(($('gateway-token') as HTMLInputElement).disabled).toBe(true);
    // Configurações avançadas recolhidas por padrão; "Configurar servidor" as abre.
    expect(($('gateway-advanced') as HTMLDetailsElement).open).toBe(false);
    await click($('open-advanced'));
    expect(($('gateway-advanced') as HTMLDetailsElement).open).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('cada provedor mostra o nome, "Obter chave de API" para a página oficial (nova aba, sem referer) e instruções', async () => {
    saveGatewayOrigin(GW);
    await mount();
    await click($('mode-remote'));
    expect($('get-api-key')).toBeNull();
    for (const p of PROVIDER_PRESETS) {
      await click($(`provider-${p.id}`));
      expect($('selected-provider')?.dataset.provider).toBe(p.id);
      expect($('selected-provider')?.textContent).toContain(p.name);
      const a = $('get-api-key') as HTMLAnchorElement;
      expect(a.textContent).toContain('Obter chave de API');
      expect(a.getAttribute('href')).toBe(p.keysUrl);
      expect(a.target).toBe('_blank');
      expect(a.rel).toContain('noopener');
      expect(a.rel).toContain('noreferrer');
      expect(a.getAttribute('referrerpolicy')).toBe('no-referrer');
      const how = $('key-instructions')!.textContent!;
      for (const step of p.steps) expect(how).toContain(step);
      expect(how).toContain(p.gatewayKeyEnv);
      expect(how).toContain('Não cole a chave do provedor neste app');
      expect($('provider-api')?.textContent).toContain(p.apiBase);
    }
    // Escolher provedor e abrir o link não faz nenhuma requisição (o link é navegação do usuário, não fetch).
    expect(requests).toHaveLength(0);
  });

  it('campo do token: máscara, mostrar/ocultar, colar e explicação do tipo de credencial', async () => {
    saveGatewayOrigin(GW);
    setClipboard(async () => ` ${TOKEN}\n`);
    await mount();
    await click($('mode-remote'));
    await click($('provider-anthropic'));
    const input = $('gateway-token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect($('gateway-panel')?.textContent).toContain('Não é a chave de API do provedor');
    await click($('gateway-token-toggle'));
    expect(($('gateway-token') as HTMLInputElement).type).toBe('text');
    await click($('gateway-token-toggle'));
    expect(($('gateway-token') as HTMLInputElement).type).toBe('password');
    await click($('gateway-token-paste'));
    await waitFor(() => ($('gateway-token') as HTMLInputElement).value === TOKEN);
    // Vazio: mensagem e nada enviado.
    await setValue($('gateway-token'), '');
    await click($('gateway-connect'));
    expect($('gateway-error')?.textContent).toContain('Cole o token');
    expect(requests).toHaveLength(0);
  });

  it('colar falha (sem permissão): mensagem clara', async () => {
    saveGatewayOrigin(GW);
    setClipboard(async () => Promise.reject(new Error('NotAllowed')));
    await mount();
    await click($('mode-remote'));
    await click($('provider-openai'));
    await click($('gateway-token-paste'));
    await waitFor(() => $('gateway-error')?.textContent?.includes('área de transferência'));
  });

  it('chave de provedor colada no campo do token: recusada, campo limpo, nada enviado nem guardado', async () => {
    saveGatewayOrigin(GW);
    const ls = vi.spyOn(Storage.prototype, 'setItem');
    await mount();
    for (const key of [FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, FAKE_GEMINI_KEY]) {
      await connect('openai', key);
      expect($('gateway-error')?.textContent).toContain('não o token do servidor');
      expect(($('gateway-token') as HTMLInputElement).value).toBe('');
      expect(document.body.innerHTML).not.toContain(key);
    }
    expect(requests).toHaveLength(0);
    expect(ls).not.toHaveBeenCalled();
  });

  it('token incorreto: recusado pelo servidor com mensagem fixa', async () => {
    saveGatewayOrigin(GW);
    catalogResponse = async () => json(401, { error: { code: 'unauthorized', message: 'detalhe interno' } });
    await mount();
    await connect();
    await waitFor(() => $('gateway-error')?.textContent);
    expect($('gateway-error')?.textContent).toContain('recusou o acesso');
    expect($('ai-status')?.dataset.status).toBe('auth_failure');
    expect(document.body.textContent).not.toContain('detalhe interno');
  });

  it('token correto: host resolvido sozinho, modelo do catálogo e pronto para conversar', async () => {
    saveGatewayOrigin(GW);
    await mount();
    await connect('openai');
    await waitFor(() => $('gateway-connected'));
    expect(requests).toEqual([{ url: `${GW}/v1/models`, auth: `Bearer ${TOKEN}` }]);
    expect($('ai-status')?.dataset.status).toBe('connected');
    const sel = $('ai-remote-model') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'modelo-o']);
    expect($('setup-start-chat')).toBeNull();
    await setValue(sel, 'modelo-o');
    expect($('setup-confirm')?.textContent).toContain('OpenAI');
    await click($('setup-start-chat'));
    expect(document.activeElement).toBe($('ai-question'));
  });

  it('modelo indisponível: sem chave no servidor não vira opção; modelo recusado pelo servidor dá mensagem própria', async () => {
    saveGatewayOrigin(GW);
    onGenerate = async () => json(403, { error: { code: 'model_not_allowed' } });
    await mount();
    await connect('gemini');
    await waitFor(() => $('gateway-connected'));
    expect(($('ai-remote-model') as HTMLSelectElement).disabled).toBe(true);
    expect([...($('ai-remote-model') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['']);
    expect($('ai-status')?.dataset.status).toBe('provider_unavailable');
    await click($('provider-anthropic'));
    await setValue($('ai-remote-model'), 'modelo-c');
    await setValue($('ai-question'), 'Como foi minha semana?');
    await click($('ai-send'));
    await waitFor(() => $('preview-authorize'));
    await click($('preview-authorize'));
    await waitFor(() => $('chat-error'));
    expect($('chat-error')?.textContent).toContain('não é oferecido por este provedor');
  });

  it('cota, faturamento e rede: mensagens específicas', async () => {
    saveGatewayOrigin(GW);
    await mount();
    await connect('anthropic');
    await waitFor(() => $('gateway-connected'));
    await setValue($('ai-remote-model'), 'modelo-c');
    const cases: [() => Promise<Response>, string][] = [
      [async () => json(429, { error: { code: 'provider_rate_limited' } }), 'faturamento'],
      [async () => json(429, { error: { code: 'quota_exceeded' } }), 'cota'],
      [async () => Promise.reject(new TypeError('Failed to fetch')), 'Não foi possível contatar o servidor seguro'],
      [async () => json(503, { error: { code: 'provider_unavailable' } }), 'sem chave no servidor'],
    ];
    for (const [i, [handler, text]] of cases.entries()) {
      onGenerate = handler;
      await setValue($('ai-question'), `Pergunta ${i}`);
      await click($('ai-send'));
      await waitFor(() => $('preview-authorize'));
      await click($('preview-authorize'));
      await waitFor(() => $$('[data-testid="chat-error"]').length === i + 1);
      expect($$('[data-testid="chat-error"]')[i].textContent).toContain(text);
    }
  });

  it('cancelar a conexão em andamento: nada conectado e o formulário volta', async () => {
    saveGatewayOrigin(GW);
    let aborted = false;
    catalogResponse = (signal) =>
      new Promise((_r, reject) =>
        signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('abort', 'AbortError'));
        }),
      );
    await mount();
    await connect();
    await waitFor(() => $('gateway-cancel'));
    await click($('gateway-cancel'));
    await waitFor(() => $('gateway-connect'));
    expect(aborted).toBe(true);
    expect($('gateway-connected')).toBeNull();
    expect($('gateway-error')?.textContent).toBe('');
    expect(comp.service.listProviders().map((p) => p.id)).toEqual(['mock']);
  });

  it('desconectar limpa as credenciais: token esquecido, provedores remotos removidos, endereço mantido', async () => {
    saveGatewayOrigin(GW);
    await mount();
    await connect();
    await waitFor(() => $('gateway-connected'));
    await click($('gateway-disconnect'));
    expect($('gateway-connected')).toBeNull();
    expect(($('gateway-token') as HTMLInputElement).value).toBe('');
    expect(comp.service.listProviders().map((p) => p.id)).toEqual(['mock']);
    expect($('gateway-origin')?.textContent).toBe(GW);
    // Reconectar exige o token de novo.
    await click($('gateway-connect'));
    expect($('gateway-error')?.textContent).toContain('Cole o token');
  });

  it('trocar o endereço nas configurações avançadas desconecta; esquecer volta a "sem servidor"', async () => {
    saveGatewayOrigin(GW);
    await mount();
    await connect();
    await waitFor(() => $('gateway-connected'));
    await setValue($('gateway-url'), 'https://outro.exemplo');
    await click($('gateway-url-save'));
    expect($('gateway-connected')).toBeNull();
    expect($('gateway-origin')?.textContent).toBe('https://outro.exemplo');
    await click($('gateway-url-forget'));
    expect($('no-gateway')).not.toBeNull();
    expect(localStorage.getItem(GATEWAY_ENDPOINT_KEY)).toBeNull();
  });

  it('privacidade: no armazenamento só fica a origem do servidor; token e chaves nunca', async () => {
    saveGatewayOrigin(GW);
    await mount();
    await connect();
    await waitFor(() => $('gateway-connected'));
    const all = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(all).not.toContain(TOKEN);
    expect(Object.keys(localStorage)).toEqual([GATEWAY_ENDPOINT_KEY]);
    expect(localStorage.getItem(GATEWAY_ENDPOINT_KEY)).toBe(JSON.stringify({ v: 1, origin: GW }));
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});

describe('estado e isolamento', () => {
  it('estado "sem servidor" só no modo remoto e antes de conectar', () => {
    expect(assistantStatus({ mode: 'simulated', hasEndpoint: false, gatewayStatus: 'disconnected' })).toBe('local');
    expect(assistantStatus({ mode: 'remote', hasEndpoint: false, gatewayStatus: 'disconnected' })).toBe('no_gateway');
    expect(assistantStatus({ mode: 'remote', hasEndpoint: true, gatewayStatus: 'disconnected' })).toBe('unavailable');
    expect(assistantStatus({ mode: 'remote', hasEndpoint: true, gatewayStatus: 'error', gatewayErrorCode: 'no_gateway' })).toBe('no_gateway');
  });

  it('presetById só conhece os três provedores', () => {
    expect(presetById('openai')?.name).toBe('OpenAI');
    expect(presetById('ollama')).toBeUndefined();
  });
});
