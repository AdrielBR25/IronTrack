// Ponto de entrada da API no Railway: `node services/api/src/main.ts` (Node 22.18+, TypeScript nativo).
// Lê a configuração do ambiente (nunca registra valores), abre o pool do PostgreSQL, escuta em PORT e encerra com graça
// em SIGTERM (o Railway envia SIGTERM ao trocar a versão). As migrações rodam ANTES, no comando de pré-implantação
// (`node services/api/scripts/migrate.ts`); a API só responde "pronta" (/api/v1/ready) com o esquema em dia.
import { createApi } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';

const err = (s: string) => process.stderr.write(`[api] ${s}\n`);

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    err('configuração inválida — corrija as variáveis no Railway:');
    for (const p of e.problems) err(`  - ${p}`);
    process.exit(1);
  }
  throw e;
}

const pool = createPool(cfg);
const api = createApi({ cfg, pool });
if (cfg.ai.errors.length) err(`IA desativada: configuração de provedores inválida (${cfg.ai.errors.join(', ')}).`);
err(`e-mail: ${api.mailer.provider}${api.mailer.enabled ? '' : ' (verificação e recuperação de senha INDISPONÍVEIS)'}`);

const maintenance = setInterval(() => void api.maintenance().catch(() => err('manutenção periódica falhou (tentará de novo)')), 10 * 60_000);
maintenance.unref();

let stopping = false;
async function stop(sig: string) {
  if (stopping) return;
  stopping = true;
  err(`${sig}: encerrando (${api.inFlight()} requisição(ões) em andamento).`);
  clearInterval(maintenance);
  await api.shutdown(Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000));
  await pool.end();
  err('encerrado.');
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

const onListening = () => {
  const a = api.server.address();
  err(`ouvindo em ${a && typeof a === 'object' ? `${a.address} porta ${a.port}` : cfg.port} (${cfg.env}).`);
};
// HOST "::" (rede privada da Railway, IPv4 e IPv6). Num ambiente sem IPv6, cai para "0.0.0.0" em vez de não subir.
api.server.once('error', (e: NodeJS.ErrnoException) => {
  if (cfg.host === '::' && e.code === 'EAFNOSUPPORT') {
    err('IPv6 indisponível neste ambiente; ouvindo só em IPv4 (0.0.0.0).');
    api.server.listen(cfg.port, '0.0.0.0', onListening);
    return;
  }
  throw e;
});
api.server.listen(cfg.port, cfg.host, onListening);
