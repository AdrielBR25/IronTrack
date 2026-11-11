# Homologação (staging) na Railway — IronTrack Life (Fase 07)

Ambiente **`staging`** no MESMO projeto da Railway, separado do ambiente `production`, com três serviços próprios:
`irontrack-web`, `irontrack-api` e um `Postgres` **exclusivo** (volume próprio, sem nenhum dado de produção).
Branch: `feature/irontrack-life-f07-homologation`.

> Nada disto foi executado por mim na Railway: não há acesso autorizado ao painel nesta sessão. Os passos abaixo são
> para você seguir. O que foi testado localmente está em `docs/PUBLICACAO_LIFE.md` §1.

## 0. Como a separação é garantida

| Risco | Proteção |
|---|---|
| API do staging usar o banco de produção | `DATABASE_URL=${{Postgres.DATABASE_URL}}` (referência resolve **dentro** do ambiente). Além disso, com `APP_ENV=staging` a API e as migrações **recusam** qualquer banco que já tenha migrações e não tenha a marca `staging` (o banco de produção de hoje). Um banco vazio recebe a marca na primeira migração. Teste: `services/api/tests/staging.test.ts`. |
| Produção usar o banco do staging | Com `APP_ENV=production` (padrão) a API recusa um banco marcado `staging`. Produção nunca grava marca. |
| Frontend do staging falar com a API de produção | O app chama só a própria origem (`/api/v1`); o Caddy repassa para `API_HOST`, que é a referência `${{irontrack-api.RAILWAY_PRIVATE_DOMAIN}}` **do mesmo ambiente**. A rede privada de um ambiente não enxerga a do outro. |
| E-mail real para pessoas | `APP_ENV=staging` + Resend **exige** `EMAIL_ALLOWLIST`; quem não estiver na lista não recebe nada (evento `email_suppressed` no log, sem endereço). Assunto com `[Homologação]`. |
| Confundir staging com produção | `VITE_APP_ENV=staging` no web: faixa amarela "Homologação" em todas as telas, título da aba `[Homologação]`, app instalado como "IronTrack (Homologação)". `/api/v1/health` responde `"environment":"staging"`. |
| Migração no banco errado | O pre-deploy (`migrate.ts`) roda com as variáveis do serviço do ambiente; a marca de ambiente é conferida **antes** de aplicar qualquer migração. |

## 1. Criar o ambiente

1. Railway → projeto do IronTrack → seletor de ambiente (topo) → **New Environment** → nome **`staging`**.
   - Recomendado: **Duplicate Environment** a partir de `production` (copia serviços, configurações e variáveis; o
     Postgres do novo ambiente é um serviço novo com volume vazio).
   - A Railway mostra as mudanças como pendentes. **Não clique em Deploy ainda**: ajuste os passos 2–4 primeiro.
2. Confira que no ambiente `staging` existem `irontrack-web`, `irontrack-api` e `Postgres`. Se o Postgres não vier,
   **New → Database → PostgreSQL** dentro do ambiente `staging` e renomeie para `Postgres`.
3. Em cada serviço de código (`irontrack-api` e `irontrack-web`) do ambiente `staging`: Settings → Source → **Branch**
   `feature/irontrack-life-f07-homologation`. Root Directory vazio. Desligue "PR Environments" se estiver ligado.
4. Postgres do staging: Settings → **não** ative TCP Proxy. Backups automáticos podem ficar desligados (dados de teste).

## 2. Variáveis — `irontrack-api` (ambiente staging)

Confira **uma a uma**. Uma variável com valor colado à mão (em vez de referência) é copiada igual da produção.

