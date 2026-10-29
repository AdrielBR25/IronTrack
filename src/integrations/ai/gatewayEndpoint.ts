// Endereço do servidor seguro do IronTrack (gateway de IA), resolvido automaticamente (ajuste do Prompt 20). A pessoa
// não digita host a cada conexão: o endereço vem, nesta ordem, de
//   1. "Configurações avançadas" deste aparelho (localStorage `irontrack.aiGateway.v1`, só a ORIGEM pública);
//   2. a configuração pública da publicação (`VITE_AI_GATEWAY_URL` no build: um endereço, nunca uma chave).
// Os dois passam por validateGatewayUrl (HTTPS, ou HTTP só em loopback; sem usuário, caminho ou parâmetros); um valor
// inválido é ignorado. Sem nenhum dos dois, não há gateway e a tela diz isso. Nunca é o endereço de um provedor
// (api.openai.com etc.): o navegador não fala com provedores. Token e chaves NUNCA são guardados aqui.
import { useSyncExternalStore } from 'react';
import { validateGatewayUrl, type GatewayUrlCheck } from './gatewayValidation';

export const GATEWAY_ENDPOINT_KEY = 'irontrack.aiGateway.v1';

export type GatewayEndpointSource = 'device' | 'build';

export interface GatewayEndpoint {
  origin: string;
  source: GatewayEndpointSource;
}

/** Hosts das APIs oficiais dos provedores: nunca aceitos como gateway (o navegador não chama provedores). */
const PROVIDER_API_HOSTS = new Set(['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com']);

/** Validação do gateway + recusa dos hosts de provedor (confundir os dois mandaria a pergunta direto ao provedor). */
export function checkGatewayOrigin(input: string): GatewayUrlCheck {
  const c = validateGatewayUrl(input);
  if (c.ok && PROVIDER_API_HOSTS.has(new URL(c.origin).hostname))
    return { ok: false, error: 'Este é o endereço da API do provedor, não o do servidor seguro do IronTrack. O app nunca chama o provedor diretamente.' };
  return c;
}

function buildOrigin(): string | null {
  const raw = (import.meta.env.VITE_AI_GATEWAY_URL as string | undefined) ?? '';
  if (!raw.trim()) return null;
  const c = checkGatewayOrigin(raw);
  return c.ok ? c.origin : null;
}

function readDevice(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(GATEWAY_ENDPOINT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { v?: unknown; origin?: unknown };
    if (v?.v !== 1 || typeof v.origin !== 'string') return null;
    const c = checkGatewayOrigin(v.origin);
    return c.ok ? c.origin : null;
  } catch {
    return null;
  }
}

/** Endereço em uso agora, ou null se não houver gateway configurado. */
export function resolveGatewayEndpoint(): GatewayEndpoint | null {
  const device = readDevice();
  if (device) return { origin: device, source: 'device' };
  const build = buildOrigin();
  return build ? { origin: build, source: 'build' } : null;
}

let listeners: (() => void)[] = [];
const emit = () => listeners.forEach((l) => l());

/** Guarda (validado) o endereço das configurações avançadas. Só a origem; nada mais. */
export function saveGatewayOrigin(input: string): GatewayUrlCheck {
  const c = checkGatewayOrigin(input);
  if (!c.ok) return c;
  try {
    globalThis.localStorage?.setItem(GATEWAY_ENDPOINT_KEY, JSON.stringify({ v: 1, origin: c.origin }));
  } catch {
    return { ok: false, error: 'Não foi possível salvar o endereço neste aparelho.' };
  }
  emit();
  return c;
}

/** Esquece o endereço salvo neste aparelho (volta ao da publicação, se houver). */
export function forgetGatewayOrigin(): void {
  try {
    globalThis.localStorage?.removeItem(GATEWAY_ENDPOINT_KEY);
  } catch {
    /* sem armazenamento: nada a apagar */
  }
  emit();
}

let cache: { key: string; value: GatewayEndpoint | null } = { key: '\0', value: null };
function snapshot(): GatewayEndpoint | null {
  const v = resolveGatewayEndpoint();
  const key = v ? `${v.source}|${v.origin}` : '';
  if (key !== cache.key) cache = { key, value: v };
  return cache.value;
}

function subscribe(l: () => void) {
  listeners = [...listeners, l];
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === GATEWAY_ENDPOINT_KEY) l();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners = listeners.filter((x) => x !== l);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** Endereço resolvido, atualizado quando muda nesta aba ou em outra. */
export function useGatewayEndpoint(): GatewayEndpoint | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
