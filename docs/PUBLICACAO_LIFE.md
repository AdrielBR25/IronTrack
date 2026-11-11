# Publicação do IronTrack Life — checklist (Fase 07)

Vale para levar as Fases 00–07 da branch `feature/irontrack-life-f07-homologation` para o ambiente `production` da
Railway (hoje na branch `feature/irontrack-2-p21-fullstack-cloud`, só com a migração 0001).
**Nada aqui é automático.** Staging nunca é promovido sozinho; cada passo de produção precisa da decisão do Adriel.
O GitHub Pages continua no ar como está (não desligar).

## 1. Pré-requisitos (bloqueiam a publicação)

- ☐ Homologação feita no ambiente `staging` (`docs/STAGING_RAILWAY.md` §5–§7) com todos os itens ok.
- ☐ OpenAI validada com chamada real (conversa, ação aprovada e desfeita, foto) — com autorização de gasto.
- ☐ Resend com **domínio verificado** e e-mail de confirmação/recuperação chegando de verdade.
- ☐ `AI_REQUIRE_VERIFIED_EMAIL` **sem** `false` em produção.
- ☐ Janela de publicação num horário de pouco uso; você com o celular à mão para testar.

## 2. Backup antes da atualização

1. Railway → ambiente `production` → `Postgres` → Backups → **Create Backup** (manual). Anotar data/hora.
2. Backup lógico, numa máquina sua (a URL só no terminal, nunca em arquivo versionado):
   ```bash
   railway environment production && railway status          # confira: production
   railway connect Postgres                                     # túnel temporário; copie a URL mostrada
   pg_dump --format=custom --no-owner --no-privileges --file=irontrack-prod-AAAAMMDD-HHMM.dump "<URL do túnel>"
   pg_restore --list irontrack-prod-AAAAMMDD-HHMM.dump | head  # o arquivo abre
   ```
   Guardar o `.dump` cifrado, fora do repositório.
3. **Prova de restauração** (banco descartável local, nunca na Railway de produção):
   ```bash
   createdb irontrack_restore_teste
   pg_restore --no-owner --no-privileges --exit-on-error -d irontrack_restore_teste irontrack-prod-AAAAMMDD-HHMM.dump
   DATABASE_URL=postgres://…/irontrack_restore_teste node services/api/scripts/migrate.ts --status   # "pendentes: 0002 … 0008"
   psql irontrack_restore_teste -c "select count(*) from users; select count(*) from workout_sessions;"
   dropdb irontrack_restore_teste
   ```
   Se quiser ensaiar a migração com os dados reais, faça-o **neste banco local**, nunca no staging da Railway
   (dados pessoais não vão para o staging).

## 3. Verificação das variáveis (`irontrack-api`, ambiente production)

- ☐ `DATABASE_URL=${{Postgres.DATABASE_URL}}` (referência).
- ☐ `APP_ENV` ausente ou `production`. **Nunca** `staging`.
- ☐ `APP_ORIGIN` = domínio público de produção.
- ☐ `OPENAI_API_KEY` (projeto de produção na OpenAI, com orçamento mensal e alerta).
- ☐ `EMAIL_PROVIDER=resend`, `EMAIL_FROM` do domínio verificado, `RESEND_API_KEY`. Sem `EMAIL_ALLOWLIST`.
- ☐ Sem `AI_REQUIRE_VERIFIED_EMAIL=false`, sem `API_TEST_MODE`, sem `COOKIE_SECURE=false`.
- ☐ `irontrack-web` de produção **sem** `VITE_APP_ENV`.

## 4. Migrações pendentes

- Produção tem só `0001_init.sql`. Serão aplicadas `0002_assistant` → `0008_integration`, todas **aditivas**
  (tabelas/colunas novas e `CHECK` ampliado; nenhuma remove ou reescreve dado).
- Rodam no pre-deploy do `irontrack-api`, numa transação por arquivo, com trava (dois deploys não colidem) e
  checksum. Falhou uma, nada dela é aplicado e a versão nova não entra no ar (a antiga continua atendendo).
- Ensaio local feito (Fase 07, `scripts/homologacao/upgrade-check.sh`): contas criadas pelo **código de produção**,
  depois 0002–0008, depois reexecução, depois restauração — 19/19 verificações (ver relatório).

