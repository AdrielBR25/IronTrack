// Tela do assistente (P05) montada no jsdom com o provedor simulado e o banco fictício
// (fake-indexeddb). Sem bibliotecas extras: React + act. Dados fictícios apenas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AIAssistantPage from '@/pages/AIAssistantPage';
import { DB_SCHEMA_VERSION, IronTrackDB, db, setDb } from '@/db/db';
import { createAssistantService, type AssistantComposition } from '@/integrations/ai/assistantService';
import { loadContextSources } from '@/integrations/ai/contextSources';
import type { AssistantDeps } from '@/features/assistant/useAssistant';
import type { AIContextSources } from '@/modules/ai';
import { addDays, fromISODate, todayISO } from '@/lib/dates';
import { entry, photo, session, settings } from './fixtures';

// O cabeçalho vem do layout, que importa o registro do service worker (módulo virtual do Vite).
vi.mock('@/components/UpdatePrompt', () => ({ OfflineBadge: () => null, UpdatePrompt: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
let dbName = '';
let root: Root | null = null;
let container: HTMLDivElement;
let comp: AssistantComposition;

const recent = (daysAgo: number) => fromISODate(addDays(todayISO(), -daysAgo)).getTime() + 10 * 3600_000;

async function seed() {
  await db.settings.put(settings({ userName: 'Pessoa Fictícia' }));
  await db.sessions.bulkPut([session('s1', { startedAt: recent(1), notes: 'observação secreta' }), session('s2', { startedAt: recent(3) })]);
  await db.bodyEntries.bulkPut([entry('b1', { date: '2026-01-10', notes: 'nota secreta' }), entry('b2', { date: '2026-02-10', weightKg: 79 })]);
  await db.photos.put(photo('p1', 'b1'));
}

async function dump() {
  return JSON.stringify(await Promise.all([db.settings, db.routines, db.sessions, db.rotations, db.overrides, db.bodyEntries, db.photos, db.profiles].map((t) => t.toArray())));
}

async function mount(over: Partial<AssistantDeps> = {}) {
  comp = over.composition ?? createAssistantService({ latencyMs: 30 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <AIAssistantPage deps={{ composition: comp, ...over }} />
      </MemoryRouter>,
    );
  });
}

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

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

async function type(text: string) {
  const el = $('ai-question') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error('elemento ausente');
  await act(async () => {
    el.click();
  });
}

async function check(cat: string) {
  await click($(`cat-${cat}`));
}

async function openPreview(question = 'Como foi minha semana?') {
  await type(question);
  await click($('ai-send'));
  return waitFor(() => $('share-preview'));
}

beforeEach(async () => {
  dbName = `assistant-ui-${++n}`;
  setDb(new IronTrackDB(dbName));
  await db.open();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('assistente: página e prévia', () => {
  it('modo simulado identificado e nenhuma categoria pessoal selecionada por padrão', async () => {
    await mount();
    expect($('demo-banner')?.textContent).toContain('Modo de demonstração — respostas simuladas');
    expect($('demo-badge')?.textContent).toContain('Simulado');
    for (const c of ['training_summary', 'training_history', 'body_measurements', 'body_evolution', 'profile_preferences'])
      expect(($(`cat-${c}`) as HTMLInputElement).checked).toBe(false);
    expect($('cat-progress_photos')?.querySelector('input')).toBeNull();
    expect($('data-indicator')?.textContent).toContain('Nenhum dado selecionado');
    expect($('chat-empty')).not.toBeNull();
  });

  it('pergunta vazia ou longa demais não prepara nada', async () => {
    await mount();
    const prepare = vi.spyOn(comp.service, 'prepare');
    await click($('ai-send'));
    expect($('ai-notice')?.textContent).toContain('Escreva uma pergunta');
    await type('a'.repeat(2001));
    await click($('ai-send'));
    expect($('ai-notice')?.textContent).toContain('2.000');
    expect(prepare).not.toHaveBeenCalled();
    expect($('share-preview')).toBeNull();
  });

  it('seleção de categorias atualiza o indicador', async () => {
    await mount();
    await check('training_history');
    await check('body_measurements');
    expect($('data-indicator')?.textContent).toBe('2 categorias selecionadas: Histórico de treinos, Medidas corporais');
    await check('training_history');
    expect($('data-indicator')?.textContent).toBe('1 categoria selecionada: Medidas corporais');
  });

  it('sem categorias: prévia mostra que só a pergunta vai, sem dados pessoais', async () => {
    await seed();
    await mount();
    const preview = await openPreview();
    expect(preview.querySelector('[data-testid="preview-categories"]')?.textContent).toContain('Nenhuma');
    expect(preview.querySelector('[data-testid="preview-included"]')).toBeNull();
    const raw = preview.querySelector('[data-testid="preview-raw"]')!.textContent!;
    expect(raw).not.toContain('Contexto autorizado');
    expect($('preview-provider')?.textContent).toContain('Provedor simulado');
    expect($('preview-model')?.textContent).toContain('Simulado (texto)');
    expect($('preview-purpose')?.textContent).toBe('Pergunta geral');
    expect($('preview-question')?.textContent).toBe('Como foi minha semana?');
  });

  it('prévia mostra os dados efetivos preparados pelo serviço, sem dados internos', async () => {
    await seed();
    await mount();
    const prepare = vi.spyOn(comp.service, 'prepare');
    await check('body_measurements');
    await check('training_history');
    const preview = await openPreview();
    const prepared = await prepare.mock.results[0].value;
    // O conteúdo exato da mensagem preparada aparece na prévia.
    const raw = preview.querySelector('[data-testid="preview-raw"]')!.textContent!;
    for (const m of prepared.request.messages) expect(raw).toContain(m.content);
    expect($('preview-data-body_measurements')?.textContent).toContain('2026-02-10');
    expect($('preview-data-body_measurements')?.textContent).toContain('Peso 79 kg');
    expect($('preview-data-training_history')?.textContent).toContain('Supino');
    expect($('preview-purpose')?.textContent).toBe('Pergunta geral');
    expect($('preview-excluded')?.textContent).toContain('Fotos de progresso: bloqueada');
    expect($('preview-excluded')?.textContent).toContain('Evolução corporal: não selecionada');
    const text = preview.textContent!;
    for (const bad of ['observação secreta', 'nota secreta', 'Pessoa Fictícia', 'data:image', 'profileId']) expect(text).not.toContain(bad);
  });

  it('dados ausentes: informa sem inventar valores', async () => {
    await mount();
    await check('body_measurements');
    await check('body_evolution');
    const preview = await openPreview();
    expect($('preview-no-data')?.textContent).toContain('Nenhuma avaliação corporal registrada ainda.');
    expect($('preview-no-data')?.textContent).toContain('duas avaliações');
    expect(preview.querySelector('[data-testid="preview-included"]')).toBeNull();
    expect(preview.querySelector('[data-testid="preview-raw"]')!.textContent).not.toContain('body_measurements');
  });

  it('cancelar a prévia não executa nada e mantém a pergunta', async () => {
    await mount();
    const execute = vi.spyOn(comp.service, 'execute');
    await openPreview('Pergunta cancelada');
    await click($('preview-cancel'));
    await waitFor(() => !$('share-preview'));
    expect(execute).not.toHaveBeenCalled();
    expect(($('ai-question') as HTMLTextAreaElement).value).toBe('Pergunta cancelada');
    expect($$('chat-user')).toHaveLength(0);
  });
});

describe('assistente: autorização e execução', () => {
  it('autorização explícita executa uma vez e mostra a resposta simulada', async () => {
    await seed();
    await mount();
    const execute = vi.spyOn(comp.service, 'execute');
    await check('training_summary');
    await openPreview();
    expect(execute).not.toHaveBeenCalled(); // nada antes da confirmação
    await click($('preview-authorize'));
    const reply = await waitFor(() => $('chat-assistant'));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reply.textContent).toContain('[SIMULAÇÃO]');
    expect(reply.textContent).toContain('Simulação');
    expect(reply.textContent).toContain('não é uma análise real');
    expect($('chat-user')?.dataset.status).toBe('sent');
    expect($('chat-user')?.textContent).toContain('Resumo de treinos');
    expect(($('ai-question') as HTMLTextAreaElement).value).toBe('');
  });

  it('consentimento de uso único: a mesma autorização não executa de novo; nova pergunta exige nova prévia', async () => {
    await mount();
    const execute = vi.spyOn(comp.service, 'execute');
    await openPreview('Primeira');
    await click($('preview-authorize'));
    await waitFor(() => $('chat-assistant'));
    const [prepared, consent] = execute.mock.calls[0];
    await expect(comp.service.execute(prepared, consent)).rejects.toMatchObject({ code: 'permission_denied' });
    // Segunda pergunta: abre outra prévia, com outra solicitação e nova autorização.
    await openPreview('Segunda');
    expect($('preview-question')?.textContent).toBe('Segunda');
    await click($('preview-authorize'));
    await waitFor(() => $$('chat-assistant').length === 2);
    const [prepared2, consent2] = execute.mock.calls.at(-1)!;
    expect(prepared2.requestId).not.toBe(prepared.requestId);
    expect(consent2!.id).not.toBe(consent!.id);
    expect(consent2!.scope.requestId).toBe(prepared2.requestId);
  });

  it('alterar a pergunta invalida a prévia aberta', async () => {
    await mount();
    await openPreview('Original');
    await type('Alterada');
    await waitFor(() => !$('share-preview'));
    await openPreview('Alterada');
    expect($('preview-question')?.textContent).toBe('Alterada');
  });

  it('alterar o contexto ou o modelo invalida a prévia aberta', async () => {
    await mount();
    await openPreview('Pergunta');
    await act(async () => {
      ($('cat-body_measurements') as HTMLInputElement).click();
    });
    await waitFor(() => !$('share-preview'));
    await openPreview('Pergunta');
    const select = $('ai-model') as HTMLSelectElement;
    await act(async () => {
      select.value = 'mock-tiny';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => !$('share-preview'));
  });

  it('mudança dos dados em outra aba invalida a prévia e impede executar o pedido antigo', async () => {
    await seed();
    await mount();
    const execute = vi.spyOn(comp.service, 'execute');
    await check('body_measurements');
    await openPreview();
    const otherTab = new IronTrackDB(dbName);
    await otherTab.open();
    await otherTab.bodyEntries.update('b2', { weightKg: 75 });
    await waitFor(() => $('preview-stale'));
    expect($('preview-stale')?.textContent).toContain('mudaram');
    expect($('preview-authorize')).toBeNull();
    await click($('preview-reprepare'));
    await waitFor(() => $('share-preview') && !$('preview-stale') && $('preview-data-body_measurements')?.textContent?.includes('Peso 75 kg'));
    expect(execute).not.toHaveBeenCalled();
    otherTab.close();
  });

  it('confere os dados de novo no clique: se mudaram, não executa (mesmo sem aviso prévio)', async () => {
    await seed();
    let current: AIContextSources | null = null;
    // Observação desligada: só a conferência no clique protege.
    await mount({ watchSources: () => () => undefined, loadSources: async (c) => current ?? loadContextSources(c) });
    const execute = vi.spyOn(comp.service, 'execute');
    await check('body_measurements');
    await openPreview();
    current = { bodyEntries: [{ date: '2026-03-10', weightKg: 70 }] };
    await click($('preview-authorize'));
    await waitFor(() => $('preview-stale'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('prévia expirada exige nova preparação', async () => {
    let clock = 1_000_000;
    const composition = createAssistantService({ latencyMs: 10, now: () => clock });
    await mount({ composition, now: () => clock, previewTtlMs: 60_000 });
    const execute = vi.spyOn(composition.service, 'execute');
    await openPreview();
    clock += 60_001;
    await click($('preview-authorize'));
    await waitFor(() => $('preview-stale'));
    expect($('preview-stale')?.textContent).toContain('expirou');
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancelamento durante a execução', async () => {
    await mount({ composition: createAssistantService({ scenario: 'hang' }) });
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-running'));
    await click($('ai-cancel-run'));
    await waitFor(() => $('chat-user')?.dataset.status === 'cancelled');
    expect($('chat-running')).toBeNull();
    expect($('chat-error')?.textContent).toContain('cancelou');
    expect($('chat-assistant')).toBeNull();
    expect($('ai-send')).not.toBeNull();
  });

  it('sair da página durante a execução cancela a solicitação', async () => {
    const composition = createAssistantService({ scenario: 'hang' });
    const execute = vi.spyOn(composition.service, 'execute');
    await mount({ composition });
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-running'));
    await act(async () => root!.unmount());
    root = null;
    await expect(execute.mock.results[0].value).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('tempo limite encerra a espera sem deixar a mensagem presa', async () => {
    await mount({ composition: createAssistantService({ scenario: 'hang' }), timeoutMs: 50 });
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-user')?.dataset.status === 'failed');
    expect($('chat-error')?.textContent).toContain('demorou demais');
    expect($('chat-running')).toBeNull();
  });

  it('falha simulada do provedor: mensagem compreensível, sem detalhes internos', async () => {
    await mount({ composition: createAssistantService({ scenario: 'fail', latencyMs: 5 }) });
    await openPreview('Pergunta com dado 80 kg');
    await click($('preview-authorize'));
    await waitFor(() => $('chat-user')?.dataset.status === 'failed');
    const err = $('chat-error')!.textContent!;
    expect(err).toContain('falhou ao responder');
    expect(err).not.toMatch(/mock upstream|80 kg/);
    // Editar e reenviar devolve a pergunta ao campo (sem executar).
    await click($('chat-error')!.querySelector('button'));
    expect(($('ai-question') as HTMLTextAreaElement).value).toBe('Pergunta com dado 80 kg');
  });

  it('resposta inválida do provedor é tratada', async () => {
    await mount({ composition: createAssistantService({ scenario: 'invalid_response', latencyMs: 5 }) });
    await openPreview();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-user')?.dataset.status === 'failed');
    expect($('chat-error')?.textContent).toContain('resposta inválida');
  });

  it('falha na preparação: aviso amigável e nenhuma prévia', async () => {
    await mount({ loadSources: async () => Promise.reject(new Error('IDBDatabase interno: detalhe')) });
    await check('training_history');
    await type('Pergunta');
    await click($('ai-send'));
    await waitFor(() => $('ai-notice')?.textContent);
    expect($('ai-notice')?.textContent).toContain('Nenhum dado foi enviado');
    expect($('ai-notice')?.textContent).not.toContain('IDBDatabase');
    expect($('share-preview')).toBeNull();
  });
});

describe('assistente: privacidade e integridade', () => {
  it('não persiste mensagens, não usa rede e não modifica treinos nem avaliações', async () => {
    await seed();
    const before = await dump();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const beacon = vi.fn();
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    const lsSet = vi.spyOn(Storage.prototype, 'setItem');

    await mount();
    for (const c of ['training_summary', 'training_history', 'body_measurements', 'body_evolution', 'profile_preferences']) await check(c);
    await openPreview('Pergunta privada fictícia');
    await click($('preview-authorize'));
    await waitFor(() => $('chat-assistant'));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(lsSet).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(await dump()).toBe(before); // treinos, avaliações, fotos, perfil e configurações intactos
    expect(db.tables.map((t) => t.name).sort()).toEqual(['bodyEntries', 'goals', 'overrides', 'photos', 'profiles', 'rotations', 'routines', 'sessions', 'settings']);
    expect(db.verno).toBe(DB_SCHEMA_VERSION);

    // Recarregar (montar de novo) perde a conversa: nada foi guardado.
    await act(async () => root!.unmount());
    container.remove();
    await mount();
    expect($('chat-empty')).not.toBeNull();
    expect($$('chat-user')).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('resposta é texto puro: HTML não é interpretado', async () => {
    await mount();
    await openPreview('<img src=x onerror="alert(1)"> <b>negrito</b>');
    expect($('preview-question')?.querySelector('img, b')).toBeNull();
    await click($('preview-authorize'));
    await waitFor(() => $('chat-assistant'));
    expect(container.querySelector('img, b, script')).toBeNull();
    expect($('chat-user')?.textContent).toContain('<img src=x');
  });
});
