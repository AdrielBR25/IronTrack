import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { getInstallEvent, isStandalone, promptInstall, subscribeInstall } from '@/lib/install';
import { Button } from './ui/button';
import { LogoMark } from './Logo';

const KEY = 'irontrack.install.dismissed';

export function useInstallAvailable() {
  const [ev, setEv] = useState(getInstallEvent());
  useEffect(() => {
    const unsub = subscribeInstall(() => setEv(getInstallEvent()));
    return () => {
      unsub();
    };
  }, []);
  return !!ev && !isStandalone();
}

/** Convite para instalar o app (só aparece quando o navegador permite instalar). */
export function InstallBanner() {
  const available = useInstallAvailable();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (!available || dismissed) return null;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-3">
      <LogoMark className="h-10 w-10 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Instale o IronTrack</p>
        <p className="text-xs text-muted-foreground">Tela cheia, ícone na tela inicial e uso offline.</p>
      </div>
      <Button size="sm" onClick={() => void promptInstall()}>
        <Download /> Instalar
      </Button>
      <button
        aria-label="Dispensar"
        className="rounded-full p-1.5 text-muted-foreground"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(KEY, '1');
          } catch {
            /* ignore */
          }
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
