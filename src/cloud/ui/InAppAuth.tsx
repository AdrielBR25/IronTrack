// Telas de conta dentro do app (Prompt 21): entrar de novo quando a sessão expirou, entrar/criar conta a partir do modo
// sem conta, e os links dos e-mails (confirmar e-mail, nova senha) quando o app já está aberto.
import { useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { PageHeader } from '@/components/AppLayout';
import { useAccountPointer } from '../accountPointer';
import type { AuthResponse } from '../api';
import { afterAuthenticated, refreshAccount } from '../runtime';
import { ForgotForm, LoginForm, ResetForm, SignupForm, TermsText, VerifyEmail } from './authForms';

function useOnAuthenticated() {
  const navigate = useNavigate();
  return (r: AuthResponse) => {
    if (afterAuthenticated(r.account) === 'resumed') {
      toast.success('Sessão renovada. A sincronização continua de onde parou.');
      navigate('/conta/sincronizacao');
      return;
    }
    window.location.replace(`${window.location.pathname}#/`);
    window.location.reload();
  };
}

const Narrow = ({ children }: { children: React.ReactNode }) => <div className="mx-auto max-w-md">{children}</div>;

export function LoginRoute() {
  const p = useAccountPointer();
  const onAuth = useOnAuthenticated();
  const expired = p?.mode === 'account';
  return (
    <Narrow>
      <PageHeader title={expired ? 'Entrar de novo' : 'Entrar'} subtitle={expired ? 'Sua sessão expirou. Nada deste aparelho foi perdido: as alterações pendentes serão enviadas assim que você entrar.' : undefined} />
      <LoginForm onAuthenticated={onAuth} defaultEmail={expired ? p.email : ''} />
      {!expired && (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Não tem conta?{' '}
          <Link to="/conta/criar" className="font-medium text-primary underline-offset-4 hover:underline">
            Criar conta
          </Link>
        </p>
      )}
    </Narrow>
  );
}

export function SignupRoute() {
  const onAuth = useOnAuthenticated();
  return (
    <Narrow>
      <PageHeader title="Criar conta" subtitle="Depois de criar, você pode importar os dados deste navegador para a conta." />
      <SignupForm onAuthenticated={onAuth} />
    </Narrow>
  );
}

export function ForgotRoute() {
  return (
    <Narrow>
      <PageHeader title="Recuperar senha" />
      <ForgotForm />
    </Narrow>
  );
}

export function ResetRoute() {
  const navigate = useNavigate();
  return (
    <Narrow>
      <PageHeader title="Criar nova senha" />
      <ResetForm onDone={() => navigate('/conta/entrar')} />
    </Narrow>
  );
}

export function VerifyRoute() {
  const onVerified = useCallback(() => void refreshAccount(), []);
  return (
    <Narrow>
      <PageHeader title="Confirmar e-mail" />
      <VerifyEmail onVerified={onVerified} />
    </Narrow>
  );
}

export function TermsRoute() {
  return (
    <Narrow>
      <PageHeader title="Termos e privacidade" />
      <TermsText />
    </Narrow>
  );
}
