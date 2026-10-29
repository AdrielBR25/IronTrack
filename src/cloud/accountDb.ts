// Banco IndexedDB de uma conta (Prompt 21, docs/NUVEM_SINCRONIZACAO.md §3). Cada conta usa um banco próprio
// (`irontrack-acct-<id>`): trocar de conta no mesmo aparelho troca de banco, então os dados de uma pessoa nunca aparecem
// para outra. O perfil principal desse banco tem o ID de dados da conta (`dataProfileId`), igual em todos os aparelhos:
// os filtros por `profileId` que o app já usa funcionam sem mudança.
// O banco antigo (`irontrack`, modo sem conta) NÃO é alterado por nada daqui: só lido, na importação.
// Esquema: as 6 versões do app (herdadas) + v7 só neste banco, com as tabelas da sincronização.
import Dexie, { type Table } from 'dexie';
import { IronTrackDB } from '@/db/db';
import type { DataSnapshot, LocalProfile } from '@/lib/types';
import type { SyncCollection } from '@shared/sync/collections.ts';

/** Última versão do servidor conhecida para cada entidade (base da detecção de alterações e da mesclagem). */
export interface SyncMeta {
  /** `<coleção>:<id da entidade>` */
  key: string;
  collection: SyncCollection;
  entityId: string;
  version: number;
  /** JSON canônico da versão do servidor que este aparelho conhece. */
  baseJson: string;
}

/** Operação pendente de envio (no máximo uma por entidade). */
export interface OutboxEntry {
  opId: string;
  key: string;
  collection: SyncCollection;
  entityId: string;
  kind: 'put' | 'delete';
  baseVersion: number;
  doc?: Record<string, unknown>;
  /** JSON canônico do que será enviado (compara com o registro local para saber se mudou de novo). */
  json: string;
  createdAt: number;
  /** Tentativas de envio já feitas (0 = nunca saiu do aparelho; pode ser atualizada no lugar). */
  attempts: number;
  state: 'pending' | 'conflict' | 'rejected';
  reason?: 'conflict_resolution';
  /** Conflito: versão atual do servidor e onde as alterações se sobrepõem. */
  server?: { version: number; deleted: boolean; doc: Record<string, unknown> | null };
  conflictPaths?: string[];
  /** Recusa do servidor (validação). */
  error?: string;
}

export interface SyncKv {
  k: 'deviceId' | 'cursor' | 'lastSyncAt';
  v: string | number;
}

export const accountDbName = (accountId: string) => `irontrack-acct-${accountId}`;
export const ACCOUNT_DB_VERSION = 7;

export class AccountDB extends IronTrackDB {
  // `declare`: as tabelas são criadas pelo Dexie na declaração do esquema (dentro do construtor da base); um campo de
  // classe comum seria reinicializado depois e as apagaria.
  declare syncMeta: Table<SyncMeta, string>;
  declare syncOutbox: Table<OutboxEntry, string>;
  declare syncKv: Table<SyncKv, string>;
  readonly accountId: string;
  readonly dataProfileId: string;

  constructor(accountId: string, dataProfileId: string, name = accountDbName(accountId)) {
    super(name, (d) => d.version(ACCOUNT_DB_VERSION).stores({ syncMeta: 'key, collection', syncOutbox: 'opId, &key, state', syncKv: 'k' }));
    this.accountId = accountId;
    this.dataProfileId = dataProfileId;
    // O perfil principal deste banco é criado com o ID de dados da conta (mesmo em todos os aparelhos).
    this.newProfileId = () => dataProfileId;
  }
}

export const isAccountDb = (d: unknown): d is AccountDB => d instanceof AccountDB;

/** Apaga deste aparelho o banco de uma conta (só por pedido explícito, depois de avisar o que não foi sincronizado). */
export async function deleteAccountDb(accountId: string): Promise<void> {
  await Dexie.delete(accountDbName(accountId));
}

export interface LegacyLocalData {
  profile: LocalProfile;
  data: DataSnapshot;
  photos: number;
}

/**
 * Lê (somente leitura) o banco do modo sem conta deste navegador, para a importação. Não cria o banco se ele não
 * existir e não grava nada nele além do que o próprio app faz ao abrir (garantir o perfil principal).
 */
export async function readLegacyLocalData(opts: { withPhotos?: boolean } = {}): Promise<LegacyLocalData | null> {
  if (!(await Dexie.exists('irontrack'))) return null;
  const legacy = new IronTrackDB('irontrack');
  try {
    await legacy.open();
    return await legacy.transaction('r', legacy.tables, async () => {
      const profiles = await legacy.profiles.toArray();
      const profile = profiles.find((p) => p.isDefault) ?? profiles[0];
      if (!profile) return null;
      const [settings, routines, sessions, rotations, overrides, bodyEntries, photos, goals, planEntries, calendarDecisions, customExercises, exerciseFavorites] = await Promise.all([
        legacy.settings.get('settings'),
        legacy.routines.toArray(),
        legacy.sessions.toArray(),
        legacy.rotations.toArray(),
        legacy.overrides.toArray(),
        legacy.bodyEntries.toArray(),
        opts.withPhotos ? legacy.photos.toArray() : legacy.photos.count(),
        legacy.goals.toArray(),
        legacy.planEntries.toArray(),
        legacy.calendarDecisions.toArray(),
        legacy.customExercises.toArray(),
        legacy.exerciseFavorites.toArray(),
      ]);
      return {
        profile,
        photos: typeof photos === 'number' ? photos : photos.length,
        data: { settings: settings ?? null, routines, sessions, rotations, overrides, bodyEntries, photos: typeof photos === 'number' ? [] : photos, goals, planEntries, calendarDecisions, customExercises, exerciseFavorites },
      };
    });
  } finally {
    legacy.close();
  }
}
