# Homologação e segurança operacional do gateway de IA

IronTrack 2.0 · Fase 01 · Prompt 07. Endurecimento do gateway (`services/ai-gateway`) criado no Prompt 06 e
preparação de uma homologação real verificável. Arquitetura geral: [IA_GATEWAY.md](IA_GATEWAY.md).

> **Estado:** todas as verificações foram feitas com provedores **simulados** (fetch simulado e servidores
> locais em `127.0.0.1`). **Nenhuma chamada paga foi feita**, nenhum serviço foi publicado e não havia
> credenciais reais. A **homologação externa está PENDENTE** para OpenAI, Anthropic e Gemini (seção 9).

## 1. Auditoria de segurança

Revisão do código de `4a45bb4` (branch `feature/irontrack-2-f01-ai-gateway`), superfície por superfície.
Cada achado foi conferido no código; os marcados com reprodução foram demonstrados com servidores locais.

### 1.1 Achados e correções

| # | Gravidade | Achado (em `4a45bb4`) | Correção (P07) | Testes |
| --- | --- | --- | --- | --- |
| A1 | **Alta** | **Redirecionamentos seguidos na chamada ao provedor.** `postJson` usava o `fetch` com `redirect: 'follow'` (padrão). Um 307/308 vindo do endereço do provedor (ou de um `baseUrl`/DNS comprometido) reenviava o corpo — o prompt autorizado — e os cabeçalhos `x-api-key` (Anthropic) e `x-goog-api-key` (Gemini), que o fetch **não** remove em redirecionamento entre origens. **Reproduzido:** o destino do redirecionamento recebeu a chave e o prompt. | `redirect: 'manual'` em toda chamada; qualquer 3xx vira `provider_failure` sem ler o corpo. | `hardening` (307 real entre dois servidores locais), `contracts` (301/302/303/307/308 nos três adaptadores). |
| A2 | Média | **Revogação só com reinício, sem expiração e sem rotação.** A configuração era lida uma vez na partida; a documentação dizia "revogar = `enabled: false`", mas o processo continuava aceitando o token até reiniciar. Um titular tinha um único hash (trocar o token = janela sem acesso). | Credenciais com `keyId` não secreto, `expiresAt` e `revokedAt`; várias por titular; recarregamento atômico (`reload`, SIGHUP e monitoramento do arquivo); requisições em andamento com credencial revogada são interrompidas; utilitário de emissão/rotação/revogação com gravação atômica. | `hardening` (válido, inválido, revogado, expirado, rotação, reload), `credentials`, `process` (processo real). |
| A3 | Média | **Reservas de cota presas em falhas.** "Falhas mantêm a reserva" valia para tudo: erro do adaptador antes do envio, cancelamento antes do envio e respostas HTTP de erro (401/429/5xx) consumiam `entrada + maxOutputTokens` da cota do dia sem nada ter sido gerado. Algumas falhas seguidas bloqueavam o titular até o dia seguinte. | Acerto por situação (seção 5.3): nada enviado ou erro HTTP → devolve tudo; 2xx inaproveitável com uso informado → cobra o informado; tempo limite/cancelamento/queda após o envio → mantém a reserva. | `hardening` (falha antes do envio, cancelamento antes e depois, erros HTTP, 2xx com uso). |
| A4 | Média | **Uso do Gemini subcontado.** `thoughtsTokenCount` (raciocínio, cobrado como saída e informado **separado** de `candidatesTokenCount`) era ignorado: cota e logs subestimavam o gasto em modelos com raciocínio. Respostas cobradas mas inaproveitáveis (raciocínio esgotou o limite) não registravam o uso informado. | Saída Gemini = candidatos + raciocínio; adaptadores anexam o uso informado aos erros de respostas 2xx (`GatewayError.usage`). | `contracts`. |
| A5 | Média | **Leitura do corpo ignorava tempo limite e cancelamento.** `readBody` não ouvia o sinal: um cliente que enviasse o corpo devagar segurava a requisição até o `requestTimeout` do servidor (tempo limite + 15 s). | Leitura do corpo termina com o sinal (tempo limite → 504) ou com o fechamento da conexão. | `hardening` (corpo lento). |
| A6 | Baixa | **Sem encerramento gracioso.** SIGTERM/SIGINT matavam o processo no meio de chamadas ao provedor (o provedor cobra e o cliente recebe conexão interrompida). | `shutdown(graceMs)`: recusa novas (503), espera as em andamento e interrompe o restante; `main.ts` trata SIGTERM/SIGINT. | `hardening`, `process`. |
| A7 | Baixa | **Sem limite global de simultaneidade.** Cada titular podia ter 2 chamadas; N titulares = 2N chamadas pagas simultâneas. | `limits.maxConcurrentTotal` (padrão 8). | `hardening`. |
| A8 | Baixa | **Limites sem teto.** Qualquer inteiro positivo era aceito (ex.: `upstreamTimeoutMs` de horas, `maxBodyBytes` de gigabytes): um zero a mais desligava a proteção. | `MAX_LIMITS`: valor acima do teto = configuração inválida (gateway bloqueado). | `hardening`. |
| A9 | Baixa | **Log com dados potencialmente pessoais.** O log gravava o caminho digitado (`GET /qualquer-coisa` pode carregar dados) e o ID do titular (pode ser um nome). | Rota só como rótulo fixo (`outra` para o resto); log identifica a **credencial** pelo `keyId`, não o titular. | `gateway` (15), `hardening`. |
| A10 | Baixa | **Janela fixa por minuto.** Permitia rajada de 2× o limite na virada do minuto. | Janela deslizante de 60 s. | `hardening`. |
| A11 | Baixa | **429 do provedor confundido com falha genérica.** Limite/cota da conta no provedor aparecia como `provider_failure`. | Código próprio `provider_rate_limited` (429), sem nova tentativa; o app mostra "aguarde". | `contracts`, `adapters`, app. |
| A12 | Baixa | **`baseUrl` http (loopback) aceito com o gateway exposto.** Servidor simulado é coisa de desenvolvimento. | Com `exposeBeyondLoopback: true`, `baseUrl` precisa ser `https://`. | `hardening`. |
| A13 | Info | Log de acesso sempre ligado em stdout. | `AI_GATEWAY_ACCESS_LOG=off`. | `process`. |
| A14 | Info | **Interface:** token recusado no meio do uso (revogado/expirado) continuava na memória e "conectado". | O app esquece o token e os provedores remotos na hora e pede nova conexão. | `assistant-remote-ui`, E2E. |
| A15 | Info | Respostas sem `Content-Security-Policy`. | `default-src 'none'; frame-ancestors 'none'`. | `hardening`. |

