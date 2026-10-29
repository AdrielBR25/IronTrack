// Estado e fluxo da tela do assistente (IronTrack 2.0 F01/P05–P06):
//   pergunta → validação → leitura das categorias escolhidas → prepare() → prévia →
//   autorização explícita (consentimento de uso único) → execute() → resposta.
// Nada é executado antes da autorização. A conversa vive só na memória do componente.
// A prévia perde a validade quando a pergunta, as categorias, o modelo ou o provedor mudam,
// quando os registros usados mudam (inclusive em outra aba) ou quando expira.
// P06: o modo simulado é o padrão. O modo remoto exige conectar um gateway (token só na memória) e escolher provedor
// e modelo explicitamente; nada é selecionado automaticamente.
// Ajuste do P20: o endereço do gateway é resolvido sozinho (gatewayEndpoint.ts); a pessoa escolhe o provedor, informa
// só o token de acesso ao gateway e escolhe um modelo do catálogo dele. Chave de provedor nunca passa pelo app.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CONSENT_TTL_MS, createConsent, isAIError, type AIContextSources, type PreparedAIRequest } from '@/modules/ai';
import { ASSISTANT_TIMEOUT_MS, REMOTE_TIMEOUT_MS, createAssistantService, type AssistantComposition, type DemoScenario, type RemoteProviderInfo } from '@/integrations/ai/assistantService';
import { ASSISTANT_CATEGORIES, contextFingerprint, loadContextSources, watchContextSources, type AssistantCategory } from '@/integrations/ai/contextSources';
import { CATEGORY_LABEL, assistantStatus, friendlyError, purposeFor, validateQuestion, type ChatMessage } from './assistantModel';
import { loadSnapshot, saveSnapshot, sessionComposition, touchAssistantSession } from './assistantSession';
import { localAnswer, type LocalExercise } from './localAnswers';
import { resolveGatewayEndpoint, useGatewayEndpoint } from '@/integrations/ai/gatewayEndpoint';
import { ACCOUNT_GATEWAY_LABEL } from '@/integrations/ai/assistantService';
import { accountModeActive } from '@/cloud/config';

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
  /**
   * P20: guarda conexão e conversa na memória do app ao sair da tela (navegação interna), nunca em armazenamento.
   * Padrão: ligado na tela real; desligado quando o teste fornece a própria composição.
   */
  persist: boolean;
  /** P21: IA pela conta (sessão do app) em vez de token do gateway. Padrão: modo conta ativo neste aparelho. */
  accountMode: boolean;
  /** P20: exercícios do catálogo para respostas locais (carregados sob demanda). null = sem respostas locais. */
  localExercises: (() => Promise<readonly LocalExercise[]>) | null;
}

/** Catálogo do IronTrack no formato das respostas locais (pedaço separado, baixado só quando há pergunta). */
let catalogCache: Promise<readonly LocalExercise[]> | null = null;
/** Catálogo resumido para respostas locais; carregado uma vez, sob demanda (fica fora do pacote principal). */
function catalogForAnswers(): Promise<readonly LocalExercise[]> {
  catalogCache ??= loadCatalogForAnswers().catch((e) => {
    catalogCache = null;
    throw e;
  });
  return catalogCache;
}
async function loadCatalogForAnswers(): Promise<readonly LocalExercise[]> {
  const [{ getCatalog }, { MUSCLE_NAME, EQUIPMENT_NAME }] = await Promise.all([import('@/modules/exercises/catalog'), import('@/modules/exercises')]);
  return getCatalog().map((c) => ({
    name: c.name,
    aliases: c.aliases,
    primary: c.primaryMuscles.map((m) => MUSCLE_NAME[m]),
    secondary: c.secondaryMuscles.map((m) => MUSCLE_NAME[m]),
    equipment: c.equipment.map((e) => EQUIPMENT_NAME[e]),
    instructions: c.instructions,
    commonMistakes: c.commonMistakes,
    safetyNotes: c.safetyNotes,
  }));
}

