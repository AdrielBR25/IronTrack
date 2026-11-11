// Fase 07 — marca de ambiente do banco. Impede que a API (ou as migrações) da HOMOLOGAÇÃO usem o banco de PRODUÇÃO
// por engano (ex.: DATABASE_URL colada à mão) e vice-versa.
//
// Regras (APP_ENV da API):
//  - staging: o banco precisa ter a marca `staging`. Um banco NOVO (sem nenhuma migração aplicada) recebe a marca na
//    primeira migração. Um banco SEM marca e COM migrações aplicadas é tratado como produção: recusado.
//  - production: recusa um banco marcado como `staging`. Nunca grava nada (o banco atual de produção continua igual).
//  - development / não informado: sem verificação (testes e desenvolvimento local).
import type { Pool, PoolClient } from 'pg';

export type DbEnv = 'production' | 'staging' | 'development';
export const ENV_TABLE = 'irontrack_environment';

export class DatabaseEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseEnvironmentError';
  }
}

type Q = Pick<Pool | PoolClient, 'query'>;

export async function readDatabaseMark(c: Q): Promise<{ mark: string | null; migrated: boolean }> {
  const t = await c.query<{ env: string | null; mig: string | null }>(`SELECT to_regclass('${ENV_TABLE}')::text AS env, to_regclass('schema_migrations')::text AS mig`);
  let mark: string | null = null;
  if (t.rows[0]?.env) mark = (await c.query<{ env: string }>(`SELECT env FROM ${ENV_TABLE} LIMIT 1`)).rows[0]?.env ?? null;
  let migrated = false;
  if (t.rows[0]?.mig) migrated = Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM schema_migrations')).rows[0]?.n ?? 0) > 0;
  return { mark, migrated };
}

/**
 * Confere (e, com `claim`, marca um banco novo de homologação). Lança DatabaseEnvironmentError com uma mensagem que
 * diz o que fazer, sem revelar a URL do banco.
 */
export async function ensureDatabaseEnvironment(c: Q, appEnv: DbEnv | undefined, opts: { claim?: boolean } = {}): Promise<'ok' | 'claimed'> {
  if (!appEnv || appEnv === 'development') return 'ok';
  const { mark, migrated } = await readDatabaseMark(c);
  if (appEnv === 'production') {
    if (mark && mark !== 'production') throw new DatabaseEnvironmentError(`APP_ENV=production, mas este banco está marcado como "${mark}". Confira a referência DATABASE_URL do serviço: produção nunca usa o banco de homologação.`);
    return 'ok';
  }
  // staging
  if (mark === 'staging') return 'ok';
  if (mark) throw new DatabaseEnvironmentError(`APP_ENV=staging, mas este banco está marcado como "${mark}". A homologação nunca usa o banco de produção.`);
  if (migrated)
    throw new DatabaseEnvironmentError(
      'APP_ENV=staging, mas este banco já tem migrações e não tem a marca de homologação: parece ser o banco de PRODUÇÃO. Nada foi alterado. Use o Postgres exclusivo do ambiente staging (DATABASE_URL=${{Postgres.DATABASE_URL}} dentro do ambiente staging).',
    );
  if (!opts.claim) return 'ok'; // banco vazio: a marca é gravada pela primeira migração
  await c.query(`CREATE TABLE IF NOT EXISTS ${ENV_TABLE} (env text PRIMARY KEY CHECK (env IN ('production','staging')), marked_at timestamptz NOT NULL DEFAULT now())`);
  await c.query(`INSERT INTO ${ENV_TABLE} (env) VALUES ('staging') ON CONFLICT DO NOTHING`);
  return 'claimed';
}

export function appEnvFrom(env: Record<string, string | undefined>): DbEnv | undefined {
  const v = (env.APP_ENV ?? '').trim();
  if (v === 'production' || v === 'staging' || v === 'development') return v;
  return env.NODE_ENV === 'production' ? 'production' : undefined;
}
