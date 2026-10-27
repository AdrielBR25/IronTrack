import Dexie, { type Table, type Transaction } from 'dexie';
import type { BodyEntry, DayOverride, ProgressPhoto, Routine, RotationState, Settings, WorkoutSession } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/defaults';

/**
 * Versão atual do esquema IndexedDB (Dexie). É independente da versão do formato
 * JSON de backup (BACKUP_SCHEMA_VERSION). Histórico e regras em docs/MIGRACOES.md.
 */
export const DB_SCHEMA_VERSION = 1;

export class IronTrackDB extends Dexie {
  settings!: Table<Settings, string>;
  routines!: Table<Routine, string>;
  sessions!: Table<WorkoutSession, string>;
  rotations!: Table<RotationState, string>;
  overrides!: Table<DayOverride, [string, string]>;
  bodyEntries!: Table<BodyEntry, string>;
  photos!: Table<ProgressPhoto, string>;

  constructor(name = 'irontrack') {
    super(name);
    // Versões do esquema IndexedDB. Ao mudar a estrutura, adicione uma nova
    // versão com .upgrade() em vez de alterar as anteriores.
    // A declaração da versão 1 é congelada (ver tests/unit/migrations.test.ts).
    // Modelo para a próxima versão (só quando houver mudança real de esquema):
    //   this.version(2)
    //     .stores({ ...somente as tabelas que mudam... })
    //     .upgrade(migration(2, 'descrição', async (tx) => { ... }));
    this.version(1).stores({
      settings: 'id',
      routines: 'id, updatedAt',
      sessions: 'id, status, startedAt, workoutId, routineId',
      rotations: 'routineId',
      overrides: '[routineId+date], routineId, date',
      bodyEntries: 'id, date',
      photos: 'id, entryId',
    });
  }
}

export class MigrationError extends Error {
  constructor(
    readonly version: number,
    readonly description: string,
    readonly cause: unknown,
  ) {
    super(`Falha ao atualizar o banco local para a versão ${version} (${description}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
  }
}

/**
 * Envolve a função de upgrade de uma versão do esquema. Os upgrades do Dexie rodam
 * dentro da transação de mudança de versão: se a função falhar, o IndexedDB desfaz
 * tudo e o banco continua na versão anterior, com os dados intactos.
 * Regras: determinística, sem rede, sem timers, só operações na transação `tx`.
 */
export function migration(version: number, description: string, fn: (tx: Transaction) => Promise<void> | void) {
  return async (tx: Transaction) => {
    try {
      await fn(tx);
    } catch (e) {
      throw new MigrationError(version, description, e);
    }
  };
}

/** Traduz falhas ao abrir o banco em mensagens compreensíveis (sem apagar nada). */
export function describeOpenError(e: unknown): string {
  const err = e as { name?: string; inner?: { name?: string }; message?: string };
  const name = err?.inner?.name ?? err?.name;
  if (err instanceof MigrationError || (err as { inner?: unknown })?.inner instanceof MigrationError)
    return `${(err instanceof MigrationError ? err : (err as { inner: MigrationError }).inner).message}. Seus dados não foram apagados: o banco permaneceu na versão anterior.`;
  if (name === 'VersionError')
    return 'Os dados deste aparelho foram gravados por uma versão mais nova do IronTrack. Atualize o app (recarregue a página) para acessá-los; nada foi apagado.';
  if (name === 'MissingAPIError' || name === 'InvalidStateError')
    return 'Este navegador não permite armazenamento local (IndexedDB), por exemplo em modo privado. Seus dados não podem ser acessados aqui.';
  return `Não foi possível abrir os dados locais (${name ?? 'erro desconhecido'}). Nada foi apagado; feche outras abas do IronTrack e recarregue.`;
}

export let db = new IronTrackDB();

/** Usado nos testes para isolar bancos. */
export function setDb(next: IronTrackDB) {
  db = next;
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return mergeSettings(s);
}

export function mergeSettings(s: Partial<Settings> | undefined): Settings {
  if (!s) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    progression: {
      ...DEFAULT_SETTINGS.progression,
      ...(s.progression ?? {}),
      increments: { ...DEFAULT_SETTINGS.progression.increments, ...(s.progression?.increments ?? {}) },
    },
    id: 'settings',
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...patch });
  await db.settings.put(next);
  return next;
}

/** Pede ao navegador armazenamento persistente (menos chance de limpeza automática). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch {
    /* indisponível */
  }
  return null;
}
