// Importação de dados antigos para a conta (Prompt 21, docs/NUVEM_SINCRONIZACAO.md §7). Origens: o perfil local deste
// navegador (modo sem conta) ou um arquivo de backup (v0–v8, ex.: exportado do GitHub Pages).
// Nunca associa sozinho e nunca apaga a origem: a pessoa vê as contagens e a prévia, confirma, e o app ainda lê de
// volta do servidor e compara registro a registro (hash canônico) antes de dizer que terminou.
// Fotos não vão para a nuvem nesta fase: podem ser copiadas só para o banco local da conta, e ficam marcadas assim.
import { canonicalJson, recordHash, sha256Hex } from '@shared/canonical.ts';
import { SYNC_COLLECTIONS, entityIdOf, type SyncCollection } from '@shared/sync/collections.ts';
import { assignOwner, type BackupData } from '@/lib/backupFormat';
import type { ProgressPhoto } from '@/lib/types';
import type { AccountDB } from './accountDb';
import { apiRequest } from './api';

export interface ImportItem {
  collection: SyncCollection;
  entityId: string;
  doc: Record<string, unknown>;
  hash: string;
}

export interface PreparedImport {
  sourceKind: 'backup_file' | 'local_profile';
  sourceProfileId: string | null;
  items: ImportItem[];
  counts: Partial<Record<SyncCollection, number>>;
  /** Registros sem identidade válida (não enviados). */
  skipped: number;
  photos: ProgressPhoto[];
  fingerprint: string;
}

export interface CollectionReport {
  new: number;
  identical: number;
  conflict: number;
  replaced: number;
}
export interface ImportReport {
  policy: 'merge' | 'replace';
  totals: CollectionReport;
  byCollection: Partial<Record<SyncCollection, CollectionReport>>;
  conflicts: { collection: SyncCollection; entityId: string; outcome: string }[];
}
export interface VerifyResult {
  checked: number;
  expectedEqual: number;
  matched: number;
  keptAccountVersion: number;
  mismatches: { collection: SyncCollection; entityId: string; reason: 'missing' | 'different' }[];
  ok: boolean;
  accountCounts: Partial<Record<SyncCollection, number>>;
}

/** Limites do envio em lotes (o servidor aceita até 500 itens e 4 MB por lote). */
export const IMPORT_BATCH = { maxItems: 500, maxBytes: 3 * 1024 * 1024 };

/** Converte os dados (já validados pelo leitor de backup) em itens da conta, com o perfil de dados da conta. */
export async function prepareImport(data: BackupData, dataProfileId: string, source: { kind: 'backup_file' | 'local_profile'; profileId: string | null }): Promise<PreparedImport> {
  const owned = assignOwner(data, dataProfileId);
  const items: ImportItem[] = [];
  const counts: Partial<Record<SyncCollection, number>> = {};
  let skipped = 0;
  for (const c of SYNC_COLLECTIONS) {
    const rows: unknown[] = c === 'settings' ? (owned.settings ? [owned.settings] : []) : ((owned[c] as unknown[] | undefined) ?? []);
    for (const r of rows) {
      const id = entityIdOf(c, r);
      if (!id) {
        skipped++;
        continue;
      }
      // Mesmo texto que o servidor guarda (canônico): o hash bate dos dois lados.
      const doc = JSON.parse(canonicalJson(r)) as Record<string, unknown>;
      items.push({ collection: c, entityId: id, doc, hash: await recordHash(doc) });
      counts[c] = (counts[c] ?? 0) + 1;
    }
  }
  items.sort((a, b) => (a.collection === b.collection ? a.entityId.localeCompare(b.entityId) : a.collection.localeCompare(b.collection)));
  const fingerprint = await sha256Hex(items.map((i) => `${i.collection}\u0000${i.entityId}\u0000${i.hash}`).join('\n'));
  return { sourceKind: source.kind, sourceProfileId: source.profileId, items, counts, skipped, photos: owned.photos ?? [], fingerprint };
}

export function importBatches(items: ImportItem[]): ImportItem[][] {
  const out: ImportItem[][] = [];
  let cur: ImportItem[] = [];
  let bytes = 0;
  for (const it of items) {
    const size = new TextEncoder().encode(JSON.stringify(it)).length + 2;
    if (cur.length && (cur.length >= IMPORT_BATCH.maxItems || bytes + size > IMPORT_BATCH.maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface ImportJob {
  jobId: string;
  previousImport: { jobId: string; committedAt: string } | null;
}

export const importApi = {
  create: (p: PreparedImport) =>
    apiRequest<ImportJob>('POST', '/import/jobs', { sourceKind: p.sourceKind, sourceFingerprint: p.fingerprint, sourceProfileId: p.sourceProfileId, expectedItems: p.items.length }),
  upload: (jobId: string, items: ImportItem[]) => apiRequest<{ accepted: number }>('POST', `/import/jobs/${jobId}/items`, { items }, { timeoutMs: 60_000 }),
  preview: (jobId: string) => apiRequest<ImportReport & { staged: number; expected: number }>('GET', `/import/jobs/${jobId}/preview`, undefined, { timeoutMs: 60_000 }),
  commit: (jobId: string, policy: 'merge' | 'replace') =>
    apiRequest<{ report: ImportReport }>('POST', `/import/jobs/${jobId}/commit`, policy === 'replace' ? { policy, confirmReplace: true } : { policy }, { timeoutMs: 120_000 }),
  verify: (jobId: string) => apiRequest<VerifyResult>('GET', `/import/jobs/${jobId}/verify`, undefined, { timeoutMs: 120_000 }),
  cancel: (jobId: string) => apiRequest<void>('DELETE', `/import/jobs/${jobId}`),
};

/** Cria o trabalho e envia todos os lotes (área de preparo; nada entra na conta ainda). */
export async function stageImport(p: PreparedImport, onProgress?: (sent: number, total: number) => void): Promise<ImportJob> {
  const job = await importApi.create(p);
  let sent = 0;
  onProgress?.(0, p.items.length);
  for (const batch of importBatches(p.items)) {
    await importApi.upload(job.jobId, batch);
    sent += batch.length;
    onProgress?.(sent, p.items.length);
  }
  return job;
}

/**
 * Copia as fotos para o banco local da conta (só neste aparelho; não vão para a nuvem). Não substitui fotos já
 * existentes com o mesmo ID. Devolve quantas foram copiadas.
 */
export async function copyPhotosLocally(d: AccountDB, photos: ProgressPhoto[]): Promise<number> {
  if (!photos.length) return 0;
  return d.transaction('rw', d.photos, async () => {
    let n = 0;
    for (const p of photos) {
      if (await d.photos.get(p.id)) continue;
      await d.photos.add({ ...p, profileId: d.dataProfileId });
      n++;
    }
    return n;
  });
}

export const COLLECTION_LABELS: Record<SyncCollection, string> = {
  settings: 'Configurações',
  routines: 'Fichas',
  sessions: 'Treinos registrados',
  rotations: 'Posição na rotação',
  overrides: 'Ajustes de dia',
  bodyEntries: 'Medidas corporais',
  goals: 'Metas',
  planEntries: 'Planejamento',
  calendarDecisions: 'Decisões do calendário',
  customExercises: 'Exercícios personalizados',
  exerciseFavorites: 'Exercícios favoritos',
};
