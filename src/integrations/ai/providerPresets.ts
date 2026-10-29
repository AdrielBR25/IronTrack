// Provedores de IA pré-configurados (IronTrack 2.0, ajuste do Prompt 20). Só dados públicos e fixos: nome, página
// oficial de criação de chaves e endereço oficial da API. O endereço da API é INFORMATIVO: o navegador nunca chama o
// provedor diretamente (quem chama é o servidor seguro do IronTrack, o gateway, com a chave guardada lá). Os IDs são
// os mesmos do gateway (services/ai-gateway/src/config.ts, PROVIDER_IDS). Nenhum modelo é listado aqui: os modelos
// vêm só do catálogo do gateway conectado.

export interface ProviderPreset {
  /** Mesmo ID do gateway. */
  id: 'openai' | 'anthropic' | 'gemini';
  name: string;
  /** Página oficial onde a pessoa cria a chave de API (abre em nova aba, sem parâmetros). */
  keysUrl: string;
  /** API oficial do provedor (usada só pelo gateway; mostrada nos detalhes). */
  apiBase: string;
  /** Variável de ambiente do gateway que guarda a chave (services/ai-gateway/config/*.example.json, apiKeyEnv). */
  gatewayKeyEnv: string;
  /** Passos curtos para gerar a chave na página oficial. */
  steps: readonly string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    keysUrl: 'https://platform.openai.com/api-keys',
    apiBase: 'https://api.openai.com/v1',
    gatewayKeyEnv: 'OPENAI_API_KEY',
    steps: ['Entre na sua conta da OpenAI Platform.', 'Toque em "Create new secret key", dê um nome e confirme.', 'Copie a chave: ela só aparece uma vez.'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    apiBase: 'https://api.anthropic.com',
    gatewayKeyEnv: 'ANTHROPIC_API_KEY',
    steps: ['Entre no Console da Anthropic.', 'Em "API keys", toque em "Create key", dê um nome e confirme.', 'Copie a chave: ela só aparece uma vez.'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    keysUrl: 'https://aistudio.google.com/app/apikey',
    apiBase: 'https://generativelanguage.googleapis.com',
    gatewayKeyEnv: 'GEMINI_API_KEY',
    steps: ['Entre no Google AI Studio com sua conta Google.', 'Toque em "Create API key" e escolha ou crie um projeto.', 'Copie a chave gerada.'],
  },
];

export const presetById = (id: string): ProviderPreset | undefined => PROVIDER_PRESETS.find((p) => p.id === id);

/** Hosts oficiais das páginas de chaves. Um link fora desta lista nunca é aberto. */
const OFFICIAL_KEY_HOSTS = new Set(['platform.openai.com', 'console.anthropic.com', 'aistudio.google.com']);

/** Confere se o link é a página oficial, em HTTPS, sem usuário, parâmetros ou fragmento (nada do usuário vai junto). */
export function isOfficialKeysUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && OFFICIAL_KEY_HOSTS.has(u.hostname) && !u.username && !u.password && !u.search && !u.hash && !u.port;
}

/**
 * Reconhece pelo formato uma CHAVE DE PROVEDOR colada no campo do token do gateway (são credenciais diferentes e não
 * intercambiáveis). Devolve o nome do provedor provável ou null. Não guarda nem envia o valor.
 */
export function providerKeyKind(value: string): string | null {
  const v = value.trim();
  if (/^sk-ant-/.test(v)) return 'Anthropic';
  // Tamanhos diferentes dos 43 caracteres do token do gateway (32 bytes em base64url), para não confundir os dois.
  if (/^sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{45,}$/.test(v)) return 'OpenAI';
  if (/^AIza[0-9A-Za-z_-]{35}$/.test(v)) return 'Google Gemini';
  return null;
}