| Variável | Valor no staging | Por quê |
|---|---|---|
| `APP_ENV` | `staging` | **Nova.** Liga a proteção do banco, a lista de e-mail e a identificação. |
| `NODE_ENV` | `production` | Mesmo build/segurança da produção (cookie `__Host-`, HTTPS obrigatório). |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | **Referência**, nunca um valor colado. Se aparecer um texto `postgresql://…` fixo, apague e use a referência. |
| `APP_ORIGIN` | `https://${{irontrack-web.RAILWAY_PUBLIC_DOMAIN}}` | Resolve para o domínio do web **do staging** (links dos e-mails, CSRF). |
| `HOST` / `PORT` | `::` / `8080` | Iguais à produção. |
| `TRUST_PROXY_HOPS` | `2` | Igual. |
| `RATE_LIMIT_SECRET` | **novo** valor (`openssl rand -base64 48`) | Não reaproveite o da produção. |
| `EMAIL_PROVIDER` | `resend` (ou `disabled`) | Ver §4. |
| `EMAIL_FROM` | `IronTrack Homologação <onboarding@resend.dev>` enquanto não houver domínio verificado | Ver §4. |
| `RESEND_API_KEY` | chave do Resend (pode ser uma chave só para testes) | Só na API. |
| `EMAIL_ALLOWLIST` | **Nova.** seu e-mail (ex.: `voce@gmail.com`), separados por vírgula; `@dominio.com` libera um domínio | Obrigatória com `APP_ENV=staging` + Resend. |
| `OPENAI_API_KEY` | chave da API da OpenAI (de preferência um **projeto separado** "irontrack-staging" com limite de gasto baixo) | Só na API. |
| `AI_REQUIRE_VERIFIED_EMAIL` | **não defina** | Padrão = exige e-mail confirmado (com o Resend funcionando, a confirmação chega). |
| `ANTHROPIC_API_KEY` | não defina (assistente clássico, opcional) | — |
| Nunca | `API_TEST_MODE`, `EMAIL_PROVIDER=test-mailbox`, `COOKIE_SECURE=false` | A API recusa em `NODE_ENV=production`. |

Deploy (Settings): Pre-deploy `node services/api/scripts/migrate.ts`; Start `node services/api/src/main.ts`;
Healthcheck `/api/v1/ready`; `RAILWAY_DOCKERFILE_PATH=services/api/Dockerfile`. Sem domínio público.

## 3. Variáveis — `irontrack-web` (ambiente staging)

| Variável | Valor |
|---|---|
| `VITE_APP_ENV` | `staging` (**nova**; entra no build: faixa "Homologação", título e nome do app instalado) |
| `API_HOST` | `${{irontrack-api.RAILWAY_PRIVATE_DOMAIN}}` |
| `API_PORT` | `${{irontrack-api.PORT}}` |
| `RAILWAY_DOCKERFILE_PATH` | `services/web/Dockerfile` |

Settings → Networking → **Generate Domain** (será algo como `irontrack-web-staging.up.railway.app`). Volte ao
`irontrack-api` e confira que `APP_ORIGIN` mostra esse domínio. Healthcheck `/healthz`.

**Não** defina `VITE_APP_ENV` no ambiente `production`.

## 4. E-mail (Resend)

**Para homologar agora, sem domínio:** o Resend permite enviar de `onboarding@resend.dev` **apenas para o e-mail do
dono da conta Resend**. Use `EMAIL_FROM=IronTrack Homologação <onboarding@resend.dev>` e coloque esse mesmo e-mail em
`EMAIL_ALLOWLIST`. Crie as contas de teste com esse endereço (ou com `seuemail+a@…`/`+b@…` se o seu provedor aceitar
`+` e você incluir cada um na lista).

**Para produção (obrigatório antes de publicar):**
1. Resend → Domains → **Add Domain** (ex.: `mail.seudominio.com.br`; precisa ser um domínio seu).
2. No DNS do domínio, criar os registros que o Resend mostrar (SPF `TXT`, DKIM `TXT`/`CNAME`, e o `MX` de retorno).
   Recomendado: um `TXT _dmarc` com `v=DMARC1; p=none;`.
3. Aguardar o status **Verified** no Resend.
4. Resend → API Keys → criar chave com permissão **Sending access** restrita a esse domínio.
5. Produção: `EMAIL_PROVIDER=resend`, `EMAIL_FROM=IronTrack <nao-responda@mail.seudominio.com.br>`, `RESEND_API_KEY`.
   Sem `EMAIL_ALLOWLIST` (todos recebem). Sem `AI_REQUIRE_VERIFIED_EMAIL=false`.

**Diagnóstico:** falhas aparecem no log da API como `email_failed` com `providerStatus` e `providerError`, sem
destinatário nem chave. `403 validation_error` = remetente/domínio não verificado ou destinatário não permitido pelo
Resend; `401` = chave inválida; `429` = limite do plano. Sem provedor, o log de início diz
`e-mail: disabled (verificação e recuperação de senha INDISPONÍVEIS)` e as telas mostram "O envio de e-mails ainda não
foi configurado neste servidor".

