// Executor de migrações versionadas (Prompt 21, docs/NUVEM_ARQUITETURA.md §2.1). Regras:
//  - arquivos `NNNN_nome.sql` em services/api/migrations, aplicados em ordem, cada um numa transação;
//  - trava consultiva: dois deploys simultâneos não aplicam a mesma migração;
//  - o checksum de cada arquivo aplicado é conferido: alterar uma migração já aplicada é ERRO (crie outra);
//  - nunca há "db push" nem sincronização destrutiva de esquema.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { Pool } from './pool.ts';

export const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const LOCK_KEY = 7_041_021; // constante arbitrária da trava consultiva do IronTrack

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: URL = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(new URL(name, dir), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export class MigrationChecksumError extends Error {
  readonly migration: string;
  constructor(migration: string) {
    super(`A migração ${migration} já aplicada foi alterada. Restaure o arquivo original e crie uma nova migração.`);
    this.migration = migration;
    this.name = 'MigrationChecksumError';
  }
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(pool: Pool, files: MigrationFile[] = readMigrations()): Promise<MigrateResult> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await c.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    for (const [name, checksum] of done) {
      const f = files.find((x) => x.name === name);
      if (f && f.checksum !== checksum) throw new MigrationChecksumError(name);
    }
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f.name)) continue;
      await c.query('BEGIN');
      try {
        await c.query(f.sql);
        await c.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f.name, f.checksum]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Falha ao aplicar ${f.name}: ${e instanceof Error ? e.message : String(e)}. Nada desta migração foi aplicado.`);
      }
      applied.push(f.name);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    try {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } finally {
      c.release();
    }
  }
}

/** Migrações pendentes (prontidão: a API só fica pronta com o esquema em dia). */
export async function pendingMigrations(pool: Pool, files: MigrationFile[] = readMigrations()): Promise<string[]> {
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('schema_migrations') AS t");
  if (!exists.rows[0]?.t) return files.map((f) => f.name);
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  return files.filter((f) => !done.has(f.name)).map((f) => f.name);
}