### 1.2 Superfícies verificadas sem achado

| Superfície | Conclusão |
| --- | --- |
| Validação de configuração | Estrita (campos desconhecidos recusados), erros só com o caminho do campo, inválida = bloqueado. Mantida e ampliada (credenciais, tetos). |
| Autenticação e comparação | Token de 256 bits, só o SHA-256 no servidor, `timingSafeEqual` percorrendo **todas** as credenciais (sem retorno antecipado). Recusas (desconhecido, revogado, expirado, titular desligado) têm a mesma resposta. UUID do perfil, origem e corpo não autenticam. |
| CORS | Não autentica; sem curinga nem `null`; origem estranha → 403; preflight só para rotas conhecidas. Sem origem (curl) ainda exige token. |
| Endpoints fixos / SSRF | O cliente não escolhe URL, cabeçalho, ferramenta nem parâmetro (corpo estrito); endereços oficiais fixos; `baseUrl` só pelo operador; ID de modelo sem `/` e codificado na rota do Gemini; IP de metadados de nuvem inalcançável pelo cliente. |
| Respostas excessivas | Limite de bytes por `content-length` e durante a leitura (também após descompressão); corte por `maxOutputTokens × 4`. |
| Tratamento de erros / exposição | Frases fixas; corpo de erro do provedor nunca repassado; checagem final de que nenhuma chave sai na resposta; sem `x-powered-by`. |
| Credenciais no navegador | Token só em memória (closure do transporte), nunca em storage, IndexedDB, backup, URL ou log; `redirect: 'error'`, `credentials: 'omit'`, `no-referrer` no app. |
| Persistência | O código do gateway não grava arquivos nem usa banco (teste de código-fonte); só `main.ts` lê a configuração e `scripts/token.ts` grava o arquivo de configuração (só hashes). |