let seq = 0;
const tempId = () => `tmp-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export function defaultAssistantDeps(persist = true): AssistantDeps {
  return {
    composition: persist ? sessionComposition() : createAssistantService(),
    persist,
    localExercises: catalogForAnswers,
    loadSources: (c) => loadContextSources(c),
    watchSources: watchContextSources,
    now: Date.now,
    newId: () => globalThis.crypto?.randomUUID?.() ?? tempId(),
    previewTtlMs: DEFAULT_CONSENT_TTL_MS,
    timeoutMs: ASSISTANT_TIMEOUT_MS,
    remoteTimeoutMs: REMOTE_TIMEOUT_MS,
    accountMode: accountModeActive(),
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

/** Sem endereço de gateway resolvido (nem nas configurações avançadas nem na publicação). */
export const NO_GATEWAY_MESSAGE = 'Para conectar uma IA real, é necessário configurar o servidor seguro do IronTrack.';

/** Mostrado quando o gateway recusa o token no meio do uso: o token é esquecido nesta página. */
export const TOKEN_REJECTED_MESSAGE = 'O gateway recusou o token (errado, revogado ou expirado) e ele foi esquecido nesta página. Conecte de novo com um token válido.';

/** P21: o servidor recusou o acesso pela conta (sessão expirada ou e-mail ainda não confirmado). */
export const ACCOUNT_REJECTED_MESSAGE = 'O servidor recusou o acesso pela sua conta: a sessão expirou ou o e-mail ainda não foi confirmado. Entre de novo ou confirme o e-mail em Minha conta.';

export interface GatewayState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  origin?: string;
  providers: RemoteProviderInfo[];
  error?: string;
  /** P20: código do erro (estado mostrado: falha de autenticação × gateway inacessível). */
  errorCode?: string;
}

export function useAssistant(overrides: Partial<AssistantDeps> = {}) {
  const [deps] = useState<AssistantDeps>(() => {
    const persist = overrides.persist ?? !overrides.composition;
    return { ...defaultAssistantDeps(persist && !overrides.composition), ...overrides, persist };
  });
  const { composition, accountMode } = deps;
  const simulated = composition.providers[0];
  // P20: retoma a sessão da memória do app (navegação interna), se houver e ainda for da mesma composição.
  const [snap] = useState(() => (deps.persist ? loadSnapshot() : null));
  // Ajuste P20: só retoma a conexão se o endereço resolvido ainda for o mesmo (trocar o servidor exige conectar de novo).
  const restoredGateway = snap && snap.gateway.status === 'connected' && snap.gateway.origin === (accountMode ? ACCOUNT_GATEWAY_LABEL : resolveGatewayEndpoint()?.origin) && composition.service.listProviders().some((p) => snap.gateway.providers.some((g) => g.id === p.id)) ? (snap.gateway as GatewayState) : null;

  const [messages, setMessages] = useState<ChatMessage[]>(() => snap?.messages ?? []);
  const [draft, setDraftState] = useState('');
  const [categories, setCategories] = useState<AssistantCategory[]>(() => snap?.categories ?? []);
  const [mode, setModeState] = useState<AssistantMode>(() => (snap?.mode === 'remote' ? 'remote' : 'simulated'));
  const [gateway, setGateway] = useState<GatewayState>(() => restoredGateway ?? (snap?.gateway.status === 'error' ? (snap.gateway as GatewayState) : { status: 'disconnected', providers: [] }));
  const [providerId, setProviderState] = useState(() => (snap ? (snap.mode === 'remote' ? (restoredGateway ? snap.providerId : '') : snap.providerId) : (simulated?.id ?? '')));
  const [modelId, setModelState] = useState(() => (snap ? (snap.mode === 'remote' ? (restoredGateway ? snap.modelId : '') : snap.modelId) : (simulated?.models[0]?.id ?? '')));
  const [lastRunError, setLastRunError] = useState<string | null>(null);
  /** P20: provedor escolhido no passo a passo antes de conectar (confirmado depois, se o gateway o oferecer). */
  const [wantedProvider, setWantedProvider] = useState<string>(() => (snap?.mode === 'remote' && restoredGateway ? snap.providerId : ''));
  const endpoint = useGatewayEndpoint();
  const wantedRef = useRef('');
  wantedRef.current = wantedProvider;
  /** "Perguntar à IA mesmo assim": a próxima pergunta não usa a resposta local. */
  const skipLocalRef = useRef(false);
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

  // Estado atual para guardar ao sair (P20). Uma pergunta em andamento é cancelada ao sair e fica marcada assim.
  const liveRef = useRef({ messages, categories, mode, providerId, modelId, gateway });
  liveRef.current = { messages, categories, mode, providerId, modelId, gateway };
  useEffect(() => {
    if (deps.persist) touchAssistantSession();
  }, [deps.persist, messages, gateway, mode]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Sair da página cancela a execução e encerra a observação dos dados.
      mountedRef.current = false;
      abortRef.current?.abort();
      connectRef.current?.abort();
      unwatchRef.current?.();
      if (expiryRef.current) clearTimeout(expiryRef.current);
      if (deps.persist) {
        // P20: conexão e conversa ficam na memória do app (nunca em armazenamento) até recarregar ou inatividade.
        const l = liveRef.current;
        const cancelled = 'Você saiu da tela do assistente e a solicitação foi cancelada.';
        saveSnapshot({
          ...l,
          messages: l.messages.map((m) => (m.status === 'sending' ? { ...m, status: 'cancelled' as const, error: cancelled } : m)),
          gateway: l.gateway.status === 'connecting' ? { status: 'disconnected', providers: [] } : l.gateway,
        });
      } else {
        // O token do gateway some junto com a tela.
        composition.disconnectGateway();
      }
    };
  }, [composition, deps.persist]);

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

  /**
   * Escolha explícita do provedor no passo a passo (antes ou depois de conectar). Conectado, vale se o gateway o
   * oferecer; o modelo volta a ficar sem escolha.
   */
  const chooseProvider = useCallback(
    (id: string) => {
      setWantedProvider(id);
      setProviderState(gateway.status === 'connected' && gateway.providers.some((p) => p.id === id) ? id : '');
      setModelState('');
      setNotice(null);
      setLastRunError(null);
      invalidate();
    },
    [gateway, invalidate],
  );

  /**
   * Conecta ao gateway por ação do usuário, no endereço resolvido automaticamente. Só o token vai junto; nenhum dado
   * pessoal. Sem endereço configurado, não faz nenhuma requisição.
   */
  const connectGateway = useCallback(
    async (token: string): Promise<boolean> => {
      connectRef.current?.abort();
      const ep = resolveGatewayEndpoint();
      if (!ep) {
        connectRef.current = null;
        setGateway({ status: 'error', providers: [], error: NO_GATEWAY_MESSAGE, errorCode: 'no_gateway' });
        return false;
      }
      const url = ep.origin;
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
        // A escolha explícita do passo "Provedor" vale se o gateway o oferecer (sem chave lá, aparece como indisponível).
        const wanted = conn.providers.find((p) => p.id === wantedRef.current);
        if (wanted) setProviderState(wanted.id);
        return true;
      } catch (e) {
        if (!mountedRef.current || connectRef.current !== ctrl) return false;
        const fe = friendlyError(e);
        setGateway({ status: 'error', providers: [], error: fe.message, errorCode: fe.code });
        return false;
      } finally {
        if (connectRef.current === ctrl) connectRef.current = null;
      }
    },
    [composition, invalidate],
  );

  /** P21: conecta pela conta (sem token e sem endereço). Busca só o catálogo de provedores habilitados no servidor. */
  const connectAccount = useCallback(async (): Promise<boolean> => {
    connectRef.current?.abort();
    const ctrl = new AbortController();
    connectRef.current = ctrl;
    invalidate();
    setProviderState('');
    setModelState('');
    setGateway({ status: 'connecting', providers: [] });
    try {
      const conn = await composition.connectAccount(ctrl.signal);
      if (!mountedRef.current || connectRef.current !== ctrl) return false;
      setGateway({ status: 'connected', origin: conn.origin, providers: conn.providers });
      const wanted = conn.providers.find((p) => p.id === wantedRef.current) ?? conn.providers.find((p) => p.available);
      if (wanted) {
        setWantedProvider(wanted.id);
        setProviderState(wanted.id);
      }
      return true;
    } catch (e) {
      if (!mountedRef.current || connectRef.current !== ctrl) return false;
      const fe = friendlyError(e);
      setGateway({ status: 'error', providers: [], error: fe.message, errorCode: fe.code });
      return false;
    } finally {
      if (connectRef.current === ctrl) connectRef.current = null;
    }
  }, [composition, invalidate]);

  /** Cancela uma conexão em andamento (nada é guardado; o token digitado continua só no campo). */
  const cancelConnect = useCallback(() => {
    if (!connectRef.current) return;
    connectRef.current.abort();
    connectRef.current = null;
    composition.disconnectGateway();
    setGateway({ status: 'disconnected', providers: [] });
  }, [composition]);

  /** Esquece o gateway e o token. Volta a não haver provedor remoto. */
  const disconnectGateway = useCallback(() => {
    connectRef.current?.abort();
    connectRef.current = null;
    composition.disconnectGateway();
    setGateway({ status: 'disconnected', providers: [] });
    setProviderState('');
    setModelState('');
    setLastRunError(null);
    invalidate();
  }, [composition, invalidate]);

  /** P20: "Testar conexão" — confere de novo o gateway e a disponibilidade dos provedores (sem dados pessoais). */
  const [testing, setTesting] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const testConnection = useCallback(async () => {
    if (gateway.status !== 'connected') return;
    setTesting('testing');
    try {
      const conn = await composition.testGateway();
      if (!mountedRef.current) return;
      setGateway((g) => ({ ...g, status: 'connected', providers: conn.providers }));
      setLastRunError(null);
      setTesting('ok');
    } catch (e) {
      if (!mountedRef.current) return;
      const fe = friendlyError(e);
      setTesting('fail');
      if (fe.code === 'access_denied') {
        composition.disconnectGateway();
        setGateway({ status: 'error', providers: [], error: accountMode ? ACCOUNT_REJECTED_MESSAGE : TOKEN_REJECTED_MESSAGE, errorCode: 'access_denied' });
        setProviderState('');
        setModelState('');
      } else setLastRunError(fe.code);
    }
  }, [composition, gateway.status, accountMode]);

  /** P20: limpa a conversa desta sessão (só memória). */
  const clearConversation = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setLastRunError(null);
  }, []);

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
    // P20: pergunta sobre um exercício do catálogo → resposta local, no aparelho, sem prévia (nada é enviado).
    if (!skipLocalRef.current && deps.localExercises) {
      let local: ReturnType<typeof localAnswer> = null;
      try {
        local = localAnswer(check.text, await deps.localExercises());
      } catch {
        local = null;
      }
      if (local && mountedRef.current) {
        stopWatching();
        setPreview(null);
        setNotice(null);
        setMessages((m) => [
          ...m,
          { id: tempId(), role: 'user', text: check.text, status: 'sent', local: true },
          { id: tempId(), role: 'assistant', text: local.text, status: 'done', local: true },
        ]);
        setDraftState('');
        draftVersion.current++;
        return;
      }
    }
    skipLocalRef.current = false;
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
      setLastRunError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      const cancelled = isAIError(e) && e.code === 'cancelled';
      const error = cancelled ? 'Você cancelou. Nenhuma resposta foi gerada.' : friendlyError(e).message;
      setMessages((m) => m.map((x) => (x.id === userMsg.id ? { ...x, status: cancelled ? 'cancelled' : 'failed', error } : x)));
      if (isRemote && isAIError(e) && !cancelled) setLastRunError(e.code);
      // P07: token recusado durante o uso (revogado, expirado ou trocado no servidor): esquece o token
      // desta página na hora, em vez de continuar tentando com uma credencial que não vale mais.
      if (isRemote && isAIError(e) && e.code === 'access_denied') {
        connectRef.current?.abort();
        connectRef.current = null;
        composition.disconnectGateway();
        setGateway({ status: 'error', providers: [], error: accountMode ? ACCOUNT_REJECTED_MESSAGE : TOKEN_REJECTED_MESSAGE, errorCode: 'access_denied' });
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

  /** P20: "Perguntar à IA mesmo assim" depois de uma resposta local. */
  const askAIAnyway = useCallback(
    (question: string) => {
      skipLocalRef.current = true;
      setDraftState(question);
      setNotice(null);
      invalidate();
    },
    [invalidate],
  );

  const status = assistantStatus({ mode, hasEndpoint: accountMode || !!endpoint, gatewayStatus: gateway.status, gatewayErrorCode: gateway.errorCode, providerAvailable: remoteInfo ? remoteInfo.available : null, lastRunErrorCode: lastRunError });

  return {
    mode,
    setMode,
    gateway,
    endpoint,
    connectGateway,
    connectAccount,
    accountMode,
    cancelConnect,
    disconnectGateway,
    chooseProvider,
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
    status,
    wantedProvider,
    setWantedProvider,
    testing,
    testConnection,
    clearConversation,
    askAIAnyway,
  };
}

export type AssistantState = ReturnType<typeof useAssistant>;
