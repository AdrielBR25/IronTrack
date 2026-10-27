// Tela do assistente no modo remoto (P06), montada no jsdom com um gateway SIMULADO (fetch falso) e o
// banco fictício. Confere: simulado como padrão, seleção explícita, aviso de destino remoto, prévia com
// o conteúdo exato, consentimento, cancelamento, gateway/provedor indisponíveis e nenhuma chamada
// remota sem autorização. Dados e tokens fictícios, gerados na execução.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AIAssistantPage from '@/pages/AIAssistantPage';
import { IronTrackDB, db, setDb } from '@/db/db';
import { createAssistantService, type AssistantComposition } from '@/integrations/ai/assistantService';
import { addDays, fromISODate, todayISO } from '@/lib/dates';
import { entry, session, settings } from './fixtures';

vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = `tok_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
const GW = 'https://gateway.exemplo';
const CATALOG = {
  protocol: 'irontrack.ai-gateway.v1',
  providers: [
    { id: 'anthropic', displayName: 'Anthropic Claude', available: true, models: [{ id: 'modelo-c', displayName: 'Modelo C', maxInputChars: 20000, maxOutputTokens: 800 }] },
    { id: 'gemini', displayName: 'Google Gemini', available: false, models: [{ id: 'modelo-g', displayName: 'Modelo G', maxInputChars: 20000, maxOutputTokens: 800 }] },
  ],
};

type Handler = (body: Record<string, unknown>, signal?: AbortSignal | null) => Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let n = 0;
let root: Root | null = null;
let container: HTMLDivElement;
let comp: AssistantComposition;
let requests: { url: string; method: string; body?: Record<string, unknown>; auth?: string }[] = [];
let onGenerate: Handler;
let catalogResponse: () => Promise<Response>;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  requests.push({ url, method: init?.method ?? 'GET', ...(body ? { body } : {}), auth: (init?.headers as Record<string, string>)?.authorization });
  if (url === `${GW}/v1/models`) return catalogResponse();
  if (url === `${GW}/v1/generate`) return onGenerate(body!, init?.signal);
  return json(404, { error: { code: 'not_found' } });
}) as unknown as typeof fetch;

const recent = (d: number) => fromISODate(addDays(todayISO(), -d)).getTime() + 10 * 3600_000;

async function seed() {
  await db.settings.put(settings({ userName: 'Pessoa Fictícia' }));
  await db.sessions.bulkPut([session('s1', { startedAt: recent(1), notes: 'observação secreta' })]);
  await db.bodyEntries.bulkPut([entry('b1', { date: '2026-01-10', notes: 'nota secreta' }), entry('b2', { date: '2026-02-10', weightKg: 79 })]);
}

async function mount() {
  comp = createAssistantService({ latencyMs: 20, fetchImpl });
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

async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    let v: T | null | undefined | false = undefined;
    try {
      v = fn();
    } catch {
      v = undefined;
    }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: tempo esgotado');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function setValue(el: HTMLElement | null, value: string) {
  if (!el) throw new Error('elemento ausente');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => {
    el.click();
  });
}

async function connect() {
  await click($('mode-remote'));
  await setValue($('gateway-url'), GW);
  await setValue($('gateway-token'), TOKEN);
  await click($('gateway-connect'));
  await waitFor(() => $('gateway-origin'));
}

async function chooseRemote(provider = 'anthropic', model = 'modelo-c') {
  await setValue($('ai-provider'), provider);
  await setValue($('ai-remote-model'), model);
}

async function openPreview(q = 'Como foi minha semana?') {
  await setValue($('ai-question'), q);
  await click($('ai-send'));
  return waitFor(() => $('share-preview'));
}

const generates = () => requests.filter((r) => r.url.endsWith('/v1/generate'));

beforeEach(async () => {
  setDb(new IronTrackDB(`assistant-remote-${++n}`));
  await db.open();
  requests = [];
  catalogResponse = async () => json(200, CATALOG);
  onGenerate = async (body) => json(200, { provider: body.provider, model: body.model, output: { type: 'text', text: 'Resposta remota fictícia.' }, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 4 } });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('assistente remoto: modo e seleção explícita', () => {
  it('modo simulado é o padrão; nenhum gateway, nenhuma rede', async () => {
    await mount();
    expect(($('mode-simulated') as HTMLInputElement).checked).toBe(true);
    expect(($('mode-remote') as HTMLInputElement).checked).toBe(false);
    expect($('demo-banner')).not.toBeNull();
    expect($('remote-banner')).toBeNull();
    expect($('gateway-panel')).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('modo remoto identifica o compartilhamento externo e exige conectar antes de perguntar', async () => {
    await mount();
    await click($('mode-remote'));
    expect($('remote-banner')?.textContent).toContain('sai do aparelho');
    expect($('remote-badge')).not.toBeNull();
    await setValue($('ai-question'), 'Pergunta');
    await click($('ai-send'));
    expect($('ai-notice')?.textContent).toContain('Conecte um gateway');
    expect($('share-preview')).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('conectar busca só o catálogo, limpa o token e não escolhe provedor nem modelo', async () => {
    await mount();
    await connect();
    expect(requests).toEqual([{ url: `${GW}/v1/models`, method: 'GET', auth: `Bearer ${TOKEN}` }]);
    expect(($('gateway-token') as HTMLInputElement | null)?.value ?? '').toBe('');
    expect(($('ai-provider') as HTMLSelectElement).value).toBe('');
    expect(($('ai-remote-model') as HTMLSelectElement).value).toBe('');
    const gem = [...($('ai-provider') as HTMLSelectElement).options].find((o) => o.value === 'gemini')!;
    expect(gem.disabled).toBe(true);
    expect(gem.textContent).toContain('indisponível');
    expect(document.body.textContent).not.toContain(TOKEN);

    await setValue($('ai-question'), 'Pergunta');
    await click($('ai-send'));
    expect($('ai-notice')?.textContent).toContain('Escolha um provedor');
    await setValue($('ai-provider'), 'anthropic');
    await click($('ai-send'));
    expect($('ai-notice')?.textContent).toContain('Escolha um modelo');
    expect($('remote-destination')?.textContent).toContain(`${GW} → Anthropic Claude`);
    expect(generates()).toHaveLength(0);
  });

  it('escolher modelo não envia dados; voltar ao simulado restaura o padrão', async () => {
    await seed();
    await mount();
    await connect();
    await chooseRemote();
    expect(generates()).toHaveLength(0);
    await click($('mode-simulated'));
    expect($('gateway-panel')).toBeNull();
    expect(($('ai-model') as HTMLSelectElement).value).toBe('mock-text');
  });
});

describe('assistente remoto: prévia, consentimento e execução', () => {
  it('prévia mostra provedor, modelo, destino, finalidade, categorias, conteúdo exato e aviso externo; nada antes de autorizar', async () => {
    await seed();
    await mount();
    await connect();
    await chooseRemote();
    await click($('cat-body_measurements'));
    const preview = await openPreview('Resuma minhas medidas');
    expect($('preview-remote-note')?.textContent).toContain('Compartilhamento externo');
    expect($('preview-simulated-note')).toBeNull();
    expect($('preview-provider')?.textContent).toContain('Anthropic Claude');
    expect($('preview-provider')?.textContent).toContain('remoto');
    expect($('preview-model')?.textContent).toContain('Modelo C');
    expect($('preview-destination')?.textContent).toBe(`${GW} → Anthropic Claude`);
    expect($('preview-purpose')?.textContent).toContain('Revisão da evolução corporal');
    expect($('preview-categories')?.textContent).toContain('Medidas corporais');
    const raw = $('preview-raw')!.textContent!;
    expect(raw).toContain('Resuma minhas medidas');
    expect(raw).not.toMatch(/nota secreta|Pessoa Fictícia|b1|b2/);
    expect(preview.textContent).toContain('Autorizar e enviar');
    expect(generates()).toHaveLength(0);

    await click($('preview-authorize'));
    const reply = await waitFor(() => $('chat-assistant'));
    expect(generates()).toHaveLength(1);
    const sent = generates()[0];
    expect(sent.auth).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(sent.body!).sort()).toEqual(['maxOutputTokens', 'messages', 'model', 'provider']);
    expect(sent.body!.provider).toBe('anthropic');
    expect(sent.body!.model).toBe('modelo-c');
    const content = JSON.stringify(sent.body!.messages);
    expect(content).toContain('Resuma minhas medidas');
    expect(content).not.toMatch(/nota secreta|Pessoa Fictícia|profileId|"id"/);
    expect(reply.textContent).toContain('Resposta remota fictícia.');
    expect($('chat-remote-badge')?.textContent).toContain('Anthropic Claude');
    expect(reply.textContent).not.toContain('Simulação');
    expect($('chat-destination')?.textContent).toContain('Anthropic Claude');
  });

  it('cancelar a prévia não envia nada', async () => {
    await mount();
    await connect();
    await chooseRemote();
    await openPreview();
    await click($('preview-cancel'));
    await waitFor(() => !$('share-preview'));
    expect(generates()).toHaveLength(0);
  });

  it('desconectar o gateway impede executar um pedido já preparado', async () => {
    await mount();
    await connect();
    await chooseRemote();
    await openPreview();
    await act(async () => {
      comp.disconnectGateway();
    });
    await click($('preview-authorize'));
    // O pedido preparado não executa sem o provedor (removido ao desconectar).
    await waitFor(() => $('chat-user')?.dataset.status === 'failed');
    expect(generates()).toHaveLength(0);
  });

  it('cada pergunta exige nova prévia e nova autorização (sem reutilizar consentimento)', async () => {
    await mount();
    await connect();
    await chooseRemote();
    await openPreview('Primeira');
    await click($('preview-authorize'));
    await waitFor(() => $('chat-assistant'));
    await setValue($('ai-question'), 'Segunda');
    await click($('ai-send'));
    await waitFor(() => $('share-preview'));
    expect(generates()).toHaveLength(1);
  });

  it('cancelamento durante a execução aborta a requisição ao gateway', async () => {
    let signal: AbortSignal | null | undefined;
    onGenerate = (_b, s) => {
      signal = s;
      return new Promise((_r, reject) => s?.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError'))));
    };
    await mount();
    await connect();
    await chooseRemote();
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('ai-cancel-run'));
    expect($('chat-running')?.textContent).toContain('Anthropic Claude');
    await click($('ai-cancel-run'));
    await waitFor(() => $('chat-user')?.dataset.status === 'cancelled');
    expect(signal?.aborted).toBe(true);
  });
});

describe('assistente remoto: indisponibilidade e privacidade', () => {
  it('gateway indisponível: erro compreensível e o modo simulado continua funcionando', async () => {
    catalogResponse = async () => Promise.reject(new TypeError('Failed to fetch'));
    await mount();
    await click($('mode-remote'));
    await setValue($('gateway-url'), GW);
    await setValue($('gateway-token'), TOKEN);
    await click($('gateway-connect'));
    const e = await waitFor(() => $('gateway-error')?.textContent);
    expect(e).toContain('Não foi possível contatar o gateway');
    await click($('mode-simulated'));
    await openPreview();
    await click($('preview-authorize'));
    expect((await waitFor(() => $('chat-assistant'))).textContent).toContain('[SIMULAÇÃO]');
  });

  it('token recusado pelo gateway: mensagem fixa, sem detalhes do servidor', async () => {
    catalogResponse = async () => json(401, { error: { code: 'unauthorized', message: 'detalhe interno 42' } });
    await mount();
    await click($('mode-remote'));
    await setValue($('gateway-url'), GW);
    await setValue($('gateway-token'), TOKEN);
    await click($('gateway-connect'));
    const e = await waitFor(() => $('gateway-error')?.textContent);
    expect(e).toContain('recusou o acesso');
    expect(document.body.textContent).not.toContain('detalhe interno 42');
  });

  it('endereço HTTP não local é recusado sem nenhuma requisição', async () => {
    await mount();
    await click($('mode-remote'));
    await setValue($('gateway-url'), 'http://gateway.exemplo');
    await setValue($('gateway-token'), TOKEN);
    await click($('gateway-connect'));
    await waitFor(() => $('gateway-error')?.textContent);
    expect(requests).toHaveLength(0);
  });

  it('provedor indisponível no servidor durante a execução: falha amigável, sem repetir nem trocar de provedor', async () => {
    onGenerate = async () => json(503, { error: { code: 'provider_unavailable', message: 'sem chave X' } });
    await mount();
    await connect();
    await chooseRemote();
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-user')?.dataset.status === 'failed');
    expect($('chat-error')?.textContent).toContain('não pode ser usado agora');
    expect(document.body.textContent).not.toContain('sem chave X');
    expect(generates()).toHaveLength(1);
  });

  it('cota e limite de requisições: mensagens específicas', async () => {
    onGenerate = async () => json(429, { error: { code: 'quota_exceeded' } });
    await mount();
    await connect();
    await chooseRemote();
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-user')?.dataset.status === 'failed');
    expect($('chat-error')?.textContent).toContain('cota');
  });

  it('nada é persistido: sem storage, sem alterar o banco; sair da página esquece o gateway', async () => {
    await seed();
    const before = JSON.stringify(await Promise.all([db.settings, db.sessions, db.bodyEntries, db.photos, db.profiles].map((t) => t.toArray())));
    const lsSet = vi.spyOn(Storage.prototype, 'setItem');
    await mount();
    await connect();
    await chooseRemote();
    await click($('cat-training_history'));
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-assistant'));
    expect(lsSet).not.toHaveBeenCalled();
    expect(JSON.stringify(await Promise.all([db.settings, db.sessions, db.bodyEntries, db.photos, db.profiles].map((t) => t.toArray())))).toBe(before);
    expect(db.verno).toBe(2);
    await act(async () => root!.unmount());
    root = null;
    expect(comp.service.listProviders().map((p) => p.id)).toEqual(['mock']);
  });
});
