import Dexie, { type Table } from 'dexie';
import type { BodyEntry, DayOverride, ProgressPhoto, Routine, RotationState, Settings, WorkoutSession } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/defaults';

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
