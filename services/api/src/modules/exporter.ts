// Exportação individual (Prompt 21): todos os dados da conta no formato de backup v8 do app, restaurável no próprio
// IronTrack (inclusive no modo sem conta). Fotos não estão na nuvem nesta fase, então `photos` vai vazio e o arquivo
// diz isso em `cloudNotice`.
import { SYNC_COLLECTIONS } from '../../../../shared/sync/collections.ts';
import type { Pool } from '../db/pool.ts';
import { ApiError, type Router } from '../http/core.ts';
import { LIMITS, type RateLimiter } from '../lib/rateLimit.ts';
import { TABLES } from './records.ts';

export const EXPORT_BACKUP_VERSION = 8;

export async function exportAccount(pool: Pool, userId: string): Promise<Record<string, unknown>> {
  const u = await pool.query<{ name: string; data_profile_id: string; created_at: Date }>('SELECT name, data_profile_id, created_at FROM users WHERE id = $1', [userId]);
  if (!u.rows[0]) throw new ApiError('unauthenticated');
  const data: Record<string, unknown> = { photos: [] };
  for (const col of SYNC_COLLECTIONS) {
    const r = await pool.query<{ doc: Record<string, unknown> }>(`SELECT doc FROM ${TABLES[col].table} WHERE user_id = $1 AND NOT deleted ORDER BY id`, [userId]);
    data[col] = col === 'settings' ? (r.rows[0]?.doc ?? null) : r.rows.map((x) => x.doc);
  }
  return {
    app: 'irontrack',
    kind: 'backup',
    schemaVersion: EXPORT_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profile: { id: u.rows[0].data_profile_id, displayName: u.rows[0].name, createdAt: u.rows[0].created_at.getTime() },
    cloudNotice: 'Exportado da conta na nuvem. Fotos de progresso ficam só nos aparelhos e não estão neste arquivo.',
    data,
  };
}

export function exportRoutes(router: Router, d: { pool: Pool; limiter: RateLimiter }): void {
  router.add({
    method: 'GET',
    path: '/api/v1/me/export',
    auth: 'session',
    handler: async (ctx) => {
      await d.limiter.consume(LIMITS.exportUser, ctx.auth!.userId);
      const body = await exportAccount(d.pool, ctx.auth!.userId);
      return { status: 200, body, headers: { 'content-disposition': `attachment; filename="irontrack-conta-${new Date().toISOString().slice(0, 10)}.json"` } };
    },
  });
}
