// Lembretes da Bíblia (Fase 05, docs/BIBLIA.md §10). Opcionais e desligados por padrão.
//
//  - Com o app ABERTO: no horário escolhido aparece um aviso discreto dentro do app (uma vez por lembrete por dia).
//  - Notificação do navegador/PWA: só se a pessoa ativar em Ajustes (o pedido de permissão sai de um toque dela) e só
//    quando o app está aberto em segundo plano. Com o app FECHADO não há notificação: isso exigiria push no servidor
//    (Web Push + VAPID + assinatura por aparelho), que ainda não existe. Nada de notificações falsas.
//  - Respeita o horário de silêncio e o fuso do aparelho; nunca aparece durante o treino em andamento (a tela de treino
//    fica fora do layout que monta este componente) nem com uma sessão de leitura/estudo rodando.
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { BiblePrefsView, Reminder } from '@shared/bible/protocol.ts';
import { useLifeVersion } from '../life/api';
import { bibleApi } from './api';

const FIRED = 'irontrack.bible.reminders.fired.v1';
const NOTIFY = 'irontrack.bible.notify.v1';

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Dentro do horário de silêncio (pode atravessar a meia-noite, ex.: 22:00–07:00). */
export function inQuiet(now: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  const n = toMin(now);
  const a = toMin(start);
  const b = toMin(end);
  return a < b ? n >= a && n < b : n >= a || n < b;
}

/** Lembretes que devem disparar agora (até 15 min de atraso, para quem abriu o app logo depois). */
export function dueReminders(list: Reminder[], now: Date, fired: Set<string>): Reminder[] {
  const n = toMin(hhmm(now));
  return list.filter((r) => r.enabled && r.days.includes(now.getDay()) && n >= toMin(r.time) && n - toMin(r.time) <= 15 && !fired.has(`${ymd(now)}|${r.kind}|${r.time}`));
}

export const notifyEnabled = () => {
  try {
    return localStorage.getItem(NOTIFY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  } catch {
    return false;
  }
};
export async function enableNotifications(on: boolean): Promise<boolean> {
  try {
    if (!on) {
      localStorage.removeItem(NOTIFY);
      return false;
    }
    if (typeof Notification === 'undefined') return false;
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (p !== 'granted') return false;
    localStorage.setItem(NOTIFY, '1');
    return true;
  } catch {
    return false;
  }
}

// Rótulos locais (sem importar o protocolo: o cânon da tradução não entra no pacote principal).
const REMINDER_LABEL: Record<Reminder['kind'], string> = { verse: 'Versículo do dia', reading: 'Horário de leitura', plan: 'Plano de leitura', reflection: 'Momento de reflexão' };
const TARGET: Record<Reminder['kind'], string> = { verse: '/biblia', reading: '/biblia/ler', plan: '/biblia/planos', reflection: '/biblia/diario?nova=1' };
const TEXT: Record<Reminder['kind'], string> = { verse: 'A passagem de hoje está pronta.', reading: 'Hora da sua leitura.', plan: 'A leitura do seu plano de hoje está esperando.', reflection: 'Um momento para escrever uma reflexão ou gratidão?' };

export function BibleReminders() {
  const v = useLifeVersion();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const prefs = useRef<BiblePrefsView | null>(null);
  const path = useRef(pathname);
  path.current = pathname;

  useEffect(() => {
    let alive = true;
    bibleApi
      .prefs()
      .then((r) => alive && (prefs.current = r.prefs))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [v]);

  useEffect(() => {
    const check = () => {
      const p = prefs.current;
      if (!p || !p.reminders.some((r) => r.enabled)) return;
      const now = new Date();
      if (inQuiet(hhmm(now), p.quietStart, p.quietEnd)) return;
      if (path.current.startsWith('/treino') || path.current.startsWith('/conhecimento/foco')) return;
      try {
        if (localStorage.getItem('irontrack.knowledge.timer.v1')?.includes('"timer":{')) return; // sessão rodando
      } catch {
        /* ignora */
      }
      let fired: Set<string>;
      try {
        fired = new Set((JSON.parse(localStorage.getItem(FIRED) ?? '[]') as string[]).filter((k) => k.startsWith(ymd(now))));
      } catch {
        fired = new Set();
      }
      const due = dueReminders(p.reminders, now, fired);
      if (!due.length) return;
      const r = due[0];
      for (const d of due) fired.add(`${ymd(now)}|${d.kind}|${d.time}`);
      try {
        localStorage.setItem(FIRED, JSON.stringify([...fired]));
      } catch {
        /* ignora */
      }
      if (document.visibilityState === 'hidden' && notifyEnabled()) {
        void navigator.serviceWorker?.getRegistration().then((reg) => {
          if (reg) void reg.showNotification(REMINDER_LABEL[r.kind], { body: TEXT[r.kind], tag: `bible-${r.kind}`, icon: 'pwa-192.png' });
          else new Notification(REMINDER_LABEL[r.kind], { body: TEXT[r.kind] });
        });
      } else {
        toast(REMINDER_LABEL[r.kind], { description: TEXT[r.kind], action: { label: 'Abrir', onClick: () => nav(TARGET[r.kind]) }, duration: 10_000 });
      }
    };
    const i = setInterval(check, 30_000);
    const first = setTimeout(check, 3_000);
    return () => {
      clearInterval(i);
      clearTimeout(first);
    };
  }, [nav]);
  return null;
}
