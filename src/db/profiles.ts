import { db, ensureDefaultProfile } from './db';
import type { LocalProfile } from '@/lib/types';
import { ProfileError, isValidProfileId, normalizeProfileName, PROFILE_NAME_MAX } from '@/lib/profile';

// Camada de acesso ao perfil local. Componentes React usam só estas funções (ou o hook
// useCurrentProfile); criação, migração e reparo do perfil ficam em src/db/db.ts.

export { ensureDefaultProfile };

/** ID do perfil atual, já carregado na abertura do banco. */
export async function getCurrentProfileId(): Promise<string> {
  if (!db.isOpen()) await db.open();
  if (!db.currentProfileId) throw new ProfileError('Perfil local não inicializado.');
  return db.currentProfileId;
}

export async function getProfileById(id: string): Promise<LocalProfile | undefined> {
  if (!isValidProfileId(id)) return undefined;
  return db.profiles.get(id);
}

/** Perfil principal deste navegador. Nesta versão é o único perfil e o perfil atual. */
export async function getCurrentProfile(): Promise<LocalProfile> {
  const p = await getProfileById(await getCurrentProfileId());
  if (!p) throw new ProfileError('Perfil local não encontrado. Recarregue o app.');
  return p;
}

/** Renomeia o perfil. O ID nunca muda. */
export async function renameProfile(id: string, name: string, now = Date.now()): Promise<LocalProfile> {
  const displayName = normalizeProfileName(name);
  if (!displayName) throw new ProfileError(`O nome do perfil deve ter de 1 a ${PROFILE_NAME_MAX} caracteres.`);
  return db.transaction('rw', db.profiles, async () => {
    const p = await db.profiles.get(id);
    if (!p) throw new ProfileError('Perfil local não encontrado.');
    const next = { ...p, displayName, updatedAt: now };
    await db.profiles.put(next);
    return next;
  });
}
