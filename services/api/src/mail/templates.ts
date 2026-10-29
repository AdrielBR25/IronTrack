// Textos dos e-mails (pt-BR). O link leva o token no fragmento (#) da URL do app: o fragmento não é enviado em
// requisições HTTP nem aparece em logs de servidor ou do proxy; o app o lê e envia no corpo de um POST.
import type { MailMessage } from './mailer.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, paragraphs: string[], link?: { href: string; label: string }): string {
  return `<!doctype html><html lang="pt-BR"><body style="font-family:system-ui,sans-serif;background:#f4f5f4;padding:24px;color:#111">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:16px;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="line-height:1.5">${esc(p)}</p>`).join('\n')}
${link ? `<p><a href="${esc(link.href)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600">${esc(link.label)}</a></p><p style="font-size:12px;color:#555;word-break:break-all">${esc(link.href)}</p>` : ''}
<p style="font-size:12px;color:#555">IronTrack · mensagem automática, não responda.</p></div></body></html>`;
}

export function verificationEmail(to: string, name: string, appOrigin: string, token: string): MailMessage {
  const href = `${appOrigin}/#/conta/verificar-email?token=${encodeURIComponent(token)}`;
  const lines = [`Olá, ${name}.`, 'Confirme seu e-mail para proteger sua conta do IronTrack. O link vale por 24 horas e só pode ser usado uma vez.', 'Se você não criou esta conta, ignore esta mensagem.'];
  return { to, subject: 'Confirme seu e-mail no IronTrack', text: `${lines.join('\n\n')}\n\n${href}`, html: layout('Confirme seu e-mail', lines, { href, label: 'Confirmar e-mail' }) };
}

export function resetEmail(to: string, appOrigin: string, token: string): MailMessage {
  const href = `${appOrigin}/#/conta/redefinir-senha?token=${encodeURIComponent(token)}`;
  const lines = ['Recebemos um pedido para redefinir a senha da sua conta do IronTrack.', 'O link vale por 30 minutos e só pode ser usado uma vez. Ao redefinir, todas as sessões abertas são encerradas.', 'Se não foi você, ignore esta mensagem: sua senha continua a mesma.'];
  return { to, subject: 'Redefinição de senha do IronTrack', text: `${lines.join('\n\n')}\n\n${href}`, html: layout('Redefinir senha', lines, { href, label: 'Redefinir senha' }) };
}

export function securityNotice(to: string, what: 'password_changed' | 'password_reset'): MailMessage {
  const lines = [
    what === 'password_changed' ? 'A senha da sua conta do IronTrack foi alterada. As outras sessões foram encerradas.' : 'A senha da sua conta do IronTrack foi redefinida. Todas as sessões foram encerradas.',
    'Se não foi você, redefina a senha imediatamente pela opção "Esqueci minha senha".',
  ];
  return { to, subject: 'Aviso de segurança do IronTrack', text: lines.join('\n\n'), html: layout('Aviso de segurança', lines) };
}
