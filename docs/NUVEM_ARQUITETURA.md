# IronTrack na nuvem — auditoria, arquitetura e plano de migração (Prompt 21)

Este documento foi escrito **antes** de qualquer código que toque dados. Ele registra o que existe hoje, as decisões
de arquitetura da versão com contas e o plano para levar os dados locais ao PostgreSQL sem perder nada.
Implantação passo a passo: [NUVEM_IMPLANTACAO.md](NUVEM_IMPLANTACAO.md). Rotas da API: [NUVEM_API.md](NUVEM_API.md).
Sincronização e conflitos: [NUVEM_SINCRONIZACAO.md](NUVEM_SINCRONIZACAO.md). Segurança: [NUVEM_SEGURANCA.md](NUVEM_SEGURANCA.md).

## 1. Auditoria do estado atual (main `9239bf0`)

| Área | Situação encontrada |
| --- | --- |
| App | React 18 + TS + Vite 6, HashRouter, Tailwind, PWA (`registerType: 'prompt'`), base `/IronTrack/` via `BASE_PATH`. |
| Banco local | Dexie 4, banco `irontrack`, **esquema v6**. 13 tabelas (abaixo). Abertura garante um perfil principal (`ensureDefaultProfile`). |
| Perfis | Exatamente **um** perfil local por navegador (UUID v4). Não existe troca de perfil em tempo de execução. Os registros com dono levam `profileId`; as consultas filtram por `db.currentProfileId`. |
| Backup | JSON versionado, **v8**, migrações v0→v8 puras em `src/lib/backupFormat.ts`; restauração por mesclagem ou substituição com prévia, integridade e trava de concorrência. Fotos vão no backup (data URL). |
| Analytics / desempenho / calendário | Módulos puros que leem o Dexie; nada persistido além das tabelas abaixo. |
| IA | `src/modules/ai` (serviço, registro de provedores, consentimento com prévia, `ContextBuilder`). Transporte único `gatewayTransport.ts`. Provedor remoto = `GatewayAIProvider` com transporte injetável. |
| Gateway | `services/ai-gateway`: `node:http` sem dependências, token Bearer por titular (hash), allowlist de provedor/modelo, limites **em memória** (uma instância), adaptadores OpenAI/Anthropic/Gemini. Nunca implantado. |
| Estado auxiliar | `localStorage`: `irontrack.setTimer.v1`, `irontrack.modelSnapshot.v1`, `irontrack.capabilities.v1`, `irontrack.calendarPrefs.v1`, `irontrack.aiGateway.v1`. Por aparelho, fora do backup. |
| Deploy | `.github/workflows/deploy.yml`: push na main → testes unitários, build, E2E, publica `dist` no `gh-pages`. |
| Testes (linha de base) | 1.294 unitários, 157 do gateway, 94 E2E. |

### 1.1 Tabelas Dexie (v6) e identidade

| Tabela | Chave | Dono | Observação |
| --- | --- | --- | --- |
| `settings` | `'settings'` (único) | implícito | Preferências (unidade, descansos, tema, rotação…). |
| `profiles` | UUID | — | Perfil local (não é conta). |
| `routines` | `id` | `profileId` | Fichas: `workouts[]` → `exercises[]` (`ExerciseTemplate`, ID próprio; `catalogId`/`customExerciseId` só origem). |
| `sessions` | `id` | `profileId` | Treinos: `exercises[]` → `sets[]`; `timing`, `revision`, `revisions[]` (P20, máx. 10). |
| `rotations` | `routineId` | herdado da rotina | Próximo treino da rotação. |
| `overrides` | `[routineId+date]` | herdado | Exceções da agenda antiga. |
| `bodyEntries` | `id` | `profileId` | Medidas corporais (dado sensível). |
| `photos` | `id` | `profileId` | Fotos em data URL (até MBs cada). |
| `goals` | `id` | `profileId` | Metas (`revision`). |
| `planEntries` | `id` | `profileId` | Planejamento semanal (`revision`). |
| `calendarDecisions` | `<perfil>~<conflito>` | `profileId` | Decisões lembradas do calendário. |
| `customExercises` | `cx_…` | `profileId` | Exercícios personalizados (`revision`). |
| `exerciseFavorites` | `<perfil>~<alvo>` | `profileId` | Favoritos da biblioteca. |

Regras de identidade que a nuvem **preserva**: IDs nunca mudam; exercícios nunca são agrupados por nome
(`exerciseKey`, `templateId`, `catalogId`, `customExerciseId` são campos distintos); o catálogo de 110 exercícios é
estático no código e **não** vai para o banco (não há tabela `exercise_catalog_metadata`: seria redundante).

