import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ORIGIN, Client, STRONG, linkToken, setupApi, signup, uniqueEmail, type TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupApi();
});
afterAll(async () => {
  await env?.close();
});

describe('cadastro', () => {
  it('cria conta com e-mail normalizado, sessão em cookie HttpOnly e e-mail de verificação', async () => {
    const c = new Client(env);
    const email = uniqueEmail('Maiusculas').toUpperCase();
    const r = await c.post('/api/v1/auth/signup', { name: '  Ana   Souza ', email: `  ${email} `, password: STRONG, acceptTerms: true });
    expect(r.status).toBe(201);
    expect(r.body.account.email).toBe(email.toLowerCase());
    expect(r.body.account.name).toBe('Ana Souza');
    expect(r.body.account.emailVerified).toBe(false);
    expect(r.body.verificationEmail).toBe('sent');
    const cookie = r.headers.getSetCookie()[0];
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(JSON.stringify(r.body)).not.toMatch(/password|hash/i);
    expect(env.mailbox.for(email.toLowerCase())).toHaveLength(1);
    const row = await env.pool.query('SELECT password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
    expect(row.rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(row.rows[0].password_hash).not.toContain(STRONG);
  });

  it('valida campos, aceite dos termos e senha forte', async () => {
    const c = new Client(env);
    const bad = await c.post('/api/v1/auth/signup', { name: '', email: 'nao-e-email', password: STRONG, acceptTerms: false });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.error.fields).sort()).toEqual(['acceptTerms', 'email', 'name']);
    const weak = await c.post('/api/v1/auth/signup', { name: 'Ana', email: uniqueEmail(), password: 'curta1', acceptTerms: true });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('weak_password');
    expect(weak.body.error.fields.password).toContain('Pelo menos 10 caracteres');
    const noDigit = await c.post('/api/v1/auth/signup', { name: 'Ana', email: uniqueEmail(), password: 'somenteletrasaqui', acceptTerms: true });
    expect(noDigit.body.error.code).toBe('weak_password');
    const extra = await c.post('/api/v1/auth/signup', { name: 'Ana', email: uniqueEmail(), password: STRONG, acceptTerms: true, userId: 'x' });
    expect(extra.status).toBe(422);
  });

  it('e-mail já cadastrado: 409 genérico, sem sessão e sem dizer que a conta existe', async () => {
    const { email } = await signup(env);
    const c = new Client(env);
    const r = await c.post('/api/v1/auth/signup', { name: 'Outra', email: email.toUpperCase(), password: 'outraSenha99x', acceptTerms: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('signup_unavailable');
    expect(r.headers.getSetCookie()).toHaveLength(0);
  });
});

describe('limites de cadastro', () => {
  it('no máximo 5 cadastros por IP por hora', async () => {
    const c = new Client(env);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await c.post('/api/v1/auth/signup', { name: 'Lote', email: uniqueEmail('lote'), password: STRONG, acceptTerms: true })).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe('login e sessões', () => {
  it('credenciais erradas e e-mail inexistente recebem a MESMA resposta', async () => {
    const { email } = await signup(env);
    const c = new Client(env);
    const wrong = await c.post('/api/v1/auth/login', { email, password: 'senhaErrada123' });
    const ghost = await c.post('/api/v1/auth/login', { email: uniqueEmail('fantasma'), password: 'senhaErrada123' });
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body).toEqual(ghost.body);
    expect(c.cookie).toBe('');
  });

  it('login cria sessão; /me exige sessão; logout revoga no servidor (cookie antigo deixa de valer)', async () => {
    const { email } = await signup(env);
    const c = new Client(env);
    expect((await c.get('/api/v1/me')).status).toBe(401);
    const r = await c.post('/api/v1/auth/login', { email, password: STRONG });
    expect(r.status).toBe(200);
    const stolen = c.cookie;
    expect((await c.get('/api/v1/me')).body.account.email).toBe(email);
    const out = await c.post('/api/v1/auth/logout');
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()[0]).toMatch(/Max-Age=0/);
    const replay = new Client(env);
    replay.cookie = stolen;
    expect((await replay.get('/api/v1/me')).status).toBe(401);
    const row = await env.pool.query("SELECT revoked_reason FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1 AND revoked_at IS NOT NULL", [email]);
    expect(row.rows.map((x) => x.revoked_reason)).toContain('logout');
  });

  it('sessão expirada ou ociosa demais não vale', async () => {
    const { client, account } = await signup(env);
    await env.pool.query("UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [account.id]);
    expect((await client.get('/api/v1/me')).status).toBe(401);
    const b = await signup(env);
    await env.pool.query("UPDATE auth_sessions SET last_seen_at = now() - interval '15 days' WHERE user_id = $1", [b.account.id]);
    expect((await b.client.get('/api/v1/me')).status).toBe(401);
  });

  it('só o hash do token fica no banco', async () => {
    const { client, account } = await signup(env);
    const token = client.cookie.split('=')[1];
    const rows = await env.pool.query('SELECT token_hash FROM auth_sessions WHERE user_id = $1', [account.id]);
    expect(rows.rows[0].token_hash).toBeInstanceOf(Buffer);
    expect(rows.rows[0].token_hash.toString('utf8')).not.toContain(token);
    expect(rows.rows[0].token_hash.length).toBe(32);
  });

  it('lista sessões, encerra as outras e não deixa revogar sessão de outra conta', async () => {
    const { client: a1, email } = await signup(env);
    const a2 = new Client(env);
    await a2.post('/api/v1/auth/login', { email, password: STRONG });
    const list = await a1.get('/api/v1/me/sessions');
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = await signup(env);
    const otherSessions = await other.client.get('/api/v1/me/sessions');
    const foreignId = otherSessions.body.sessions[0].id;
    expect((await a1.req('DELETE', `/api/v1/me/sessions/${foreignId}`)).status).toBe(404);
    expect((await other.client.get('/api/v1/me')).status).toBe(200);
    const r = await a1.post('/api/v1/me/sessions/revoke-others');
    expect(r.body.revoked).toBe(1);
    expect((await a2.get('/api/v1/me')).status).toBe(401);
    expect((await a1.get('/api/v1/me')).status).toBe(200);
  });

  it('limite de tentativas de login por e-mail (persistido no PostgreSQL)', async () => {
    const { email } = await signup(env);
    const c = new Client(env);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await c.post('/api/v1/auth/login', { email, password: 'errada-123456' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    const ok = await c.post('/api/v1/auth/login', { email, password: STRONG });
    expect(ok.status).toBe(429);
    expect(Number(ok.headers.get('retry-after'))).toBeGreaterThan(0);
    const buckets = await env.pool.query("SELECT bucket FROM rate_limits WHERE bucket LIKE 'login-email:%'");
    expect(buckets.rows.every((b) => !b.bucket.includes('@'))).toBe(true);
  });
});

describe('verificação de e-mail', () => {
  it('token de uso único confirma a conta; reutilizar falha', async () => {
    const { client, email } = await signup(env);
    const token = linkToken(env.mailbox.for(email)[0].text);
    const anon = new Client(env);
    expect((await anon.post('/api/v1/auth/verify-email', { token })).status).toBe(200);
    expect((await client.get('/api/v1/me')).body.account.emailVerified).toBe(true);
    const again = await anon.post('/api/v1/auth/verify-email', { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('token_invalid');
  });

  it('token expirado é recusado; reenvio limitado a 3 por hora', async () => {
    const { client, email, account } = await signup(env);
    await env.pool.query("UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [account.id]);
    const token = linkToken(env.mailbox.for(email)[0].text);
    expect((await client.post('/api/v1/auth/verify-email', { token })).status).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await client.post('/api/v1/auth/verify-email/resend')).status);
    expect(codes).toEqual([202, 202, 202, 429]);
    expect(env.mailbox.for(email)).toHaveLength(4);
  });

  it('o token nunca aparece nos logs', async () => {
    const { email } = await signup(env);
    const token = linkToken(env.mailbox.for(email)[0].text);
    await new Client(env).post('/api/v1/auth/verify-email', { token });
    const all = env.logs.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(email);
    expect(all).not.toContain(STRONG);
  });
});

describe('recuperação de senha', () => {
  it('não revela se o e-mail existe', async () => {
    const { email } = await signup(env);
    const c = new Client(env);
    const a = await c.post('/api/v1/auth/password/forgot', { email });
    const b = await c.post('/api/v1/auth/password/forgot', { email: uniqueEmail('ninguem') });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);
  });

  it('redefine com token de uso único, revoga todas as sessões e exige senha forte', async () => {
    const { client, email } = await signup(env);
    await new Client(env).post('/api/v1/auth/password/forgot', { email });
    const mail = env.mailbox.for(email).find((m) => m.subject.includes('Redefinição'))!;
    const token = linkToken(mail.text);
    const tokenRow = await env.pool.query('SELECT token_hash FROM password_reset_tokens WHERE expires_at < now() + interval \'31 minutes\'');
    expect(tokenRow.rows.length).toBeGreaterThan(0);
    const anon = new Client(env);
    const weak = await anon.post('/api/v1/auth/password/reset', { token, password: 'fraca' });
    expect(weak.body.error.code).toBe('weak_password');
    const ok = await anon.post('/api/v1/auth/password/reset', { token, password: 'NovaSenhaForte77' });
    expect(ok.status).toBe(200);
    expect((await client.get('/api/v1/me')).status).toBe(401);
    expect((await anon.post('/api/v1/auth/password/reset', { token, password: 'OutraSenha88x' })).status).toBe(400);
    expect((await new Client(env).post('/api/v1/auth/login', { email, password: STRONG })).status).toBe(401);
    expect((await new Client(env).post('/api/v1/auth/login', { email, password: 'NovaSenhaForte77' })).status).toBe(200);
    expect(env.mailbox.for(email).some((m) => m.subject.includes('Aviso de segurança'))).toBe(true);
  });

  it('troca de senha na conta: exige a atual e encerra as outras sessões', async () => {
    const { client, email } = await signup(env);
    const other = new Client(env);
    await other.post('/api/v1/auth/login', { email, password: STRONG });
    expect((await client.post('/api/v1/me/password', { currentPassword: 'errada-123456', newPassword: 'TrocaSegura55' })).status).toBe(401);
    expect((await client.post('/api/v1/me/password', { currentPassword: STRONG, newPassword: 'TrocaSegura55' })).status).toBe(200);
    expect((await client.get('/api/v1/me')).status).toBe(200);
    expect((await other.get('/api/v1/me')).status).toBe(401);
  });
});

describe('proteções HTTP', () => {
  it('CSRF: alteração sem o cabeçalho ou de outra origem é bloqueada', async () => {
    const { client } = await signup(env);
    expect((await client.req('PATCH', '/api/v1/me', { name: 'X' }, { 'x-irontrack-csrf': '0' })).status).toBe(403);
    expect((await client.req('PATCH', '/api/v1/me', { name: 'X' }, { origin: 'https://atacante.example' })).status).toBe(403);
    const noHeader = new Client(env, { csrf: false });
    noHeader.cookie = client.cookie;
    expect((await noHeader.req('PATCH', '/api/v1/me', { name: 'X' })).body.error.code).toBe('csrf_failed');
    expect((await client.req('PATCH', '/api/v1/me', { name: 'Nome Novo' })).body.account.name).toBe('Nome Novo');
  });

  it('CORS: só a origem exata recebe credenciais; nunca curinga', async () => {
    const ok = await fetch(`${env.base}/api/v1/health`, { headers: { origin: APP_ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const bad = await fetch(`${env.base}/api/v1/health`, { headers: { origin: 'https://atacante.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await fetch(`${env.base}/api/v1/sync/push`, { method: 'OPTIONS', headers: { origin: 'https://atacante.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(403);
    const pre2 = await fetch(`${env.base}/api/v1/sync/push`, { method: 'OPTIONS', headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST' } });
    expect(pre2.status).toBe(204);
    expect(pre2.headers.get('access-control-allow-headers')).toContain('x-irontrack-csrf');
  });

  it('cabeçalhos de segurança, JSON inválido, corpo grande e rota desconhecida', async () => {
    const r = await fetch(`${env.base}/api/v1/health`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    const c = new Client(env);
    expect((await c.req('POST', '/api/v1/auth/login', '{nao json')).status).toBe(400);
    expect((await c.req('POST', '/api/v1/auth/login', JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(10_000) }))).status).toBe(413);
    expect((await c.get('/api/v1/nao-existe')).status).toBe(404);
    expect((await c.req('DELETE', '/api/v1/health')).status).toBe(405);
  });

  it('injeção de SQL nos campos é tratada como texto', async () => {
    const c = new Client(env);
    const r = await c.post('/api/v1/auth/login', { email: "x'@a.co; DROP TABLE users;--", password: "' OR '1'='1" });
    expect([401, 422]).toContain(r.status);
    const n = await env.pool.query('SELECT count(*)::int AS n FROM users');
    expect(n.rows[0].n).toBeGreaterThan(0);
  });
});

describe('exclusão de conta', () => {
  it('exige senha e a palavra EXCLUIR; apaga dados e sessões da conta, não os de outras', async () => {
    const a = await signup(env);
    const b = await signup(env);
    const push = (c: Client, acc: { id: string }) =>
      c.post('/api/v1/sync/push', { protocol: 'irontrack.sync.v1', deviceId: crypto.randomUUID(), accountId: acc.id, ops: [{ opId: crypto.randomUUID(), collection: 'bodyEntries', entityId: 'b1', kind: 'put', baseVersion: 0, doc: { id: 'b1', date: '2026-10-01', weightKg: 80, createdAt: 1 } }] });
    await push(a.client, a.account);
    await push(b.client, b.account);
    expect((await a.client.post('/api/v1/me/delete', { password: STRONG, confirm: 'apagar' })).status).toBe(422);
    expect((await a.client.post('/api/v1/me/delete', { password: 'errada-123456', confirm: 'EXCLUIR' })).status).toBe(401);
    const r = await a.client.post('/api/v1/me/delete', { password: STRONG, confirm: 'EXCLUIR' });
    expect(r.status).toBe(200);
    expect((await a.client.get('/api/v1/me')).status).toBe(401);
    for (const t of ['users', 'auth_sessions', 'body_measurements', 'email_verification_tokens'])
      expect((await env.pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = $1`, [a.account.id])).rows[0].n).toBe(0);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM body_measurements WHERE user_id = $1', [b.account.id])).rows[0].n).toBe(1);
  });
});

describe('e-mail não configurado', () => {
  it('recuperação e reenvio respondem indisponível (nada é simulado); cadastro funciona', async () => {
    const off = await setupApi({ EMAIL_PROVIDER: 'disabled' });
    try {
      const c = new Client(off);
      const s = await c.post('/api/v1/auth/signup', { name: 'Sem Email', email: uniqueEmail(), password: STRONG, acceptTerms: true });
      expect(s.status).toBe(201);
      expect(s.body.verificationEmail).toBe('unavailable');
      expect(s.body.features.email).toBe(false);
      const f = await c.post('/api/v1/auth/password/forgot', { email: uniqueEmail() });
      expect(f.status).toBe(503);
      expect(f.body.error.code).toBe('email_not_configured');
      expect((await c.post('/api/v1/auth/verify-email/resend')).body.error.code).toBe('email_not_configured');
      expect((await c.get('/api/v1/__test__/mailbox?to=x')).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});
