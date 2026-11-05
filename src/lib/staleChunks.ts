// Fase 07: depois de uma nova publicação, uma aba aberta com a versão anterior pode pedir um arquivo de tela (chunk)
// que não existe mais no servidor (o nome muda a cada build). Em vez de tela branca, recarrega UMA vez para pegar a
// versão nova. A trava em sessionStorage evita laço de recarga se o problema for outro (ex.: sem conexão).
const KEY = 'irontrack.chunkReload.v1';
const WINDOW_MS = 60_000;

export const isChunkLoadError = (e: unknown): boolean => {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Unable to preload CSS/i.test(msg);
};

/** Recarrega a página se não recarregou por esse motivo no último minuto. Devolve true se vai recarregar. */
export function reloadOnceForStaleChunk(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.sessionStorage, now = Date.now(), reload = () => window.location.reload()): boolean {
  try {
    const last = Number(storage?.getItem(KEY) ?? 0);
    if (last && now - last < WINDOW_MS) return false;
    storage?.setItem(KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

export function installStaleChunkGuard() {
  if (typeof window === 'undefined') return;
  // Evento do Vite quando o pré-carregamento de um chunk falha.
  window.addEventListener('vite:preloadError', (event) => {
    if (navigator.onLine === false) return; // offline: deixa a tela de erro explicar; recarregar não ajuda
    if (reloadOnceForStaleChunk()) event.preventDefault();
  });
}
