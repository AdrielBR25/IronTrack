// Pool de conexões PostgreSQL (pg). A URL vem de DATABASE_URL e nunca é registrada; erros de conexão são
// reduzidos a uma frase sem host, usuário ou senha.
import pg from 'pg';
import type { ApiConfig } from '../config.ts';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// bigint (server_seq, contagens) chega como string por padrão; os valores cabem com folga em Number.
pg.types.setTypeParser(20, (v: string) => Number(v));
// date (yyyy-mm-dd) fica como texto: sem conversão de fuso.
pg.types.setTypeParser(1082, (v: string) => v);

export function createPool(cfg: Pick<ApiConfig, 'databaseUrl' | 'dbSsl' | 'dbCa' | 'dbPoolMax'>): Pool {
  const ssl = cfg.dbSsl === 'disable' ? false : cfg.dbSsl === 'verify-full' ? { rejectUnauthorized: true, ...(cfg.dbCa ? { ca: cfg.dbCa } : {}) } : { rejectUnauthorized: false };
  // A URL pode conter `sslmode`; a configuração explícita acima prevalece.
  const url = new URL(cfg.databaseUrl);
  url.searchParams.delete('sslmode');
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl,
    max: cfg.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: 'irontrack-api',
  });
  // Sem este handler, a queda de uma conexão ociosa derrubaria o processo.
  pool.on('error', () => process.stderr.write('[api] conexão ociosa com o banco encerrada pelo servidor\n'));
  return pool;
}

/** Executa `fn` numa transação. Qualquer erro desfaz tudo (nenhuma alteração parcial). */
export async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* conexão já perdida: o servidor desfaz sozinho */
    }
    throw e;
  } finally {
    c.release();
  }
}

/** Erro do PostgreSQL sem detalhes sensíveis (código SQLSTATE apenas). */
export const pgCode = (e: unknown): string | undefined => (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined);
