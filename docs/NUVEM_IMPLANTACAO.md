# IronTrack na nuvem: implantação passo a passo (Prompt 21)

Arquitetura e motivos: [NUVEM_ARQUITETURA.md](NUVEM_ARQUITETURA.md). Segurança: [NUVEM_SEGURANCA.md](NUVEM_SEGURANCA.md).

> **Estado em 2026-10-29:** nada disto foi provisionado. Não existe projeto na Railway nem site na Netlify criados por
> esta etapa, nenhuma variável foi preenchida e o GitHub Pages continua igual. Tudo abaixo é feito por quem administra
> as contas (Railway e Netlify), com os valores reais digitados **só nos painéis**, nunca no repositório ou num chat.

Visão geral:

```
navegador ──HTTPS──▶ Netlify (app estático, PWA, CSP)
                        └─ /api/*  (proxy da própria Netlify, mesma origem)
                                └──HTTPS──▶ Railway: serviço "api" (Node 22, services/api)
                                                └─ rede privada ─▶ Railway PostgreSQL
                                                └──HTTPS──▶ Anthropic / OpenAI / Gemini (chaves só aqui)
                                                └──HTTPS──▶ Resend (e-mail, opcional)
```

O navegador só conversa com a origem da Netlify. O cookie de sessão é da origem do app (`__Host-irontrack_session`,
HttpOnly, Secure, SameSite=Lax). Nenhum endereço da Railway, chave ou segredo vai para o bundle.

## 1. Pré-requisitos

- Conta na Railway (plano com PostgreSQL) e na Netlify, ambas com acesso ao repositório `AdrielBR25/IronTrack`.
- Branch a publicar: hoje `feature/irontrack-2-p21-fullstack-cloud` (depois da aprovação, `main`).
- Node 22.18+ só se for rodar algo localmente.

## 2. Railway: banco PostgreSQL

1. Railway → **New Project** → **Deploy PostgreSQL**. Anote o nome do serviço (ex.: `Postgres`).
2. Em **Settings → Backups**, ative os backups automáticos (ver §6).
3. **Não copie a URL do banco para lugar nenhum.** O serviço da API vai referenciá-la por variável (`${{Postgres.DATABASE_URL}}`).

## 3. Railway: serviço da API

1. No mesmo projeto: **New → GitHub Repo** → `AdrielBR25/IronTrack`, branch escolhida.
2. **Settings → Source**: Root Directory = `/` (a API usa `shared/` e `services/ai-gateway/src`).
3. **Settings → Config-as-code**: caminho `services/api/railway.json`. Ele define:
   - build pelo `services/api/Dockerfile` (Node 22.18, só dependências de execução, usuário sem privilégios);
   - **pré-implantação** `node services/api/scripts/migrate.ts` (aplica migrações SQL versionadas, com trava e
     checksum; se falhar, a versão nova não entra no ar);
   - início `node services/api/src/main.ts`;
   - verificação de saúde em `/api/v1/ready` (só responde 200 com o banco acessível e sem migração pendente);
   - `drainingSeconds` para o encerramento gracioso (a API trata SIGTERM e termina as requisições em andamento).
4. **Settings → Networking → Generate Domain** (domínio público HTTPS da API). Esse domínio será o
   `API_PROXY_TARGET` da Netlify (§5). Não é segredo, mas não precisa ficar no repositório.
5. **Variables**: preencha conforme §4.
6. Faça o deploy. Nos logs devem aparecer só nomes, nunca valores: `e-mail: disabled (...)`, `ouvindo na porta ...`.

## 4. Variáveis da API (Railway)

Valores reais só no painel. Modelo sem valores: `services/api/.env.example`.