## 2. Rotação de tokens

Formato novo de titular (o formato do P06 com `tokenSha256` direto continua aceito e recebe um `keyId`
derivado `legacy-<12 primeiros hex do hash>`):

```json
{ "id": "celular-1", "enabled": true, "credentials": [
  { "keyId": "k-3f9a01c2b7de", "tokenSha256": "<sha-256 hex>", "createdAt": "2026-11-01T12:00:00Z", "expiresAt": "2027-01-30T12:00:00Z" }
] }
```

- `keyId`: identificador **não secreto** (auditoria, logs, revogação). O token nunca é derivável dele.
- `id` do titular: pseudônimo (não use nome, e-mail ou telefone). Os logs não o mostram.
- Utilitário (Node 22.18+, sem dependências; nada é enviado à rede):

```bash
CFG=services/ai-gateway/config/development.json
npm run gateway:token -- issue  celular-1 --expires-in 90d --config $CFG   # mostra o token UMA vez
npm run gateway:token -- rotate k-3f9a01c2b7de --grace 30m --config $CFG    # novo token; antigo vale mais 30 min
npm run gateway:token -- revoke k-3f9a01c2b7de --config $CFG                # recusa a partir do recarregamento
npm run gateway:token -- list   --config $CFG                               # keyId, status, datas (sem hashes)
```

- O token aparece **uma única vez** no terminal de quem emite. Não rode a emissão em CI nem com o terminal
  gravado. Não há como recuperar um token depois: perdeu, emita outro e revogue o antigo.
- Gravação **atômica**: arquivo temporário no mesmo diretório (`0600`), `fsync` e `rename`. Quem lê o arquivo
  vê o conteúdo antigo ou o novo inteiro, nunca um meio-termo. A configuração resultante é validada antes de
  gravar; se ficaria inválida, nada é gravado.
- `rotate` sem `--grace` revoga o antigo imediatamente; com `--grace` o antigo recebe expiração `agora + prazo`
  (nunca estende uma expiração menor). Rotação recomendada: a cada 90 dias, ou imediatamente se houver suspeita.

## 3. Revogação

O que **realmente** acontece (sem prometer mais do que o processo faz):

1. `revoke` grava `revokedAt` no arquivo (a credencial fica registrada para auditoria).
2. O gateway em execução aplica no **próximo recarregamento**:
   - **imediato** com `kill -HUP <pid>`;
   - ou em até `AI_GATEWAY_RELOAD_INTERVAL_MS` (padrão **2 s**) pelo monitoramento do arquivo (`stat`, detecta o
     `rename` atômico). Com o monitoramento desligado (`0`) e sem SIGHUP, só no reinício.
3. Ao recarregar, requisições **em andamento** com a credencial revogada são **interrompidas** (401) e a chamada ao
   provedor é abortada. Outras credenciais não são afetadas.
4. Recarregar mantém contadores de limites e cotas (revogar e reemitir não zera a cota do titular).
5. Configuração nova **inválida** (ex.: edição manual pela metade) **bloqueia** o gateway (503) até ser corrigida —
   nunca continua com a configuração antiga, que poderia conter a credencial que se quis revogar.
6. Desligar o titular (`enabled: false`) recusa todas as credenciais dele, com o mesmo recarregamento.

Testado no processo real (`tests/process.test.ts`): token aceito → `revoke` pelo utilitário → recusado em menos de
3 s sem reinício; SIGHUP aplica uma credencial nova; arquivo quebrado bloqueia.

## 4. Expiração

- `expiresAt` opcional, ISO 8601 com fuso. A partir desse instante (inclusive) o token é recusado com o mesmo 401.
- A expiração é conferida **na autenticação**. Uma requisição autenticada antes de expirar pode terminar (no
  máximo `upstreamTimeoutMs`). A revogação, ao contrário, interrompe na hora.
- A comparação usa o relógio do servidor: mantenha-o sincronizado (NTP).

## 5. Limites de uso

### 5.1 Limites e onde são aplicados