## 5. Implantar e conferir (≈10 min)

1. **Deploy** no ambiente `staging` (os três serviços).
2. Log do `irontrack-api` → pre-deploy deve mostrar `aplicadas: 0001_init.sql, … 0008_integration.sql`. Se mostrar
   `migração falhou: … parece ser o banco de PRODUÇÃO`, a `DATABASE_URL` está errada: corrija para a referência.
3. Log de início da API: `ambiente: staging (homologação; e-mails só para N destinatário(s)…)`, `e-mail: resend`,
   `Assistente: OpenAI — chave em OPENAI_API_KEY configurada; ainda não validada`.
4. `https://<web-staging>/healthz` → `ok`; `https://<web-staging>/api/v1/ready` → `{"status":"ready"}`;
   `https://<web-staging>/api/v1/health` → `{"status":"ok","environment":"staging"}`.
5. Opcional (CLI): `railway environment staging` e `railway run --service irontrack-api node services/api/scripts/migrate.ts --status`
   → `banco marcado como: staging · APP_ENV: staging` e `esquema em dia`. **Confira o ambiente antes** de rodar
   qualquer comando da CLI (`railway status`).

## 6. Roteiro de teste no staging (celular)

1. Abrir o domínio do staging: faixa "Homologação" visível; "Bem-vindo ao IronTrack".
2. Criar conta com o e-mail da allowlist → chega "[Homologação] Confirme seu e-mail" → confirmar.
3. "Esqueci minha senha" com o mesmo e-mail → link chega → trocar a senha → entrar de novo.
4. Criar conta com um e-mail **fora** da lista → nenhum e-mail sai (log: `email_suppressed`).
5. Mais → Treinar hoje → carregar exemplo → iniciar treino → registrar 2 séries → finalizar.
6. Segundo aparelho/navegador: entrar na mesma conta → a ficha e o treino aparecem; editar a mesma coisa nos dois →
   conflito explícito.
7. Modo avião no celular → registrar algo → voltar → "Sincronizado".
8. Início, Minha Semana, Minha Evolução, Alimentação, Conhecimento, Bíblia: abrir cada um (ver também §7 para a IA).
9. Publicar uma nova versão (push na branch) com o app aberto → aviso "Nova versão disponível" → Atualizar.

## 7. OpenAI real — procedimento com a sua autorização

**Grátis (pode fazer já):** Mais → Privacidade e diagnóstico da IA → **Testar conexão e modelos**. Consulta
`GET /v1/models/{id}` para cada modelo; não gera texto nem custa tokens. Esperado: `gpt-6.1-terra`, `gpt-6-luna`,
`gpt-6.1-sol` como disponíveis. Se o padrão (`gpt-6.1-terra`) vier "indisponível", a API passa sozinha a usar o
próximo modelo liberado (Fase 07) e ele some da lista; para fixar outra configuração use `ASSISTANT_CONFIG_JSON`.
Se a análise de foto acusar modelo sem suporte a imagem, defina `ASSISTANT_VISION_MODEL`.

Antes do teste pago: na OpenAI → Settings → Limits, defina um **orçamento mensal baixo** (ex.: US$ 5) e alerta de
e-mail no projeto da chave. Cotas do app por conta: 8 mensagens/min, 100/dia, 400 mil tokens/dia, 20 fotos/dia.

**Pago (só com o seu "pode fazer"), ≈3 chamadas, poucos centavos:**
1. Conversa: no chat da IA, "Como foi minha última semana?". Conferir: a resposta chega aos poucos (streaming), cita
   que consultou seus dados (ferramenta de consulta) e rotula Registrado/Sem dados.
2. Ação aprovada: "Organize minha semana de segunda a sexta com treino às 7h". Conferir: aparece a prévia com etapas;
   desmarcar uma, aprovar; abrir Minha Semana e ver os itens; voltar e **Desfazer**; os itens somem. XP não muda.
3. Foto: Alimentação → Analisar refeição com IA → foto de um prato → revisar itens → confirmar → refeição no diário.
4. Mais → Privacidade da IA → uso do dia mostra as mensagens e tokens. Painel da OpenAI → Usage confere o gasto.

Só depois disso a integração com a OpenAI pode ser declarada validada.
