// Inicialização do modo conta (Prompt 21). Decide, antes de montar o app, qual banco abrir:
// - sem `VITE_ACCOUNTS=on` (ex.: GitHub Pages): exatamente como antes (banco `irontrack`, sem rede);
// - com contas e nenhuma escolha feita neste aparelho: tela de entrada (entrar, criar conta ou usar sem conta);
// - modo sem conta escolhido: banco `irontrack`, como antes;
// - conta: banco `irontrack-acct-<conta>` e o motor de sincronização. Abre OFFLINE com os dados da última conta.
import type { AccountInfo } from '@shared/api/auth.ts';
import { setDb } from '@/db/db';
import { AccountDB } from './accountDb';
import { clearAccountPointer, readAccountPointer, setAccountPointer, type AccountPointer } from './accountPointer';
import { api } from './api';
import { ACCOUNTS_ENABLED } from './config';
import { SyncEngine, deviceIdOf, getSyncEngine, setSyncEngine } from './syncEngine';

export type BootMode = { kind: 'local' } | { kind: 'auth' } | { kind: 'account'; pointer: Extract<AccountPointer, { mode: 'account' }>; db: AccountDB };

let accountDb: AccountDB | null = null;
export const currentAccountDb = () => accountDb;

/** Escolhe o modo e, no modo conta, troca o banco do app pelo da conta (antes de qualquer leitura). */
export function chooseBootMode(): BootMode {
  if (!ACCOUNTS_ENABLED) return { kind: 'local' };
  const p = readAccountPointer();
  if (!p) return { kind: 'auth' };
  if (p.mode === 'local') return { kind: 'local' };
  accountDb = new AccountDB(p.id, p.dataProfileId);
  setDb(accountDb);
  return { kind: 'account', pointer: p, db: accountDb };
}

/** Depois que o banco abriu: liga a sincronização e confere a sessão em segundo plano (sem bloquear o uso offline). */
export async function startAccountRuntime(mode: Extract<BootMode, { kind: 'account' }>): Promise<void> {
  const d = mode.db;
  const deviceId = await deviceIdOf(d);
  const engine = new SyncEngine(d, {
    push: (ops, signal) => api.push(d.accountId, deviceId, ops, signal),
    pull: (cursor, signal) => api.pull(d.accountId, cursor, signal),
  });
  setSyncEngine(engine);
  engine.start();
  void refreshAccount();
}

/** Atualiza nome/e-mail/verificação guardados para exibição. Sessão expirada fica a cargo do motor (aviso para entrar). */
export async function refreshAccount(): Promise<AccountInfo | null> {
  try {
    const { account } = await api.me({ timeoutMs: 10_000 });
    const p = readAccountPointer();
    if (p?.mode === 'account' && p.id === account.id) setAccountPointer(account);
    return account;
  } catch {
    return null;
  }
}

/**
 * Entrou (ou criou conta). Se é a mesma conta já aberta, só retoma a sincronização; se é outra (ou se estava sem conta),
 * troca o ponteiro e recarrega para abrir o banco certo. O banco sem conta e o de outras contas não são tocados.
 */
export function afterAuthenticated(account: AccountInfo): 'resumed' | 'reload' {
  const p = readAccountPointer();
  if (p?.mode === 'account' && p.id === account.id && accountDb) {
    setAccountPointer(account);
    getSyncEngine()?.resume();
    return 'resumed';
  }
  setAccountPointer(account);
  return 'reload';
}

/** Sai da conta neste aparelho. Os dados locais da conta ficam (a menos que a pessoa peça para remover). */
export async function signOutHere(opts: { removeLocalCopy: boolean }): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* offline ou sessão já expirada: sai localmente do mesmo jeito; o servidor expira a sessão */
  }
  const engine = getSyncEngine();
  engine?.stop();
  setSyncEngine(null);
  const d = accountDb;
  clearAccountPointer();
  if (d && opts.removeLocalCopy) {
    d.close();
    const { deleteAccountDb } = await import('./accountDb');
    await deleteAccountDb(d.accountId);
  }
}
