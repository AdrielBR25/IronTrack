import { useEffect } from 'react';
import { useActiveSession } from '@/hooks/data';
import { setTimerStore, SET_TIMER_KEY } from './setTimerStore';

/**
 * Mantém o cronômetro de execução coerente em qualquer tela (P11): recupera após recarregar, acompanha outras abas,
 * corrige mudanças de relógio e descarta cronômetros de séries que não estão mais pendentes. Não desenha nada.
 */
export function SetTimerWatcher() {
  const session = useActiveSession();

  useEffect(() => {
    void setTimerStore.recover();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === SET_TIMER_KEY) setTimerStore.sync();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') setTimerStore.markHidden();
      else setTimerStore.tick(false);
    };
    const onHide = () => setTimerStore.markHidden();
    const id = setInterval(() => setTimerStore.tick(document.visibilityState === 'hidden'), 1000);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(id);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  useEffect(() => {
    if (session === undefined) return;
    setTimerStore.discardWhere((t) => {
      if (!session || t.sessionId !== session.id) return true;
      const set = session.exercises.find((e) => e.id === t.exerciseId)?.sets.find((s) => s.id === t.setId);
      return !set || set.status !== 'pending';
    });
  }, [session]);

  return null;
}
