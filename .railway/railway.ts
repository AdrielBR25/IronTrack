// Infraestrutura do IronTrack na Railway (Prompt 21.1): um projeto, três serviços.
//   irontrack-web  → Caddy: app React/Vite/PWA + proxy /api/v1 para a API pela rede privada (único domínio público)
//   irontrack-api  → Node/TypeScript (services/api), sem domínio público
//   Postgres       → PostgreSQL da Railway, só na rede privada
// Mecanismo atual da Railway (Infrastructure as Code; railway.json/railway.toml estão depreciados). Aplicar com
// `railway config plan` (revisar) e `railway config apply`. Passo a passo e alternativa pelo painel: docs/RAILWAY_FULLSTACK.md.
//
// Nenhum segredo aqui: valores sensíveis usam preserve() (ficam como estão no painel, nunca no repositório).
import { defineRailway, github, postgres, preserve, project, service } from 'railway/iac';

export const REPO = 'AdrielBR25/IronTrack';
// Branch implantada. Depois da aprovação e do merge, troque para "main".
export const BRANCH = 'feature/irontrack-2-p21-fullstack-cloud';
// Porta interna da API, escolhida aqui e repassada ao irontrack-web por referência (${{irontrack-api.PORT}}).
export const API_INTERNAL_PORT = '8080';

export default defineRailway(() => {
  const db = postgres('Postgres');

  const api = service('irontrack-api', {
    source: github(REPO, { branch: BRANCH }),
    // Contexto de build = raiz do repositório (a API usa shared/ e o adaptador de IA de services/ai-gateway).
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'services/api/Dockerfile',
      watchPatterns: ['services/api/**', 'services/ai-gateway/src/**', 'shared/**', 'package.json', 'package-lock.json'],
    },
    // Migrações SQL versionadas antes de a versão nova entrar no ar (falha = a versão antiga continua).
    preDeploy: 'node services/api/scripts/migrate.ts',
    start: 'node services/api/src/main.ts',
    // Só responde 200 com o banco acessível e sem migração pendente.
    healthcheck: '/api/v1/ready',
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5, drainingSeconds: 15 },
    env: {
      NODE_ENV: 'production',
      // "::" aceita IPv4 e IPv6 (ambientes antigos da Railway só têm IPv6 na rede privada).
      HOST: '::',
      PORT: API_INTERNAL_PORT,
      // Referência privada ao banco: a URL nunca aparece no código nem no app.
      DATABASE_URL: db.env.DATABASE_URL,
      // Origem pública do app = domínio do irontrack-web (sintaxe de referência da Railway, resolvida no painel).
      APP_ORIGIN: 'https://${{irontrack-web.RAILWAY_PUBLIC_DOMAIN}}',
      // Borda da Railway + Caddy do irontrack-web: o IP do cliente é o penúltimo do X-Forwarded-For.
      TRUST_PROXY_HOPS: '2',
      EMAIL_PROVIDER: preserve(),
      EMAIL_FROM: preserve(),
      RESEND_API_KEY: preserve(),
      RATE_LIMIT_SECRET: preserve(),
      ANTHROPIC_API_KEY: preserve(),
    },
  });

  const web = service('irontrack-web', {
    source: github(REPO, { branch: BRANCH }),
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'services/web/Dockerfile',
      watchPatterns: ['src/**', 'public/**', 'shared/**', 'index.html', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js', 'services/web/**', 'package.json', 'package-lock.json'],
    },
    healthcheck: '/healthz',
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 5, drainingSeconds: 15 },
    env: {
      // Destino do proxy /api/v1: nome privado real e porta da API, por referência (nada inventado).
      API_HOST: api.env.RAILWAY_PRIVATE_DOMAIN,
      API_PORT: api.env.PORT,
    },
  });

  return project('IronTrack', { resources: [web, api, db] });
});
