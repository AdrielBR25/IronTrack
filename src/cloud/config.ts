// Configuração pública do modo nuvem (Prompt 21). Só existe uma variável de build: `VITE_ACCOUNTS=on` (imagem do irontrack-web na Railway).
// Sem ela (build do GitHub Pages) o app é 100% local, como antes. A API é SEMPRE a mesma origem (`/api`), servida
// pelo Caddy do irontrack-web para a API, na rede privada da Railway: nenhuma URL de backend, chave ou segredo vai para o bundle.
import { readAccountPointer } from './accountPointer';

export const ACCOUNTS_ENABLED = import.meta.env.VITE_ACCOUNTS === 'on';
export const API_BASE = '/api/v1';

/** Modo conta ativo neste aparelho (contas ligadas e uma conta aberta). */
export const accountModeActive = (): boolean => ACCOUNTS_ENABLED && readAccountPointer()?.mode === 'account';
