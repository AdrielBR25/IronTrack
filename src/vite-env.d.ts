/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Endereço PÚBLICO (origem HTTPS) do servidor seguro de IA do IronTrack. Nunca uma chave ou token. */
  readonly VITE_AI_GATEWAY_URL?: string;
}
