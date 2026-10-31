# IronTrack inteiro na Railway (Prompt 21.1)

Substitui a combinação Netlify + Railway do Prompt 21. Arquitetura de dados, sincronização e segurança continuam em
[NUVEM_ARQUITETURA.md](NUVEM_ARQUITETURA.md), [NUVEM_SINCRONIZACAO.md](NUVEM_SINCRONIZACAO.md) e
[NUVEM_SEGURANCA.md](NUVEM_SEGURANCA.md); rotas em [NUVEM_API.md](NUVEM_API.md).

> **Estado:** nada foi provisionado. Não existe projeto na Railway criado por esta etapa, nenhuma variável foi
> preenchida, a `main` e o GitHub Pages continuam como estavam. Valores reais (chaves, segredos) vão **só no painel da
> Railway**, nunca no repositório nem num chat.

## 1. Visão geral

Um projeto Railway, um ambiente (`production`), três serviços:

```
navegador ──HTTPS──▶ borda da Railway (TLS) ──▶ irontrack-web (Caddy, único domínio público)
                                                  ├─ /healthz            → "ok" (saúde do próprio web)
                                                  ├─ /api/v1/*           → http://irontrack-api.railway.internal:8080 (rede privada)
                                                  ├─ /api/* (outros)     → 404 JSON (proxy fechado)
                                                  └─ resto               → app React/Vite/PWA (dist), HashRouter
irontrack-api (Node 22, services/api, sem domínio público) ──rede privada──▶ Postgres (sem acesso público)
                                     └──HTTPS──▶ Anthropic (IA) e Resend (e-mail), se configurados
```

- **Uma origem só**: o navegador fala apenas com o domínio do `irontrack-web`. O cookie `__Host-irontrack_session`
  (HttpOnly, Secure, SameSite=Lax) e a proteção CSRF (cabeçalho + `Origin`) funcionam sem CORS.
- **API e banco fora da internet**: só a rede privada da Railway chega a eles.
- **Nada secreto no app**: a imagem do web não recebe variável nenhuma no build além de `VITE_ACCOUNTS=on` e
  `BASE_PATH=/`, fixas no Dockerfile.

## 2. Arquivos

| Arquivo | Para quê |
|---|---|
| `.railway/railway.ts` | Infraestrutura como código (mecanismo atual da Railway): os três serviços, builds, comandos, saúde, variáveis por referência. |
| `services/web/Dockerfile` | Imagem do `irontrack-web`: etapa Node compila o app (`vite build`), etapa final `caddy:2.10.2-alpine` serve `/srv`. Usuário sem privilégios. |
| `services/web/Caddyfile` | App estático, cabeçalhos (CSP etc.), cache, proxy `/api/v1`, limites e tempos. |
| `services/web/entrypoint.sh` | Confere `PORT`, `API_HOST`, `API_PORT` e `TRUSTED_PROXIES` antes de subir o Caddy (falha clara se faltar). |
| `services/api/Dockerfile` | Imagem do `irontrack-api` (inalterada no essencial; agora escuta em `HOST`). |
| `services/web/compose.stack.yml`, `scripts/stack-test.sh`, `e2e-stack/` | Teste de integração dos contêineres (§10). |

`services/api/railway.json`, `netlify.toml` e `scripts/netlify-redirects.mjs` foram removidos: Config as Code
(`railway.json`/`railway.toml`) está depreciado (serviços novos não podem usá-lo; a Railway deixa de ler esses arquivos
em 01/12/2026) e não há mais Netlify.

## 3. Criar o projeto (escolha um caminho)

Os nomes dos serviços importam: as referências usam `irontrack-web`, `irontrack-api` e `Postgres` exatamente assim.

### 3A. Pelo painel (recomendado para a primeira vez)

1. **New Project → Deploy PostgreSQL.** Renomeie o serviço para `Postgres` se vier com outro nome. Em **Backups**,
   ative os automáticos (§8). Não ative "TCP Proxy" (acesso público ao banco).
2. **No mesmo projeto: New → GitHub Repo → `AdrielBR25/IronTrack`.** Renomeie para `irontrack-api`.
   - Settings → Source: **branch** `feature/irontrack-2-p21-fullstack-cloud` (depois da aprovação, `main`); **Root
     Directory vazio** (raiz do repositório: a API usa `shared/` e `services/ai-gateway/src`).
   - Variables: as da §4.1. `RAILWAY_DOCKERFILE_PATH=services/api/Dockerfile` faz a Railway usar esse Dockerfile.
   - Settings → Deploy: **Pre-deploy Command** `node services/api/scripts/migrate.ts`; **Start Command**
     `node services/api/src/main.ts`; **Healthcheck Path** `/api/v1/ready` (timeout 120 s); restart "On Failure".
   - Settings → Networking: **não** gere domínio público. O nome privado aparece como
     `irontrack-api.railway.internal`.
