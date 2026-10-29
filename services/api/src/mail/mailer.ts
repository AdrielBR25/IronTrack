// Envio de e-mails transacionais (verificação, recuperação, aviso de segurança). Sempre no backend.
// Provedores: `disabled` (padrão: recursos dependentes ficam INDISPONÍVEIS, nada é simulado), `resend` (API HTTPS,
// chave em RESEND_API_KEY) e `test-mailbox` (somente testes; proibido em produção pela configuração).
import type { ApiConfig } from '../config.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  readonly provider: ApiConfig['email']['provider'];
  readonly enabled: boolean;
  send(msg: MailMessage): Promise<void>;
}

export class MailError extends Error {
  readonly reason: 'disabled' | 'provider';
  constructor(reason: 'disabled' | 'provider') {
    super(reason === 'disabled' ? 'E-mail não configurado' : 'Falha do provedor de e-mail');
    this.reason = reason;
    this.name = 'MailError';
  }
}

export const disabledMailer: Mailer = {
  provider: 'disabled',
  enabled: false,
  async send() {
    throw new MailError('disabled');
  },
};

/** Caixa de e-mail em memória (E2E e testes de integração). Nunca usada em produção. */
export class TestMailbox implements Mailer {
  readonly provider = 'test-mailbox' as const;
  readonly enabled = true;
  readonly messages: (MailMessage & { at: number })[] = [];
  async send(msg: MailMessage) {
    this.messages.push({ ...msg, at: Date.now() });
    if (this.messages.length > 500) this.messages.shift();
  }
  for(to: string) {
    return this.messages.filter((m) => m.to === to);
  }
  clear() {
    this.messages.length = 0;
  }
}

export function resendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    provider: 'resend',
    enabled: true,
    async send(msg) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
          signal: ctrl.signal,
          redirect: 'manual',
        });
        if (res.status < 200 || res.status >= 300) throw new MailError('provider');
      } catch (e) {
        throw e instanceof MailError ? e : new MailError('provider');
      } finally {
        clearTimeout(t);
      }
    },
  };
}

export function createMailer(cfg: ApiConfig): Mailer {
  if (cfg.email.provider === 'resend' && cfg.email.resendApiKey) return resendMailer(cfg.email.resendApiKey, cfg.email.from);
  if (cfg.email.provider === 'test-mailbox' && cfg.testMode) return new TestMailbox();
  return disabledMailer;
}