| Variável | Obrigatória | O que é |
|---|---|---|
| `NODE_ENV` | sim | `production`. Em produção a API recusa `COOKIE_SECURE=false`, `API_TEST_MODE` e provedor de IA sem HTTPS. |
| `DATABASE_URL` | sim | Referência `${{Postgres.DATABASE_URL}}` (rede privada `*.railway.internal`, sem TLS por ser interna). Nunca registrada em log. |
| `DATABASE_SSL` | não | Inferido: `disable` na rede privada, `require` fora dela. `verify-full` + `DATABASE_SSL_CA` se usar o endereço público. |
| `DATABASE_POOL_MAX` | não | Conexões do pool (padrão 10). |
| `APP_ORIGIN` | sim | Origem pública do app na Netlify (ex.: o domínio `*.netlify.app` ou o seu). Usada nos links de e-mail, CORS e CSRF. |
| `ALLOWED_ORIGINS` | não | Outras origens aceitas, separadas por vírgula (ex.: domínio próprio além do `.netlify.app`). |
| `ALLOWED_ORIGIN_PATTERN` | não | Para pré-visualizações da Netlify: expressão ancorada `^https://...$`. Deixe vazio se não usar previews com API. |
| `RATE_LIMIT_SECRET` | sim | 32+ caracteres aleatórios (ex.: `openssl rand -base64 48`). Protege as chaves de limite (IP/e-mail com HMAC). |
| `TRUST_PROXY_HOPS` | sim | Quantos proxies confiáveis acrescentam `X-Forwarded-For`. Com Netlify → Railway, **comece com `2`** e confira (§7, item 6). |
| `SESSION_TTL_DAYS` / `SESSION_IDLE_DAYS` | não | Validade máxima (30) e por inatividade (14) das sessões. |
| `SIGNUP_ENABLED` | não | `false` fecha novos cadastros. |
| `EMAIL_PROVIDER` | não | `disabled` (padrão) ou `resend`. Desligado: cadastro e entrada funcionam, mas confirmação de e-mail e recuperação de senha respondem "indisponível" (nada é simulado). |
| `RESEND_API_KEY`, `EMAIL_FROM` | se `resend` | Chave da Resend e remetente de um domínio verificado nela. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | não | Chaves dos provedores de IA. Sem chave, o provedor aparece "indisponível". OpenAI e Gemini estão desabilitados em `services/api/config/ai.json` até alguém escolher o modelo atual na documentação oficial. |
| `AI_REQUIRE_VERIFIED_EMAIL` | não | `true` (padrão): IA só com e-mail confirmado. |
| `AI_DAILY_TOKENS_PER_USER` / `AI_DAILY_REQUESTS_PER_USER` / `AI_MAX_CONCURRENT_PER_USER` | não | Cotas por conta (20000 / 50 / 1). Persistidas no PostgreSQL. |
| `AI_CONFIG_JSON` / `AI_CONFIG_PATH` | não | Substitui a lista de provedores e modelos (formato do gateway, sem segredos). |
| `REQUEST_TIMEOUT_MS`, `MAX_BODY_BYTES`, `ACCESS_LOG`, `SHUTDOWN_GRACE_MS` | não | Tempo limite (30 s), corpo máximo (4 MB), log de acesso (`off` desliga), espera no encerramento (10 s). |
| `PORT` | — | Definida pela Railway. |

Nunca defina `API_TEST_MODE` nem `EMAIL_PROVIDER=test-mailbox` fora dos testes (a API se recusa a iniciar em produção).

## 5. Netlify: app

1. Netlify → **Add new site → Import from Git** → `AdrielBR25/IronTrack`, branch escolhida.
2. O `netlify.toml` da raiz já define: base `/`, `npm run build && node scripts/netlify-redirects.mjs`, publicação
   `dist`, Node 22.18, `BASE_PATH=/`, `VITE_ACCOUNTS=on`, cabeçalhos de segurança (CSP restrita à própria origem) e
   cache correto do service worker.
3. **Site configuration → Environment variables**: `API_PROXY_TARGET` = domínio HTTPS público da API (§3.4), só a
   origem, sem caminho. O build gera `dist/_redirects` com `/api/*  <origem>/api/:splat  200!` e **falha** se a
   variável faltar ou não for HTTPS.
4. Deploy. Depois, na Railway, ponha a origem da Netlify em `APP_ORIGIN` (e redeploy da API).
5. Domínio próprio (opcional): configure na Netlify e acrescente a origem em `ALLOWED_ORIGINS` (ou troque `APP_ORIGIN`).

O GitHub Pages **continua no ar** com o build sem `VITE_ACCOUNTS` (100% local, como antes). Não desligue nem apague o
site antigo: quem tem dados lá exporta o backup v8 (Ajustes → Exportar backup) e importa na conta (§7, item 9).

## 6. Backups do PostgreSQL e restauração

- **Automáticos**: ative em Railway → Postgres → Backups (diários; retenção conforme o plano). São a primeira linha.
- **Lógicos semanais (recomendado)**: de uma máquina confiável, com a URL pública do banco digitada só no terminal:
  `pg_dump --format=custom --no-owner --file irontrack-AAAA-MM-DD.dump "$URL"`. Guarde cifrado (ex.: `age`/`gpg`) num
  armazenamento privado; retenha 4 semanais + 3 mensais. Nunca no repositório.