Todos são aplicados **antes** de chamar o provedor pago, nesta ordem: requisições/minuto → corpo (tamanho, tempo) →
allowlist → entrada/saída → chave configurada → simultaneidade do titular → simultaneidade total → cota diária.

| Limite | Padrão | Teto aceito | Recusa |
| --- | --- | --- | --- |
| `requestsPerMinute` (janela deslizante, por titular) | 10 | 600 | 429 `rate_limited` |
| `maxConcurrentPerClient` | 2 | 20 | 429 `rate_limited` |
| `maxConcurrentTotal` (todos os titulares) | 8 | 200 | 429 `rate_limited` |
| `dailyTokenBudget` (dia UTC, por titular) | 50.000 | 100.000.000 | 429 `quota_exceeded` |
| `maxBodyBytes` | 64 KiB | 1 MiB | 413 |
| `maxMessages` / `maxInputChars` | 6 / 24.000 | 50 / 1.000.000 | 413 |
| `maxOutputTokens` | 1.024 | 100.000 | 400 |
| `upstreamTimeoutMs` (cobre leitura do corpo + provedor) | 30 s | 300 s | 504 `timeout` |
| `maxUpstreamResponseBytes` | 256 KiB | 8 MiB | 502 `invalid_response` |

O log registra qual limite recusou (`limit`: `requests_per_minute`, `concurrency_client`, `concurrency_total`,
`daily_quota`).

### 5.2 Três níveis de limite (não confunda)

| Nível | Onde | Vale para | Garante |
| --- | --- | --- | --- |
| **Local de uma instância** | `MemoryUsageStore` no processo | Só este processo; zera ao reiniciar | Proteção de uso e de custo **neste** gateway. É o único suportado hoje. |
| **Global de implantação distribuída** | Armazenamento compartilhado (ex.: Redis/KV com operações atômicas) | Todas as instâncias | **Não implementado.** Com várias instâncias, cada uma teria contadores próprios (limites multiplicados). |
| **Gasto no provedor** | Painel da OpenAI, Anthropic e Google | A conta/projeto no provedor | Teto financeiro real, independente do gateway. **Obrigatório** antes de qualquer uso real. |

**Restrição explícita:** o gateway deve rodar como **uma única instância**. Plataformas que escalam
horizontalmente ou serverless exigiriam um `UsageStore` compartilhado (a interface existe; a implementação não).

### 5.3 Concorrência, reservas e liberação

- Cada operação do `MemoryUsageStore` é síncrona por dentro (sem `await` entre ler e gravar). No laço de eventos
  do Node, duas requisições nunca leem o mesmo saldo: **não há corrida que ultrapasse a cota** (testado com 12
  requisições simultâneas e cota para 3: exatamente 3 chegam ao provedor).
- Reserva antes da chamada: `entrada estimada (chars/4) + maxOutputTokens`. Acerto depois:

| Situação | Cota |
| --- | --- |
| Sucesso | Troca a reserva pelo uso informado (ou estimado, se o provedor não informar). |
| Nada foi enviado (adaptador recusou, cancelado antes do envio, revogado antes) | Devolve tudo. |
| Provedor respondeu erro HTTP (401, 403, 429, 5xx…) | Devolve tudo (provedores não cobram solicitações recusadas; o teto do painel é a rede de segurança). |
| Provedor respondeu 2xx inaproveitável (recusa, vazio, raciocínio esgotou o limite) com uso informado | Cobra o uso informado. |
| Tempo limite, cancelamento ou queda de rede **depois** do envio | Mantém a reserva (o provedor pode ter gerado e cobrado a resposta inteira). |

- Vagas de simultaneidade (titular e total) são liberadas em `finally` em qualquer desfecho: sucesso, erro,
  cancelamento, tempo limite, revogação ou encerramento (testado: nenhum contador fica preso).
- Uma solicitação longa nunca prende o titular além de `upstreamTimeoutMs` (que agora também cobre a leitura do
  corpo). Ao exceder, a chamada ao provedor é abortada e a conexão com ele, fechada.
- Desconexão do cliente aborta a chamada ao provedor (o socket com o provedor é fechado).

## 6. Resiliência

