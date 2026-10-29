// Sessão do assistente na MEMÓRIA do app (IronTrack 2.0 F01/P20, docs/IA_ASSISTENTE.md §sessão). Antes (P05–P07) a
// conexão com o gateway e a conversa morriam ao sair da tela; agora sobrevivem à navegação dentro do app (ex.: abrir o
// assistente pelo treino e voltar), para que o atalho do treino e o dos detalhes do exercício sirvam para algo.
// Continua valendo: nada vai para localStorage, sessionStorage, IndexedDB, backup ou logs. Recarregar ou fechar o app
// apaga tudo (é só uma variável do módulo). Sem uso por IDLE_FORGET_MS, o token e a conversa são esquecidos sozinhos.
import { createAssistantService, type AssistantComposition } from '@/integrations/ai/assistantService';
import type { AssistantCategory } from '@/integrations/ai/contextSources';
import type { ChatMessage } from './assistantModel';

/** Sem uso por 30 min: esquece token e conversa. */
export const IDLE_FORGET_MS = 30 * 60_000;

export interface AssistantSnapshot {
  messages: ChatMessage[];
  categories: AssistantCategory[];
  mode: 'simulated' | 'remote';
  providerId: string;
  modelId: string;
  gateway: { status: 'disconnected' | 'connecting' | 'connected' | 'error'; origin?: string; providers: { id: string }[]; error?: string; errorCode?: string };
}

let composition: AssistantComposition | null = null;
let snapshot: AssistantSnapshot | null = null;
let lastActivity = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Composição única do app (registro de provedores + token do gateway, só em memória). */
export function sessionComposition(): AssistantComposition {
  if (composition && lastActivity && Date.now() - lastActivity > IDLE_FORGET_MS) forgetAssistantSession();
  composition ??= createAssistantService();
  return composition;
}

export function loadSnapshot(): AssistantSnapshot | null {
  if (snapshot && Date.now() - lastActivity > IDLE_FORGET_MS) forgetAssistantSession();
  return snapshot;
}

/** Guarda o estado da tela ao sair (só memória) e arma o esquecimento por inatividade. */
export function saveSnapshot(s: AssistantSnapshot): void {
  snapshot = s;
  touchAssistantSession();
}

export function touchAssistantSession(): void {
  lastActivity = Date.now();
  if (timer) clearTimeout(timer);
  timer = setTimeout(forgetAssistantSession, IDLE_FORGET_MS);
  (timer as { unref?: () => void }).unref?.();
}

/** Esquece token, provedores remotos e conversa (inatividade, "Encerrar sessão" ou testes). */
export function forgetAssistantSession(): void {
  composition?.disconnectGateway();
  composition = null;
  snapshot = null;
  lastActivity = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}
