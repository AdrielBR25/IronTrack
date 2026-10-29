// Tela de entrada do modo conta (Prompt 21): aparece quando o aparelho ainda não escolheu entre entrar numa conta e
// usar sem conta. Nenhum banco é aberto aqui. Também atende os links dos e-mails (confirmar e-mail, nova senha).
import { useEffect, useState } from 'react';
import { HashRouter, Link, Route, Routes, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Cloud, HardDrive, Loader2 } from 'lucide-react';
import type { ServerFeatures } from '@shared/api/auth.ts';
import { LogoMark } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { api } from '../api';
import { setLocalMode } from '../accountPointer';
import { afterAuthenticated } from '../runtime';
import { ForgotForm, FormAlert, LoginForm, ResetForm, SignupForm, TermsText, VerifyEmail, friendlyError } from './authForms';

function useSystemTheme() {
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', mq?.matches ?? true);
    apply();
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, []);
}

export function AuthShell({ title, subtitle, children, back }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; back?: boolean }) {
  useEffect(() => {
    document.title = `${title} · IronTrack`;
  }, [title]);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-10 pt-[calc(2rem+env(safe-area-inset-top))]">
      <div className="mb-6 flex items-center gap-2.5">
        <LogoMark />
        <span className="font-display text-xl font-bold tracking-tight">
          Iron<span className="text-primary">Track</span>
        </span>
      </div>
      <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      <div className="mt-6">{children}</div>
      {back && (
        <p className="mt-6 text-center text-sm">
          <Link to="/" className="font-medium text-primary underline-offset-4 hover:underline">
            Voltar
          </Link>
        </p>
      )}
    </main>
  );
}

function useFeatures() {
  const [f, setF] = useState<ServerFeatures | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.config().then((r) => setF(r.features), (e) => setErr(friendlyError(e)));
  }, []);
  return { features: f, error: err };
}

const enter = (r: { account: Parameters<typeof afterAuthenticated>[0] }) => {
  afterAuthenticated(r.account);
  window.location.replace(`${window.location.pathname}#/`);
  window.location.reload();
};

function Welcome() {
  const { features, error } = useFeatures();
  const navigate = useNavigate();
  return (
    <AuthShell title="Bem-vindo ao IronTrack" subtitle="Entre para guardar seus treinos na nuvem e usar em mais de um aparelho.">
      <div className="space-y-3">
        {error && <FormAlert tone="info">Servidor indisponível agora: {error} Você pode usar sem conta e entrar depois.</FormAlert>}
        <Button className="w-full" size="lg" onClick={() => navigate('/conta/entrar')}>
          <Cloud aria-hidden /> Entrar
        </Button>
        <Button className="w-full" size="lg" variant="secondary" onClick={() => navigate('/conta/criar')} disabled={features?.signup === false}>
          Criar conta
        </Button>
        {features?.signup === false && <p className="text-xs text-muted-foreground">Novos cadastros estão fechados neste servidor.</p>}
        <div className="pt-4">
          <Button
            className="w-full"
            variant="outline"
            onClick={() => {
              setLocalMode();
              window.location.replace(`${window.location.pathname}#/`);
              window.location.reload();
            }}
          >
            <HardDrive aria-hidden /> Usar sem conta (só neste aparelho)
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">Sem conta, os dados ficam apenas neste navegador, como antes. Você pode criar uma conta depois e importar tudo.</p>
        </div>
      </div>
    </AuthShell>
  );
}

function Busy() {
  return (
    <p role="status" className="flex items-center gap-2 p-6 text-sm">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Carregando…
    </p>
  );
}

export default function AuthApp() {
  useSystemTheme();
  return (
    <HashRouter>
      <Routes>
        <Route
          path="/conta/entrar"
          element={
            <AuthShell title="Entrar" back>
              <LoginForm onAuthenticated={enter} />
              <p className="mt-6 text-center text-sm text-muted-foreground">
                Não tem conta?{' '}
                <Link to="/conta/criar" className="font-medium text-primary underline-offset-4 hover:underline">
                  Criar conta
                </Link>
              </p>
            </AuthShell>
          }
        />
        <Route
          path="/conta/criar"
          element={
            <AuthShell title="Criar conta" subtitle="Seus treinos guardados com segurança e disponíveis em todos os seus aparelhos." back>
              <SignupForm onAuthenticated={enter} />
            </AuthShell>
          }
        />
        <Route
          path="/conta/esqueci"
          element={
            <AuthShell title="Recuperar senha" subtitle="Enviaremos um link para você criar uma nova senha." back>
              <ForgotForm />
            </AuthShell>
          }
        />
        <Route path="/conta/redefinir-senha" element={<ResetRoute />} />
        <Route
          path="/conta/verificar-email"
          element={
            <AuthShell title="Confirmar e-mail" back>
              <VerifyEmail />
            </AuthShell>
          }
        />
        <Route
          path="/conta/termos"
          element={
            <AuthShell title="Termos e privacidade" back>
              <TermsText />
            </AuthShell>
          }
        />
        <Route path="/carregando" element={<Busy />} />
        <Route path="*" element={<Welcome />} />
      </Routes>
      <Toaster position="top-center" richColors closeButton />
    </HashRouter>
  );
}

function ResetRoute() {
  const navigate = useNavigate();
  return (
    <AuthShell title="Criar nova senha" back>
      <ResetForm onDone={() => navigate('/conta/entrar')} />
    </AuthShell>
  );
}