| Cenário | Comportamento | Teste |
| --- | --- | --- |
| Configuração inválida na partida ou no recarregamento | Bloqueado (503 em tudo); erros só com nomes de campos. | `gateway` 17, `hardening`, `process` |
| Falha de DNS / conexão recusada | 502 `provider_failure`, sem nova tentativa, sem trocar de provedor. | `hardening` |
| Resposta lenta | 504 `timeout`, chamada abortada, vaga liberada. | `gateway` 10 |
| Desconexão do cliente | Chamada abortada; 499 no log; vaga liberada. | `gateway` 11, `integration` |
| Encerramento do gateway | Recusa novas (503 + `connection: close`), espera em andamento até o prazo, interrompe o resto. | `hardening`, `process` |
| Falha de leitura do corpo (cliente cai ou envia devagar) | `cancelled` ou 504; nada é enviado ao provedor. | `hardening` |
| Provedor indisponível (5xx, 529) | 502, sem repetir. | `adapters`, `contracts` |
| Resposta malformada / conexão cai no meio do corpo | 502 (`invalid_response` / `provider_failure`). | `contracts`, `hardening` |
| Uso simultâneo por titulares diferentes | Cotas, janelas e vagas independentes; só o limite total é compartilhado. | `hardening` |

**Sem retries automáticos** de chamadas pagas e **sem fallback** silencioso entre provedores (testado).

## 7. Contratos dos provedores

Referências oficiais consultadas em **27/10/2026**. Nenhum ID de modelo está fixo no código; o roteiro de
homologação exige o ID explicitamente.

