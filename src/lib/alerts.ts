// Avisos de fim de descanso: som (Web Audio), vibração e notificação local.
// Cada recurso é opcional; a interface sempre mostra um aviso visual também.

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Deve ser chamado em um gesto do usuário (ex.: CONCLUIR SÉRIE) para liberar o áudio no celular. */
export function unlockAudio() {
  const ctx = getCtx();
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

export function audioAvailable(): boolean {
  return typeof window !== 'undefined' && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
}

export function playBeep(): boolean {
  const ctx = getCtx();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    [0, 0.22, 0.44].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 2 ? 1320 : 880;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.5, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + (i === 2 ? 0.45 : 0.18));
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.5);
    });
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

export function vibrationAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function vibrate(pattern: number[] = [300, 120, 300, 120, 500]): boolean {
  try {
    return vibrationAvailable() ? navigator.vibrate(pattern) : false;
  } catch {
    return false;
  }
}

export type NotifState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotifState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotifState;
}

/** Só chamar a partir de um clique explícito do usuário. */
export async function requestNotificationPermission(): Promise<NotifState> {
  if (notificationState() === 'unsupported') return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotifState;
  } catch {
    return notificationState();
  }
}

export async function showLocalNotification(title: string, body: string): Promise<boolean> {
  if (notificationState() !== 'granted') return false;
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body,
    tag: 'irontrack-rest',
    renotify: true,
    icon: `${import.meta.env.BASE_URL}pwa-192.png`,
    badge: `${import.meta.env.BASE_URL}pwa-192.png`,
    vibrate: [300, 120, 300],
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, options);
      return true;
    }
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

export async function closeRestNotifications() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const list = await reg?.getNotifications({ tag: 'irontrack-rest' });
    list?.forEach((n) => n.close());
  } catch {
    /* ignore */
  }
}
