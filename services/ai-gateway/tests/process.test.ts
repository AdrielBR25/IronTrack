// Processo real do gateway (src/main.ts): recarregamento por monitoramento do arquivo e por SIGHUP,
// revogação efetiva sem reiniciar, configuração inválida bloqueia, encerramento gracioso por SIGTERM e
// log de acesso sem token. Só loopback; nenhum provedor é chamado.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig, newToken } from './helpers.ts';

const root = join(import.meta.dirname, '..');
let child: ChildProcess | undefined;
let dir = '';
afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const token = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'token.ts'), ...args], { encoding: 'utf8' });

async function boot(file: string, extraEnv: Record<string, string> = {}) {
  const p = spawn(process.execPath, [join(root, 'src', 'main.ts')], { env: { PATH: process.env.PATH ?? '', AI_GATEWAY_CONFIG: file, AI_GATEWAY_RELOAD_INTERVAL_MS: '100', ...extraEnv } });
  child = p;
  let stdout = '';
  let stderr = '';
  p.stdout!.on('data', (c) => (stdout += c));
  p.stderr!.on('data', (c) => (stderr += c));
  const base = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`gateway não subiu: ${stderr}`)), 8_000);
    p.stderr!.on('data', () => {
      const m = /ouvindo em (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
  });
  return { p, base, out: () => stdout, errs: () => stderr };
}

const models = (base: string, tok: string) => fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.status);
async function until(fn: () => Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('processo do gateway', () => {
  it('revogação pelo utilitário vale sem reiniciar (monitoramento do arquivo); SIGHUP recarrega; SIGTERM encerra', async () => {
    dir = mkdtempSync(join(tmpdir(), 'irontrack-gw-'));
    const file = join(dir, 'gateway.json');
    writeFileSync(file, JSON.stringify({ ...testConfig(newToken()), clients: [] }));
    const issued = token(['issue', 'celular', '--config', file]);
    const tok = /\n([A-Za-z0-9_-]{43})\n/.exec(issued.stdout)![1];
    const keyId = /keyId: (k-[0-9a-f]{12})/.exec(issued.stdout)![1];
    const g = await boot(file);
    expect(await models(g.base, tok)).toBe(200);

    // Revogar: o processo em execução passa a recusar em instantes, sem reinício.
    const t0 = Date.now();
    expect(token(['revoke', keyId, '--config', file]).status).toBe(0);
    expect(await until(async () => (await models(g.base, tok)) === 401)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000);

    // Nova credencial + SIGHUP (recarregamento imediato).
    const tok2 = /\n([A-Za-z0-9_-]{43})\n/.exec(token(['issue', 'celular', '--config', file]).stdout)![1];
    g.p.kill('SIGHUP');
    expect(await until(async () => (await models(g.base, tok2)) === 200)).toBe(true);

    // Arquivo inválido: bloqueia (503), não continua com a configuração antiga.
    writeFileSync(file, '{quebrado');
    g.p.kill('SIGHUP');
    expect(await until(async () => (await models(g.base, tok2)) === 503)).toBe(true);

    const exited = new Promise<number | null>((r) => g.p.on('exit', (c) => r(c)));
    g.p.kill('SIGTERM');
    expect(await exited).toBe(0);
    child = undefined;
    expect(g.errs()).toContain('encerrado');
    // Log de acesso: só metadados, sem tokens.
    expect(g.out()).not.toContain(tok);
    expect(g.out()).not.toContain(tok2);
    expect(g.out()).toContain('"keyId"');
    expect(g.errs()).not.toContain(tok2);
  }, 20_000);

  it('AI_GATEWAY_ACCESS_LOG=off desliga o log de acesso; enabled=false sobe bloqueado', async () => {
    dir = mkdtempSync(join(tmpdir(), 'irontrack-gw-'));
    const file = join(dir, 'gateway.json');
    // Porta 0 (livre) via arquivo: sem arquivo o gateway usaria a porta padrão 8787.
    writeFileSync(file, JSON.stringify(testConfig(newToken(), { enabled: false })));
    const g = await boot(file, { AI_GATEWAY_ACCESS_LOG: 'off' });
    expect(await models(g.base, newToken())).toBe(503);
    expect(g.errs()).toContain('BLOQUEADO');
    await new Promise((r) => setTimeout(r, 100));
    expect(g.out()).toBe('');
  });
});
