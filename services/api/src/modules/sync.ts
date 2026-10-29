// Sincronização `irontrack.sync.v1` (Prompt 21, docs/NUVEM_SINCRONIZACAO.md).
//  - push: cada operação é aplicada só se `baseVersion` for a versão atual (controle otimista); senão volta como
//    CONFLITO com a versão do servidor — nunca "última gravação vence". Idempotente por `opId`. Cada operação roda num
//    SAVEPOINT: uma recusa não desfaz as outras; erro inesperado desfaz o lote inteiro (o app reenvia os mesmos IDs).
//  - pull: alterações da conta em ordem do cursor (`server_seq`), incluindo exclusões.
// O usuário vem SEMPRE da sessão; `accountId` do corpo só confere que a fila do aparelho é desta conta.
import { canonicalJson } from '../../../../shared/canonical.ts';
import { SYNC_COLLECTIONS, type SyncCollection } from '../../../../shared/sync/collections.ts';
import { SYNC_LIMITS, SYNC_PROTOCOL, pushRequestSchema, syncOpSchema, type PullResponse, type PushResponse, type ServerRecord, type SyncOpResult } from '../../../../shared/sync/protocol.ts';
import { withTx, type Pool, type PoolClient } from '../db/pool.ts';
import { ApiError, readJson, type Router } from '../http/core.ts';
import { LIMITS, type RateLimiter } from '../lib/rateLimit.ts';
import { RecordError, TABLES, deleteRow, lockRow, lockUserSeq, normalizeRecord, saveRevision, saveUserSeq, writeRow } from './records.ts';

export interface SyncDeps {
  pool: Pool;
  limiter: RateLimiter;
}

const REJECT_MESSAGES: Record<string, string> = {
  invalid_op: 'Operação em formato inválido.',
  invalid_record: 'O registro não passou na validação do servidor.',
  entity_mismatch: 'O ID do registro não corresponde à entidade.',
  profile_mismatch: 'O registro pertence a outro perfil.',
  too_large: 'Registro maior que o limite.',
};

const rejected = (opId: string, code: string, field?: string): SyncOpResult => ({ opId, status: 'rejected', code, message: `${REJECT_MESSAGES[code] ?? 'Operação recusada.'}${field ? ` (${field})` : ''}` });

/** Aplica um lote de operações da conta. Exportado para testes de integração. */
export async function applyPush(pool: Pool, userId: string, deviceId: string, rawOps: unknown[]): Promise<SyncOpResult[]> {
  return withTx(pool, async (c) => {
    const { seq: startSeq, dataProfileId } = await lockUserSeq(c, userId);
    let seq = startSeq;
    const results: SyncOpResult[] = [];
    for (const raw of rawOps) {
      const parsed = syncOpSchema.safeParse(raw);
      if (!parsed.success) {
        const opId = raw && typeof raw === 'object' && typeof (raw as { opId?: unknown }).opId === 'string' ? String((raw as { opId: string }).opId).slice(0, 64) : '';
        results.push(rejected(opId, 'invalid_op'));
        continue;
      }
      const op = parsed.data;
      const prev = await c.query<{ result: SyncOpResult }>('SELECT result FROM sync_operations WHERE user_id = $1 AND op_id = $2', [userId, op.opId]);
      if (prev.rows[0]) {
        results.push({ ...prev.rows[0].result, ...(prev.rows[0].result.status === 'applied' ? { replayed: true } : {}) } as SyncOpResult);
        continue;
      }
      await c.query('SAVEPOINT op');
      let result: SyncOpResult;
      try {
        const out = await applyOne(c, userId, dataProfileId, deviceId, op, seq);
        result = out.result;
        seq = out.seq;
        await c.query('RELEASE SAVEPOINT op');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT op');
        if (e instanceof RecordError) result = rejected(op.opId, e.code, e.field);
        // Dado que o PostgreSQL recusou (data impossível, número fora do tipo, restrição): recusa só esta operação.
        else if (isDataError(e)) result = rejected(op.opId, 'invalid_record', 'banco');
        else throw e;
      }
      // Conflitos não são gravados como resultado definitivo: depois de resolver, o app manda uma operação NOVA.
      if (result.status !== 'conflict')
        await c.query('INSERT INTO sync_operations (user_id, op_id, device_id, collection, entity_id, result) VALUES ($1, $2, $3, $4, $5, $6)', [userId, op.opId, deviceId, op.collection, op.entityId, JSON.stringify(result)]);
      results.push(result);
    }
    if (seq !== startSeq) await saveUserSeq(c, userId, seq);
    return results;
  });
}

const isDataError = (e: unknown) => {
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
  return code.startsWith('22') || code.startsWith('23');
};

