import type { Table, Transaction } from 'dexie';
import type { Routine } from '@/lib/types';
import { EXERCISE_MODEL_CAPABILITY, isNewerCapability, snapshotRoutine, type ModelSnapshot } from '@/modules/training';

// Estado auxiliar da proteção de compatibilidade (IronTrack 2.0 F01/P11, docs/CRONOMETROS_E_CONCORRENCIA.md §7–8).
// Fica no armazenamento local do navegador (localStorage), fora do IndexedDB e fora dos backups:
// - `irontrack.modelSnapshot.v1`: campos de modalidade de cada rotina na última gravação feita por ESTE app
//   (atualizada pelos ganchos do Dexie, só quando a transação é concluída);
// - `irontrack.capabilities.v1`: a maior capacidade de modelo que já abriu estes dados.
// Nada aqui altera registros. Se o armazenamento local estiver indisponível, a proteção fica desligada (sem erro).

export const MODEL_SNAPSHOT_KEY = 'irontrack.modelSnapshot.v1';
export const CAPABILITIES_KEY = 'irontrack.capabilities.v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readModelSnapshot(): ModelSnapshot {
  try {
    const raw = storage()?.getItem(MODEL_SNAPSHOT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ModelSnapshot) : {};
  } catch {
    return {};
  }
}

function writeModelSnapshot(next: ModelSnapshot): void {
  try {
    storage()?.setItem(MODEL_SNAPSHOT_KEY, JSON.stringify(next));
  } catch {
    /* sem armazenamento local: proteção desligada */
  }
}

/** Registra a rotina como gravada por este app (ou aceita o estado atual dela). */
export function rememberRoutineModel(r: Pick<Routine, 'id' | 'updatedAt' | 'workouts'>): void {
  const snap = readModelSnapshot();
  snap[r.id] = snapshotRoutine(r);
  writeModelSnapshot(snap);
}

export function forgetRoutineModel(id: string): void {
  const snap = readModelSnapshot();
  if (!(id in snap)) return;
  delete snap[id];
  writeModelSnapshot(snap);
}

/** Primeira vez que este app vê a rotina (ex.: criada antes do P11): o estado atual vira a referência. */
export function baselineRoutineModels(routines: Routine[]): void {
  const snap = readModelSnapshot();
  let changed = false;
  for (const r of routines)
    if (!snap[r.id]) {
      snap[r.id] = snapshotRoutine(r);
      changed = true;
    }
  if (changed) writeModelSnapshot(snap);
}

const afterCommit = (trans: Transaction | undefined, fn: () => void) => {
  const t = trans as unknown as { on?: (ev: 'complete', cb: () => void) => void } | undefined;
  if (t?.on) t.on('complete', fn);
  else fn();
};

/** Ganchos na tabela de rotinas: toda gravação feita por este app atualiza a fotografia depois do commit. */
export function installModelSnapshotHooks(routines: Table<Routine, string>): void {
  routines.hook('creating', function (_pk, obj, trans) {
    this.onsuccess = () => afterCommit(trans, () => rememberRoutineModel(obj));
  });
  routines.hook('updating', function (_mods, _pk, _obj, trans) {
    this.onsuccess = (updated: Routine) => afterCommit(trans, () => rememberRoutineModel(updated));
  });
  routines.hook('deleting', function (pk, _obj, trans) {
    this.onsuccess = () => afterCommit(trans, () => forgetRoutineModel(String(pk)));
  });
}

/**
 * Marca de capacidade. Devolve true se estes dados já foram abertos por um app que entende um modelo de exercícios
 * mais novo que este (este app está desatualizado e não deve editar exercícios). Caso contrário registra a
 * capacidade atual (nunca diminui a marca).
 */
export function checkModelCapability(current = EXERCISE_MODEL_CAPABILITY): { newer: boolean; stored: number | null } {
  const s = storage();
  if (!s) return { newer: false, stored: null };
  try {
    const raw = s.getItem(CAPABILITIES_KEY);
    const parsed = raw ? (JSON.parse(raw) as { exerciseModel?: unknown }) : {};
    const stored = typeof parsed?.exerciseModel === 'number' ? parsed.exerciseModel : null;
    if (isNewerCapability(stored, current)) return { newer: true, stored };
    if (stored !== current) s.setItem(CAPABILITIES_KEY, JSON.stringify({ ...parsed, exerciseModel: current }));
    return { newer: false, stored };
  } catch {
    return { newer: false, stored: null };
  }
}
