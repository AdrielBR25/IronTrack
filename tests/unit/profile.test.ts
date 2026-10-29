import { describe, expect, it } from 'vitest';
import { IronTrackDB, db, describeOpenError, ensureDefaultProfile, setDb } from '@/db/db';
import { getCurrentProfile, getCurrentProfileId, getProfileById, renameProfile } from '@/db/profiles';
import { addRoutine, completedSessions, deleteRoutine, saveBodyEntryWithPhotos, startSession } from '@/db/repo';
import { DEFAULT_PROFILE_NAME, ProfileError, generateProfileId, isValidProfileId, normalizeProfileName, pickDefaultProfile } from '@/lib/profile';
import type { LocalProfile } from '@/lib/types';
import { entry, routine, session } from './fixtures';

let n = 0;
const uniqueName = () => `profile-test-${++n}`;

async function open(name: string) {
  const d = new IronTrackDB(name);
  await d.open();
  return d;
}

/** Simula falha na geração do ID (ex.: navegador sem fonte aleatória). */
class FailingIdDB extends IronTrackDB {
  protected newProfileId = (): string => {
    throw new ProfileError('gerador indisponível (simulado).');
  };
}

const OTHER_ID = '11111111-2222-4333-8444-555555555555';

describe('identificador do perfil', () => {
  it('gera UUID v4 com randomUUID e, sem ele, com getRandomValues; sem fonte segura, falha', () => {
    const a = generateProfileId();
    expect(isValidProfileId(a)).toBe(true);
    expect(generateProfileId()).not.toBe(a);
    const fallback = generateProfileId({ getRandomValues: <T extends ArrayBufferView | null>(b: T) => crypto.getRandomValues(b as Uint8Array) as unknown as T });
    expect(isValidProfileId(fallback)).toBe(true);
    expect(() => generateProfileId({} as never)).toThrow(ProfileError);
  });

  it('valida o formato e não aceita IDs derivados de nome ou data', () => {
    expect(isValidProfileId(OTHER_ID)).toBe(true);
    expect(isValidProfileId('meu-perfil')).toBe(false);
    expect(isValidProfileId('2026-10-27')).toBe(false);
    expect(isValidProfileId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'.toUpperCase())).toBe(false);
    expect(isValidProfileId(undefined)).toBe(false);
  });

  it('normaliza o nome e rejeita vazio ou longo demais', () => {
    expect(normalizeProfileName('  Treino   de casa ')).toBe('Treino de casa');
    expect(normalizeProfileName('   ')).toBeNull();
    expect(normalizeProfileName('x'.repeat(41))).toBeNull();
  });

  it('escolha do principal é determinística (mais antigo, depois ID)', () => {
    const p = (id: string, createdAt: number, isDefault = true): LocalProfile => ({ id, displayName: 'P', createdAt, updatedAt: createdAt, isDefault });
    const a = p('aaaaaaaa-0000-4000-8000-000000000000', 2);
    const b = p('bbbbbbbb-0000-4000-8000-000000000000', 1);
    expect(pickDefaultProfile([a, b])?.id).toBe(b.id);
    expect(pickDefaultProfile([p(a.id, 1), p(b.id, 1)])?.id).toBe(a.id);
    expect(pickDefaultProfile([p(a.id, 1, false)])).toBeUndefined();
  });
});

describe('perfil local principal', () => {
  it('primeira inicialização sem dados cria exatamente um perfil principal', async () => {
    const d = await open(uniqueName());
    const all = await d.profiles.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ displayName: DEFAULT_PROFILE_NAME, isDefault: true });
    expect(isValidProfileId(all[0].id)).toBe(true);
    expect(d.currentProfileId).toBe(all[0].id);
    d.close();
  });

  it('o ID persiste ao fechar e reabrir o banco e ao "recarregar" (nova instância)', async () => {
    const name = uniqueName();
    const d = await open(name);
    const id = d.currentProfileId;
    d.close();
    await d.open();
    expect(d.currentProfileId).toBe(id);
    d.close();
    for (let i = 0; i < 3; i++) {
      const again = await open(name);
      expect(again.currentProfileId).toBe(id);
      expect(await again.profiles.count()).toBe(1);
      again.close();
    }
  });

  it('bancos diferentes têm IDs diferentes (não derivados do aparelho ou do navegador)', async () => {
    const a = await open(uniqueName());
    const b = await open(uniqueName());
    expect(a.currentProfileId).not.toBe(b.currentProfileId);
    a.close();
    b.close();
  });

  it('inicializações concorrentes (duas abas) não duplicam o perfil', async () => {
    const name = uniqueName();
    const tabs = Array.from({ length: 4 }, () => new IronTrackDB(name));
    await Promise.all(tabs.map((t) => t.open()));
    const ids = new Set(tabs.map((t) => t.currentProfileId));
    expect(ids.size).toBe(1);
    expect(await tabs[0].profiles.count()).toBe(1);
    // chamadas concorrentes explícitas também convergem
    const again = await Promise.all(tabs.map((t) => ensureDefaultProfile(t)));
    expect(new Set(again.map((p) => p.id))).toEqual(ids);
    expect(await tabs[0].profiles.count()).toBe(1);
    tabs.forEach((t) => t.close());
  });

  it('alterar o nome não altera o ID; nome inválido não grava nada', async () => {
    setDb(new IronTrackDB(uniqueName()));
    await db.open();
    const before = await getCurrentProfile();
    const renamed = await renameProfile(before.id, '  Casa  ', before.createdAt + 10);
    expect(renamed).toMatchObject({ id: before.id, displayName: 'Casa', createdAt: before.createdAt, isDefault: true });
    expect(await getCurrentProfileId()).toBe(before.id);
    await expect(renameProfile(before.id, '   ')).rejects.toBeInstanceOf(ProfileError);
    await expect(renameProfile(OTHER_ID, 'Outro')).rejects.toThrow(/não encontrado/);
    expect((await getProfileById(before.id))?.displayName).toBe('Casa');
    expect(await getProfileById('invalido')).toBeUndefined();
    expect(await db.profiles.count()).toBe(1);
  });

  it('perfil sem marcação de principal é promovido, sem trocar o ID', async () => {
    const name = uniqueName();
    const d = await open(name);
    const id = d.currentProfileId!;
    await d.profiles.update(id, { isDefault: false });
    d.close();
    const again = await open(name);
    expect(again.currentProfileId).toBe(id);
    expect((await again.profiles.get(id))?.isDefault).toBe(true);
    expect(await again.profiles.count()).toBe(1);
    again.close();
  });

  it('perfil apagado por fora: é restabelecido com o mesmo ID dos registros (nenhum registro muda de dono)', async () => {
    const name = uniqueName();
    setDb(new IronTrackDB(name));
    await db.open();
    const id = db.currentProfileId!;
    await addRoutine(routine());
    await db.profiles.clear();
    db.close();
    setDb(new IronTrackDB(name));
    await db.open();
    expect(db.currentProfileId).toBe(id);
    expect(await db.profiles.count()).toBe(1);
    expect((await db.routines.get('r1'))?.profileId).toBe(id);
  });

  it('dois perfis marcados como principal: usa o mais antigo, não apaga nenhum', async () => {
    const name = uniqueName();
    const d = await open(name);
    const id = d.currentProfileId!;
    const created = (await d.profiles.get(id))!.createdAt;
    await d.profiles.add({ id: OTHER_ID, displayName: 'Duplicado', createdAt: created + 1, updatedAt: created + 1, isDefault: true });
    d.close();
    const again = await open(name);
    expect(again.currentProfileId).toBe(id);
    expect(await again.profiles.count()).toBe(2);
    again.close();
  });

  it('falha durante a inicialização: abertura falha com mensagem clara, sem perfil parcial; nova tentativa funciona', async () => {
    const name = uniqueName();
    const broken = new FailingIdDB(name);
    const err = await broken.open().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeTruthy();
    expect(describeOpenError(err)).toMatch(/perfil local/);
    expect(describeOpenError(err)).toMatch(/Nada foi apagado/);
    broken.close();
    const ok = await open(name);
    expect(await ok.profiles.count()).toBe(1);
    ok.close();
  });
});

