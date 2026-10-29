// Minha conta (Prompt 21): dados da conta, verificação de e-mail, senha, sessões abertas, exportação, saída e exclusão.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { CloudDownload, Download, KeyRound, Laptop, Loader2, LogOut, MailWarning, RefreshCw, ShieldCheck, Trash2, Upload, UserRound } from 'lucide-react';
import { passwordRequirements, type SessionInfo } from '@shared/api/auth.ts';
import { PageHeader } from '@/components/AppLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { downloadJson } from '@/lib/utils';
import { useAccountPointer } from '../accountPointer';
import { api } from '../api';
import { refreshAccount, signOutHere } from '../runtime';
import { useSyncStatus } from '../syncEngine';
import { Field, FormAlert, PasswordChecklist, PasswordInput, friendlyError } from './authForms';
import { SyncStatusChip } from './SyncStatusChip';

const fmtDate = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function reloadHome() {
  window.location.replace(`${window.location.pathname}#/`);
  window.location.reload();
}

export default function AccountPage() {
  const p = useAccountPointer();
  const sync = useSyncStatus();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [sessErr, setSessErr] = useState<string | null>(null);
  const [name, setName] = useState(p?.mode === 'account' ? p.name : '');
  const [dialog, setDialog] = useState<null | 'password' | 'logout' | 'delete'>(null);

  const loadSessions = useCallback(() => {
    setSessErr(null);
    api.sessions().then(
      (r) => setSessions(r.sessions),
      (e) => setSessErr(friendlyError(e)),
    );
  }, []);
  useEffect(() => {
    void refreshAccount();
    loadSessions();
  }, [loadSessions]);
  useEffect(() => {
    if (p?.mode === 'account') setName(p.name);
  }, [p]);

  if (p?.mode !== 'account') {
    return (
      <>
        <PageHeader title="Conta" />
        <Card>
          <CardContent className="space-y-3 pt-4">
            <p className="text-sm">Você está usando o IronTrack sem conta: os dados ficam só neste navegador.</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => navigate('/conta/entrar')}>Entrar</Button>
              <Button variant="secondary" onClick={() => navigate('/conta/criar')}>
                Criar conta
              </Button>
            </div>
          </CardContent>
        </Card>
      </>
    );
  }

  const saveName = async () => {
    try {
      await api.updateName(name);
      await refreshAccount();
      toast.success('Nome atualizado.');
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  const resend = async () => {
    try {
      await api.resendVerification();
      toast.success('Enviamos um novo link de confirmação para o seu e-mail.');
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  const exportData = async () => {
    try {
      const data = await api.exportData();
      downloadJson(`irontrack-conta-${new Date().toISOString().slice(0, 10)}.json`, data);
      toast.success('Exportação baixada. Fotos ficam fora: elas estão só neste aparelho (exporte pelo backup local em Ajustes).');
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  return (
    <>
      <PageHeader title="Minha conta" subtitle={p.email} action={<SyncStatusChip />} />
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRound className="h-4 w-4" aria-hidden /> Dados da conta
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Nome">
              {(f) => (
                <div className="flex gap-2">
                  <Input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
                  <Button variant="secondary" onClick={saveName} disabled={!name.trim() || name.trim() === p.name}>
                    Salvar
                  </Button>
                </div>
              )}
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">E-mail</p>
                <p className="text-sm text-muted-foreground">{p.email}</p>
              </div>
              {p.emailVerified ? (
                <Badge>
                  <ShieldCheck aria-hidden /> Confirmado
                </Badge>
              ) : (
                <Badge variant="warn">
                  <MailWarning aria-hidden /> Não confirmado
                </Badge>
              )}
            </div>
            {!p.emailVerified && (
              <FormAlert tone="info">
                Confirme seu e-mail pelo link que enviamos. Sem confirmação, a recuperação de senha e o assistente de IA ficam indisponíveis.{' '}
                <Button variant="link" className="h-auto p-0" onClick={resend}>
                  Reenviar link
                </Button>
              </FormAlert>
            )}
            <Button variant="outline" onClick={() => setDialog('password')}>
              <KeyRound aria-hidden /> Alterar senha
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4" aria-hidden /> Sincronização e dados
            </CardTitle>
            <CardDescription>Seus dados ficam neste aparelho e na nuvem. Fotos de progresso continuam só neste aparelho (não sincronizadas).</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="secondary" asChild>
              <Link to="/conta/sincronizacao">
                <RefreshCw aria-hidden /> Detalhes da sincronização
              </Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link to="/conta/importar">
                <Upload aria-hidden /> Importar dados antigos
              </Link>
            </Button>
            <Button variant="secondary" onClick={exportData}>
              <Download aria-hidden /> Exportar meus dados
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Laptop className="h-4 w-4" aria-hidden /> Sessões ativas
            </CardTitle>
            <CardDescription>Aparelhos e navegadores conectados à sua conta.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessErr && <FormAlert>{sessErr}</FormAlert>}
            {!sessions && !sessErr && <Loader2 className="h-4 w-4 animate-spin" aria-label="Carregando sessões" />}
            <ul className="divide-y">
              {sessions?.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {s.device} {s.current && <Badge className="ml-1">Este aparelho</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">Último uso: {fmtDate(s.lastSeenAt)} · desde {fmtDate(s.createdAt)}</p>
                  </div>
                  {!s.current && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await api.revokeSession(s.id);
                          loadSessions();
                          toast.success('Sessão encerrada.');
                        } catch (e) {
                          toast.error(friendlyError(e));
                        }
                      }}
                    >
                      Encerrar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {sessions && sessions.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const r = await api.revokeOthers();
                    loadSessions();
                    toast.success(`${r.revoked} sessão(ões) encerrada(s).`);
                  } catch (e) {
                    toast.error(friendlyError(e));
                  }
                }}
              >
                Encerrar todas as outras
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-wrap gap-2 pt-4">
            <Button variant="secondary" onClick={() => setDialog('logout')}>
              <LogOut aria-hidden /> Sair desta conta
            </Button>
            <Button variant="outline" className="text-destructive" onClick={() => setDialog('delete')}>
              <Trash2 aria-hidden /> Excluir conta
            </Button>
          </CardContent>
        </Card>
      </div>

      <ChangePasswordDialog open={dialog === 'password'} onClose={() => setDialog(null)} email={p.email} />
      <LogoutDialog open={dialog === 'logout'} onClose={() => setDialog(null)} pending={(sync?.pending ?? 0) + (sync?.conflicts ?? 0) + (sync?.rejected ?? 0)} />
      <DeleteDialog open={dialog === 'delete'} onClose={() => setDialog(null)} onExport={exportData} />
    </>
  );
}

function ChangePasswordDialog({ open, onClose, email }: { open: boolean; onClose: () => void; email: string }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setCur('');
    setNext('');
    setConfirm('');
    setErr(null);
    onClose();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordRequirements(next, email).every((r) => r.ok)) return setErr('A nova senha não atende aos requisitos.');
    if (next !== confirm) return setErr('As senhas não coincidem.');
    setBusy(true);
    try {
      await api.changePassword(cur, next);
      toast.success('Senha alterada. As outras sessões foram encerradas.');
      close();
    } catch (x) {
      setErr(friendlyError(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Alterar senha</DialogTitle>
          <DialogDescription>As outras sessões abertas serão encerradas.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {err && <FormAlert>{err}</FormAlert>}
          <Field label="Senha atual">{(f) => <PasswordInput {...f} value={cur} onChange={setCur} autoComplete="current-password" />}</Field>
          <Field label="Nova senha" hint={<PasswordChecklist password={next} email={email} />}>
            {(f) => <PasswordInput {...f} value={next} onChange={setNext} autoComplete="new-password" />}
          </Field>
          <Field label="Confirmar nova senha">{(f) => <PasswordInput {...f} value={confirm} onChange={setConfirm} autoComplete="new-password" />}</Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />} Alterar senha
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LogoutDialog({ open, onClose, pending }: { open: boolean; onClose: () => void; pending: number }) {
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sair desta conta?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              {pending > 0 ? (
                <FormAlert>
                  Há {pending} alteração(ões) deste aparelho que ainda não chegaram à nuvem. Se sair agora, elas continuam guardadas aqui e serão enviadas quando você entrar de novo nesta conta
                  neste aparelho.
                </FormAlert>
              ) : (
                <p>Tudo deste aparelho já está na nuvem.</p>
              )}
              <p>Os dados usados sem conta neste navegador não são afetados.</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[hsl(var(--primary))]" checked={remove} onChange={(e) => setRemove(e.target.checked)} disabled={pending > 0} />
          <span>
            Remover a cópia desta conta deste aparelho (inclui fotos guardadas só aqui).
            {pending > 0 && <span className="block text-xs text-muted-foreground">Indisponível enquanto houver alterações não enviadas.</span>}
          </span>
        </label>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await signOutHere({ removeLocalCopy: remove && pending === 0 });
              reloadHome();
            }}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden />} Sair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ open, onClose, onExport }: { open: boolean; onClose: () => void; onExport: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [removeLocal, setRemoveLocal] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setPassword('');
    setTyped('');
    setErr(null);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Excluir conta</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>
                Isto apaga <strong>definitivamente</strong> a conta, todas as sessões e todos os dados dela no servidor (fichas, treinos, medidas, metas, planejamento, consumo da IA). Não há como
                desfazer.
              </p>
              <p>Exporte seus dados antes, se quiser guardar uma cópia.</p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <Button variant="secondary" onClick={onExport}>
          <CloudDownload aria-hidden /> Exportar meus dados agora
        </Button>
        <div className="space-y-4">
          {err && <FormAlert>{err}</FormAlert>}
          <Field label="Sua senha">{(f) => <PasswordInput {...f} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
          <Field label='Digite "EXCLUIR" para confirmar'>{(f) => <Input {...f} value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" autoComplete="off" />}</Field>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[hsl(var(--primary))]" checked={removeLocal} onChange={(e) => setRemoveLocal(e.target.checked)} />
            <span>Apagar também a cópia desta conta neste aparelho. (Os dados usados sem conta neste navegador não são tocados.)</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={busy || typed !== 'EXCLUIR' || !password}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await api.deleteAccount(password);
                setPassword('');
                await signOutHere({ removeLocalCopy: removeLocal });
                reloadHome();
              } catch (x) {
                setErr(friendlyError(x));
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="animate-spin" aria-hidden />} Excluir definitivamente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
