// Estado e fluxo da tela do assistente (IronTrack 2.0 F01/P05–P06):
//   pergunta → validação → leitura das categorias escolhidas → prepare() → prévia →
//   autorização explícita (consentimento de uso único) → execute() → resposta.
// Nada é executado antes da autorização. A conversa vive só na memória do componente.
// A prévia perde a validade quando a pergunta, as categorias, o modelo ou o provedor mudam,
// quando os registros usados mudam (inclusive em outra aba) ou quando expira.
// P06: o modo simulado é o padrão. O modo remoto exige conectar um gateway (endereço + token, só na
// memória) e escolher provedor e modelo explicitamente; nada é selecionado automaticamente.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CONSENT_TTL_MS, createConsent, isAIError, type AIContextSources, type PreparedAIRequest } from '@/modules/ai';
import { ASSISTANT_TIMEOUT_MS, REMOTE_TIMEOUT_MS, createAssistantService, type AssistantComposition, type DemoScenario, type RemoteProviderInfo } from '@/integrations/ai/assistantService';
import { ASSISTANT_CATEGORIES, contextFingerprint, loadContextSources, watchContextSources, type AssistantCategory } from '@/integrations/ai/contextSources';
import { CATEGORY_LABEL, friendlyError, purposeFor, validateQuestion, type ChatMessage } from './assistantModel';

export interface AssistantDeps {
  composition: AssistantComposition;
  loadSources: (categories: readonly AssistantCategory[]) => Promise<AIContextSources>;
  watchSources: (categories: readonly AssistantCategory[], onChange: (s: AIContextSources) => void, onError?: () => void) => () => void;
  now: () => number;
  newId: () => string;
  /** Validade da prévia (padrão: a da autorização, 5 min). */
  previewTtlMs: number;
  timeoutMs: number;
  /** Tempo limite das execuções remotas (gateway). */
  remoteTimeoutMs: number;
}

