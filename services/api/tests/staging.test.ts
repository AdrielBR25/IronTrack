// Fase 07 — homologação (staging) separada da produção: marca de ambiente do banco, e-mails só para a lista
// permitida e com "[Homologação]" no assunto, configuração que recusa staging inseguro.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createPool, type Pool } from '../src/db/pool.ts';
import { migrate, readMigrations } from '../src/db/migrate.ts';
import { DatabaseEnvironmentError, ensureDatabaseEnvironment, readDatabaseMark } from '../src/db/environment.ts';
import { TestMailbox, guardedMailer, recipientAllowed, resendMailer, MailError, mailFailureInfo } from '../src/mail/mailer.ts';
import { adminUrl } from './helpers.ts';

const BASE = {
  DATABASE_URL: 'postgresql://u:x@postgres.railway.internal:5432/railway',
  APP_ORIGIN: 'https://irontrack-web-staging.up.railway.app',
  RATE_LIMIT_SECRET: 'r'.repeat(40),
  NODE_ENV: 'production',
};
const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems;
  }
};

describe('configuração do staging', () => {
  it('APP_ENV padrão: production com NODE_ENV=production', () => {
    expect(loadConfig(BASE).appEnv).toBe('production');
    expect(loadConfig({ ...BASE, APP_ENV: 'staging' }).appEnv).toBe('staging');
  });
  it('staging com Resend exige EMAIL_ALLOWLIST; valores inválidos são recusados', () => {
    const resend = { ...BASE, APP_ENV: 'staging', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_1234567890', EMAIL_FROM: 'IronTrack <nao-responda@exemplo.com>' };
    expect(problems(resend).join()).toMatch(/EMAIL_ALLOWLIST é obrigatória/);
    expect(problems({ ...resend, EMAIL_ALLOWLIST: 'adriel@exemplo.com, @exemplo.org' })).toEqual([]);
    expect(problems({ ...resend, EMAIL_ALLOWLIST: 'não é e-mail' }).join()).toMatch(/EMAIL_ALLOWLIST deve ter/);
    expect(problems({ ...BASE, APP_ENV: 'homolog' }).join()).toMatch(/APP_ENV deve ser/);
  });
});

describe('e-mail da homologação', () => {
  it('lista permitida: e-mail exato ou domínio', () => {
    expect(recipientAllowed('Adriel@Exemplo.com', ['adriel@exemplo.com'])).toBe(true);
    expect(recipientAllowed('qualquer@exemplo.org', ['@exemplo.org'])).toBe(true);
    expect(recipientAllowed('outra@gmail.com', ['adriel@exemplo.com', '@exemplo.org'])).toBe(false);
    expect(recipientAllowed('outra@gmail.com', [])).toBe(true);
  });
  it('staging: só entrega para a lista, com [Homologação] no assunto; o resto é descartado sem erro', async () => {
    const box = new TestMailbox();
    let suppressed = 0;
    const m = guardedMailer(box, { staging: true, allowlist: ['adriel@exemplo.com'], onSuppressed: () => suppressed++ });
    const msg = { subject: 'Confirme seu e-mail no IronTrack', text: 'Olá', html: '<html><body><div style="x">oi</div></body></html>' };
    await m.send({ ...msg, to: 'adriel@exemplo.com' });
    await m.send({ ...msg, to: 'estranho@gmail.com' });
    expect(box.messages).toHaveLength(1);
    expect(box.messages[0]!.subject).toBe('[Homologação] Confirme seu e-mail no IronTrack');
    expect(box.messages[0]!.text).toMatch(/HOMOLOGAÇÃO/);
    expect(box.messages[0]!.html).toMatch(/HOMOLOGAÇÃO/);
    expect(suppressed).toBe(1);
  });
  it('falha do Resend guarda só o código e o tipo do erro (diagnóstico de domínio não verificado)', async () => {
    const fake = (async () => new Response(JSON.stringify({ name: 'validation_error', message: 'The exemplo.com domain is not verified' }), { status: 403 })) as unknown as typeof fetch;
    const m = resendMailer('re_teste_123456', 'IronTrack <x@exemplo.com>', fake);
    const e = await m.send({ to: 'a@b.com', subject: 's', text: 't', html: 'h' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MailError);
    expect(mailFailureInfo(e)).toEqual({ reason: 'provider', providerStatus: 403, providerError: 'validation_error' });
  });
});

describe('marca de ambiente do banco', () => {
  const pools: Pool[] = [];
  const dbs: string[] = [];
  async function freshDb(): Promise<Pool> {
    const name = `it_env_${randomBytes(5).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    dbs.push(name);
    const url = new URL(adminUrl());
    url.pathname = `/${name}`;
    const p = createPool({ databaseUrl: url.toString(), dbSsl: 'disable', dbPoolMax: 2 });
    pools.push(p);
    return p;
  }
  afterAll(async () => {
    for (const p of pools) await p.end();
    const admin = new pg.Pool({ connectionString: adminUrl(), max: 1 });
    for (const d of dbs) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin.end();
  });

  it('banco novo de homologação: primeira migração marca como staging; reexecutar é seguro', async () => {
    const p = await freshDb();
    const r1 = await migrate(p, readMigrations(), { appEnv: 'staging' });
    expect(r1.applied.length).toBe(readMigrations().length);
    expect((await readDatabaseMark(p)).mark).toBe('staging');
    const r2 = await migrate(p, readMigrations(), { appEnv: 'staging' });
    expect(r2.applied).toEqual([]);
    await expect(ensureDatabaseEnvironment(p, 'staging')).resolves.toBe('ok');
  });

  it('banco de produção (migrado, sem marca): staging é recusado e NADA é gravado', async () => {
    const p = await freshDb();
    await migrate(p); // como a produção de hoje: migrações sem APP_ENV, sem marca
    const before = await p.query("SELECT count(*)::int AS n FROM schema_migrations");
    await expect(migrate(p, readMigrations(), { appEnv: 'staging' })).rejects.toBeInstanceOf(DatabaseEnvironmentError);
    await expect(ensureDatabaseEnvironment(p, 'staging')).rejects.toThrow(/parece ser o banco de PRODUÇÃO/);
    expect((await readDatabaseMark(p)).mark).toBeNull();
    expect((await p.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0]).toEqual(before.rows[0]);
    // e a produção continua aceita, sem gravar marca
    await expect(migrate(p, readMigrations(), { appEnv: 'production' })).resolves.toMatchObject({ applied: [] });
    expect((await readDatabaseMark(p)).mark).toBeNull();
  });

  it('produção recusa um banco marcado como staging', async () => {
    const p = await freshDb();
    await migrate(p, readMigrations(), { appEnv: 'staging' });
    await expect(migrate(p, readMigrations(), { appEnv: 'production' })).rejects.toThrow(/marcado como "staging"/);
  });
});