## 5. Atualização do frontend e da API

1. Abrir PR de `feature/irontrack-life-f07-homologation` → `feature/irontrack-2-p21-fullstack-cloud` (ou trocar a
   branch dos serviços de produção para a nova branch). **Decisão sua**; não é feito automaticamente.
2. Implantar **primeiro a API** (pre-deploy aplica as migrações; healthcheck `/api/v1/ready`).
3. Depois o `irontrack-web`.
4. Log da API: `aplicadas: 0002_assistant.sql, …, 0008_integration.sql`, `ambiente: production`, `e-mail: resend`.

## 6. Saúde dos serviços

- ☐ `https://<prod>/healthz` → `ok`
- ☐ `https://<prod>/api/v1/ready` → `{"status":"ready"}`
- ☐ `https://<prod>/api/v1/health` → `{"status":"ok","environment":"production"}`
- ☐ Sem faixa "Homologação" no app.

## 7. Testes de fumaça em produção (com a sua conta)

- ☐ **Login** com a conta existente; dados antigos aparecem (Mais → Treinar hoje, Histórico).
- ☐ **Sincronização**: registrar uma série no celular → aparece no outro aparelho após "Sincronizar agora".
- ☐ **E-mail**: "Esqueci minha senha" chega (pode cancelar sem trocar).
- ☐ **IA**: Testar conexão e modelos → disponível; uma pergunta curta respondida.
- ☐ Início, Minha Semana, Alimentação, Conhecimento, Bíblia abrem.
- ☐ App instalado (PWA) mostra "Nova versão disponível" → Atualizar → abre com os dados.

## 8. Estratégia de rollback (código × dados)

As migrações 0002–0008 **não são desfeitas** num rollback; o plano é compatível com isso:

| Situação | Ação | Por que funciona |
|---|---|---|
| Bug no app/API, dados ok | Railway → `irontrack-api` e `irontrack-web` → Deployments → versão anterior → **Redeploy** (ou reverter o merge). **Não** restaurar o banco. | Testado: a API de produção antiga sobe sobre o banco já migrado (não tenta desfazer, `/ready` ok), faz login, sincroniza e cadastra. Ela ignora as tabelas novas. |
| Voltar ao código novo depois | Redeploy da versão nova | Migrações já aplicadas são puladas; o que a versão antiga gravou é lido normalmente. Registros Life criados antes do rollback continuam no banco. |
| Migração falhou no deploy | Nada a fazer no banco (transação desfeita); a versão antiga segue no ar. Corrigir e implantar de novo. | Uma migração por transação. |
| Dados corrompidos/perdidos | Restaurar o backup do §2 num **Postgres novo** do ambiente, trocar a referência `DATABASE_URL` da API para ele, Redeploy. Só então decidir sobre o banco antigo (não apagar). | Restauração testada (todas as tabelas idênticas). Perde o que foi gravado depois do backup: avise antes. |

Nunca rodar `DROP`, `TRUNCATE` ou "Reset database" no Postgres de produção.

## 9. Dados do aparelho (IndexedDB) da versão antiga

- O banco local do modo sem conta (`irontrack`) e o de cada conta (`irontrack-acct-<id>`) **não mudam de versão** nas
  Fases 00–07: os módulos Life ficam no servidor. Atualizar ou voltar a versão do app não apaga nem converte nada.
- O PWA usa atualização **com aviso** ("Nova versão disponível"); nada recarrega no meio de um treino. Abas antigas
  que pedirem uma tela que não existe mais recarregam uma vez sozinhas (Fase 07) ou mostram "Recarregar" no lugar da
  tela, sem tela branca.
- O GitHub Pages (modo local) continua igual e no ar; quem usa sem conta não é afetado.
- Orientação para usuários: **não** limpar os dados do site; em caso de dúvida, Ajustes → Backup → Exportar antes.

## 10. Depois

- Acompanhar 24 h os logs (`email_failed`, erros 5xx, `assistant` com `provider_*`) e o gasto na OpenAI.
- Manter o ambiente `staging` para as próximas fases (sempre com `APP_ENV=staging`).