- **Prova de restauração (mensal)**: restaure num banco **descartável** (`createdb irontrack_restore_teste` e
  `pg_restore --no-owner -d ... arquivo.dump`), rode `node services/api/scripts/migrate.ts --status` apontando para ele
  (deve listar tudo aplicado) e compare contagens (`SELECT count(*) FROM users`, `workout_sessions`, `routines`). Apague
  o banco de teste em seguida.
- **Antes de cada migração nova**: faça um backup manual pelo painel.
- Exclusão de conta: apaga imediatamente no banco ativo; nos backups some quando eles expiram (ver NUVEM_SEGURANCA.md §6).

## 7. Homologação depois da primeira publicação (checklist)

1. `GET https://<app>/api/v1/health` → `{"status":"ok"}`; `/api/v1/ready` → `{"status":"ready"}`.
2. Abrir o app na Netlify: tela "Bem-vindo ao IronTrack"; "Usar sem conta" funciona como antes.
3. Criar conta; o indicador chega a "Sincronizado"; DevTools → Application → Cookies: `__Host-irontrack_session` HttpOnly/Secure.
4. Com e-mail configurado: chega o link de confirmação; recuperação de senha funciona. Sem e-mail: as telas dizem "indisponível".
5. Segundo aparelho/navegador: entrar, ver a mesma ficha; editar nos dois para ver um conflito explícito.
6. **Limites por IP**: errar a senha 11 vezes do celular (4G) e confirmar "Muitas tentativas" só para aquele e-mail/IP,
   enquanto outro aparelho (outra rede) continua entrando. Se todos ficarem bloqueados juntos, `TRUST_PROXY_HOPS` está
   baixo demais (todos parecem o IP da Netlify); se um IP forjado no cabeçalho escapar do limite, está alto demais.
7. IA: "IA real pela conta" → Conectar com sua conta → só provedores habilitados → pergunta passa pela prévia → resposta. Homologação real dos provedores continua pendente (docs/IA_HOMOLOGACAO.md).
8. Exportar meus dados → arquivo v8 abre no app sem conta (Ajustes → Importar backup).
9. Migração do GitHub Pages: no site antigo, Ajustes → Exportar backup; no novo, Minha conta → Importar dados antigos → arquivo → prévia → confirmar → "Importação concluída e conferida".

## 8. Testes

| Comando | O que roda | Banco |
|---|---|---|
| `npm test` | unitários do app (inclui motor de sincronização com dois aparelhos, importação, IA pela conta, arquitetura) | nenhum |
| `npm run test:gateway` | gateway de IA | nenhum |
| `TEST_DATABASE_URL=... npm run test:api` | integração da API em PostgreSQL **real**: cada arquivo cria e apaga o próprio banco | local/CI |
| `npx playwright test` | E2E do app local (GitHub Pages) | nenhum |
| `TEST_DATABASE_URL=... npx playwright test -c playwright.cloud.config.ts` | E2E da nuvem: build com `VITE_ACCOUNTS=on`, API real, PostgreSQL descartável, e-mail e IA simulados, dois navegadores independentes | local/CI |

`TEST_DATABASE_URL` deve apontar para um PostgreSQL de teste com permissão de `CREATE DATABASE` (ex.:
`postgres://postgres:postgres@127.0.0.1:5432/postgres` num contêiner). Os scripts recusam URLs da Railway. **Nunca rode
testes contra o banco de produção.** No GitHub Actions, `.github/workflows/cloud.yml` sobe um PostgreSQL de serviço.

## 9. Custos (estimativa, conferir nos sites oficiais)

- Railway: cobrança por uso (CPU/memória/volume). API + PostgreSQL pequenos ficam na faixa do plano Hobby; o banco cresce
  com o histórico (um treino ~5–20 KB).
- Netlify: plano gratuito cobre um app estático com proxy; atenção ao limite de banda e de funções (não usamos funções).
- Resend: plano gratuito com limite mensal de e-mails.
- IA: por token, no provedor. As cotas diárias por conta (§4) limitam o gasto.

## 10. Reverter

- App: na Netlify, **Deploys → publicar a versão anterior**. O GitHub Pages segue independente.
- API: Railway → Deployments → **Redeploy** de uma versão anterior. Migrações são só para frente: uma versão antiga da
  API funciona com o esquema novo enquanto as migrações forem aditivas (regra adotada; ver `services/api/migrations`).
- Dados: restaurar backup (§6) num banco novo e apontar `DATABASE_URL` para ele.