let seq = 0;
const tempId = () => `tmp-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export function defaultAssistantDeps(): AssistantDeps {
  return {
    composition: createAssistantService(),
    loadSources: (c) => loadContextSources(c),
    watchSources: watchContextSources,
    now: Date.now,
    newId: () => globalThis.crypto?.randomUUID?.() ?? tempId(),
    previewTtlMs: DEFAULT_CONSENT_TTL_MS,
    timeoutMs: ASSISTANT_TIMEOUT_MS,
    remoteTimeoutMs: REMOTE_TIMEOUT_MS,
  };
}

export type PreviewStale = 'data_changed' | 'expired';

export interface AssistantPreview {
  prepared: PreparedAIRequest;
  question: string;
  /** Categorias selecionadas quando a prévia foi preparada. */
  selected: AssistantCategory[];
  fingerprint: string;
  stale: PreviewStale | null;
  /** Conferindo os dados de novo antes de executar. */
  verifying: boolean;
}

export type AssistantPhase = 'idle' | 'preparing' | 'preview' | 'running';

/** Simulado: nada sai do aparelho (padrão). Remoto: dados autorizados vão ao gateway e ao provedor. */
export type AssistantMode = 'simulated' | 'remote';

/** Mostrado quando o gateway recusa o token no meio do uso: o token é esquecido nesta página. */
export const TOKEN_REJECTED_MESSAGE = 'O gateway recusou o token (errado, revogado ou expirado) e ele foi esquecido nesta página. Conecte de novo com um token válido.';

export interface GatewayState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  origin?: string;
  providers: RemoteProviderInfo[];
  error?: string;
}

export function useAssistant(overrides: Partial<AssistantDeps> = {}) {
  const [deps] = useState<AssistantDeps>(() => ({ ...defaultAssistantDeps(), ...overrides }));
  const { composition } = deps;
  const simulated = composition.providers[0];

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraftState] = useState('');
  const [categories, setCategories] = useState<AssistantCategory[]>([]);
  const [mode, setModeState] = useState<AssistantMode>('simulated');
  const [gateway, setGateway] = useState<GatewayState>({ status: 'disconnected', providers: [] });
  const [providerId, setProviderState] = useState(simulated?.id ?? '');
  const [modelId, setModelState] = useState(simulated?.models[0]?.id ?? '');
  const provider = mode === 'simulated' ? simulated : gateway.providers.find((p) => p.id === providerId);
  const remoteInfo = mode === 'remote' ? gateway.providers.find((p) => p.id === providerId) : undefined;
  const [scenario, setScenarioState] = useState<DemoScenario>('echo');
  const [phase, setPhase] = useState<AssistantPhase>('idle');
  const [preview, setPreviewState] = useState<AssistantPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const previewRef = useRef<AssistantPreview | null>(null);
  const unwatchRef = useRef<(() => void) | null>(null);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const connectRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  /** Muda a cada alteração do rascunho: uma preparação em andamento para um rascunho antigo é descartada. */
  const draftVersion = useRef(0);

  const setPreview = useCallback((p: AssistantPreview | null) => {
    previewRef.current = p;
    if (mountedRef.current) setPreviewState(p);
  }, []);

  const stopWatching = useCallback(() => {
    unwatchRef.current?.();
    unwatchRef.current = null;
    if (expiryRef.current) clearTimeout(expiryRef.current);
    expiryRef.current = null;
  }, []);

  const markStale = useCallback(
    (reason: PreviewStale, target: AssistantPreview) => {
      const cur = previewRef.current;
      if (!cur || cur.prepared !== target.prepared || cur.stale) return;
      stopWatching();
      setPreview({ ...cur, stale: reason, verifying: false });
    },
    [setPreview, stopWatching],
  );

  /** Descarta a prévia sem executar nada. */
  const closePreview = useCallback(() => {
    stopWatching();
    setPreview(null);
    if (mountedRef.current) setPhase((p) => (p === 'preview' || p === 'preparing' ? 'idle' : p));
  }, [setPreview, stopWatching]);

  /** Qualquer mudança no que seria enviado invalida a prévia e a preparação em andamento. */
  const invalidate = useCallback(() => {
    draftVersion.current++;
    if (previewRef.current) closePreview();
  }, [closePreview]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Sair da página cancela a execução e encerra a observação dos dados.
      mountedRef.current = false;
      abortRef.current?.abort();
      connectRef.current?.abort();
      // O token do gateway some junto com a tela.
      composition.disconnectGateway();
      unwatchRef.current?.();
      if (expiryRef.current) clearTimeout(expiryRef.current);
    };
  }, [composition]);

  const setDraft = useCallback(
    (t: string) => {
      setDraftState(t);
      setNotice(null);
      invalidate();
    },
    [invalidate],
  );

  const toggleCategory = useCallback(
    (c: AssistantCategory) => {
      if (!(ASSISTANT_CATEGORIES as readonly string[]).includes(c)) return;
      setCategories((prev) => {
        const next = prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c];
        return ASSISTANT_CATEGORIES.filter((x) => next.includes(x));
      });
      invalidate();
    },
    [invalidate],
  );

  const clearCategories = useCallback(() => {
    setCategories([]);
    invalidate();
  }, [invalidate]);

  const setModel = useCallback(
    (id: string) => {
      setModelState(id);
      invalidate();
    },
    [invalidate],
  );

  /** Troca de modo. Remoto começa sem provedor e sem modelo: a escolha é sempre explícita. */
  const setMode = useCallback(
    (m: AssistantMode) => {
      if (m !== 'simulated' && m !== 'remote') return;
      setModeState(m);
      setNotice(null);
      if (m === 'simulated') {
        setProviderState(simulated?.id ?? '');
        setModelState(simulated?.models[0]?.id ?? '');
      } else {
        setProviderState('');
        setModelState('');
      }
      invalidate();
    },
    [simulated, invalidate],
  );

  /** Escolha explícita do provedor remoto (o modelo volta a ficar sem escolha). */
  const setProvider = useCallback(
    (id: string) => {
      setProviderState(id);
      setModelState('');
      setNotice(null);
      invalidate();
    },
    [invalidate],
  );

  /** Conecta ao gateway por ação do usuário. Só o token vai junto; nenhum dado pessoal. */
  const connectGateway = useCallback(
    async (url: string, token: string): Promise<boolean> => {
      connectRef.current?.abort();
      const ctrl = new AbortController();
      connectRef.current = ctrl;
      invalidate();
      setProviderState('');
      setModelState('');
      setGateway({ status: 'connecting', providers: [] });
      try {
        const conn = await composition.connectGateway({ url, token }, ctrl.signal);
        if (!mountedRef.current || connectRef.current !== ctrl) return false;
        setGateway({ status: 'connected', origin: conn.origin, providers: conn.providers });
        return true;
      } catch (e) {
        if (!mountedRef.current || connectRef.current !== ctrl) return false;
        setGateway({ status: 'error', providers: [], error: friendlyError(e).message });
        return false;
      } finally {
        if (connectRef.current === ctrl) connectRef.current = null;
      }
    },
    [composition, invalidate],
  );

  /** Esquece o gateway e o token. Volta a não haver provedor remoto. */
  const disconnectGateway = useCallback(() => {
    connectRef.current?.abort();
    connectRef.current = null;
    composition.disconnectGateway();
    setGateway({ status: 'disconnected', providers: [] });
    setProviderState('');
    setModelState('');
    invalidate();
  }, [composition, invalidate]);

  const setScenario = useCallback(
    (s: DemoScenario) => {
      composition.setScenario(s);
      setScenarioState(s);
    },
    [composition],
  );

  /** Prepara a solicitação e abre a prévia. Não envia nada. */
  const submit = useCallback(async () => {
    if (phase === 'running' || phase === 'preparing') return;
    const check = validateQuestion(draft);
    if (!check.ok) {
      setNotice(check.error);
      return;
    }
    if (mode === 'remote' && gateway.status !== 'connected') {
      setNotice('Conecte um gateway de IA ou volte ao modo simulado.');
      return;
    }
    if (!provider) {
      setNotice(mode === 'remote' ? 'Escolha um provedor remoto.' : 'Nenhum provedor de IA disponível.');
      return;
    }
    if (!modelId) {
      setNotice('Escolha um modelo.');
      return;
    }
    if (remoteInfo && !remoteInfo.available) {
      setNotice('Este provedor não está configurado no gateway (sem chave no servidor). Escolha outro ou use o modo simulado.');
      return;
    }
    stopWatching();
    setPreview(null);
    setNotice(null);
    setPhase('preparing');
    const version = draftVersion.current;
    const selected = [...categories];
    try {
      const sources = await deps.loadSources(selected);
      const prepared = await composition.service.prepare({
        providerId: provider.id,
        modelId,
        purpose: purposeFor(selected),
        instruction: check.text,
        categories: selected,
        sources,
      });
      if (!mountedRef.current || version !== draftVersion.current) return;
      const p: AssistantPreview = { prepared, question: check.text, selected, fingerprint: contextFingerprint(sources, selected), stale: null, verifying: false };
      setPreview(p);
      setPhase('preview');
      // Observa só as tabelas das categorias escolhidas, e só enquanto a prévia está aberta.
      if (selected.length)
        unwatchRef.current = deps.watchSources(
          selected,
          (fresh) => {
            if (contextFingerprint(fresh, selected) !== p.fingerprint) markStale('data_changed', p);
          },
          () => markStale('data_changed', p),
        );
      const ttl = Math.max(0, p.prepared.preparedAt + deps.previewTtlMs - deps.now());
      expiryRef.current = setTimeout(() => markStale('expired', p), ttl);
    } catch (e) {
      if (!mountedRef.current || version !== draftVersion.current) return;
      setPhase('idle');
      setNotice(friendlyError(e).message);
    }
  }, [phase, draft, mode, gateway.status, provider, remoteInfo, modelId, categories, deps, composition, setPreview, stopWatching, markStale]);

  /** Autoriza a solicitação preparada (e só ela) e executa. */
  const authorize = useCallback(async () => {
    const p = previewRef.current;
    if (!p || p.stale || p.verifying) return;
    if (deps.now() - p.prepared.preparedAt >= deps.previewTtlMs) return markStale('expired', p);
    setPreview({ ...p, verifying: true });
    // Confere de novo os registros usados: se mudaram desde a prévia, não executa o pedido antigo.
    let fresh: AIContextSources;
    try {
      fresh = p.selected.length ? await deps.loadSources(p.selected) : {};
    } catch {
      return markStale('data_changed', p);
    }
    if (previewRef.current?.prepared !== p.prepared) return;
    if (p.selected.length && contextFingerprint(fresh, p.selected) !== p.fingerprint) return markStale('data_changed', p);

    // Consentimento criado só agora, depois do clique, para esta solicitação exata; usado uma vez.
    const consent = createConsent(p.prepared, { grantedAt: deps.now(), id: deps.newId() });
    stopWatching();
    setPreview(null);
    const target = composition.service.listProviders().find((x) => x.id === p.prepared.providerId);
    const isRemote = !!target && target.kind !== 'simulated';
    const userMsg: ChatMessage = {
      id: tempId(),
      role: 'user',
      text: p.question,
      status: 'sending',
      categories: p.prepared.categories.map((c) => CATEGORY_LABEL[c]),
      ...(isRemote ? { destination: target.displayName } : {}),
    };
    setMessages((m) => [...m, userMsg]);
    setDraftState('');
    draftVersion.current++;
    setPhase('running');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await composition.service.execute(p.prepared, consent, { signal: ctrl.signal, timeoutMs: isRemote ? deps.remoteTimeoutMs : deps.timeoutMs });
      if (!mountedRef.current) return;
      const reply: ChatMessage = {
        id: tempId(),
        role: 'assistant',
        text: res.output.text,
        status: 'done',
        simulated: res.metadata.simulated,
        truncated: res.metadata.truncated,
        ...(isRemote ? { providerLabel: target.displayName, modelId: res.modelId } : {}),
      };
      setMessages((m) => [...m.map((x) => (x.id === userMsg.id ? { ...x, status: 'sent' as const } : x)), reply]);
    } catch (e) {
      if (!mountedRef.current) return;
      const cancelled = isAIError(e) && e.code === 'cancelled';
      const error = cancelled ? 'Você cancelou. Nenhuma resposta foi gerada.' : friendlyError(e).message;
      setMessages((m) => m.map((x) => (x.id === userMsg.id ? { ...x, status: cancelled ? 'cancelled' : 'failed', error } : x)));
      // P07: token recusado durante o uso (revogado, expirado ou trocado no servidor): esquece o token
      // desta página na hora, em vez de continuar tentando com uma credencial que não vale mais.
      if (isRemote && isAIError(e) && e.code === 'access_denied') {
        connectRef.current?.abort();
        connectRef.current = null;
        composition.disconnectGateway();
        setGateway({ status: 'error', providers: [], error: TOKEN_REJECTED_MESSAGE });
        setProviderState('');
        setModelState('');
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (mountedRef.current) setPhase('idle');
    }
  }, [deps, composition, setPreview, stopWatching, markStale]);

  /** Prepara de novo a mesma pergunta (prévia desatualizada ou expirada). */
  const reprepare = useCallback(() => {
    const p = previewRef.current;
    closePreview();
    if (p) void submit();
  }, [closePreview, submit]);

  /** Cancela a execução em andamento. */
  const cancelRun = useCallback(() => abortRef.current?.abort(), []);

  /** Devolve ao campo de texto uma pergunta que não foi respondida. */
  const retry = useCallback(
    (id: string) => {
      const m = messages.find((x) => x.id === id);
      if (m) setDraft(m.text);
    },
    [messages, setDraft],
  );

  const models = useMemo(() => provider?.models ?? [], [provider]);

  return {
    mode,
    setMode,
    gateway,
    connectGateway,
    disconnectGateway,
    provider,
    remoteInfo,
    providerId,
    setProvider,
    models,
    modelId,
    setModel,
    scenario,
    setScenario,
    messages,
    draft,
    setDraft,
    categories,
    toggleCategory,
    clearCategories,
    phase,
    preview,
    notice,
    submit,
    authorize,
    reprepare,
    closePreview,
    cancelRun,
    retry,
  };
}

export type AssistantState = ReturnType<typeof useAssistant>;