| Item | OpenAI (Responses) | Anthropic (Messages) | Gemini (generateContent) |
| --- | --- | --- | --- |
| Endpoint | `POST /v1/responses` | `POST /v1/messages` | `POST /v1beta/models/{m}:generateContent` |
| Autenticação | `Authorization: Bearer` | `x-api-key` + `anthropic-version` | `x-goog-api-key` (nunca `?key=`) |
| Sistema | `instructions` | `system` (campo próprio) | `systemInstruction.parts[].text` |
| Saída | `max_output_tokens` (mín. 16; inclui raciocínio) | `max_tokens` (obrigatório) | `generationConfig.maxOutputTokens` (limita também o raciocínio) |
| Texto | itens `message` → `output_text`; itens `reasoning` ignorados | blocos `text`; `thinking`/`redacted_thinking` ignorados | `parts[].text` sem `thought: true` |
| Parcial | `incomplete` + `max_output_tokens` com texto → `length` | `max_tokens` / `model_context_window_exceeded` → `length` | `MAX_TOKENS`, `CONTINUATION` com texto → `length` |
| Recusa | item `refusal` ou `content_filter` → `content_filtered` | `stop_reason: refusal` (HTTP 200, `stop_details`) → `content_filtered` | `promptFeedback.blockReason`, `SAFETY`, `RECITATION`, `LANGUAGE`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_*`, `ESCALATION` → `content_filtered`; `PUP_LIMITED_DISABLED` → `provider_unavailable` |
| Vazia | → `invalid_response` (com uso, se informado) | `end_turn` vazio (caso documentado) → `invalid_response` | → `invalid_response` |
| Raciocínio | limite pode acabar só com `reasoning` (sem `message`): cobrado → `invalid_response` com uso | só com `thinking` ligado (o gateway não liga) | `thoughtsTokenCount` cobrado como saída: **somado** ao uso |
| Uso | `input_tokens`, `output_tokens` (já inclui raciocínio) | `input_tokens`, `output_tokens` | `promptTokenCount`, `candidatesTokenCount + thoughtsTokenCount` |
| Erros HTTP | 401/403 → `provider_unavailable`; 429 → `provider_rate_limited`; 413 → `payload_too_large`; 3xx, 400, 404, 408, 5xx, 529 → `provider_failure` (Gemini devolve chave inválida como 400 → `provider_failure`) | | |
| Cancelamento | sinal repassado ao fetch; abortado no tempo limite, desconexão, revogação ou encerramento | | |

Outros status (`queued`/`in_progress` da OpenAI, `tool_use`/`pause_turn` da Anthropic, `OTHER`/`MALFORMED_*`/
`UNEXPECTED_TOOL_CALL` do Gemini) → `invalid_response`: são recursos que o IronTrack não usa. Não supomos que
todos os modelos respondam igual: cada adaptador trata os casos documentados do seu provedor.

Testes de contrato com respostas realistas: `services/ai-gateway/tests/contracts.test.ts` (e `adapters.test.ts`).

## 8. Observabilidade sem dados pessoais

- **Log de acesso** (stdout, uma linha JSON por requisição; `AI_GATEWAY_ACCESS_LOG=off` desliga): `ts`, `id`
  aleatório, rota (rótulo fixo), `status`, `code`, `keyId`, `provider`, `model`, `durationMs`, `inputTokens`,
  `outputTokens`, `usageSource` (`reported`/`estimated`) e `limit`.
- **Métricas agregadas** só em memória (zeradas ao reiniciar), sem titular, keyId, IP ou conteúdo: total, por rota,
  por status, erros por código, limites atingidos e, por `provedor/modelo`, solicitações, sucessos, erros, duração
  total e máxima, tokens informados e estimados. `kill -USR2 <pid>` escreve um retrato em stderr; o encerramento
  também. **Não há rota HTTP de métricas** (não amplia a superfície) e **nada vai para terceiros**.
- **Nunca registrados**: perguntas, respostas, histórico de treinos, medidas corporais, tokens, chaves, cabeçalhos,
  caminhos digitados, IP, conteúdo de consentimento. Testado com marcadores em logs e métricas.

## 9. Homologação externa

### 9.1 Roteiro (`npm run gateway:homologate`)

Execução **manual**, desativada por padrão, uma solicitação por provedor:

```bash
# Em um terminal de homologação autorizado, com chave de TESTE e teto de gasto configurado no painel do provedor:
export AI_GATEWAY_HOMOLOGATION=1
export ANTHROPIC_API_KEY=...            # só nesta sessão; nunca em arquivo versionado nem VITE_*
npm run gateway:homologate -- --provider anthropic --model <id-atual-conferido-na-documentação> --confirm-paid-call
unset ANTHROPIC_API_KEY AI_GATEWAY_HOMOLOGATION
```

| Garantia | Como |
| --- | --- |
| Manual e desligado por padrão | Exige `AI_GATEWAY_HOMOLOGATION=1` **e** `--confirm-paid-call`; nenhum teste automático chama provedor real. |
| Credencial só no ambiente | Chave lida da variável (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` ou `--api-key-env`). |
| Modelo explícito | `--model` obrigatório, sem padrão. |
| Pergunta fictícia | Texto fixo de conectividade ("Responda somente: OK"), sem nenhum dado do usuário. |
| Saída pequena / tempo curto | `--max-output-tokens` 16–64 (padrão 32); `--timeout-ms` 1.000–30.000 (padrão 20.000). |
| Uma solicitação | Limites internos `requestsPerMinute: 1`, simultaneidade 1; sem nova tentativa. |
| Caminho completo | Sobe o gateway em `127.0.0.1` com configuração só em memória e token descartável; passa por autenticação, allowlist, limites, adaptador e normalização. |
| Nada gravado | Não escreve arquivos. Saída: **uma linha JSON** com `ts`, `provider`, `model`, `ok`, `code` (se falhou), `durationMs`, `usage` (se informado). Nunca prompt, resposta, chave ou token. |
| Ensaio sem custo | `--base-url http://127.0.0.1:<porta>` aponta para um servidor simulado local (qualquer outro endereço é recusado). Usado nos testes. |

### 9.2 Evidências

| Provedor | Modelo | Data | Resultado | Código | Duração | Uso | Evidência |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | — | — | **PENDENTE** | — | — | — | Sem credencial nem autorização. |
| Anthropic | — | — | **PENDENTE** | — | — | — | Sem credencial nem autorização. |
| Google Gemini | — | — | **PENDENTE** | — | — | — | Sem credencial nem autorização. |

Para concluir: rodar o roteiro uma vez por provedor, colar a linha JSON de cada um nesta tabela (ela não contém
segredos nem conteúdo), conferir no painel do provedor que a solicitação apareceu com o uso correspondente e
repetir com uma chave inválida para confirmar `provider_unavailable` (Gemini: `provider_failure`, porque devolve
400). **A homologação só pode ser marcada como concluída com essas evidências reais.**