3. **New → GitHub Repo → `AdrielBR25/IronTrack`** de novo. Renomeie para `irontrack-web`.
   - Mesma branch, Root Directory vazio.
   - Variables: as da §4.2, incluindo `RAILWAY_DOCKERFILE_PATH=services/web/Dockerfile`.
   - Settings → Deploy: **Healthcheck Path** `/healthz`. Sem pre-deploy; o início é o da imagem.
   - Settings → Networking → **Generate Domain**. A porta alvo é a `PORT` que a Railway entrega ao serviço (o Caddy
     escuta nela). Este é o único domínio público.
4. Volte ao `irontrack-api` e confira que `APP_ORIGIN` resolve para `https://<domínio do web>` (a referência só tem
   valor depois do passo 3). Faça **Redeploy** da API.

### 3B. Por código (`.railway/railway.ts`)

1. Instale a CLI da Railway (5.42.1 ou mais nova) e entre: `railway login`, depois `railway link` no projeto.
2. Crie antes, no painel, as variáveis marcadas `preserve()` (§4.1): o arquivo não guarda segredos e mantém o que
   estiver lá.
3. `railway config plan` e **leia o plano**. Ele lista o que será criado ou alterado (valores ocultos).
4. `railway config apply`. Depois gere o domínio do `irontrack-web` no painel (passo 3A.3) e rode
   `railway config pull` para comparar o que o painel guardou com o arquivo antes de qualquer novo `apply`.

Cuidados: o arquivo descreve o projeto **inteiro**; um serviço que não esteja nele pode ser apagado num `apply`. Um
serviço não pode ser gerido pelo painel/Config as Code e pelo IaC ao mesmo tempo (`railway config plan` avisa). O
arquivo foi conferido com os tipos do SDK `railway@3.16.0` e por teste (`tests/unit/railway-iac.test.ts`), mas **não**
contra uma conta real: o primeiro `plan` é a validação final.

## 4. Variáveis (sem valores)

### 4.1 `irontrack-api`

| Variável | Valor | Observação |
|---|---|---|
| `NODE_ENV` | `production` | Em produção a API recusa `COOKIE_SECURE=false`, `API_TEST_MODE`, origem sem HTTPS e provedor de IA sem HTTPS. |
| `HOST` | `::` | Rede privada IPv4 e IPv6 (ambientes antigos da Railway só têm IPv6). Sem IPv6 no contêiner, a API cai sozinha para `0.0.0.0`. |
| `PORT` | `8080` | Escolhida por nós e repassada ao web por referência. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Referência privada. Nunca copie o valor. |
| `APP_ORIGIN` | `https://${{irontrack-web.RAILWAY_PUBLIC_DOMAIN}}` | Links dos e-mails, CSRF. Com domínio próprio, troque por ele ou use `ALLOWED_ORIGINS`. |
| `TRUST_PROXY_HOPS` | `2` | Borda da Railway + Caddy (§6). |
| `RATE_LIMIT_SECRET` | 32+ caracteres aleatórios | Ex.: `openssl rand -base64 48`, no seu computador. Marque como "sealed". |
| `RAILWAY_DOCKERFILE_PATH` | `services/api/Dockerfile` | Só no caminho do painel (3A); o IaC usa `dockerfilePath`. |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `RESEND_API_KEY` | `resend`, remetente do domínio verificado, chave | Opcional. Sem e-mail: confirmação, recuperação de senha e (por padrão) IA ficam indisponíveis. |
| `ANTHROPIC_API_KEY` | chave | Opcional. Sem chave a IA aparece indisponível. |

Opcionais sem mudança desde o Prompt 21: `ALLOWED_ORIGINS`, `ALLOWED_ORIGIN_PATTERN`, `DATABASE_POOL_MAX`,
`SESSION_TTL_DAYS`, `SESSION_IDLE_DAYS`, `SIGNUP_ENABLED`, `AI_REQUIRE_VERIFIED_EMAIL`, cotas de IA, `AI_CONFIG_JSON`,
`REQUEST_TIMEOUT_MS`, `MAX_BODY_BYTES`, `ACCESS_LOG`, `SHUTDOWN_GRACE_MS` (lista comentada em `services/api/.env.example`).
Nunca defina `API_TEST_MODE` nem `EMAIL_PROVIDER=test-mailbox`.