async function applyOne(c: PoolClient, userId: string, dataProfileId: string, deviceId: string, op: ReturnType<typeof syncOpSchema.parse>, seq: number): Promise<{ result: SyncOpResult; seq: number }> {
  const col = op.collection as SyncCollection;
  const cur = await lockRow(c, col, userId, op.entityId);
  const conflict = (): { result: SyncOpResult; seq: number } => ({
    result: { opId: op.opId, status: 'conflict', server: { version: cur?.version ?? 0, deleted: cur?.deleted ?? true, doc: cur && !cur.deleted ? cur.doc : null } },
    seq,
  });
  if (op.kind === 'put') {
    const doc = normalizeRecord(col, op.entityId, op.doc!, dataProfileId);
    if (!cur) {
      if (op.baseVersion !== 0) return conflict();
      await writeRow(c, col, userId, op.entityId, doc, 1, seq + 1, deviceId);
      return { result: { opId: op.opId, status: 'applied', version: 1, seq: seq + 1 }, seq: seq + 1 };
    }
    if (cur.version !== op.baseVersion) {
      // O mesmo conteúdo já está no servidor (ex.: resposta perdida, ou os dois aparelhos fizeram a mesma coisa).
      if (!cur.deleted && canonicalJson(cur.doc) === canonicalJson(doc)) return { result: { opId: op.opId, status: 'applied', version: cur.version, seq: cur.server_seq }, seq };
      return conflict();
    }
    if (!cur.deleted && canonicalJson(cur.doc) === canonicalJson(doc)) return { result: { opId: op.opId, status: 'applied', version: cur.version, seq: cur.server_seq }, seq };
    if (op.reason === 'conflict_resolution') await saveRevision(c, userId, col, op.entityId, cur, 'conflict_resolution', deviceId);
    await writeRow(c, col, userId, op.entityId, doc, cur.version + 1, seq + 1, deviceId);
    return { result: { opId: op.opId, status: 'applied', version: cur.version + 1, seq: seq + 1 }, seq: seq + 1 };
  }
  // delete
  if (!cur || cur.deleted) return { result: { opId: op.opId, status: 'applied', version: cur?.version ?? 0, seq: cur?.server_seq ?? seq }, seq };
  if (cur.version !== op.baseVersion) return conflict();
  await saveRevision(c, userId, col, op.entityId, cur, 'delete', deviceId);
  await deleteRow(c, col, userId, op.entityId, cur.version + 1, seq + 1, deviceId);
  return { result: { opId: op.opId, status: 'applied', version: cur.version + 1, seq: seq + 1 }, seq: seq + 1 };
}

/** Alterações da conta depois do cursor, em ordem. */
export async function pullChanges(pool: Pool, userId: string, since: number, limit: number): Promise<PullResponse & { reset?: boolean }> {
  const head = await pool.query<{ sync_seq: number }>('SELECT sync_seq FROM users WHERE id = $1', [userId]);
  const top = head.rows[0]?.sync_seq ?? 0;
  // Cursor à frente do servidor (ex.: banco restaurado de um backup): o aparelho precisa recomeçar do zero.
  if (since > top) return { protocol: SYNC_PROTOCOL, cursor: '0', hasMore: true, changes: [], reset: true };
  const union = SYNC_COLLECTIONS.map((col, i) => `SELECT '${col}'::text AS collection, id, version, deleted, doc, server_seq, ${i} AS o FROM ${TABLES[col].table} WHERE user_id = $1 AND server_seq > $2`).join(' UNION ALL ');
  const r = await pool.query<{ collection: SyncCollection; id: string; version: number; deleted: boolean; doc: Record<string, unknown>; server_seq: number }>(`${union} ORDER BY server_seq, o LIMIT $3`, [userId, since, limit + 1]);
  const rows = r.rows.slice(0, limit);
  const changes: ServerRecord[] = rows.map((x) => ({ collection: x.collection, entityId: x.id, version: x.version, deleted: x.deleted, doc: x.deleted ? null : x.doc, seq: x.server_seq }));
  const cursor = rows.length ? rows[rows.length - 1].server_seq : since;
  return { protocol: SYNC_PROTOCOL, cursor: String(cursor), hasMore: r.rows.length > limit, changes };
}

export function syncRoutes(router: Router, d: SyncDeps): void {
  router.add({
    method: 'POST',
    path: '/api/v1/sync/push',
    auth: 'session',
    maxBody: SYNC_LIMITS.maxPushBytes,
    handler: async (ctx) => {
      const a = ctx.auth!;
      await d.limiter.consume(LIMITS.syncUser, a.userId);
      const parsed = pushRequestSchema.safeParse(await readJson(ctx, SYNC_LIMITS.maxPushBytes));
      if (!parsed.success) throw new ApiError('bad_request');
      if (parsed.data.accountId !== a.userId) throw new ApiError('account_mismatch');
      const results = await applyPush(d.pool, a.userId, parsed.data.deviceId, parsed.data.ops);
      const body: PushResponse = { protocol: SYNC_PROTOCOL, results };
      return { status: 200, body };
    },
  });

  router.add({
    method: 'GET',
    path: '/api/v1/sync/pull',
    auth: 'session',
    handler: async (ctx) => {
      const a = ctx.auth!;
      await d.limiter.consume(LIMITS.syncUser, a.userId);
      const raw = ctx.url.searchParams.get('cursor') ?? '0';
      if (!/^\d{1,15}$/.test(raw)) throw new ApiError('bad_request');
      const limitRaw = Number(ctx.url.searchParams.get('limit') ?? SYNC_LIMITS.maxPullPage);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, SYNC_LIMITS.maxPullPage) : SYNC_LIMITS.maxPullPage;
      const accountId = ctx.url.searchParams.get('accountId');
      if (accountId && accountId !== a.userId) throw new ApiError('account_mismatch');
      return { status: 200, body: await pullChanges(d.pool, a.userId, Number(raw), limit) };
    },
  });
}
