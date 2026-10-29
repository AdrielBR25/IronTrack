# Segurança do modo nuvem (Prompt 21)

Complementa [NUVEM_API.md](NUVEM_API.md) (regras por rota) e [NUVEM_IMPLANTACAO.md](NUVEM_IMPLANTACAO.md) (variáveis).

## 1. Segredos

| Segredo | Onde fica | Nunca |
|---|---|---|
| URL do PostgreSQL | variável `DATABASE_URL` do serviço da API na Railway (referência ao banco) | no código, em arquivo versionado, no app, em variável `VITE_`, em log ou chat |
| `RATE_LIMIT_SECRET` | Railway | idem |
| Chaves de IA (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) | Railway | no app, no navegador, em backups ou exportações; o usuário comum nunca cola chave |
| `RESEND_API_KEY` | Railway | idem |
| Endereço da API | variável `API_PROXY_TARGET` da Netlify (vira `dist/_redirects` no build) | no bundle do app |

Proteções automáticas: `ConfigError` lista só NOMES de variáveis; o pool não registra a URL; o script de migração não
imprime a URL; a API recusa iniciar em produção com `COOKIE_SECURE=false`, `API_TEST_MODE` ou provedor de IA sem HTTPS;
a resposta da IA é conferida para não conter nenhuma chave configurada; teste de arquitetura impede `DATABASE_URL`,
domínios da Railway e chaves no código do app, e `VITE_` além de `VITE_ACCOUNTS`.

## 2. Senhas e sessões

- Argon2id (m=19 MiB, t=2, p=1, parâmetros da OWASP), rehash ao entrar quando os parâmetros mudarem. Senha nunca em
  texto puro, nunca em log, nunca no armazenamento do navegador (teste E2E confere).
- Entrada com e-mail inexistente roda um Argon2 de mentira: mesmo tempo, mesma mensagem (`invalid_credentials`).
- Sessão: token de 256 bits no cookie `__Host-` HttpOnly/Secure/SameSite=Lax; o banco guarda só o SHA-256. Validade
  máxima 30 dias e 14 dias sem uso. Revogável (sair, encerrar outras, encerrar uma, troca de senha revoga as outras,
  redefinição revoga todas, exclusão apaga todas).
- Tokens de e-mail (confirmação 24 h, nova senha 30 min) aleatórios, guardados como hash, uso único; usar um invalida
  os demais pendentes da mesma conta.

## 3. Enumeração de contas

- Entrada e "esqueci a senha": mesma resposta com ou sem conta.
- Cadastro com e-mail existente: `409 signup_unavailable` com texto genérico ("se você já tem conta, entre ou recupere a
  senha"). **Risco residual aceito:** quem tenta cadastrar descobre que o e-mail não está livre; mitigado pelo limite de
  5 cadastros/h por IP. A alternativa (sempre "verifique seu e-mail") exige e-mail configurado; fica como opção futura.

## 4. Requisições

- CSRF: cabeçalho `x-irontrack-csrf` + `Origin` permitida/`Sec-Fetch-Site: same-origin` em toda alteração; cookie
  SameSite=Lax. CORS só para origens configuradas.
- Autorização por recurso: a conta vem da sessão; todo SQL filtra por `user_id`; IDs vindos do cliente só servem para
  recusar divergências (`account_mismatch`). Teste E2E: uma conta não lê nem grava dados de outra.
- SQL sempre parametrizado; nomes de tabela vêm de uma lista fixa no código.
- Validação Zod estrita; limites de corpo por rota; tempo limite por requisição; `statement_timeout` no PostgreSQL.
- Limites de tentativas persistidos no PostgreSQL (valem entre réplicas e reinícios); chaves com HMAC (IP/e-mail não
  ficam em claro). IP do cliente = N-ésimo a partir da direita em `X-Forwarded-For` (`TRUST_PROXY_HOPS`).
- Cabeçalhos: API com `no-store`, `nosniff`, CSP `default-src 'none'`, `DENY`, HSTS; app (Netlify) com CSP só da própria
  origem (scripts sem `unsafe-inline`), `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy`.
- O service worker do PWA não atende `/api/*` (sem cache de dados da conta nem página no lugar da API).

## 5. Logs

JSON com metadados: método, rota (modelo, sem parâmetros), status, duração, ID da conta quando houver. Nunca: corpo,
senha, token, cookie, e-mail em claro, URL do banco, chaves, conteúdo da IA. Eventos (`account_created`,
`account_deleted`, `email_failed`) só com IDs ou o tipo. A IA registra em `ai_usage_events` apenas provedor, modelo, estado, tokens e duração.

## 6. Exclusão de conta (política)

- Exige senha e digitar `EXCLUIR`; sugere exportar antes.
- Apaga **imediatamente**, numa transação, a conta e em cascata: sessões, tokens, todos os registros sincronizados,
  projeções de treino, histórico de revisões, operações, importações, consumo de IA. O e-mail fica livre para novo cadastro.
- No aparelho: opção (marcada por padrão) de apagar também a cópia local da conta. O banco do modo sem conta não é tocado.
- Backups do PostgreSQL: os dados apagados permanecem só nas cópias já feitas e somem quando elas expiram (retenção dos
  backups automáticos da Railway e dos lógicos: até ~3 meses, ver NUVEM_IMPLANTACAO.md §6). Se um backup for restaurado,
  as contas excluídas depois dele devem ser excluídas de novo (manter a lista de IDs excluídos fora do banco é uma
  melhoria pendente).
- Limites de tentativas e eventos de log não guardam e-mail em claro.

## 7. Pendências conhecidas

- E-mail transacional, provedores de IA e o próprio deploy dependem de configuração real (não feita nesta etapa).
- `TRUST_PROXY_HOPS` com Netlify → Railway precisa ser conferido na homologação (NUVEM_IMPLANTACAO.md §7, item 6).
- Fotos não sincronizam (sem armazenamento privado de objetos).
- Sem 2FA nem login social nesta fase.