### 4.2 `irontrack-web`

| Variável | Valor | Observação |
|---|---|---|
| `API_HOST` | `${{irontrack-api.RAILWAY_PRIVATE_DOMAIN}}` | Nome privado real da API, dado pela Railway. |
| `API_PORT` | `${{irontrack-api.PORT}}` | A porta da API (8080), por referência. |
| `RAILWAY_DOCKERFILE_PATH` | `services/web/Dockerfile` | Só no caminho do painel. |
| `TRUSTED_PROXIES` | (vazio) | Opcional. Padrão `0.0.0.0/0 ::/0` (§6). |
| `PORT` | — | Definida pela Railway. |

## 5. Proxy `/api/v1` (Caddy)

- Só `/api/v1/*` vai para `{$API_HOST}:{$API_PORT}`. O destino vem das variáveis, conferidas no início (só nome de
  host e número de porta). Não há roteamento por `Host`, URL absoluta ou parâmetro: não é um proxy aberto. Outros
  `/api/*` recebem 404 JSON.
- Método, corpo, cookies, `Origin` e o cabeçalho CSRF passam como vieram; `Set-Cookie` da API volta ao navegador.
  O Caddy não lê nem registra tokens: o log de acesso é JSON **sem cabeçalhos** e sem o parâmetro `token`.
- Limites: corpo até 5 MB (a API aceita 4 MB), conexão com a API em até 5 s, resposta da API em até 70 s (a API
  encerra pedidos em 30 s e a IA em 30 s). Sem nova tentativa automática (um POST de sincronização não é repetido).
- App estático: CSP só da própria origem (scripts sem `unsafe-inline`), HSTS, `nosniff`, `DENY`, `no-referrer`,
  `Permissions-Policy`, COOP. `index.html`, `sw.js`, `registerSW.js` e o manifesto com `no-cache`; `/assets/*` com cache
  de um ano e **404 real** quando o arquivo não existe. Caminho desconhecido fora de `/assets` devolve o app.
- Encerramento gracioso de 10 s; `/healthz` fora do log.

## 6. IP do cliente e `TRUST_PROXY_HOPS`

O valor anterior (2) foi revisto para o caminho novo, não herdado. A API toma o IP do cliente como o N-ésimo a partir da
direita no `X-Forwarded-For`.

1. A borda da Railway escreve o IP do cliente no `X-Forwarded-For` (um moderador da Railway afirma que ela sobrescreve o
   cabeçalho; não há documento oficial com garantia).
2. O Caddy confia nos proxies de `TRUSTED_PROXIES` e **acrescenta** o IP de quem o chamou (a borda). Padrão:
   `0.0.0.0/0 ::/0`, como no guia de Caddy da própria Railway, porque a única entrada pública do serviço é a borda e a
   Railway não publica faixas estáveis dos proxies dela.
3. A API recebe `…, <cliente>, <borda>` e, com `TRUST_PROXY_HOPS=2`, usa `<cliente>`. Se a borda sobrescrever, a lista é
   `<cliente>, <borda>`; se acrescentar, `<forjado>, <cliente>, <borda>`. Nos dois casos o resultado é o cliente real.

Comprovado localmente com os contêineres (`e2e-stack`, teste "IP do cliente"): um IP forjado à esquerda não escapa do
limite e IPs diferentes têm limites separados. **Falta conferir com a borda real** (checklist §11, item 6).

## 7. Migrações e saúde

- Migrações SQL versionadas (`services/api/migrations`) rodam no **pre-deploy** do `irontrack-api`, que a Railway executa
  dentro da rede privada com as variáveis do serviço. Falhou, a versão nova não entra no ar. Sem `db push`.
- `irontrack-api`: `/api/v1/ready` só responde 200 com o banco acessível e nenhuma migração pendente.
- `irontrack-web`: `/healthz` responde "ok" sem depender da API (o app abre e funciona offline mesmo com a API fora).
- Para ver o estado das migrações: `railway run --service irontrack-api node services/api/scripts/migrate.ts --status`.

## 8. Backups e restauração

- **Automáticos**: Railway → Postgres → Backups (diários). Primeira linha de defesa.
- **Lógicos semanais**: `pg_dump --format=custom --no-owner` a partir de uma máquina confiável. O banco não tem acesso
  público; use `railway connect Postgres` (túnel temporário da CLI) e digite a URL só no terminal. Guarde cifrado,
  fora do repositório; mantenha 4 semanais e 3 mensais.
