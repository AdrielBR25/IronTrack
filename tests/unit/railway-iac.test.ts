// Prompt 21.1: a infraestrutura da Railway em código (.railway/railway.ts) e o serviço web (Caddy) conferidos sem
// rede: três serviços, só referências privadas, nenhum segredo no repositório, Dockerfiles e caminhos que existem.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRailwayContext, project } from 'railway/iac';
import program, { API_INTERNAL_PORT, BRANCH, REPO } from '../../.railway/railway';

type Node = {
  name: string;
  type: string;
  source?: { repo?: string; branch?: string };
  build?: { builder?: string; dockerfilePath?: string; watchPatterns?: string[] };
  deploy?: { startCommand?: string; preDeployCommand?: string[]; healthcheckPath?: string };
  variables?: Record<string, { type: string; value?: string; resource?: string; output?: string }>;
  networking?: unknown;
};

async function graph() {
  const def = await program(createRailwayContext({ environmentName: 'production' }), project);
  const nodes = (def.resources ?? []).flat() as unknown as Node[];
  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  return { def, nodes, byName };
}

describe('.railway/railway.ts', () => {
  it('um projeto com irontrack-web, irontrack-api e Postgres', async () => {
    const { def, nodes, byName } = await graph();
    expect(def.name).toBe('IronTrack');
    expect(nodes.map((n) => n.name).sort()).toEqual(['Postgres', 'irontrack-api', 'irontrack-web']);
    expect(byName.Postgres.type).toBe('database');
    for (const s of ['irontrack-web', 'irontrack-api']) {
      expect(byName[s].source).toMatchObject({ repo: REPO, branch: BRANCH });
      expect(byName[s].build?.builder).toBe('DOCKERFILE');
      expect(existsSync(byName[s].build!.dockerfilePath!)).toBe(true);
    }
  });

  it('API: migração antes da implantação, verificação de prontidão, sem domínio público', async () => {
    const api = (await graph()).byName['irontrack-api'];
    expect(api.build?.dockerfilePath).toBe('services/api/Dockerfile');
    expect(api.deploy?.preDeployCommand).toEqual(['node services/api/scripts/migrate.ts']);
    expect(api.deploy?.startCommand).toBe('node services/api/src/main.ts');
    expect(api.deploy?.healthcheckPath).toBe('/api/v1/ready');
    expect(api.networking).toBeUndefined();
    for (const f of ['services/api/scripts/migrate.ts', 'services/api/src/main.ts']) expect(existsSync(f)).toBe(true);
  });

  it('variáveis: banco e destinos por referência; segredos preservados no painel, nunca no arquivo', async () => {
    const { byName } = await graph();
    const api = byName['irontrack-api'].variables!;
    const web = byName['irontrack-web'].variables!;
    expect(api.DATABASE_URL).toEqual({ type: 'reference', resource: 'database.Postgres', output: 'DATABASE_URL' });
    expect(api.APP_ORIGIN).toEqual({ type: 'literal', value: 'https://${{irontrack-web.RAILWAY_PUBLIC_DOMAIN}}' });
    expect(api.PORT).toEqual({ type: 'literal', value: API_INTERNAL_PORT });
    expect(api.HOST).toEqual({ type: 'literal', value: '::' });
    expect(api.TRUST_PROXY_HOPS).toEqual({ type: 'literal', value: '2' });
    expect(api.NODE_ENV).toEqual({ type: 'literal', value: 'production' });
    for (const k of ['RATE_LIMIT_SECRET', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'EMAIL_PROVIDER', 'EMAIL_FROM']) expect(api[k]).toEqual({ type: 'preserve' });
    expect(web.API_HOST).toEqual({ type: 'reference', resource: 'service.irontrack-api', output: 'RAILWAY_PRIVATE_DOMAIN' });
    expect(web.API_PORT).toEqual({ type: 'reference', resource: 'service.irontrack-api', output: 'PORT' });
    // nenhum valor literal com cara de segredo, URL de banco ou modo de teste
    const literals = [...Object.values(api), ...Object.values(web)].filter((v) => v.type === 'literal').map((v) => v.value ?? '');
    for (const v of literals) expect(v).not.toMatch(/postgres(ql)?:\/\/|sk-|re_|test-mailbox|^1$/);
    expect(Object.keys(api)).not.toContain('API_TEST_MODE');
    expect(Object.keys(api)).not.toContain('COOKIE_SECURE');
  });
});

describe('services/web (Caddy)', () => {
  const caddy = readFileSync('services/web/Caddyfile', 'utf8');
  const entry = readFileSync('services/web/entrypoint.sh', 'utf8');
  const docker = readFileSync('services/web/Dockerfile', 'utf8');

  it('proxy só de /api/v1 para o destino fixo das variáveis; sem TLS local; sem admin', () => {
    expect(caddy).toMatch(/handle \/api\/v1\/\* \{[\s\S]*reverse_proxy \{\$API_HOST\}:\{\$API_PORT\}/);
    expect(caddy.match(/reverse_proxy/g)).toHaveLength(1);
    expect(caddy).toContain('auto_https off');
    expect(caddy).toContain('admin off');
    expect(caddy).toContain('max_size 5MB');
    expect(caddy).toContain('response_header_timeout');
    expect(entry).toMatch(/API_HOST[\s\S]*fail/);
  });

  it('Dockerfiles compatíveis com o builder da Railway: nenhum RUN --mount além de cache', () => {
    for (const f of ['services/web/Dockerfile', 'services/api/Dockerfile']) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/--mount=([^\s\\]+)/g)) expect(m[1], f).toMatch(/(^|,)type=cache(,|$)/);
      expect(text, f).not.toMatch(/type=secret|type=ssh|type=bind/);
      expect(text, f).toMatch(/^RUN npm ci /m);
    }
  });

  it('imagem de produção: build com VITE_ACCOUNTS=on em "/", servida pelo Caddy sem root (nunca vite preview)', () => {
    expect(docker).toContain('ENV BASE_PATH=/ VITE_ACCOUNTS=on');
    expect(docker).toContain('FROM caddy:');
    expect(docker).toContain('USER nobody');
    expect(docker).not.toMatch(/vite preview/);
  });
});
