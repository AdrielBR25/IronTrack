// Aplica as migrações pendentes: `node services/api/scripts/migrate.ts` (pré-implantação no Railway, ou manual).
// Só precisa de DATABASE_URL (e DATABASE_SSL, se aplicável). Nunca imprime a URL. Saída 1 = nada novo aplicado.
// `--status` só lista as pendentes, sem aplicar.
import { createPool } from '../src/db/pool.ts';
import { migrate, pendingMigrations } from '../src/db/migrate.ts';

const url = process.env.DATABASE_URL ?? '';
if (!/^postgres(ql)?:\/\//.test(url)) {
  process.stderr.write('DATABASE_URL ausente.\n');
  process.exit(1);
}
let host = '';
try {
  host = new URL(url).hostname;
} catch {
  /* inválida: o pool falha abaixo */
}
const sslEnv = process.env.DATABASE_SSL;
const dbSsl = sslEnv === 'disable' || sslEnv === 'require' || sslEnv === 'verify-full' ? sslEnv : host.endsWith('.railway.internal') || ['localhost', '127.0.0.1'].includes(host) ? 'disable' : 'require';
const pool = createPool({ databaseUrl: url, dbSsl, ...(process.env.DATABASE_SSL_CA ? { dbCa: process.env.DATABASE_SSL_CA } : {}), dbPoolMax: 1 });
try {
  if (process.argv.includes('--status')) {
    const p = await pendingMigrations(pool);
    process.stdout.write(p.length ? `pendentes: ${p.join(', ')}\n` : 'esquema em dia\n');
  } else {
    const r = await migrate(pool);
    process.stdout.write(r.applied.length ? `aplicadas: ${r.applied.join(', ')}\n` : `nenhuma pendente (${r.alreadyApplied} já aplicadas)\n`);
  }
} catch (e) {
  process.stderr.write(`migração falhou: ${e instanceof Error ? e.message.replace(url, '[DATABASE_URL]') : 'erro desconhecido'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
