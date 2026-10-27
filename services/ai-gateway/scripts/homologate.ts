// Homologação externa CONTROLADA de um provedor real (manual; nunca roda na suíte automática).
//
//   AI_GATEWAY_HOMOLOGATION=1 ANTHROPIC_API_KEY=... \
//     npm run gateway:homologate -- --provider anthropic --model <id-atual> --confirm-paid-call
//
// Faz UMA solicitação, com pergunta fictícia e fixa (sem dados pessoais), saída pequena e tempo limite
// curto, passando pelo gateway completo (autenticação, allowlist, limites, adaptador, normalização) num
// processo local em 127.0.0.1 com configuração só em memória. Escreve UMA linha JSON com: provedor,
// modelo, sucesso/falha, código de erro normalizado, duração e uso informado. Nunca escreve o prompt, a
// resposta, a chave ou o token, e não grava arquivos.
//
// Travas: exige AI_GATEWAY_HOMOLOGATION=1 E --confirm-paid-call; modelo sempre explícito (sem padrão);
// chave só da variável de ambiente do processo. `--base-url http://127.0.0.1:<porta>` aponta para um
// servidor simulado local (ensaio sem custo; usado nos testes); qualquer outro endereço é recusado.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { sha256Hex } from '../src/auth.ts';
import { PROVIDER_IDS, isLoopbackHost, isProviderId, type ProviderId } from '../src/config.ts';
import { createGateway, type GatewayLogEvent } from '../src/gateway.ts';

/** Pergunta fictícia e fixa: nada do usuário, nenhum dado pessoal. */
export const HOMOLOGATION_MESSAGES = [
  { role: 'system', content: 'Você verifica conectividade. Responda somente com a palavra OK.' },
  { role: 'user', content: 'Teste de conectividade do IronTrack. Responda somente: OK' },
] as const;

const DEFAULT_ENV: Record<ProviderId, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export interface HomologationRecord {
  ts: string;
  provider: string;
  model: string;
  ok: boolean;
  /** Código normalizado do gateway quando falha. */
  code?: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

class Refusal extends Error {}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Refusal(`Argumento inesperado: ${a}`);
    const key = a.slice(2);
    if (key === 'confirm-paid-call') flags[key] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Refusal(`Falta o valor de ${a}.`);
      flags[key] = v;
      i++;
    }
  }
  return flags;
}

const boundedInt = (v: string | true | undefined, def: number, min: number, max: number, name: string) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Refusal(`${name} deve ser um inteiro entre ${min} e ${max}.`);
  return n;
};

