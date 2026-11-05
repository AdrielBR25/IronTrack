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
  /** Fase 07: código HTTP e tipo do erro do provedor (ex.: 403 validation_error = domínio não verificado). Sem dados pessoais. */
  readonly providerStatus?: number;
  readonly providerError?: string;
  constructor(reason: 'disabled' | 'provider', detail: { status?: number; error?: string } = {}) {
    super(reason === 'disabled' ? 'E-mail não configurado' : 'Falha do provedor de e-mail');
    this.reason = reason;
    this.name = 'MailError';
    if (detail.status !== undefined) this.providerStatus = detail.status;
    if (detail.error) this.providerError = detail.error;
  }
}

/** Dados seguros para log de uma falha de envio (nunca o destinatário, o corpo ou a chave). */
export function mailFailureInfo(e: unknown): Record<string, string | number> {
  if (!(e instanceof MailError)) return { reason: 'unknown' };
  return { reason: e.reason, ...(e.providerStatus !== undefined ? { providerStatus: e.providerStatus } : {}), ...(e.providerError ? { providerError: e.providerError } : {}) };
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
        if (res.status < 200 || res.status >= 300) {
          let error: string | undefined;
          try {
            const b = (await res.json()) as { name?: unknown };
            if (typeof b?.name === 'string' && /^[a-z_]{1,40}$/.test(b.name)) error = b.name;
          } catch {
            /* corpo não-JSON */
          }
          throw new MailError('provider', { status: res.status, ...(error ? { error } : {}) });
        }
      } catch (e) {
        throw e instanceof MailError ? e : new MailError('provider');
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/** O destinatário está na lista (e-mail exato ou domínio "@dominio")? Lista vazia = todos. */
export function recipientAllowed(to: string, allowlist: readonly string[]): boolean {
  if (!allowlist.length) return true;
  const addr = to.trim().toLowerCase();
  const domain = addr.slice(addr.lastIndexOf('@'));
  return allowlist.some((a) => (a.startsWith('@') ? a === domain : a === addr));
}

/**
 * Fase 07 — homologação: assunto com "[Homologação]" e entrega só para a EMAIL_ALLOWLIST. Para quem não está na lista
 * o envio é descartado em silêncio (a API responde como se tivesse enviado, sem revelar nada a quem pediu) e o log
 * registra só o evento `email_suppressed`, sem o endereço.
 */
export function guardedMailer(inner: Mailer, opts: { staging: boolean; allowlist: readonly string[]; onSuppressed?: () => void }): Mailer {
  if (!opts.staging && !opts.allowlist.length) return inner;
  return {
    provider: inner.provider,
    enabled: inner.enabled,
    async send(msg) {
      if (!recipientAllowed(msg.to, opts.allowlist)) {
        opts.onSuppressed?.();
        return;
      }
      if (!opts.staging) return inner.send(msg);
      const tag = '[Homologação] ';
      const note = 'Mensagem do ambiente de HOMOLOGAÇÃO (testes) do IronTrack.';
      return inner.send({ ...msg, subject: tag + msg.subject, text: `${note}\n\n${msg.text}`, html: msg.html.replace('<body', `<body data-env="staging"`).replace(/(<div[^>]*>)/, `$1<p style="background:#fef08a;padding:8px;border-radius:8px;font-size:13px">${note}</p>`) });
    },
  };
}

export function createMailer(cfg: ApiConfig, onSuppressed?: () => void): Mailer {
  const base = cfg.email.provider === 'resend' && cfg.email.resendApiKey ? resendMailer(cfg.email.resendApiKey, cfg.email.from) : cfg.email.provider === 'test-mailbox' && cfg.testMode ? new TestMailbox() : disabledMailer;
  if (!base.enabled || base instanceof TestMailbox) return base;
  return guardedMailer(base, { staging: cfg.appEnv === 'staging', allowlist: cfg.email.allowlist, ...(onSuppressed ? { onSuppressed } : {}) });
}