- **Prova mensal**: restaurar num banco descartável, `migrate.ts --status` apontando para ele e comparar contagens.
- **Antes de cada migração nova**: backup manual pelo painel.

## 9. Logs, rollback e custos

- **Logs**: cada serviço em Railway → serviço → Deployments → Logs. API: JSON só com metadados (nunca senha, token,
  cookie, e-mail ou URL do banco). Web: JSON do Caddy sem cabeçalhos. Postgres: logs do próprio banco.
- **Rollback**: Deployments → versão anterior → Redeploy, por serviço. Migrações são só aditivas, então uma API anterior
  funciona no esquema novo. Dados: restaurar backup num banco novo e apontar `DATABASE_URL` para ele.
- **Custos** (estimativa; conferir em railway.com/pricing): cobrança por uso de CPU, memória, volume e tráfego de saída.
  Três serviços pequenos (Caddy usa pouca memória) ficam na faixa do plano Hobby; o banco cresce com o histórico
  (um treino ~5–20 KB). A IA é cobrada por token no provedor, limitada pelas cotas por conta. Resend tem plano gratuito
  com limite mensal.

## 10. Testes

| Comando | O que prova |
|---|---|
| `npm test` | Unitários, incluindo `.railway/railway.ts` e o Caddyfile. |
| `TEST_DATABASE_URL=… npm run test:api` | API em PostgreSQL real. |
| `TEST_DATABASE_URL=… npx playwright test -c playwright.cloud.config.ts` | 38 cenários E2E com o app no vite preview. |
| `E2E_WEB_IMAGE=irontrack-web:stack TEST_DATABASE_URL=… npx playwright test -c playwright.cloud.config.ts` | Os mesmos 38 com o app servido pelo **contêiner de produção do web** (Caddy + proxy). |
| `./scripts/stack-test.sh` | Constrói as duas imagens de produção, sobe Postgres + API + Caddy (`services/web/compose.stack.yml`, os nomes `api`/`db` fazem o papel dos nomes privados) e roda `e2e-stack/`: saúde, cabeçalhos e cache, proxy fechado, corpo grande, cadastro, cookie, CSRF, sair, recuperação de senha, IP do cliente, dois navegadores, HashRouter, PWA offline e humanoide 3D sob a CSP real. |

`TEST_DATABASE_URL` aponta para um PostgreSQL **de teste** com permissão de `CREATE DATABASE` (ex.: um contêiner local);
cada execução cria e apaga o próprio banco, e os scripts recusam endereços da Railway. **Nunca rode testes contra o
banco de produção.** O CI (`.github/workflows/cloud.yml`) roda tudo isso com bancos descartáveis, sem publicar nada.

## 11. Primeira implantação e homologação

1. Criar o projeto (§3), preencher variáveis (§4) e esperar os três serviços ficarem verdes.
2. `https://<web>/healthz` → `ok`; `https://<web>/api/v1/ready` → `{"status":"ready"}`.
3. Abrir `https://<web>`: tela "Bem-vindo ao IronTrack"; "Usar sem conta" funciona como antes.
4. Criar conta; o indicador chega a "Sincronizado"; DevTools → Cookies: `__Host-irontrack_session` HttpOnly e Secure.
5. Com Resend: chegam a confirmação de e-mail e o link de nova senha. Sem: as telas dizem "indisponível".
6. **IP do cliente**: errar a senha de contas inexistentes mais de 30 vezes em 15 minutos pelo 4G deve bloquear só
   aquela rede; outro aparelho (outra rede) continua entrando. Se todos ficarem bloqueados juntos, o hop está errado
   (a API está vendo o IP da borda): ajuste `TRUST_PROXY_HOPS`. Teste também mandar um `X-Forwarded-For` inventado
   com `curl`: o bloqueio deve continuar.
7. Segundo aparelho: entrar, ver a mesma ficha; editar o mesmo campo nos dois e ver o conflito explícito.
8. Offline: modo avião com o app aberto, registrar uma série, voltar e ver "Sincronizado".
9. IA (com chave): "IA real pela conta" responde. Homologação com o provedor real continua pendente.
10. Exportar meus dados → arquivo v8 abre no app sem conta. Backup do GitHub Pages importa na conta.
11. Humanoide 3D da biblioteca aparece; atualizar o app (novo deploy) mostra o aviso de nova versão do PWA.

O GitHub Pages **continua no ar** como está. Não desligue nem apague o site antigo.