## 2. Arquitetura alvo

```
Navegador (PWA, Netlify)  ──/api/* (mesma origem, proxy Netlify)──►  API Node.js (Railway)  ──►  PostgreSQL (Railway, rede privada)
   IndexedDB = cache + fila                                             └──► OpenAI / Anthropic / Gemini (chaves só no Railway)
```

* **Frontend** continua o mesmo app. Com `VITE_ACCOUNTS=on` (build da Netlify) ganha contas, sincronização e IA da
  conta. Sem a variável (build do GitHub Pages) nada muda: o app segue 100% local.
* **API** nova em `services/api` (Node 22.18+, TypeScript nativo, `node:http`, sem framework). Reutiliza do gateway
  os adaptadores de provedor, o contrato `irontrack.ai-gateway.v1`, a validação de configuração de provedores e a
  lógica de reserva/acerto de cota (extraída para `services/ai-gateway/src/generation.ts`). O gateway continua
  existindo e funcionando sozinho (157 testes intactos); transformá-lo na API misturaria autenticação por token
  compartilhado com sessões de conta e quebraria seu modelo de ameaça "sem dependências".
* **Mesma origem por proxy**: a Netlify encaminha `/api/*` para o domínio do Railway (regra 200 gerada no build a
  partir de `API_PROXY_TARGET`). O navegador só fala com o domínio da Netlify, então o cookie de sessão é *first-party*
  (`SameSite=Lax`, `HttpOnly`, `Secure`, `__Host-`) e não depende de cookies de terceiros — que Safari/iOS e o Chrome
  em modo restrito bloqueiam. Não há CORS com credenciais em produção.
* **Contratos compartilhados** em `shared/` (protocolo de sincronização, coleções sincronizadas, JSON canônico e hash),
  importados pelo app e pela API.

### 2.1 Persistência: SQL versionado + `pg` (sem ORM)

Avaliados Prisma e Drizzle. Escolha: **migrações SQL puras versionadas** (`services/api/migrations/NNNN_*.sql`) aplicadas
por um executor próprio com trava (advisory lock), transação por arquivo e checksum (arquivo aplicado alterado = erro),
mais **consultas parametrizadas** com `pg`. Motivos: o esquema é pequeno e estável, as consultas críticas (fila de
sincronização, cotas, cursores) precisam de SQL explícito (`FOR UPDATE`, `ON CONFLICT`), não há geração de código nem
binário de engine no deploy, e o SQL é auditável no diff. Não existe `db push`: o único caminho de mudança de esquema
é um novo arquivo de migração.

### 2.2 Modelo relacional

Todos os dados privados têm `user_id` com chave estrangeira para `users(id) ON DELETE CASCADE` e chave primária
`(user_id, id)` — o ID do cliente é preservado e o mesmo ID em contas diferentes não colide.

* Conta: `users`, `auth_sessions`, `email_verification_tokens`, `password_reset_tokens`, `rate_limits`.
* Domínio (uma tabela por coleção do app, com colunas tipadas para consulta e **o registro completo em `doc jsonb`**):
  `user_settings`, `routines`, `workout_sessions`, `rotation_states`, `day_overrides`, `body_measurements`, `goals`,
  `plan_entries`, `calendar_decisions`, `custom_exercises`, `exercise_favorites`.
  O `doc` guarda o registro exatamente como o app grava (dezenas de campos opcionais que evoluem a cada fase); as
  colunas tipadas (status, datas, nomes, chaves) são extraídas e validadas no servidor a cada gravação.
* Projeção relacional dos treinos: `workout_exercises` e `workout_sets`, reescritas **na mesma transação** de cada
  gravação de treino (nunca parcial), com FKs em cascata. Servem a consultas, auditoria e integridade (ex.: contagem de
  séries feitas por exercício sem ler JSON) e preservam `exercise_key`, `template_id`, `catalog_id`,
  `custom_exercise_id` separados.
* Sincronização e auditoria: `sync_operations` (idempotência por `op_id`), `record_revisions` (versão anterior
  guardada em resolução de conflito, substituição por importação e exclusão).
