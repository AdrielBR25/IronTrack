// Gestão de credenciais de acesso ao gateway, FORA do cliente (Node 22.18+).
//
//   npm run gateway:token -- issue  <titular> [--expires-in 90d | --expires-at <ISO>] [--config <arquivo>]
//   npm run gateway:token -- rotate <keyId>   [--grace 30m] [--expires-in 90d]       --config <arquivo>
//   npm run gateway:token -- revoke <keyId>                                          --config <arquivo>
//   npm run gateway:token -- list                                                    --config <arquivo>
//   npm run gateway:token -- <titular>       (atalho de "issue" sem arquivo: só imprime o trecho)
//
// O token aparece UMA vez, no terminal de quem emite (entregue ao titular por canal privado). Nunca é
// gravado em arquivo nem em log; na configuração fica só o SHA-256. Com --config, o arquivo é
// regravado de forma ATÔMICA (arquivo temporário no mesmo diretório, fsync, rename), com permissão 0600,
// e o gateway em execução aplica a mudança no próximo recarregamento (SIGHUP ou monitoramento do
// arquivo; ver docs/IA_GATEWAY.md, seção "Rotação e revogação"). Sem --config nada é gravado.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { CredentialError, issueCredential, listCredentials, parseDuration, revokeCredential, rotateCredential } from '../src/credentials.ts';

/** Grava `text` em `path` de forma atômica: quem ler o arquivo vê o conteúdo antigo ou o novo inteiro. */
export function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new CredentialError(`Falta o valor de ${a}.`);
      flags[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

function main(argv: string[]): number {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const note = (s: string) => process.stderr.write(`${s}\n`);
  const { pos, flags } = parseArgs(argv);
  const known = ['config', 'expires-in', 'expires-at', 'grace'];
  for (const f of Object.keys(flags)) if (!known.includes(f)) throw new CredentialError(`Opção desconhecida: --${f}.`);
  let [cmd, arg] = pos;
  if (cmd && !['issue', 'rotate', 'revoke', 'list'].includes(cmd)) [cmd, arg] = ['issue', cmd];
  cmd ??= 'issue';
  const path = flags.config;
  const load = () => {
    if (!path) throw new CredentialError('Informe --config <arquivo de configuração do gateway>.');
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      throw new CredentialError('Não foi possível ler a configuração (arquivo ausente ou JSON inválido). Nada foi alterado.');
    }
  };
  const save = (cfg: unknown) => writeAtomic(path!, `${JSON.stringify(cfg, null, 2)}\n`);
  const exp = { ...(flags['expires-in'] ? { expiresInMs: parseDuration(flags['expires-in']) } : {}), ...(flags['expires-at'] ? { expiresAt: flags['expires-at'] } : {}) };

  if (cmd === 'list') {
    for (const c of listCredentials(load())) out(JSON.stringify(c));
    return 0;
  }
  if (cmd === 'revoke') {
    if (!arg) throw new CredentialError('Informe o keyId a revogar.');
    save(revokeCredential(load(), arg));
    note(`Credencial ${arg} revogada no arquivo. O gateway em execução passa a recusá-la no próximo recarregamento (SIGHUP ou monitoramento do arquivo); requisições em andamento com ela são interrompidas.`);
    return 0;
  }
  if (cmd === 'rotate') {
    if (!arg) throw new CredentialError('Informe o keyId a substituir.');
    const r = rotateCredential(load(), arg, { ...exp, ...(flags.grace ? { graceMs: parseDuration(flags.grace) } : {}) });
    save(r.config);
    out(`Novo token (entregue ao titular; não será mostrado de novo):\n${r.token}\n`);
    out(`keyId: ${r.keyId}${r.expiresAt ? ` · expira em ${r.expiresAt}` : ''}`);
    note(flags.grace ? `A credencial ${arg} continua aceita até o fim do período de transição (${flags.grace}).` : `A credencial ${arg} foi revogada.`);
    return 0;
  }
  // issue
  const holder = arg ?? 'dev';
  if (path) {
    const r = issueCredential(load(), holder, exp);
    save(r.config);
    out(`Token (entregue ao titular; não será mostrado de novo):\n${r.token}\n`);
    out(`keyId: ${r.keyId}${r.expiresAt ? ` · expira em ${r.expiresAt}` : ''}`);
    note('Credencial gravada no arquivo de configuração (só o hash).');
    return 0;
  }
  const r = issueCredential({ enabled: false, clients: [] }, holder, exp);
  const client = (r.config.clients as Record<string, unknown>[])[0];
  out(`Token (entregue ao titular; não será mostrado de novo):\n${r.token}\n`);
  out(`Trecho para "clients" na configuração do gateway:\n${JSON.stringify(client, null, 2)}`);
  return 0;
}

if (process.argv[1]?.endsWith('token.ts')) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof CredentialError ? e.message : 'Falha inesperada; nada foi alterado.'}\n`);
    process.exitCode = 1;
  }
}
