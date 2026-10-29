import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { checkCsrf, clientIp } from '../src/http/core.ts';
import { deviceLabel } from '../src/modules/auth.ts';

const BASE = {
  DATABASE_URL: 'postgresql://u:senha-super-secreta@postgres.railway.internal:5432/railway',
  APP_ORIGIN: 'https://irontrack.netlify.app',
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

describe('configuração da API', () => {
  it('produção válida: rede privada do Railway sem TLS, cookie __Host- Secure, e-mail desligado', () => {
    const c = loadConfig(BASE);
    expect(c.dbSsl).toBe('disable');
    expect(c.cookieName).toBe('__Host-irontrack_session');
    expect(c.cookieSecure).toBe(true);
    expect(c.email.provider).toBe('disabled');
    expect(c.allowedOrigins).toEqual(['https://irontrack.netlify.app']);
    expect(c.ai.config?.providers.anthropic?.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
  });

  it('URL pública (proxy TCP) exige TLS por padrão', () => {
    expect(loadConfig({ ...BASE, DATABASE_URL: 'postgresql://u:p@trolley.proxy.rlwy.net:12345/railway' }).dbSsl).toBe('require');
  });

  it('recusa configurações perigosas em produção, sem expor valores', () => {
    const p = problems({ ...BASE, API_TEST_MODE: '1', COOKIE_SECURE: 'false', RATE_LIMIT_SECRET: 'curto', APP_ORIGIN: 'http://site.com', ALLOWED_ORIGINS: '*' });
    expect(p.join('|')).toMatch(/API_TEST_MODE/);
    expect(p.join('|')).toMatch(/COOKIE_SECURE/);
    expect(p.join('|')).toMatch(/RATE_LIMIT_SECRET/);
    expect(p.join('|')).toMatch(/APP_ORIGIN/);
    expect(p.join('|')).toMatch(/ALLOWED_ORIGINS/);
    expect(p.join('|')).not.toContain('senha-super-secreta');
    expect(problems({ ...BASE, EMAIL_PROVIDER: 'resend' }).join('|')).toMatch(/RESEND_API_KEY/);
    expect(problems({ ...BASE, EMAIL_PROVIDER: 'test-mailbox' }).join('|')).toMatch(/test-mailbox/);
    expect(problems({ ...BASE, ALLOWED_ORIGIN_PATTERN: '.*' }).join('|')).toMatch(/ALLOWED_ORIGIN_PATTERN/);
    expect(problems({ ...BASE, DATABASE_URL: '' }).join('|')).toMatch(/DATABASE_URL/);
  });

  it('padrão de origem de pré-visualização ancorado', () => {
    const c = loadConfig({ ...BASE, ALLOWED_ORIGIN_PATTERN: '^https://deploy-preview-\\d+--irontrack\\.netlify\\.app$' });
    expect(c.allowedOriginPattern!.test('https://deploy-preview-12--irontrack.netlify.app')).toBe(true);
    expect(c.allowedOriginPattern!.test('https://deploy-preview-12--irontrack.netlify.app.evil.com')).toBe(false);
  });

  it('IP do cliente com N proxies confiáveis ignora valores forjados à esquerda', () => {
    const req = (xff: string) => ({ headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.1' } }) as never;
    expect(clientIp(req('1.1.1.1, 2.2.2.2, 3.3.3.3'), 1)).toBe('3.3.3.3');
    expect(clientIp(req('forjado, 2.2.2.2, 3.3.3.3'), 2)).toBe('2.2.2.2');
    expect(clientIp(req(''), 0)).toBe('10.0.0.1');
  });

  it('CSRF: cabeçalho próprio + origem permitida; Origin null ou cross-site bloqueados', () => {
    const cfg = { allowedOrigins: ['https://a.app'], allowedOriginPattern: null };
    const req = (h: Record<string, string>) => ({ headers: h }) as never;
    expect(checkCsrf(cfg, req({ 'x-irontrack-csrf': '1', origin: 'https://a.app', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(checkCsrf(cfg, req({ 'x-irontrack-csrf': '1' }))).toBe(true);
    expect(checkCsrf(cfg, req({ origin: 'https://a.app' }))).toBe(false);
    expect(checkCsrf(cfg, req({ 'x-irontrack-csrf': '1', origin: 'null' }))).toBe(false);
    expect(checkCsrf(cfg, req({ 'x-irontrack-csrf': '1', 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('rótulo do aparelho sem guardar o user-agent inteiro', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome · Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS');
    expect(deviceLabel(undefined)).toBe('Navegador · Outro sistema');
  });
});
