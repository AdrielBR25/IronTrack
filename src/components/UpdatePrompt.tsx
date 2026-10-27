import { useRegisterSW } from 'virtual:pwa-register/react';
import { AnimatePresence, motion } from 'framer-motion';
import { RefreshCw, WifiOff, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Verifica atualizações periodicamente enquanto o app está aberto.
      if (reg) setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
    },
  });

  useEffect(() => {
    if (offlineReady) {
      const t = setTimeout(() => setOfflineReady(false), 5000);
      return () => clearTimeout(t);
    }
  }, [offlineReady, setOfflineReady]);

  const { pathname } = useLocation();
  // Na tela de treino o painel inferior é a área de toque principal: o aviso vai para o topo.
  const top = pathname === '/treino';
  const show = needRefresh || offlineReady;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: top ? -80 : 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: top ? -80 : 80, opacity: 0 }}
          className={cn(
            'fixed inset-x-3 z-[60] mx-auto max-w-md rounded-2xl border bg-popover p-3 shadow-2xl',
            top ? 'top-[calc(4.5rem+env(safe-area-inset-top))]' : 'bottom-[calc(9.5rem+env(safe-area-inset-bottom))] md:bottom-4',
          )}
          role="status"
        >
          <div className="flex items-center gap-3">
            <RefreshCw className="h-5 w-5 shrink-0 text-primary" />
            <p className="flex-1 text-sm">{needRefresh ? 'Nova versão disponível.' : 'Pronto para funcionar offline.'}</p>
            {needRefresh && (
              <Button size="sm" onClick={() => void updateServiceWorker(true)}>
                Atualizar
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dispensar"
              onClick={() => {
                setNeedRefresh(false);
                setOfflineReady(false);
              }}
            >
              <X />
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function OfflineBadge() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground" role="status">
      <WifiOff className="h-3.5 w-3.5" /> Offline · dados salvos no aparelho
    </div>
  );
}
