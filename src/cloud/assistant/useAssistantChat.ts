// Estado do chat do Assistente IA central (Fase 00). Tudo vem do servidor (histórico no PostgreSQL da conta); aqui só
// fica o que está na tela. Antes de perguntar e de aprovar uma proposta, sincroniza o aparelho para a IA ler os
// registros atuais e para a aprovação não esbarrar numa versão antiga.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_ERROR_MESSAGES, type ActionView, type ApproveBody, type AssistantStatusView, type ConversationSummaryView, type MessageView, type StreamEvent } from '@shared/assistant/protocol.ts';
import { ApiClientError, assistantApi } from '../api';
import { getSyncEngine } from '../syncEngine';
import { invalidateLife } from '../life/api';

export interface LiveTool {
  name: string;
  label: string;
  kind: 'read' | 'write';
  state: 'start' | 'end';
  ok?: boolean;
}

export interface ChatError {
  code: string;
  message: string;
}

export const errorMessage = (e: unknown): ChatError => {
  if (e instanceof ApiClientError) return { code: e.code, message: ASSISTANT_ERROR_MESSAGES[e.code] ?? e.message };
  return { code: 'internal_error', message: ASSISTANT_ERROR_MESSAGES.internal_error };
};

/** Sincroniza sem travar a conversa por muito tempo (offline ou servidor lento seguem com o que já está na nuvem). */
async function syncQuick(ms = 5000): Promise<void> {
  const engine = getSyncEngine();
  if (!engine) return;
  await Promise.race([engine.syncNow().catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export function useAssistantChat() {
  const [status, setStatus] = useState<AssistantStatusView | null>(null);
  const [statusError, setStatusError] = useState<ChatError | null>(null);
  const [conversations, setConversations] = useState<ConversationSummaryView[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState<string>('Nova conversa');
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [actions, setActions] = useState<Record<string, ActionView>>({});
  const [streaming, setStreaming] = useState<{ text: string; tools: LiveTool[] } | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  // Fase 03: miniaturas das fotos enviadas NESTA sessão (só memória da tela; o servidor não guarda a foto).
  const [photoPreviews, setPhotoPreviews] = useState<Record<string, string>>({});
  const ctrl = useRef<AbortController | null>(null);
  const current = useRef<string | null>(null);
  current.current = conversationId;

  const refreshStatus = useCallback(async () => {
    try {
      const s = await assistantApi.status();
      setStatus(s);
      setStatusError(null);
      setModel((m) => (m && s.models.some((x) => x.id === m) ? m : s.defaultModel));
      return s;
    } catch (e) {
      setStatusError(errorMessage(e));
      return null;
    }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setConversations((await assistantApi.conversations()).conversations);
    } catch {
      /* lista é secundária: o erro aparece ao abrir */
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshList();
    return () => ctrl.current?.abort();
  }, [refreshStatus, refreshList]);

  const open = useCallback(async (id: string | null) => {
    ctrl.current?.abort();
    setStreaming(null);
    setError(null);
    if (!id) {
      setConversationId(null);
      setTitle('Nova conversa');
      setMessages([]);
      setActions({});
      return;
    }
    setLoadingConversation(true);
    try {
      const { conversation } = await assistantApi.conversation(id);
      setConversationId(conversation.id);
      setTitle(conversation.title);
      setMessages(conversation.messages);
      setActions(Object.fromEntries(conversation.actions.map((a) => [a.id, a])));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingConversation(false);
    }
  }, []);

  const send = useCallback(
    async (content: string, photo?: { dataUrl: string } | null): Promise<boolean> => {
      const text = content.trim() || (photo ? 'Analise esta foto da minha refeição.' : '');
      if (!text || streaming) return false;
      setError(null);
      const c = new AbortController();
      ctrl.current = c;
      setStreaming({ text: '', tools: [] });
      const optimistic: MessageView = { id: `local-${Date.now()}`, role: 'user', content: text, status: 'complete', createdAt: new Date().toISOString(), model: null, tools: [], actionIds: [], attachments: photo ? [{ type: 'image', stored: false }] : [] };
      if (photo) setPhotoPreviews((p) => ({ ...p, [optimistic.id]: photo.dataUrl }));
      setMessages((m) => [...m, optimistic]);
      let accepted = false;
      try {
        await syncQuick();
        let draft = '';
        await assistantApi.send(
          current.current,
          { content: text, ...(model ? { model } : {}), ...(timezone() ? { timezone: timezone() } : {}), ...(photo ? { attachments: [{ type: 'image' as const, purpose: 'meal' as const, dataUrl: photo.dataUrl }] } : {}) },
          (ev: StreamEvent) => {
            switch (ev.type) {
              case 'start':
                accepted = true;
                setConversationId(ev.conversationId);
                current.current = ev.conversationId;
                setTitle(ev.title);
                setMessages((m) => m.map((x) => (x.id === optimistic.id ? ev.userMessage : x)));
                if (photo) setPhotoPreviews((p) => ({ ...p, [ev.userMessage.id]: photo.dataUrl }));
                if (ev.created) void refreshList();
                break;
              case 'text':
                draft += ev.delta;
                setStreaming((s) => (s ? { ...s, text: draft } : s));
                break;
              case 'tool':
                setStreaming((s) => {
                  if (!s) return s;
                  const tools = s.tools.filter((t) => !(t.name === ev.name && t.state === 'start'));
                  return { ...s, tools: [...tools, { name: ev.name, label: ev.label, kind: ev.kind, state: ev.state, ...(ev.ok !== undefined ? { ok: ev.ok } : {}) }] };
                });
                break;
              case 'proposal':
                setActions((a) => ({ ...a, [ev.action.id]: ev.action }));
                break;
              case 'done':
                setMessages((m) => [...m, ev.message]);
                setStreaming(null);
                break;
              case 'error':
                setError({ code: ev.code, message: ev.message });
                if (ev.message_id)
                  setMessages((m) => [...m, { id: ev.message_id!, role: 'assistant', content: draft, status: ev.code === 'cancelled' ? 'cancelled' : 'error', createdAt: new Date().toISOString(), model, tools: [], actionIds: [], attachments: [] }]);
                setStreaming(null);
                break;
            }
          },
          c.signal,
        );
        void refreshList();
        void refreshStatus();
        return true;
      } catch (e) {
        const err = errorMessage(e);
        if (!accepted) setMessages((m) => m.filter((x) => x.id !== optimistic.id));
        // Interrompida pela pessoa: o servidor guarda o que já tinha sido respondido.
        if (err.code === 'cancelled' && current.current) void open(current.current);
        else setError(err);
        if (err.code === 'notice_required') void refreshStatus();
        return accepted;
      } finally {
        setStreaming(null);
        if (ctrl.current === c) ctrl.current = null;
      }
    },
    [streaming, model, refreshList, refreshStatus, open],
  );

  const stop = useCallback(() => ctrl.current?.abort(), []);

  const decide = useCallback(
    async (id: string, approve: boolean, body?: ApproveBody): Promise<ActionView | null> => {
      try {
        if (approve) await syncQuick(8000);
        const { action } = approve ? await assistantApi.approve(id, body) : await assistantApi.reject(id);
        setActions((a) => ({ ...a, [id]: action }));
        // Traz a ficha nova/alterada para o aparelho; telas do RPG recarregam.
        if (approve) void getSyncEngine()?.syncNow();
        if (approve) invalidateLife();
        if (current.current) {
          const { conversation } = await assistantApi.conversation(current.current);
          setMessages(conversation.messages);
          setActions(Object.fromEntries(conversation.actions.map((a) => [a.id, a])));
        }
        return action;
      } catch (e) {
        const err = errorMessage(e);
        setError(err);
        // Atualiza o cartão (expirada, desatualizada, já decidida).
        try {
          const { action } = await assistantApi.action(id);
          setActions((a) => ({ ...a, [id]: action }));
        } catch {
          /* mantém o cartão como estava */
        }
        return null;
      }
    },
    [],
  );

  /** Fase 01: desfaz uma proposta aplicada (o servidor recusa se o item mudou depois). */
  const undo = useCallback(async (id: string): Promise<ActionView | null> => {
    try {
      const { action } = await assistantApi.undo(id);
      setActions((a) => ({ ...a, [id]: action }));
      void getSyncEngine()?.syncNow();
      invalidateLife();
      if (current.current) {
        const { conversation } = await assistantApi.conversation(current.current);
        setMessages(conversation.messages);
        setActions(Object.fromEntries(conversation.actions.map((a) => [a.id, a])));
      }
      return action;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, []);

  const rename = useCallback(
    async (id: string, t: string) => {
      await assistantApi.rename(id, t);
      if (id === current.current) setTitle(t);
      await refreshList();
    },
    [refreshList],
  );

  const remove = useCallback(
    async (id: string) => {
      await assistantApi.remove(id);
      if (id === current.current) await open(null);
      await refreshList();
    },
    [open, refreshList],
  );

  const acceptNotice = useCallback(async () => {
    if (!status) return;
    setStatus(await assistantApi.acceptNotice(status.notice.version));
  }, [status]);

  return { photoPreviews, status, statusError, refreshStatus, conversations, conversationId, title, messages, actions, streaming, error, setError, model, setModel, loadingConversation, open, send, stop, decide, undo, rename, remove, acceptNotice };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
