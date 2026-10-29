// Importação de dados antigos para a conta (Prompt 21, docs/NUVEM_SINCRONIZACAO.md §7): backup v8 do GitHub Pages ou
// perfil local deste aparelho. O app já converteu o backup (parser v0–v8) e atribuiu os registros ao perfil da conta.
// Etapas: criar trabalho → enviar itens em lotes (área de preparo) → prévia → efetivar (UMA transação: tudo ou nada)
// → verificar (lê de volta e compara o hash canônico de cada registro).
// Idempotente: registro igual é ignorado; mesmo ID com conteúdo diferente é conflito e NÃO é sobrescrito na política
// padrão (mesclar). Substituir exige confirmação explícita e guarda a versão anterior em `record_revisions`.
import { z } from 'zod';
import { canonicalJson, recordHash } from '../../../../shared/canonical.ts';
import { MAX_ENTITY_ID, SYNC_COLLECTIONS, type SyncCollection } from '../../../../shared/sync/collections.ts';
import { pgCode, withTx, type Pool } from '../db/pool.ts';
import { ApiError, readJson, type Router } from '../http/core.ts';
import { uuid } from '../lib/crypto.ts';
import { LIMITS, type RateLimiter } from '../lib/rateLimit.ts';
import { RecordError, TABLES, lockUserSeq, normalizeRecord, saveRevision, saveUserSeq, writeRow, type CurrentRow } from './records.ts';

export const IMPORT_LIMITS = { maxItems: 50_000, maxItemsPerBatch: 500, maxBatchBytes: 4 * 1024 * 1024, maxConflictsListed: 200 } as const;

const createSchema = z
  .object({
    sourceKind: z.enum(['backup_file', 'local_profile']),
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    sourceProfileId: z.string().max(100).nullable(),
    expectedItems: z.number().int().min(0).max(IMPORT_LIMITS.maxItems),
  })
  .strict();
