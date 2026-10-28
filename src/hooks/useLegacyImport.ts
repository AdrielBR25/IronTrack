import { useLiveQuery } from 'dexie-react-hooks';
import { readImportInput, readLastImport } from '@/db/legacyImport';
import type { LegacyImportInput, PlanImportRecord } from '@/modules/planner';

// Importação da agenda antiga (IronTrack 2.0 F01/P15). Só leitura e ao vivo: uma alteração no planejamento, na agenda
// anterior ou na rotina feita em outra aba atualiza a prévia sozinha.

/** Fontes da prévia (undefined enquanto carrega). */
export function useImportSource(today: string): LegacyImportInput | undefined {
  return useLiveQuery(() => readImportInput(today), [today]);
}

/** Último registro de importação do perfil (null se não houver). */
export function useLastImport(): PlanImportRecord | null | undefined {
  return useLiveQuery(() => readLastImport(), []);
}