## 10. Segurança da interface (revisão)

Confirmado no código e nos testes: modo simulado como padrão e offline; nenhuma conexão automática; token só em
memória (campo limpo após conectar; nada em storage, IndexedDB, backup, URL ou log); endereço sem usuário/senha,
caminho ou parâmetros; destino explícito na prévia e assinado no consentimento; prévia completa; consentimento por
solicitação, de uso único; trocar ou desconectar o gateway invalida prévia e execução; cancelamento aborta a
requisição; desconectar descarta o token; erros com frases fixas. **Novo:** token recusado durante o uso
(revogado, expirado) é esquecido na hora e a conexão precisa ser refeita; `provider_rate_limited` aparece como
"aguarde". Sem login obrigatório e sem armazenamento persistente de tokens.

## 11. Riscos remanescentes

| Risco | Situação | Mitigação/requisito |
| --- | --- | --- |
| Limites só por instância | Reinício zera cotas e janelas; várias instâncias multiplicam limites. | Uma instância; teto de gasto no provedor; `UsageStore` compartilhado antes de escalar. |
| Token de portador estático | Quem tiver o token usa até revogar ou expirar; não há vínculo com aparelho. | Expiração, rotação, revogação rápida; login com tokens curtos no futuro. |
| Tentativas sem token | Não há limite por IP antes da autenticação (adivinhar 256 bits é inviável, mas consome CPU). | Limite por IP no proxy de borda. |
| Política de acerto | Supõe que provedores não cobram erros HTTP. | Teto de gasto no painel; conferir na homologação. |
| Expiração no meio da requisição | Requisição autenticada antes de expirar termina (≤ `upstreamTimeoutMs`). | Documentado; revogação interrompe. |
| Revogação depende de recarregar | Até 2 s pelo monitoramento ou imediata com SIGHUP; sem ambos, só no reinício. | Mantenha o monitoramento ligado ou envie SIGHUP. |
| Configuração quebrada derruba o serviço | Escolha consciente: bloquear em vez de aceitar credenciais antigas. | Use o utilitário (gravação atômica e validada). |
| Raciocínio consome o limite de saída | OpenAI e Gemini podem devolver vazio cobrado com limite baixo. | Escolher `maxOutputTokens` adequado por modelo na allowlist; homologar. |
| Mudanças nas APIs/modelos | IDs e versões mudam. | Conferir documentação na homologação; sem ID fixo no código. |
| Host não verificado | DNS rebinding em gateway local esbarra no token e no CORS. | Token obrigatório; proxy com Host fixo em produção. |
| Retenção de logs | stdout do processo; retenção depende do operador. | Retenção curta; logs já sem conteúdo. |
| Homologação real | Pendente. | Seção 9. |

## 12. Requisitos mínimos para implantação

Nada foi implantado. Antes de expor o gateway fora do aparelho do desenvolvedor, **todos** abaixo:

1. Homologação real concluída (seção 9) para cada provedor que será habilitado.
2. **Uma única instância** (ou `UsageStore` compartilhado e testado sob concorrência).
3. **HTTPS** terminado por proxy confiável, com Host fixo, limite por IP e corpo máximo na borda.
4. `allowedOrigins` só `https://adrielbr25.github.io`; `exposeBeyondLoopback: true` consciente; `baseUrl` só https.
5. Chaves nos segredos da plataforma (nunca no repositório, no build da PWA ou em `VITE_*`); arquivo de configuração
   com permissão `0600`, fora do repositório.
6. Credenciais por titular com `expiresAt` (≤ 90 dias), processo de rotação e revogação testado (SIGHUP ou
   monitoramento ligado).
7. **Teto de gasto e alertas** no painel de cada provedor; cotas do gateway iguais ou menores.
8. Gerenciador de processo que envie SIGTERM e respeite o prazo de encerramento (`AI_GATEWAY_SHUTDOWN_GRACE_MS`).
9. Logs de metadados com retenção curta; acompanhar 401/429/5xx e as métricas (SIGUSR2).
10. Relógio sincronizado (expiração e cota diária UTC).
11. Revisão de segurança da configuração final e aprovação explícita do Adriel.