export async function homologate(argv: string[], env: Record<string, string | undefined>): Promise<HomologationRecord> {
  if (env.AI_GATEWAY_HOMOLOGATION !== '1') throw new Refusal('Homologação desativada. Defina AI_GATEWAY_HOMOLOGATION=1 só na sessão de homologação autorizada.');
  const flags = parseArgs(argv);
  const known = ['provider', 'model', 'confirm-paid-call', 'api-key-env', 'anthropic-version', 'timeout-ms', 'max-output-tokens', 'base-url'];
  for (const k of Object.keys(flags)) if (!known.includes(k)) throw new Refusal(`Opção desconhecida: --${k}.`);
  if (flags['confirm-paid-call'] !== true) throw new Refusal('Esta chamada pode ser cobrada pelo provedor. Confirme com --confirm-paid-call.');
  const provider = flags.provider;
  if (typeof provider !== 'string' || !isProviderId(provider)) throw new Refusal(`Informe --provider (${PROVIDER_IDS.join(', ')}).`);
  const model = flags.model;
  if (typeof model !== 'string' || !MODEL_ID.test(model)) throw new Refusal('Informe --model com o ID exato de um modelo atual (sem padrão).');
  const keyEnv = typeof flags['api-key-env'] === 'string' ? flags['api-key-env'] : DEFAULT_ENV[provider];
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(keyEnv) || keyEnv.startsWith('VITE_')) throw new Refusal('--api-key-env inválido.');
  const apiKey = env[keyEnv]?.trim();
  if (!apiKey || apiKey.length < 8) throw new Refusal(`Credencial ausente: defina ${keyEnv} no ambiente desta sessão.`);
  const timeoutMs = boundedInt(flags['timeout-ms'], 20_000, 1_000, 30_000, '--timeout-ms');
  const maxOutputTokens = boundedInt(flags['max-output-tokens'], 32, 16, 64, '--max-output-tokens');
  let baseUrl: string | undefined;
  if (flags['base-url'] !== undefined) {
    let u: URL;
    try {
      u = new URL(String(flags['base-url']));
    } catch {
      throw new Refusal('--base-url inválido.');
    }
    if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname)) throw new Refusal('--base-url só aceita um servidor simulado em http://127.0.0.1 (ensaio sem custo).');
    baseUrl = u.origin;
  }
  const apiVersion = typeof flags['anthropic-version'] === 'string' ? flags['anthropic-version'] : '2026-10-21';

  // Credencial de acesso descartável, só desta execução e só em memória.
  const token = randomBytes(32).toString('base64url');
  const events: GatewayLogEvent[] = [];
  const gw = createGateway({
    config: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [],
      clients: [{ id: 'homologacao', enabled: true, credentials: [{ keyId: 'k-homologacao', tokenSha256: sha256Hex(token) }] }],
      limits: { requestsPerMinute: 1, maxConcurrentPerClient: 1, maxConcurrentTotal: 1, dailyTokenBudget: 2_000, maxOutputTokens: 64, upstreamTimeoutMs: timeoutMs, maxUpstreamResponseBytes: 64 * 1024 },
      providers: {
        [provider]: {
          enabled: true,
          displayName: provider,
          apiKeyEnv: keyEnv,
          ...(baseUrl ? { baseUrl } : {}),
          ...(provider === 'anthropic' ? { apiVersion } : {}),
          models: [{ id: model, displayName: model, maxInputChars: 2_000, maxOutputTokens: 64 }],
        },
      },
    },
    env: { [keyEnv]: apiKey },
    logger: (e) => events.push(e),
  });
  if (!gw.config) throw new Refusal(`Parâmetros inválidos (${gw.configErrors.join(', ')}).`);
  await new Promise<void>((r) => gw.server.listen(0, '127.0.0.1', r));
  const { port } = gw.server.address() as AddressInfo;
  const started = Date.now();
  let status = 0;
  let body: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider, model, messages: HOMOLOGATION_MESSAGES, maxOutputTokens }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
    status = res.status;
    body = await res.json().catch(() => undefined);
  } catch {
    status = 0;
  } finally {
    await gw.shutdown(1_000);
  }
  const durationMs = Date.now() - started;
  const ev = events.find((e) => e.route === 'POST /v1/generate');
  const b = (typeof body === 'object' && body !== null ? body : {}) as { error?: { code?: unknown }; usage?: HomologationRecord['usage']; output?: { text?: unknown } };
  const ok = status === 200 && typeof b.output?.text === 'string' && b.output.text.length > 0;
  const usage = ok ? b.usage : ev?.usageSource === 'reported' ? { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens } : undefined;
  return {
    ts: new Date(started).toISOString(),
    provider,
    model,
    ok,
    ...(ok ? {} : { code: typeof b.error?.code === 'string' ? b.error.code : status === 0 ? 'gateway_unreachable' : 'unknown' }),
    durationMs,
    ...(usage ? { usage: { ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}) } } : {}),
  };
}

if (process.argv[1]?.endsWith('homologate.ts')) {
  homologate(process.argv.slice(2), process.env).then(
    (r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exitCode = r.ok ? 0 : 1;
    },
    (e) => {
      process.stderr.write(`[homologação] ${e instanceof Refusal ? e.message : 'Falha inesperada; nenhuma evidência foi gerada.'}\n`);
      process.exitCode = 2;
    },
  );
}
