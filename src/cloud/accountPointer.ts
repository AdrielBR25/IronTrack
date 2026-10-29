// Qual conta (ou o modo sem conta) este aparelho abre (Prompt 21). Fica em localStorage `irontrack.account.v1` para o
// app abrir OFFLINE os dados da última conta. Guarda só identificação para exibir (nome, e-mail) e os IDs da conta e do
// perfil de dados; nunca senha, token de sessão (cookie HttpOnly, invisível ao app) ou dados de treino.
import { useSyncExternalStore } from 'react';
import type { AccountInfo } from '@shared/api/auth.ts';

export const ACCOUNT_POINTER_KEY = 'irontrack.account.v1';

export type AccountPointer = { v: 1; mode: 'account'; id: string; name: string; email: string; emailVerified: boolean; dataProfileId: string } | { v: 1; mode: 'local' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readAccountPointer(): AccountPointer | null {
  try {
    const raw = globalThis.localStorage?.getItem(ACCOUNT_POINTER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AccountPointer> & Record<string, unknown>;
    if (v?.v !== 1) return null;
    if (v.mode === 'local') return { v: 1, mode: 'local' };
    if (v.mode === 'account' && typeof v.id === 'string' && UUID.test(v.id) && typeof v.dataProfileId === 'string' && UUID.test(v.dataProfileId))
      return { v: 1, mode: 'account', id: v.id, name: String(v.name ?? ''), email: String(v.email ?? ''), emailVerified: v.emailVerified === true, dataProfileId: v.dataProfileId };
    return null;
  } catch {
    return null;
  }
}

let listeners: (() => void)[] = [];
let cache: { raw: string | null; value: AccountPointer | null } = { raw: '\0', value: null };

function write(p: AccountPointer | null) {
  try {
    if (p) globalThis.localStorage?.setItem(ACCOUNT_POINTER_KEY, JSON.stringify(p));
    else globalThis.localStorage?.removeItem(ACCOUNT_POINTER_KEY);
  } catch {
    /* sem armazenamento: o app volta à tela de entrada na próxima abertura */
  }
  listeners.forEach((l) => l());
}

export const pointerFromAccount = (a: AccountInfo): AccountPointer => ({ v: 1, mode: 'account', id: a.id, name: a.name, email: a.email, emailVerified: a.emailVerified, dataProfileId: a.dataProfileId });
export const setAccountPointer = (a: AccountInfo) => write(pointerFromAccount(a));
export const setLocalMode = () => write({ v: 1, mode: 'local' });
export const clearAccountPointer = () => write(null);

function snapshot(): AccountPointer | null {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(ACCOUNT_POINTER_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== cache.raw) cache = { raw, value: readAccountPointer() };
  return cache.value;
}

function subscribe(l: () => void) {
  listeners = [...listeners, l];
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ACCOUNT_POINTER_KEY) l();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    listeners = listeners.filter((x) => x !== l);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** Conta aberta neste aparelho (atualiza quando muda nesta aba ou em outra). */
export function useAccountPointer(): AccountPointer | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
