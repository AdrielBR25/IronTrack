// Ponto de entrada local: `npm run gateway:dev` (Node 22.18+, TypeScript nativo).
// Lê a configuração do arquivo indicado em AI_GATEWAY_CONFIG e as chaves das variáveis de ambiente.
// Sem arquivo, com arquivo inválido ou com `enabled: false`, o gateway sobe BLOQUEADO (503 em tudo).
// Não publique este processo na internet sem a estratégia de implantação de docs/IA_GATEWAY.md.
//
// Recarregamento (credenciais, limites, allowlists): SIGHUP recarrega na hora; além disso o arquivo é
// monitorado (AI_GATEWAY_RELOAD_INTERVAL_MS, padrão 2000; 0 desliga). Configuração nova inválida
// BLOQUEIA o gateway até ser corrigida (nunca continua com a antiga). Chaves de provedor (variáveis de
// ambiente) só mudam reiniciando o processo.
// Encerramento: SIGTERM/SIGINT param de aceitar requisições e esperam as em andamento
// (AI_GATEWAY_SHUTDOWN_GRACE_MS, padrão 10000). SIGUSR2 escreve as métricas agregadas em stderr.
// Log de acesso (metadados, stdout): AI_GATEWAY_ACCESS_LOG=off desliga. Nada vai para terceiros.
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { createGateway } from './gateway.ts';
import { isLoopbackHost } from './config.ts';

function loadRaw(path: string | undefined): unknown {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const intEnv = (name: string, def: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 ? v : def;
};
const err = (s: string) => process.stderr.write(`[ai-gateway] ${s}\n`);
const configPath = process.env.AI_GATEWAY_CONFIG;
const accessLog = process.env.AI_GATEWAY_ACCESS_LOG !== 'off';

const gw = createGateway({
  config: loadRaw(configPath),
  env: process.env,
  logger: accessLog ? (e) => process.stdout.write(`${JSON.stringify(e)}\n`) : () => {},
});

const describe = () => {
  if (!gw.config) err(`configuração ausente ou inválida (${gw.configErrors.join(', ')}): BLOQUEADO.`);
  else if (!gw.config.enabled) err('enabled=false: BLOQUEADO.');
  else err(`configuração ativa: ${gw.config.clients.reduce((n, c) => n + c.credentials.length, 0)} credencial(is), limites de UMA instância.`);
};
describe();

const reload = (why: string) => {
  gw.reload(loadRaw(configPath));
  err(`configuração recarregada (${why}).`);
  describe();
};
process.on('SIGHUP', () => reload('SIGHUP'));
const interval = intEnv('AI_GATEWAY_RELOAD_INTERVAL_MS', 2_000);
// watchFile consulta stat(): detecta a troca atômica (rename) feita por scripts/token.ts.
if (configPath && interval > 0) watchFile(configPath, { interval, persistent: false }, (cur, prev) => (cur.mtimeMs !== prev.mtimeMs || cur.ino !== prev.ino) && reload('arquivo alterado'));

process.on('SIGUSR2', () => err(`métricas ${JSON.stringify(gw.metrics())}`));

let stopping = false;
const stop = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  err(`${sig}: encerrando (aguardando ${gw.inFlight()} solicitação(ões) em andamento).`);
  if (configPath) unwatchFile(configPath);
  await gw.shutdown(intEnv('AI_GATEWAY_SHUTDOWN_GRACE_MS', 10_000));
  err(`encerrado. métricas ${JSON.stringify(gw.metrics())}`);
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));

const host = gw.config?.host ?? '127.0.0.1';
const port = gw.config?.port ?? 8787;
if (!isLoopbackHost(host)) err('ATENÇÃO: escutando fora do loopback. Use HTTPS na frente; os limites valem só para esta instância.');
gw.server.listen(port, host, () => {
  const a = gw.server.address();
  err(`ouvindo em http://${host}:${a && typeof a === 'object' ? a.port : port}`);
});