* Importação: `import_jobs` + `import_job_items` (área de preparo; a efetivação é uma única transação).
* IA: `ai_usage_daily` (cota por conta e dia, reserva atômica) e `ai_usage_events` (metadados, sem conteúdo).
* `session_revisions`, `routine_exercises`, `exercise_links` e `calendar_exceptions` **não** viraram tabelas próprias:
  as revisões de treino já vivem no registro (P20) e o servidor guarda versões substituídas em `record_revisions`; os
  exercícios da ficha e as exceções (`day_overrides`, `plan_entries` com `scope='date'`) já têm tabela; criar outras
  duplicaria a fonte da verdade.
* Fotos: **não** vão para o PostgreSQL. Ver §5.

### 2.3 Conta × perfil local

* Cada conta tem um `data_profile_id` (UUID v4 gerado no servidor). No aparelho, a conta usa **um banco IndexedDB
  próprio** (`irontrack-acct-<userId>`) cujo perfil principal tem exatamente esse ID — assim os filtros por
  `profileId` que já existem funcionam igual em todos os aparelhos da conta.
* O banco local antigo (`irontrack`) **não é alterado**: nem migração de esquema, nem exclusão. Ele continua acessível
  em "Usar sem conta" e é a origem da importação de perfis locais.
* O servidor **sempre** grava `profileId = data_profile_id` da conta autenticada e exige que os IDs dependentes de
  perfil (`<perfil>~…` em decisões e favoritos) usem esse perfil. O `userId` nunca vem do cliente.
* Trocar de conta no mesmo aparelho troca de banco: os dados da conta anterior não aparecem para a próxima.

## 3. Plano de migração dos dados

1. **Estrutural** (Railway): `node services/api/scripts/migrate.ts` como *pre-deploy command*; só aplica arquivos
   novos; falha = deploy não sobe.
2. **Perfis locais do mesmo domínio** (`Minha conta › Importar dados deste aparelho`): lê o banco `irontrack` em
   transação de leitura, mostra perfil, contagens e prévia, exige confirmação e envia pela mesma rota da importação de
   backup. Nada é associado automaticamente e o banco local nunca é apagado.
3. **GitHub Pages → Netlify** (outra origem, IndexedDB inacessível): exportar backup v8 no site antigo → entrar na
   Netlify → `Importar backup` → validação (parser v0–v8 existente) → prévia → confirmação → envio em lotes para a
   área de preparo → efetivação transacional → leitura de volta com comparação de contagens, IDs e hash canônico de
   cada registro → relatório. Só então "Importação concluída". O site antigo continua no ar.
4. **Idempotência**: registro igual (mesmo ID e mesmo conteúdo canônico) = ignorado; mesmo ID com conteúdo diferente
   = conflito listado e **não** sobrescrito na política padrão (mesclar). Substituir exige escolha explícita e guarda a
   versão anterior em `record_revisions`. Importar o mesmo arquivo de novo não cria nada.
5. **Sincronização** dos aparelhos: depois da importação, cada aparelho baixa os dados pelo cursor do servidor.

## 4. Sincronização (resumo)

PostgreSQL é a fonte dos dados confirmados; o IndexedDB da conta é cache e fila. Cada entidade tem `version`
(servidor) e cada operação tem `op_id`, `device_id`, `entity_id`, `base_version`. O servidor aplica uma operação só se
`base_version` for a versão atual — senão devolve **conflito** com a versão do servidor. O app tenta uma mesclagem de
três vias (base conhecida × local × servidor) que só é automática quando as mudanças não se sobrepõem; caso contrário
a operação fica pendente até a pessoa escolher. Detalhes em [NUVEM_SINCRONIZACAO.md](NUVEM_SINCRONIZACAO.md).

## 5. Fotos de progresso

Fotos ficam **somente no aparelho** nesta fase. Imagens em `jsonb`/`bytea` no PostgreSQL do Railway encareceriam
backups e consultas, e ainda não existe armazenamento privado de objetos configurado. A tela da conta e a de fotos
dizem explicitamente "fotos não sincronizadas — só neste aparelho". Projeto futuro: bucket privado (S3/R2) com URLs
assinadas de curta duração, nunca públicas; tabela `progress_photos` só com metadados.

## 6. O que fica explicitamente pendente de infraestrutura

* Envio de e-mail (verificação e recuperação): implementado com provedor configurável (Resend, por API HTTPS). Sem
  `EMAIL_PROVIDER` configurado as rotas respondem `email_not_configured` e a interface mostra o recurso como
  indisponível; nada é "enviado de mentira".
* IA real: depende das chaves no Railway e de homologação com chamada paga autorizada.
* Backups do PostgreSQL: dependem do plano do Railway; procedimento e verificação de restauração documentados em
  NUVEM_IMPLANTACAO.md §6, não declarados como ativos.
