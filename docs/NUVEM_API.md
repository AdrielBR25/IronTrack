# API do IronTrack — `/api/v1` (Prompt 21)

Código: `services/api` (Node 22.18+, `node:http`, `pg`, Zod). Contratos compartilhados com o app em `shared/`.

## Regras gerais

- **Mesma origem**: o app chama `/api/v1/...` na própria origem; a Netlify repassa à Railway. Sem CORS aberto: só
  origens de `APP_ORIGIN`/`ALLOWED_ORIGINS`/`ALLOWED_ORIGIN_PATTERN` recebem cabeçalhos CORS, com credenciais.
- **Sessão**: cookie `__Host-irontrack_session` (HttpOnly, Secure, SameSite=Lax, Path=/). O token é aleatório (256 bits);
  o banco guarda só o SHA-256 dele. Sessões revogáveis, com validade máxima e por inatividade.
- **CSRF**: toda requisição que altera algo (POST/PATCH/DELETE) exige `x-irontrack-csrf: 1` **e** `Origin` permitida
  (ou `Sec-Fetch-Site: same-origin`). Sem isso: `403 csrf_failed`.
- **Autorização por recurso**: a conta vem SEMPRE da sessão. IDs enviados pelo cliente (`accountId`, `profileId`) nunca
  autorizam nada: servem só para conferir e recusar (`409 account_mismatch`). Todo SQL filtra por `user_id` da sessão e é
  parametrizado.
- **Validação**: Zod estrito (campos desconhecidos recusados). Corpo máximo por rota (padrão 4 MB; IA 64 KB).
- **Erros**: `{ "error": { "code": "...", "message": "...", "fields"?: {...} } }`. Códigos e mensagens em
  `shared/api/errors.ts`. `429` traz `Retry-After`.
- **Cabeçalhos**: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, CSP `default-src 'none'`, HSTS em produção.

## Infra

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/v1/health` | — | Processo vivo. |
| GET | `/api/v1/ready` | — | Banco acessível e sem migração pendente (verificação da Railway). |
| GET | `/api/v1/config` | — | Recursos do servidor: `{ features: { email, ai, aiRequiresVerifiedEmail, signup } }`. |

## Contas e sessões

| Método | Rota | Auth | Corpo / resposta |
|---|---|---|---|
| POST | `/auth/signup` | — | `{ name, email, password, acceptTerms: true }` → 201 `{ account, features, verificationEmail }` + cookie. E-mail já usado: `409 signup_unavailable` (mensagem genérica). |
| POST | `/auth/login` | — | `{ email, password }` → `{ account, features }` + cookie. Erro sempre `401 invalid_credentials` (mesmo tempo de resposta com e sem conta). |
| POST | `/auth/logout` | sessão | Revoga a sessão atual e apaga o cookie. |
| POST | `/auth/verify-email` | — | `{ token }` (uso único, 24 h). |
| POST | `/auth/verify-email/resend` | sessão | Reenvia o link (3/h). |
| POST | `/auth/password/forgot` | — | `{ email }` → sempre `202` (não revela se existe). Sem e-mail configurado: `503 email_not_configured`. |
| POST | `/auth/password/reset` | — | `{ token, password }` (uso único, 30 min) → revoga **todas** as sessões. |
| GET | `/me` | sessão | `{ account, features }`. |
| PATCH | `/me` | sessão | `{ name }`. |
| POST | `/me/password` | sessão | `{ currentPassword, newPassword }` → revoga as outras sessões. |
| GET | `/me/sessions` | sessão | Sessões ativas (descrição do navegador, criação, último uso, atual). |
| POST | `/me/sessions/revoke-others` | sessão | Encerra as demais. |
| DELETE | `/me/sessions/:id` | sessão | Encerra uma sessão da própria conta (de outra conta: 404). |
| POST | `/me/delete` | sessão | `{ password, confirm: "EXCLUIR" }` → apaga a conta e tudo dela (cascata). |
| GET | `/me/export` | sessão | Backup v8 da conta (anexo JSON; fotos fora, com aviso). |

Senha: 10–128 caracteres, letra, número, diferente do e-mail, não comum (`shared/api/auth.ts`). Hash Argon2id
(m=19 MiB, t=2, p=1), rehash automático ao entrar se os parâmetros mudarem.

## Sincronização (`irontrack.sync.v1`)

Detalhes e exemplos: [NUVEM_SINCRONIZACAO.md](NUVEM_SINCRONIZACAO.md).

| Método | Rota | Corpo / resposta |
|---|---|---|
| POST | `/sync/push` | `{ protocol, deviceId, accountId, ops: [{ opId, collection, entityId, kind: put/delete, baseVersion, doc?, clientTime?, reason? }] }` (até 100 ops, 4 MB) → `{ results: [applied { version, seq } / conflict { server } / rejected { code, message }] }`. |
| GET | `/sync/pull?cursor=&accountId=&limit=` | `{ cursor, hasMore, changes: [{ collection, entityId, version, deleted, doc, seq }], reset? }` (até 500 por página). |

## Importação

| Método | Rota | Descrição |
|---|---|---|
| POST | `/import/jobs` | `{ sourceKind, sourceFingerprint, sourceProfileId, expectedItems }` → `{ jobId, previousImport }`. |
| POST | `/import/jobs/:id/items` | Lote `{ items: [{ collection, entityId, doc, hash }] }` (≤500, ≤4 MB). Hash canônico conferido; lote inválido não grava nada (422). |
| GET | `/import/jobs/:id/preview` | Por coleção: novos, iguais, diferentes. |
| POST | `/import/jobs/:id/commit` | `{ policy: "merge" }` ou `{ policy: "replace", confirmReplace: true }`. Uma transação: tudo ou nada. Repetir devolve o mesmo relatório. |
| GET | `/import/jobs/:id/verify` | Lê de volta e compara hash de cada registro; contagens da conta. |
| DELETE | `/import/jobs/:id` | Cancela (só em preparo). |

## IA pela conta

| Método | Rota | Descrição |
|---|---|---|
| GET | `/ai/models` | Catálogo `irontrack.ai-gateway.v1` só com provedores habilitados (`available` = há chave). |
| POST | `/ai/generate` | Mesmo contrato do gateway (provedor, modelo, mensagens, `maxOutputTokens`). E-mail confirmado exigido por padrão. Limites: por minuto, diário de pedidos e tokens por conta (PostgreSQL), concorrência. Conteúdo nunca é gravado; `ai_usage_events` guarda só provedor, modelo, estado, tokens e duração. |
| GET | `/ai/usage` | Consumo do dia e limites. |

## Limites de tentativas (PostgreSQL, chaves com HMAC)

Cadastro 5/h por IP · entrada 30/15 min por IP e 10/15 min por e-mail · esqueci a senha 10/h por IP e 3/h por e-mail ·
reenviar confirmação 3/h · troca de senha 10/h · exclusão 5/h · sincronização 240/min · importação 120/min ·
exportação 10/h · IA: conforme `limits` de `config/ai.json` e as cotas diárias.
