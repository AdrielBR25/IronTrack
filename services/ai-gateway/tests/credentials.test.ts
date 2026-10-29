// Ciclo de vida das credenciais (P07): emissão, revogação, rotação com e sem transição, listagem sem
// segredos, expiração, e o utilitário de linha de comando com gravação atômica do arquivo.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticate, sha256Hex } from '../src/auth.ts';
import { validateConfig } from '../src/config.ts';
import { CredentialError, issueCredential, listCredentials, parseDuration, revokeCredential, rotateCredential } from '../src/credentials.ts';
import { testConfig, newToken } from './helpers.ts';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const at = (ms: number) => ({ now: () => ms });
const base = () => ({ ...testConfig(newToken()), clients: [] as unknown[] });
const auth = (cfg: unknown, token: string, now: number) => {
  const r = validateConfig(cfg);
  if (!r.ok) throw new Error(r.errors.join(','));
  return authenticate(`Bearer ${token}`, r.config.clients, now);
};

describe('emissão, revogação e rotação (funções puras)', () => {
  it('issue: token de 256 bits mostrado só no retorno; arquivo guarda só o hash e um keyId não secreto', () => {
    const r = issueCredential(base(), 'celular', {}, at(T0));
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.keyId).toMatch(/^k-[0-9a-f]{12}$/);
    const text = JSON.stringify(r.config);
    expect(text).not.toContain(r.token);
    expect(text).toContain(sha256Hex(r.token));
    expect(auth(r.config, r.token, T0)?.credential.keyId).toBe(r.keyId);
    expect(auth(r.config, r.token, T0)?.client.id).toBe('celular');
  });

  it('expiração opcional (duração ou data) é aplicada', () => {
    const r = issueCredential(base(), 'celular', { expiresInMs: parseDuration('1h') }, at(T0));
    expect(r.expiresAt).toBe('2026-11-01T13:00:00Z');
    expect(auth(r.config, r.token, T0 + 3_599_000)).not.toBeNull();
    expect(auth(r.config, r.token, T0 + 3_600_000)).toBeNull();
    expect(() => issueCredential(base(), 'celular', { expiresAt: '2026-10-01T00:00:00Z' }, at(T0))).toThrow(CredentialError);
    expect(() => issueCredential(base(), 'celular', { expiresAt: 'semana que vem' }, at(T0))).toThrow(CredentialError);
  });

  it('revoke: imediato no arquivo, registrado para auditoria; outra credencial do titular segue válida', () => {
    const a = issueCredential(base(), 'celular', {}, at(T0));
    const b = issueCredential(a.config, 'celular', {}, at(T0));
    const cfg = revokeCredential(b.config, a.keyId, at(T0 + 1_000));
    expect(auth(cfg, a.token, T0 + 1_000)).toBeNull();
    expect(auth(cfg, b.token, T0 + 1_000)?.credential.keyId).toBe(b.keyId);
    expect(listCredentials(cfg, T0 + 1_000).find((c) => c.keyId === a.keyId)).toMatchObject({ status: 'revogada', revokedAt: '2026-11-01T12:00:01Z' });
    expect(() => revokeCredential(cfg, 'k-inexistente')).toThrow(CredentialError);
  });

  it('rotate sem transição: antigo revogado na hora, novo válido', () => {
    const a = issueCredential(base(), 'celular', {}, at(T0));
    const r = rotateCredential(a.config, a.keyId, {}, at(T0));
    expect(r.replaced).toBe(a.keyId);
    expect(auth(r.config, a.token, T0)).toBeNull();
    expect(auth(r.config, r.token, T0)?.client.id).toBe('celular');
    expect(() => rotateCredential(r.config, a.keyId, {}, at(T0))).toThrow(/já está revogada/);
  });

  it('rotate com transição: antigo vale até o fim do prazo; nunca estende uma expiração menor', () => {
    const a = issueCredential(base(), 'celular', { expiresInMs: parseDuration('10m') }, at(T0));
    const r = rotateCredential(a.config, a.keyId, { graceMs: parseDuration('30m') }, at(T0));
    expect(auth(r.config, a.token, T0 + 599_000)).not.toBeNull();
    expect(auth(r.config, a.token, T0 + 600_000)).toBeNull(); // 10 min, não 30
    const b = issueCredential(base(), 'pc', {}, at(T0));
    const r2 = rotateCredential(b.config, b.keyId, { graceMs: parseDuration('5m') }, at(T0));
    expect(auth(r2.config, b.token, T0 + 299_000)).not.toBeNull();
    expect(auth(r2.config, b.token, T0 + 300_000)).toBeNull();
    expect(auth(r2.config, r2.token, T0 + 300_000)).not.toBeNull();
  });

  it('migra o formato do P06 ao rotacionar (keyId legado) sem perder a credencial', () => {
    const tok = newToken();
    const legacy = testConfig(tok);
    const keyId = `legacy-${sha256Hex(tok).slice(0, 12)}`;
    const r = rotateCredential(legacy, keyId, { graceMs: 60_000 }, at(T0));
    expect((r.config.clients as Record<string, unknown>[])[0].tokenSha256).toBeUndefined();
    expect(auth(r.config, tok, T0)).not.toBeNull();
    expect(auth(r.config, tok, T0 + 60_000)).toBeNull();
  });

  it('list não mostra hashes nem tokens', () => {
    const a = issueCredential(base(), 'celular', {}, at(T0));
    const list = listCredentials(a.config, T0);
    expect(list).toEqual([{ clientId: 'celular', keyId: a.keyId, status: 'ativa', createdAt: '2026-11-01T12:00:00Z' }]);
    expect(JSON.stringify(list)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('nunca produz configuração inválida; entrada inválida é recusada sem alteração', () => {
    expect(() => issueCredential({ enabled: 'sim' }, 'x')).toThrow(/seria inválida/);
    expect(() => issueCredential(base(), 'Nome Com Espaço')).toThrow(CredentialError);
    expect(() => parseDuration('10s')).toThrow(CredentialError);
  });
});

describe('utilitário de linha de comando (scripts/token.ts)', () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'token.ts');
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('issue → rotate → revoke → list no arquivo, com gravação atômica e permissão 0600', () => {
    dir = mkdtempSync(join(tmpdir(), 'irontrack-gw-'));
    const file = join(dir, 'gateway.json');
    writeFileSync(file, JSON.stringify(base()));
    const issued = run(['issue', 'celular', '--expires-in', '90d', '--config', file]);
    expect(issued.status).toBe(0);
    const token = /\n([A-Za-z0-9_-]{43})\n/.exec(issued.stdout)![1];
    const keyId = /keyId: (k-[0-9a-f]{12})/.exec(issued.stdout)![1];
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(token);
    expect(saved).toContain(sha256Hex(token));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Sem sobras de arquivos temporários.
    expect(readdirSync(dir)).toEqual(['gateway.json']);

    const rotated = run(['rotate', keyId, '--grace', '30m', '--config', file]);
    expect(rotated.status).toBe(0);
    const token2 = /\n([A-Za-z0-9_-]{43})\n/.exec(rotated.stdout)![1];
    expect(token2).not.toBe(token);
    expect(run(['revoke', keyId, '--config', file]).status).toBe(0);
    const list = run(['list', '--config', file]);
    const rows = list.stdout.trim().split('\n').map((l) => JSON.parse(l) as { keyId: string; status: string });
    expect(rows.find((r) => r.keyId === keyId)?.status).toBe('revogada');
    expect(rows.filter((r) => r.status === 'ativa')).toHaveLength(1);
    expect(list.stdout + list.stderr).not.toContain(token2);
    expect(validateConfig(JSON.parse(readFileSync(file, 'utf8'))).ok).toBe(true);
  });

  it('arquivo inválido ou keyId inexistente: erro claro e arquivo intocado', () => {
    dir = mkdtempSync(join(tmpdir(), 'irontrack-gw-'));
    const file = join(dir, 'gateway.json');
    writeFileSync(file, '{quebrado');
    const r = run(['issue', 'celular', '--config', file]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(readFileSync(file, 'utf8')).toBe('{quebrado');
    writeFileSync(file, JSON.stringify(base()));
    const before = readFileSync(file, 'utf8');
    expect(run(['revoke', 'k-000000000000', '--config', file]).status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('atalho sem arquivo (compatível com o P06): imprime token e trecho, não grava nada', () => {
    const out = execFileSync(process.execPath, [script, 'meu-celular'], { encoding: 'utf8' });
    const token = /\n([A-Za-z0-9_-]{43})\n/.exec(out)![1];
    const snippet = JSON.parse(out.slice(out.indexOf('{'))) as { id: string; credentials: { tokenSha256: string }[] };
    expect(snippet.id).toBe('meu-celular');
    expect(snippet.credentials[0].tokenSha256).toBe(sha256Hex(token));
  });
});
