// Formulários de conta (Prompt 21): entrar, criar conta, recuperar e redefinir senha, confirmar e-mail. Usados na tela
// de entrada (sem banco aberto) e dentro do app (sessão expirada, criar conta a partir do modo sem conta).
// Acessíveis: rótulos reais, erros ligados ao campo (aria-describedby), foco no primeiro erro, sem depender de cor.
// Senhas: só no estado do formulário, enviadas no corpo do POST e descartadas; nunca em armazenamento ou log.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Eye, EyeOff, Loader2, MailCheck, X } from 'lucide-react';
import { isValidEmail, normalizeEmail, passwordRequirements, type AccountInfo } from '@shared/api/auth.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ApiClientError, api, type AuthResponse } from '../api';

export function friendlyError(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'rate_limited' && e.retryAfter) return `${e.message} (cerca de ${Math.ceil(e.retryAfter / 60)} min)`;
    return e.message;
  }
  return 'Algo deu errado. Tente de novo.';
}

export function Field({ label, error, hint, children, id }: { label: string; error?: string | null; hint?: React.ReactNode; children: (p: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => React.ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const errId = `${fid}-erro`;
  const hintId = `${fid}-dica`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={fid} className="text-sm font-medium">
        {label}
      </label>
      {children({ id: fid, ...(error ? { 'aria-invalid': true as const } : {}), ...(describedBy ? { 'aria-describedby': describedBy } : {}) })}
      {hint && (
        <div id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </div>
      )}
      {error && (
        <p id={errId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function PasswordInput({ value, onChange, autoComplete, ...rest }: { value: string; onChange: (v: string) => void; autoComplete: 'current-password' | 'new-password'; id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...rest} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} className="pr-12" spellCheck={false} autoCapitalize="none" />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
        aria-pressed={show}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

/** Indicador de requisitos da senha (texto + ícone; não depende só de cor). */
export function PasswordChecklist({ password, email }: { password: string; email: string }) {
  const reqs = passwordRequirements(password, email).filter((r) => r.id !== 'max' || !r.ok);
  const done = reqs.filter((r) => r.ok).length;
  const strength = !password ? 0 : done === reqs.length ? (password.length >= 14 ? 3 : 2) : 1;
  const labels = ['', 'Fraca', 'Boa', 'Forte'];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2" aria-hidden={!password}>
        <div className="flex h-1.5 flex-1 gap-1">
          {[1, 2, 3].map((i) => (
            <span key={i} className={cn('flex-1 rounded-full', strength >= i ? (strength === 1 ? 'bg-destructive' : 'bg-primary') : 'bg-muted')} />
          ))}
        </div>
        {password && <span className="text-xs font-medium">Força: {labels[strength]}</span>}
      </div>
      <ul className="grid gap-1 text-xs" aria-label="Requisitos da senha">
        {reqs.map((r) => (
          <li key={r.id} className={cn('flex items-center gap-1.5', r.ok ? 'text-foreground' : 'text-muted-foreground')}>
            {r.ok ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
            <span>
              {r.label}
              <span className="sr-only">{r.ok ? ' (atendido)' : ' (pendente)'}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FormAlert({ children, tone = 'error' }: { children: React.ReactNode; tone?: 'error' | 'info' | 'success' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('rounded-xl border px-3 py-2.5 text-sm', tone === 'error' ? 'border-destructive/50 bg-destructive/10' : tone === 'success' ? 'border-primary/40 bg-primary/10' : 'bg-secondary')}
    >
      {children}
    </div>
  );
}

function useFocusFirstError(errors: Record<string, string | null | undefined>) {
  const ref = useRef<HTMLFormElement>(null);
  const key = Object.entries(errors)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(',');
  useEffect(() => {
    if (!key) return;
    ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [key]);
  return ref;
}

export type OnAuthenticated = (r: AuthResponse) => void | Promise<void>;

export function LoginForm({ onAuthenticated, defaultEmail = '', lockedEmail }: { onAuthenticated: OnAuthenticated; defaultEmail?: string; lockedEmail?: boolean }) {
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ email?: string | null; password?: string | null }>({});
  const formRef = useFocusFirstError(fieldErr);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fe = { email: isValidEmail(normalizeEmail(email)) ? null : 'Informe um e-mail válido.', password: password ? null : 'Informe a senha.' };
    setFieldErr(fe);
    if (fe.email || fe.password) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.login({ email, password });
      setPassword('');
      await onAuthenticated(r);
    } catch (x) {
      setErr(friendlyError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4" aria-label="Entrar">
      {err && <FormAlert>{err}</FormAlert>}
      <Field label="E-mail" error={fieldErr.email}>
        {(p) => <Input {...p} type="email" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} readOnly={lockedEmail} autoCapitalize="none" spellCheck={false} />}
      </Field>
      <Field label="Senha" error={fieldErr.password}>
        {(p) => <PasswordInput {...p} value={password} onChange={setPassword} autoComplete="current-password" />}
      </Field>
      <Button type="submit" className="w-full" size="lg" disabled={busy}>
        {busy && <Loader2 className="animate-spin" aria-hidden />} Entrar
      </Button>
      <p className="text-center text-sm">
        <Link to="/conta/esqueci" className="font-medium text-primary underline-offset-4 hover:underline">
          Esqueci minha senha
        </Link>
      </p>
    </form>
  );
}

export function SignupForm({ onAuthenticated }: { onAuthenticated: OnAuthenticated }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string | null>>({});
  const formRef = useFocusFirstError(fe);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const strong = passwordRequirements(password, email).every((r) => r.ok);
    const next = {
      name: name.trim() ? (name.trim().length > 60 ? 'Use até 60 caracteres.' : null) : 'Informe seu nome.',
      email: isValidEmail(normalizeEmail(email)) ? null : 'Informe um e-mail válido.',
      password: strong ? null : 'A senha não atende aos requisitos abaixo.',
      confirm: confirm === password ? null : 'As senhas não coincidem.',
      terms: terms ? null : 'Para criar a conta, aceite os termos de uso e a política de privacidade.',
    };
    setFe(next);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.signup({ name, email, password, acceptTerms: true });
      setPassword('');
      setConfirm('');
      await onAuthenticated(r);
    } catch (x) {
      if (x instanceof ApiClientError && x.fields) setFe((f) => ({ ...f, ...x.fields }));
      setErr(friendlyError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-4" aria-label="Criar conta">
      {err && <FormAlert>{err}</FormAlert>}
      <Field label="Nome" error={fe.name}>
        {(p) => <Input {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}
      </Field>
      <Field label="E-mail" error={fe.email}>
        {(p) => <Input {...p} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} />}
      </Field>
      <Field label="Senha" error={fe.password} hint={<PasswordChecklist password={password} email={email} />}>
        {(p) => <PasswordInput {...p} value={password} onChange={setPassword} autoComplete="new-password" />}
      </Field>
      <Field label="Confirmar senha" error={fe.confirm}>
        {(p) => <PasswordInput {...p} value={confirm} onChange={setConfirm} autoComplete="new-password" />}
      </Field>
      <div className="space-y-1.5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
            aria-invalid={fe.terms ? true : undefined}
            aria-describedby={fe.terms ? 'termos-erro' : undefined}
          />
          <span>
            Li e aceito os{' '}
            <Link to="/conta/termos" className="font-medium text-primary underline-offset-4 hover:underline">
              termos de uso e a política de privacidade
            </Link>
            .
          </span>
        </label>
        {fe.terms && (
          <p id="termos-erro" className="text-sm font-medium text-destructive">
            {fe.terms}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full" size="lg" disabled={busy}>
        {busy && <Loader2 className="animate-spin" aria-hidden />} Criar conta
      </Button>
    </form>
  );
}

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(normalizeEmail(email))) {
      setErr('Informe um e-mail válido.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (x) {
      setErr(friendlyError(x));
    } finally {
      setBusy(false);
    }
  };
  if (sent)
    return (
      <FormAlert tone="success">
        Se houver uma conta com esse e-mail, enviamos um link para criar uma nova senha. Ele vale por 30 minutos. Confira também a caixa de spam.
      </FormAlert>
    );
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Recuperar senha">
      {err && <FormAlert>{err}</FormAlert>}
      <Field label="E-mail da conta">
        {(p) => <Input {...p} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} />}
      </Field>
      <Button type="submit" className="w-full" size="lg" disabled={busy}>
        {busy && <Loader2 className="animate-spin" aria-hidden />} Enviar link
      </Button>
    </form>
  );
}

export function ResetForm({ onDone }: { onDone: () => void }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!token) return <FormAlert>Link incompleto. Abra o link do e-mail de novo ou peça outro.</FormAlert>;
  if (done)
    return (
      <div className="space-y-4">
        <FormAlert tone="success">Senha alterada. Por segurança, todas as sessões abertas foram encerradas: entre de novo com a nova senha.</FormAlert>
        <Button className="w-full" onClick={onDone}>
          Entrar
        </Button>
      </div>
    );
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordRequirements(password).every((r) => r.ok)) return setErr('A senha não atende aos requisitos.');
    if (password !== confirm) return setErr('As senhas não coincidem.');
    setBusy(true);
    setErr(null);
    try {
      await api.resetPassword(token, password);
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (x) {
      setErr(friendlyError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Nova senha">
      {err && <FormAlert>{err}</FormAlert>}
      <Field label="Nova senha" hint={<PasswordChecklist password={password} email="" />}>
        {(p) => <PasswordInput {...p} value={password} onChange={setPassword} autoComplete="new-password" />}
      </Field>
      <Field label="Confirmar nova senha">
        {(p) => <PasswordInput {...p} value={confirm} onChange={setConfirm} autoComplete="new-password" />}
      </Field>
      <Button type="submit" className="w-full" size="lg" disabled={busy}>
        {busy && <Loader2 className="animate-spin" aria-hidden />} Salvar nova senha
      </Button>
    </form>
  );
}

/** Confirma o e-mail pelo token do link. Executa uma vez (o token é de uso único). */
export function VerifyEmail({ onVerified }: { onVerified?: () => void }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'ok' | 'error'>(token ? 'working' : 'error');
  const [msg, setMsg] = useState(token ? '' : 'Link incompleto. Abra o link do e-mail de novo.');
  const ran = useRef(false);
  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    api.verifyEmail(token).then(
      () => {
        setState('ok');
        onVerified?.();
      },
      (e) => {
        setState('error');
        setMsg(friendlyError(e));
      },
    );
  }, [token, onVerified]);
  if (state === 'working')
    return (
      <p role="status" className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Confirmando seu e-mail…
      </p>
    );
  if (state === 'ok')
    return (
      <FormAlert tone="success">
        <span className="flex items-center gap-2">
          <MailCheck className="h-4 w-4" aria-hidden /> E-mail confirmado.
        </span>
      </FormAlert>
    );
  return <FormAlert>{msg}</FormAlert>;
}

export function TermsText() {
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <p>
        <strong>O que guardamos:</strong> nome, e-mail, a senha protegida (Argon2id; nunca em texto puro), as sessões abertas (com descrição do navegador) e os dados de treino que você cria: fichas,
        treinos, medidas, metas, planejamento e preferências. Fotos de progresso continuam só no seu aparelho.
      </p>
      <p>
        <strong>Para que:</strong> sincronizar seus dados entre aparelhos e, se você usar o assistente, enviar ao provedor de IA apenas o resumo que você revisou na prévia. Não vendemos nem
        compartilhamos seus dados para publicidade.
      </p>
      <p>
        <strong>Seus direitos:</strong> em Minha conta você pode exportar todos os seus dados e excluir a conta. A exclusão apaga a conta e os dados no servidor imediatamente; cópias de
        segurança do banco são descartadas no ciclo de retenção descrito na política de privacidade.
      </p>
      <p>Uso de saúde: o IronTrack não substitui orientação profissional. Treine com segurança.</p>
    </div>
  );
}

export type { AccountInfo };
