import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { markRestNotified } from '@/db/repo';
import { useActiveSession, useSettings } from '@/hooks/data';
import { isPaused, remainingMs } from '@/modules/training';
import { playBeep, showLocalNotification, vibrate } from '@/lib/alerts';

/**
 * Observa o descanso da sessão ativa em qualquer tela e dispara os avisos
 * (som, vibração, notificação) uma única vez quando ele termina.
 */
export function RestWatcher() {
  const session = useActiveSession();
  const settings = useSettings();
  const { pathname } = useLocation();
  const [wake, setWake] = useState(0);
  const rest = session?.rest;

  useEffect(() => {
    const onVis = () => setWake((w) => w + 1);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, []);

  useEffect(() => {
    if (!session || !rest || rest.notified || isPaused(rest)) return;
    let cancelled = false;
    const fire = async () => {
      if (cancelled) return;
      if (!(await markRestNotified(session.id, rest.endsAt))) return;
      if (settings.sound) playBeep();
      if (settings.vibration) vibrate();
      if (settings.notifications && document.visibilityState === 'hidden') {
        void showLocalNotification('Descanso terminado', `Próxima: ${rest.nextLabel}`);
      }
      if (pathname !== '/treino') toast.success('Descanso terminado', { description: `Próxima: ${rest.nextLabel}` });
    };
    const ms = remainingMs(rest, Date.now());
    if (ms <= 0) {
      void fire();
      return;
    }
    const t = setTimeout(fire, ms);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, rest?.endsAt, rest?.pausedRemainingMs, rest?.notified, wake, settings.sound, settings.vibration, settings.notifications]);

  return null;
}