const itemsSchema = z
  .object({
    items: z
      .array(z.object({ collection: z.enum(SYNC_COLLECTIONS), entityId: z.string().min(1).max(MAX_ENTITY_ID), doc: z.record(z.unknown()), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
      .min(1)
      .max(IMPORT_LIMITS.maxItemsPerBatch),
  })
  .strict();
const commitSchema = z.object({ policy: z.enum(['merge', 'replace']), confirmReplace: z.literal(true).optional() }).strict();

export type ItemOutcome = 'new' | 'identical' | 'conflict' | 'deleted_in_account';

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
  conflicts: { collection: SyncCollection; entityId: string; outcome: ItemOutcome }[];
}

interface Job {
  id: string;
  status: 'staging' | 'committed' | 'cancelled';
  expected_items: number;
  policy: 'merge' | 'replace';
  report: ImportReport | null;
}

const emptyCounts = (): CollectionReport => ({ new: 0, identical: 0, conflict: 0, replaced: 0 });

async function getJob(pool: Pool, userId: string, id: string): Promise<Job> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError('not_found');
  // Filtrado pela conta: trabalho de outra conta = 404.
  const r = await pool.query<Job>('SELECT id, status, expected_items, policy, report FROM import_jobs WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!r.rows[0]) throw new ApiError('not_found');
  return r.rows[0];
}

function classify(cur: Pick<CurrentRow, 'deleted' | 'doc'> | null, doc: unknown): ItemOutcome {
  if (!cur) return 'new';
  if (cur.deleted) return 'deleted_in_account';
  return canonicalJson(cur.doc) === canonicalJson(doc) ? 'identical' : 'conflict';
}

/** Prévia: compara a área de preparo com a conta, sem gravar nada. */
export async function previewJob(pool: Pool, userId: string, jobId: string): Promise<ImportReport & { staged: number; expected: number }> {
  const job = await getJob(pool, userId, jobId);
  const items = await pool.query<{ collection: SyncCollection; entity_id: string; doc: Record<string, unknown> }>('SELECT collection, entity_id, doc FROM import_job_items WHERE job_id = $1', [jobId]);
  const report: ImportReport = { policy: job.policy, totals: emptyCounts(), byCollection: {}, conflicts: [] };
  for (const col of SYNC_COLLECTIONS) {
    const mine = items.rows.filter((i) => i.collection === col);
    if (!mine.length) continue;
    const cur = await pool.query<{ id: string; deleted: boolean; doc: Record<string, unknown> }>(`SELECT id, deleted, doc FROM ${TABLES[col].table} WHERE user_id = $1 AND id = ANY($2::text[])`, [userId, mine.map((m) => m.entity_id)]);
    const byId = new Map(cur.rows.map((r) => [r.id, r]));
    const counts = (report.byCollection[col] = emptyCounts());
    for (const it of mine) {
      const o = classify(byId.get(it.entity_id) ?? null, it.doc);
      if (o === 'new') counts.new++;
      else if (o === 'identical') counts.identical++;
      else {
        counts.conflict++;
        if (report.conflicts.length < IMPORT_LIMITS.maxConflictsListed) report.conflicts.push({ collection: col, entityId: it.entity_id, outcome: o });
      }
    }
    for (const k of ['new', 'identical', 'conflict'] as const) report.totals[k] += counts[k];
  }
  return { ...report, staged: items.rowCount ?? 0, expected: job.expected_items };
}

/** Efetiva a importação numa única transação. Qualquer falha desfaz tudo. */
export async function commitJob(pool: Pool, userId: string, jobId: string, policy: 'merge' | 'replace'): Promise<ImportReport> {
  try {
    return await commitTx(pool, userId, jobId, policy);
  } catch (e) {
    // Dado recusado pelo banco no meio: a transação já desfez tudo; responde como importação inválida.
    if (pgCode(e)?.startsWith('22') || pgCode(e)?.startsWith('23')) throw new ApiError('import_invalid');
    throw e;
  }
}

async function commitTx(pool: Pool, userId: string, jobId: string, policy: 'merge' | 'replace'): Promise<ImportReport> {
  return withTx(pool, async (c) => {
    const j = await c.query<Job>('SELECT id, status, expected_items, policy, report FROM import_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE', [jobId, userId]);
    const job = j.rows[0];
    if (!job) throw new ApiError('not_found');
    if (job.status === 'committed' && job.report) return job.report; // repetir a efetivação devolve o mesmo relatório
    if (job.status !== 'staging') throw new ApiError('import_state');
    const items = await c.query<{ collection: SyncCollection; entity_id: string; doc: Record<string, unknown> }>('SELECT collection, entity_id, doc FROM import_job_items WHERE job_id = $1 ORDER BY collection, entity_id', [jobId]);
    if ((items.rowCount ?? 0) !== job.expected_items) throw new ApiError('import_state', { items: `Recebidos ${items.rowCount ?? 0} de ${job.expected_items} registros. Envie o restante antes de confirmar.` });
    const { seq: startSeq } = await lockUserSeq(c, userId);
    let seq = startSeq;
    const report: ImportReport = { policy, totals: emptyCounts(), byCollection: {}, conflicts: [] };
    for (const it of items.rows) {
      const col = it.collection;
      const counts = (report.byCollection[col] ??= emptyCounts());
      const cur = await c.query<CurrentRow>(`SELECT version, deleted, doc, server_seq FROM ${TABLES[col].table} WHERE user_id = $1 AND id = $2 FOR UPDATE`, [userId, it.entity_id]);
      const row = cur.rows[0] ?? null;
      const o = classify(row, it.doc);
      if (o === 'identical') counts.identical++;
      else if (o === 'new') {
        seq++;
        await writeRow(c, col, userId, it.entity_id, it.doc, 1, seq, null);
        counts.new++;
      } else if (policy === 'replace') {
        seq++;
        await saveRevision(c, userId, col, it.entity_id, row!, 'import_replace', null);
        await writeRow(c, col, userId, it.entity_id, it.doc, row!.version + 1, seq, null);
        counts.replaced++;
      } else {
        counts.conflict++;
        if (report.conflicts.length < IMPORT_LIMITS.maxConflictsListed) report.conflicts.push({ collection: col, entityId: it.entity_id, outcome: o });
      }
    }
    for (const counts of Object.values(report.byCollection)) for (const k of ['new', 'identical', 'conflict', 'replaced'] as const) report.totals[k] += counts![k];
    if (seq !== startSeq) await saveUserSeq(c, userId, seq);
    await c.query("UPDATE import_jobs SET status = 'committed', policy = $3, report = $2, committed_at = now() WHERE id = $1", [jobId, JSON.stringify(report), policy]);
    return report;
  });
}

export interface VerifyResult {
  checked: number;
  /** Registros que, pelo relatório, devem estar no banco exatamente como enviados (novos, iguais, substituídos). */
  expectedEqual: number;
  matched: number;
  /** Conflitos mantidos na política "mesclar" (o banco ficou com a versão da conta, de propósito). */
  keptAccountVersion: number;
  mismatches: { collection: SyncCollection; entityId: string; reason: 'missing' | 'different' }[];
  ok: boolean;
  /** Contagem de registros ativos da conta por coleção, lida do banco. */
  accountCounts: Partial<Record<SyncCollection, number>>;
}

/** Leitura de volta depois da efetivação: confirma no PostgreSQL o que foi gravado. */
export async function verifyJob(pool: Pool, userId: string, jobId: string): Promise<VerifyResult> {
  const job = await getJob(pool, userId, jobId);
  if (job.status !== 'committed' || !job.report) throw new ApiError('import_state');
  const conflictKeys = new Set(job.report.conflicts.map((x) => `${x.collection}\u0000${x.entityId}`));
  const items = await pool.query<{ collection: SyncCollection; entity_id: string; hash: string }>('SELECT collection, entity_id, hash FROM import_job_items WHERE job_id = $1', [jobId]);
  const res: VerifyResult = { checked: 0, expectedEqual: 0, matched: 0, keptAccountVersion: 0, mismatches: [], ok: false, accountCounts: {} };
  for (const col of SYNC_COLLECTIONS) {
    const mine = items.rows.filter((i) => i.collection === col);
    const count = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${TABLES[col].table} WHERE user_id = $1 AND NOT deleted`, [userId]);
    res.accountCounts[col] = count.rows[0].n;
    if (!mine.length) continue;
    const cur = await pool.query<{ id: string; deleted: boolean; doc: Record<string, unknown> }>(`SELECT id, deleted, doc FROM ${TABLES[col].table} WHERE user_id = $1 AND id = ANY($2::text[])`, [userId, mine.map((m) => m.entity_id)]);
    const byId = new Map(cur.rows.map((r) => [r.id, r]));
    for (const it of mine) {
      res.checked++;
      const row = byId.get(it.entity_id);
      if (conflictKeys.has(`${col}\u0000${it.entity_id}`) && job.policy === 'merge') {
        res.keptAccountVersion++;
        continue;
      }
      res.expectedEqual++;
      if (!row || row.deleted) res.mismatches.push({ collection: col, entityId: it.entity_id, reason: 'missing' });
      else if ((await recordHash(row.doc)) !== it.hash) res.mismatches.push({ collection: col, entityId: it.entity_id, reason: 'different' });
      else res.matched++;
    }
  }
  res.ok = res.mismatches.length === 0 && res.matched === res.expectedEqual;
  return res;
}

export function importRoutes(router: Router, d: { pool: Pool; limiter: RateLimiter }): void {
  const { pool, limiter } = d;

  router.add({
    method: 'POST',
    path: '/api/v1/import/jobs',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      await limiter.consume(LIMITS.importUser, a.userId);
      const b = createSchema.safeParse(await readJson(ctx, 2048));
      if (!b.success) throw new ApiError('import_invalid');
      const prev = await pool.query<{ id: string; committed_at: Date }>(
        "SELECT id, committed_at FROM import_jobs WHERE user_id = $1 AND source_fingerprint = $2 AND status = 'committed' ORDER BY committed_at DESC LIMIT 1",
        [a.userId, b.data.sourceFingerprint],
      );
      const id = uuid();
      await pool.query("INSERT INTO import_jobs (id, user_id, source_kind, source_fingerprint, source_profile_id, policy, status, expected_items) VALUES ($1, $2, $3, $4, $5, 'merge', 'staging', $6)", [
        id,
        a.userId,
        b.data.sourceKind,
        b.data.sourceFingerprint,
        b.data.sourceProfileId,
        b.data.expectedItems,
      ]);
      return { status: 201, body: { jobId: id, previousImport: prev.rows[0] ? { jobId: prev.rows[0].id, committedAt: prev.rows[0].committed_at.toISOString() } : null } };
    },
  });

  router.add({
    method: 'POST',
    path: '/api/v1/import/jobs/:id/items',
    auth: 'session',
    maxBody: IMPORT_LIMITS.maxBatchBytes,
    handler: async (ctx) => {
      const a = ctx.auth!;
      await limiter.consume(LIMITS.importUser, a.userId);
      const job = await getJob(pool, a.userId, ctx.params.id);
      if (job.status !== 'staging') throw new ApiError('import_state');
      const b = itemsSchema.safeParse(await readJson(ctx, IMPORT_LIMITS.maxBatchBytes));
      if (!b.success) throw new ApiError('import_invalid');
      const errors: { collection: string; entityId: string; reason: string }[] = [];
      const ready: { collection: SyncCollection; entityId: string; doc: Record<string, unknown>; hash: string }[] = [];
      for (const it of b.data.items) {
        try {
          const doc = normalizeRecord(it.collection, it.entityId, it.doc, a.dataProfileId);
          // O hash do app tem de bater com o do conteúdo normalizado: prova de que os dois lados falam do mesmo registro.
          const h = await recordHash(doc);
          if (h !== it.hash) errors.push({ collection: it.collection, entityId: it.entityId, reason: 'hash' });
          else ready.push({ ...it, doc, hash: h });
        } catch (e) {
          errors.push({ collection: it.collection, entityId: it.entityId, reason: e instanceof RecordError ? `${e.code}${e.field ? `:${e.field}` : ''}` : 'invalid' });
        }
      }
      if (errors.length) return { status: 422, body: { error: { code: 'import_invalid', message: 'Alguns registros não passaram na validação. Nada deste lote foi guardado.' }, items: errors.slice(0, 100) } };
      await withTx(pool, async (c) => {
        await c.query(
          `INSERT INTO import_job_items (job_id, collection, entity_id, doc, hash)
           SELECT $1, x.collection, x.entity_id, x.doc, x.hash FROM jsonb_to_recordset($2::jsonb) AS x(collection text, entity_id text, doc jsonb, hash text)
           ON CONFLICT (job_id, collection, entity_id) DO UPDATE SET doc = EXCLUDED.doc, hash = EXCLUDED.hash`,
          [job.id, JSON.stringify(ready.map((r) => ({ collection: r.collection, entity_id: r.entityId, doc: r.doc, hash: r.hash })))],
        );
        const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM import_job_items WHERE job_id = $1', [job.id]);
        if (n.rows[0].n > job.expected_items) throw new ApiError('import_state', { items: 'Mais registros do que o informado ao criar a importação.' });
      });
      return { status: 200, body: { accepted: ready.length } };
    },
  });

  router.add({ method: 'GET', path: '/api/v1/import/jobs/:id/preview', auth: 'session', handler: async (ctx) => ({ status: 200, body: await previewJob(pool, ctx.auth!.userId, ctx.params.id) }) });

  router.add({
    method: 'POST',
    path: '/api/v1/import/jobs/:id/commit',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      const b = commitSchema.safeParse(await readJson(ctx, 1024));
      if (!b.success) throw new ApiError('import_invalid');
      if (b.data.policy === 'replace' && b.data.confirmReplace !== true) throw new ApiError('validation_failed', { confirmReplace: 'Confirme que deseja substituir os registros da conta.' });
      return { status: 200, body: { report: await commitJob(pool, a.userId, ctx.params.id, b.data.policy) } };
    },
  });

  router.add({ method: 'GET', path: '/api/v1/import/jobs/:id/verify', auth: 'session', handler: async (ctx) => ({ status: 200, body: await verifyJob(pool, ctx.auth!.userId, ctx.params.id) }) });

  router.add({
    method: 'DELETE',
    path: '/api/v1/import/jobs/:id',
    auth: 'session',
    handler: async (ctx) => {
      const job = await getJob(pool, ctx.auth!.userId, ctx.params.id);
      if (job.status !== 'staging') throw new ApiError('import_state');
      await pool.query("UPDATE import_jobs SET status = 'cancelled' WHERE id = $1", [job.id]);
      await pool.query('DELETE FROM import_job_items WHERE job_id = $1', [job.id]);
      return { status: 204 };
    },
  });
}
