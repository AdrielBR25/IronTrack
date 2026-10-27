// Ponto de entrada local: `npm run gateway:dev` (Node 22.18+, TypeScript nativo).
// Lê a configuração do arquivo indicado em AI_GATEWAY_CONFIG e as chaves das variáveis de ambiente.
// Sem arquivo, com arquivo inválido ou com `enabled: false`, o gateway sobe BLOQUEADO (503 em tudo).
// Não publique este processo na internet sem a estratégia de implantação de docs/IA_GATEWAY.md.
import { readFileSync } from 'node:fs';
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

const gw = createGateway({
  config: loadRaw(process.env.AI_GATEWAY_CONFIG),
  env: process.env,
  logger: (e) => process.stdout.write(`${JSON.stringify(e)}\n`),
});

if (!gw.config) process.stderr.write(`[ai-gateway] configuração ausente ou inválida (${gw.configErrors.join(', ')}): BLOQUEADO.\n`);
else if (!gw.config.enabled) process.stderr.write('[ai-gateway] enabled=false: BLOQUEADO.\n');

const host = gw.config?.host ?? '127.0.0.1';
const port = gw.config?.port ?? 8787;
if (!isLoopbackHost(host)) process.stderr.write('[ai-gateway] ATENÇÃO: escutando fora do loopback. Use HTTPS na frente e limites compartilhados.\n');
gw.server.listen(port, host, () => process.stderr.write(`[ai-gateway] ouvindo em http://${host}:${port}\n`));