describe('propriedade dos registros', () => {
  it('registros novos recebem o perfil atual; rotação e agenda não têm dono próprio', async () => {
    setDb(new IronTrackDB(uniqueName()));
    await db.open();
    const id = db.currentProfileId;
    await addRoutine(routine());
    const s = await startSession('r1', 'r1-A');
    await saveBodyEntryWithPhotos(entry('b1'), ['data:image/jpeg;base64,AAAA']);
    expect((await db.routines.get('r1'))?.profileId).toBe(id);
    expect(s.profileId).toBe(id);
    expect((await db.sessions.get(s.id))?.profileId).toBe(id);
    expect((await db.bodyEntries.get('b1'))?.profileId).toBe(id);
    expect((await db.photos.toArray()).every((p) => p.profileId === id)).toBe(true);
    expect(await db.rotations.get('r1')).not.toHaveProperty('profileId');
  });

  it('um registro não muda de dono silenciosamente: troca é bloqueada, regravação sem o campo mantém o dono', async () => {
    setDb(new IronTrackDB(uniqueName()));
    await db.open();
    const id = db.currentProfileId;
    await db.sessions.put(session('s1'));
    await expect(db.sessions.put({ ...session('s1'), profileId: OTHER_ID })).rejects.toThrow(/não pode mudar de perfil/);
    await expect(db.sessions.update('s1', { profileId: OTHER_ID })).rejects.toThrow(/não pode mudar de perfil/);
    await db.sessions.put({ ...session('s1', { notes: 'editado' }) }); // objeto sem profileId
    const s = await db.sessions.get('s1');
    expect(s).toMatchObject({ profileId: id, notes: 'editado' });
  });

  it('treino histórico continua acessível e com dono após excluir a rotina', async () => {
    setDb(new IronTrackDB(uniqueName()));
    await db.open();
    await addRoutine(routine());
    await db.sessions.put(session('s1'));
    await deleteRoutine('r1');
    const hist = await completedSessions();
    expect(hist.map((s) => s.id)).toEqual(['s1']);
    expect(hist[0].profileId).toBe(db.currentProfileId);
  });
});
