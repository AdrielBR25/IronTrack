# Gateway seguro de IA

IronTrack 2.0 · Fase 01 · Prompt 06. Primeira integração com provedores reais de IA (OpenAI, Anthropic
Claude e Google Gemini) por meio de um **gateway** separado da PWA. O gateway é um serviço mínimo em
`services/ai-gateway/`, **bloqueado por padrão**, que guarda as chaves dos provedores no servidor,
autentica quem pode usá-lo e aplica limites de uso.

> **Estado da homologação:** o gateway, os adaptadores e a interface foram validados com provedores
> **simulados** (fetch simulado e servidores locais). Nenhuma chamada paga real foi feita, nenhum
> gateway foi publicado e nenhuma credencial real existe no repositório. A homologação com cada provedor
> real está **pendente** (ver seção 13.4).

Arquitetura do módulo de IA no app: [IA_ARQUITETURA.md](IA_ARQUITETURA.md) (seção 18 para o modo remoto).

## 1. Arquitetura do gateway

```
IronTrack PWA (GitHub Pages, offline-first)
   │  modo simulado (padrão): nada sai do aparelho
   │  modo remoto: prévia → consentimento por solicitação → execute
   ▼
AIService ── GatewayAIProvider ── integrations/ai/gatewayTransport (fetch, só rotas fixas)
   │  HTTPS · Authorization: Bearer <token de acesso>
   ▼
services/ai-gateway (node:http, sem dependências)
   ├─ CORS (só navegador; não autentica) → rota → credencial → limite/min → corpo
   ├─ allowlist de provedor e modelo → limites de entrada/saída → chave no servidor
   ├─ simultaneidade → cota diária → chamada com tempo limite e cancelamento
   └─ normalização → resposta sem segredos · log só de metadados
        ├─▶ OpenAI     POST https://api.openai.com/v1/responses
        ├─▶ Anthropic  POST https://api.anthropic.com/v1/messages
        └─▶ Gemini     POST https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent
```

Rotas (todas autenticadas; qualquer outra → 404, método errado → 405, query string → 404):

| Rota | Função | Dados do usuário |
| --- | --- | --- |
| `GET /v1/models` | Catálogo: provedores habilitados, modelos permitidos, limites e se há chave configurada. | Nenhum. |
| `POST /v1/generate` | Uma solicitação de texto ao provedor escolhido. | Só as mensagens que o usuário autorizou na prévia. |

Contrato de `POST /v1/generate` (validação estrita; campos desconhecidos → 400):

```json
{ "provider": "anthropic", "model": "<id permitido>", "maxOutputTokens": 512,
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }] }
```

Resposta: `{ provider, model, output: { type: "text", text }, finishReason: "stop" | "length", usage? }`.
Erro: `{ error: { code, message } }` com frase fixa. O cliente **não** consegue indicar URL, endpoint,
cabeçalho, ferramenta, temperatura ou qualquer parâmetro do provedor.

Arquivos:

| Arquivo | Papel |
| --- | --- |
| `src/gateway.ts` | Servidor HTTP e ordem das proteções. |
| `src/config.ts` | Esquema e validação da configuração (erros apontam só o campo). |
| `src/auth.ts` | Credenciais de acesso (hash SHA-256, comparação em tempo constante). |
| `src/limits.ts` | `UsageStore` (requisições/min, simultaneidade, cota diária) e implementação em memória. |
| `src/protocol.ts` | Contrato HTTP e validação do corpo. |
| `src/providers/*.ts` | Adaptadores OpenAI, Anthropic e Gemini; leitura limitada das respostas. |
| `src/main.ts` | Entrada local (lê `AI_GATEWAY_CONFIG` e variáveis de ambiente). |
| `scripts/token.ts` | Emite credenciais de acesso. |
| `config/*.example.json`, `.env.example` | Exemplos sem segredos (desligados). |

Escolhas: `node:http` puro (Node 22.18+ executa TypeScript nativamente), sem framework e sem dependências,
para não trazer superfície de ataque nem plataforma nova. O gateway não importa código do app e o app não
importa o gateway (testado), então pode ser implantado à parte. A PWA continua estática: **sem gateway
configurado, o IronTrack funciona igual e o modo simulado continua offline**.

## 2. Autenticação e autorização

- **Credencial real, verificada no servidor.** O operador gera um token aleatório de 256 bits com
  `npm run gateway:token -- <titular>`. O token é mostrado uma única vez e entregue ao titular por canal
  privado; o servidor guarda **apenas o SHA-256** em `clients[].tokenSha256`.
- O navegador apresenta o token em `Authorization: Bearer <token>`. Formato diferente, token desconhecido
  ou titular com `enabled: false` → **401** (`WWW-Authenticate: Bearer`). A comparação é em tempo
  constante e percorre todos os titulares.
- **Não autenticam**: o UUID do perfil local, a origem/CORS, cabeçalhos customizados ou campos do corpo
  (testado: um `profileId` ou `token` no corpo continua 401).
- **CORS não é autenticação.** `allowedOrigins` só controla quais páginas o navegador deixa ler a
  resposta. Origem desconhecida → 403; ausência de origem (curl, servidor) ainda exige o token.
- **Autorização por titular**: cada titular tem cota própria (`dailyTokenBudget`), limite de requisições e
  de simultaneidade. Revogar = `enabled: false` ou remover o hash.
- O IronTrack não ganhou login: o token só é necessário para quem escolhe o modo remoto.

No app, o endereço e o token são digitados na tela do assistente, ficam **só na memória** (nunca em
IndexedDB, localStorage, backup ou logs) e somem ao recarregar ou sair da página.

## 3. Gestão de credenciais

| Credencial | Onde existe | Nunca |
| --- | --- | --- |
| Chaves OpenAI/Anthropic/Gemini | Variáveis de ambiente do processo do gateway (nome em `apiKeyEnv`). | No navegador, no bundle, em `VITE_*`, no repositório, em respostas ou logs. |
| Token de acesso do titular | Com o titular; na memória da página enquanto conectado. | No repositório, no servidor (só o hash), em storage do navegador. |
| Hash do token | Configuração do gateway (arquivo ignorado pelo git). | Em exemplos versionados. |

Proteções testadas: a chave vai só ao provedor certo, no cabeçalho (`Authorization`, `x-api-key` ou
`x-goog-api-key`), nunca na URL; corpos de erro dos provedores (que podem ecoar parte da chave) nunca são
repassados; antes de responder, o gateway confere que nenhuma chave configurada aparece no corpo — se
aparecer, devolve `internal_error`. `.gitignore` bloqueia `.env*` e `services/ai-gateway/config/*.json`
(exceto `*.example.json`). `apiKeyEnv` começando com `VITE_` é recusado. Os testes geram tokens e chaves
falsas na execução: **nenhum token de teste está no repositório**.

## 4. Modelos permitidos

- Cada provedor só existe se estiver em `providers` com `enabled: true`; cada modelo só pode ser usado se
  estiver em `providers.<id>.models` (allowlist exata). Fora disso → 403 `provider_not_allowed` /
  `model_not_allowed`.
- IDs validados por `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` (sem `/`); no Gemini o ID ainda é codificado na rota.
- **Nenhum ID de modelo está fixo no código.** Os exemplos de configuração trazem IDs ilustrativos (um ID
  atual da Anthropic e marcadores `SUBSTITUA-…` para OpenAI e Gemini): confira a documentação oficial de
  cada provedor antes de habilitar, para não usar modelos descontinuados.
- Capacidades no app: modelos remotos declaram só texto com instrução de sistema; JSON estruturado, imagens
  e streaming ficam desligados nesta etapa.
- Sem fallback: falha num provedor não aciona outro (testado).

## 5. Limites de uso

Configuráveis em `limits` (padrões do código; os exemplos usam valores iguais ou menores):

| Limite | Padrão | Efeito |
| --- | --- | --- |
| `maxBodyBytes` | 64 KiB | 413 antes de ler o resto do corpo. |
| `maxMessages` | 6 | 413. |
| `maxInputChars` | 24.000 (e o do modelo) | 413. |
| `maxOutputTokens` | 1.024 (e o do modelo) | 400 se pedir mais; texto acima de `maxOutputTokens × 4` caracteres é cortado e marcado `length`. |
| `requestsPerMinute` | 10 por titular | 429 `rate_limited` + `Retry-After: 60`. |
| `maxConcurrentPerClient` | 2 | 429. |
| `dailyTokenBudget` | 50.000 por titular (dia UTC) | Reserva `entrada estimada + maxOutputTokens` antes da chamada; 429 `quota_exceeded` se ultrapassar; depois troca a reserva pelo consumo real. Falhas mantêm a reserva (o provedor pode ter cobrado). |
| `upstreamTimeoutMs` | 30 s | 504 `timeout`; a chamada ao provedor é abortada. |
| `maxUpstreamResponseBytes` | 256 KiB | 502 `invalid_response`. |

O servidor HTTP também limita cabeçalhos (10 s) e a duração da requisição.

**Implantação distribuída:** `MemoryUsageStore` vale para **uma instância**. Com várias instâncias, cada
uma teria contadores próprios (limites multiplicados) e reinícios zerariam as cotas. Antes de qualquer
implantação com mais de uma instância (ou serverless), implemente `UsageStore` sobre armazenamento
compartilhado com operações atômicas e expiração (ex.: Redis/KV com `INCR`/`EXPIRE`). O limitador em
memória **não** é proteção suficiente nesse cenário.

## 6. Privacidade

- O gateway **não persiste** nada: sem banco, sem arquivos, sem histórico (testado no código-fonte).
- **Logs só com metadados**: horário, ID aleatório da requisição, rota, status, código de erro, titular,
  provedor, modelo, duração e tokens. Nunca prompt, resposta, dados corporais, cabeçalhos, token ou chave
  (testado com marcadores).
- Respostas com `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- OpenAI: `store: false` (a Responses API guarda respostas por padrão).
- **Limitação inevitável:** mesmo com o gateway, **o provedor remoto recebe o conteúdo que o usuário
  autorizar** e o trata conforme as políticas dele (retenção, uso para treinamento em planos gratuitos,
  revisão de abuso). O gateway reduz o que sai (allowlist, limites, nada além das mensagens) mas não
  controla o que o provedor faz depois. A prévia e o aviso do modo remoto dizem isso ao usuário.

## 7. Fluxo de consentimento

Mantido do Prompt 05: `prepare → prévia → createConsent → execute`.

1. Modo remoto, gateway conectado, **provedor e modelo escolhidos explicitamente** (nada é pré-selecionado;
   provedor sem chave no servidor aparece desabilitado).
2. `prepare` congela a solicitação e assina (SHA-256) destino, provedor, modelo, finalidade, categorias,
   mensagens e limite. Desde o P06 o **destino** (`<origem do gateway> → <provedor>`) entra na assinatura.
3. A prévia mostra provedor (selo "remoto"), modelo, **destino**, finalidade, categorias, dados
   efetivamente incluídos, o conteúdo exato e o aviso de compartilhamento externo. O botão vira
   "Autorizar e enviar".
4. A autorização vale para essa solicitação, uma vez. Reconectar a outro gateway, desconectar, trocar
   provedor/modelo/pergunta/categorias ou mudar os dados invalida a prévia ou a execução.
5. O gateway não pode pedir categorias adicionais: ele só recebe mensagens prontas e só devolve texto, que
   o app exibe como texto puro, sem executar nada.
6. Fotos, IDs internos e o banco completo continuam fora (regras do `ContextBuilder`).
7. Histórico: cada pergunta vai sozinha; a conversa fica só na memória. O contrato aceita mensagens
   anteriores (`assistant`), mas o app não as envia; se um dia enviar, elas terão de aparecer na prévia.

## 8. Integração com OpenAI

Responses API, conforme a referência oficial consultada em 27/10/2026
([developers.openai.com — responses.create](https://developers.openai.com/api/reference/python/resources/responses/methods/create)).

- `POST /v1/responses`, `Authorization: Bearer <chave>`.
- Corpo: `model`, `instructions` (sistema), `input` (`role` + `content` texto), `max_output_tokens`
  (mínimo 16 pela API; o gateway eleva valores menores e corta a saída no limite pedido), `store: false`.
- Resposta: texto = itens `output[]` do tipo `message` com conteúdo `output_text`. `status: completed` →
  `stop`; `incomplete` + `max_output_tokens` → `length`; `content_filter` ou item `refusal` →
  `content_filtered`; `failed` → `provider_failure`; outros → `invalid_response`. Uso:
  `usage.input_tokens`/`output_tokens`.
- Itens de raciocínio são ignorados. Em modelos de raciocínio, `max_output_tokens` inclui o raciocínio:
  limite baixo pode resultar em texto vazio (→ `invalid_response`).

## 9. Integração com Anthropic

Messages API, conforme a referência oficial consultada em 27/10/2026
([platform.claude.com — Messages](https://platform.claude.com/docs/en/api/messages),
[Versions](https://platform.claude.com/docs/en/api/versioning)).

- `POST /v1/messages`, cabeçalhos `x-api-key` e `anthropic-version` (obrigatório na configuração; exemplo
  `2026-10-21`, a versão mais recente documentada; `2023-06-01` continua aceita).
- Corpo: `model`, `max_tokens` (obrigatório), `system` em campo próprio, `messages` alternando
  `user`/`assistant` a partir de `user` (papéis repetidos são unidos; começar por `assistant` → 400).
  Não enviamos `temperature`/`top_p`/`top_k` (removidos na versão 2026-10-21).
- Resposta: blocos `content[]` do tipo `text` concatenados. `stop_reason`: `end_turn`/`stop_sequence` →
  `stop`; `max_tokens`/`model_context_window_exceeded` → `length`; `refusal` → `content_filtered`;
  `tool_use`/`pause_turn` (recursos não usados) → `invalid_response`. Uso: `usage.input_tokens`/`output_tokens`.

## 10. Integração com Gemini

`models.generateContent` (v1beta), conforme a referência oficial consultada em 27/10/2026
([ai.google.dev — generate-content](https://ai.google.dev/api/generate-content)).

- `POST /v1beta/models/{model}:generateContent`, chave no cabeçalho `x-goog-api-key` (a documentação também
  mostra `?key=`, que **não** usamos para a chave não aparecer em URLs e logs).
- Corpo: `systemInstruction.parts[].text`, `contents[]` com papéis `user`/`model` (o `assistant` interno
  vira `model`) e `parts[].text`, `generationConfig.maxOutputTokens`.
- Resposta: `candidates[0].content.parts[].text` (partes `thought: true` ignoradas). `finishReason`: `STOP` →
  `stop`; `MAX_TOKENS` → `length`; `SAFETY`, `RECITATION`, `LANGUAGE`, `BLOCKLIST`, `PROHIBITED_CONTENT`,
  `SPII` e `promptFeedback.blockReason` → `content_filtered`; demais → `invalid_response`. Uso:
  `usageMetadata.promptTokenCount`/`candidatesTokenCount`.
- A documentação atual do Google também apresenta a nova **Interactions API**; o `generateContent`
  continua documentado como API principal. Rever na homologação.

Erros HTTP dos três provedores: 401/403 → `provider_unavailable` (chave recusada); 413 → `payload_too_large`;
400, 404, 429, 5xx, 529 e falha de rede → `provider_failure`. **Sem nova tentativa automática.**

## 11. Limitações de Ollama

`src/modules/ai/adapters/OllamaProvider.ts` define o contrato (`POST /api/chat`, `stream: false`,
`options.num_predict`; resposta `message.content`, `done_reason`, `prompt_eval_count`, `eval_count`) e
`validateLocalEndpoint`. **Não está registrado na interface** nesta etapa. Regras e motivos:

- Endereço sempre digitado pelo usuário; **sem endereço padrão, sem descoberta, sem varredura de portas**.
- Só loopback (`localhost`, `127.0.0.1`, `[::1]`); outros aparelhos da rede ficam fora.
- A versão publicada é **HTTPS** (GitHub Pages): chamar `http://localhost` é conteúdo misto e esbarra nas
  regras de acesso à rede privada dos navegadores (Private Network Access), que variam e podem bloquear ou
  exigir permissão.
- **CORS**: o Ollama precisa liberar a origem do IronTrack (`OLLAMA_ORIGINS`); nunca recomendar `*`.
- Servidores em outros aparelhos exigiriam HTTPS com certificado válido e confirmação explícita do destino
  (um endereço errado entrega dados a outro aparelho).
- Mesmo local, cada envio continua exigindo prévia e autorização (o destino aparece na prévia).

## 12. Execução local

Requisitos: Node 22.18+ (TypeScript nativo). Nenhuma dependência extra.

```bash
cp services/ai-gateway/config/development.example.json services/ai-gateway/config/development.json
npm run gateway:token -- meu-celular        # guarde o token; cole o trecho em "clients"
# edite development.json: "enabled": true, habilite UM provedor e o ID do modelo correto
export AI_GATEWAY_CONFIG=services/ai-gateway/config/development.json
export ANTHROPIC_API_KEY=...                 # só no shell do gateway; nunca VITE_*
npm run gateway:dev                          # ouve em http://127.0.0.1:8787
npm run dev                                  # app em http://localhost:5173/IronTrack/
```

No app: **Assistente IA › Remoto via gateway**, endereço `http://127.0.0.1:8787`, token, **Conectar**,
escolha provedor e modelo, selecione dados, **Revisar e enviar**, confira a prévia e **Autorizar e enviar**.
Sem arquivo, com arquivo inválido ou `enabled: false`, o gateway sobe **bloqueado** (503 em tudo).
Fora do loopback ele só escuta com `exposeBeyondLoopback: true`.

Observação: o app publicado (HTTPS) não consegue usar um gateway `http://` de outro host; use o app local
(`npm run dev`/`preview`) para desenvolvimento.

## 13. Testes

| Suíte | Comando | Conteúdo |
| --- | --- | --- |
| Gateway | `npm run test:gateway` | 76 testes (`services/ai-gateway/tests`): os 18 cenários obrigatórios, adaptadores, configuração e integração com provedores simulados em sockets locais. |
| Unitários do app | `npm test` | Provedor remoto, Ollama, transporte, tela no modo remoto, arquitetura (rede só no transporte, sem redirect/cookies, gateway independente). |
| E2E | `npm run test:e2e` | `e2e/assistant-gateway.spec.ts`: o **gateway real** sobe dentro do teste com um provedor simulado local; celular 360 px e desktop. |

### 13.1 Cenários obrigatórios do gateway (`tests/gateway.test.ts`)

1 sem autenticação · 2 credencial inválida · 3 credencial válida · 4 provedor não permitido · 5 modelo não
permitido · 6 entrada inválida · 7 entrada excessiva · 8 limite de consumo · 9 limite de requisições ·
10 tempo limite · 11 cancelamento · 12 falha do provedor · 13 resposta inválida · 14 sem vazamento de
credenciais · 15 sem dados pessoais em logs · 16 endpoints arbitrários bloqueados · 17 falha segura sem
configuração · 18 falha segura sem segredo do provedor.

### 13.2 Adaptadores (`tests/adapters.test.ts`)

Mapeamento de mensagens e modelos, respostas textuais, motivos de parada, erros HTTP, cancelamento, limite
de bytes, corpo não JSON, falha de rede e recursos não suportados (ferramentas, recusa, JSON).

### 13.3 Interface

Simulado como padrão, seleção explícita, aviso de destino remoto, prévia com conteúdo exato, consentimento
único, cancelamento, gateway indisponível, token recusado, provedor indisponível, cota, nenhuma chamada
remota sem autorização, nada persistido e o modo simulado offline sem regressão.

### 13.4 Homologação real — PENDENTE

Não havia credenciais nem ambiente autorizado. Para homologar cada provedor: chave de teste com teto de
gasto no painel do provedor, configuração local com só aquele provedor e um modelo atual, uma pergunta
**sem dados pessoais** e conferência de: resposta, `finishReason`, uso de tokens, erro com chave inválida e
tempo limite. Registrar o resultado aqui. Até lá, a integração real **não é considerada homologada**.

## 14. Estratégia de implantação futura

Nada foi implantado. Antes de expor o gateway fora do aparelho do desenvolvedor:

1. **HTTPS** obrigatório, terminado por proxy/plataforma confiável; `allowedOrigins` só com
   `https://adrielbr25.github.io`.
2. **`UsageStore` compartilhado** (Redis/KV) para cotas e limites; teste de concorrência.
3. Credencial por titular (uma por pessoa/aparelho), revogação documentada, rotação periódica.
4. **Teto de gasto** configurado no painel de cada provedor, além da cota do gateway; alertas de custo.
5. Logs de metadados com retenção curta; monitorar 401/429 em excesso.
6. Plataforma: um contêiner pequeno (o código já é um servidor Node) ou adaptar `handle` a uma função
   serverless — nesse caso, armazenamento compartilhado é obrigatório.
7. Variáveis de ambiente/segredos da plataforma para as chaves; nunca no repositório nem no build da PWA.
8. Revisão de segurança e homologação real (seção 13.4) antes de habilitar para uso.
9. Um eventual login no futuro substituiria os tokens estáticos por tokens de curta duração emitidos após
   autenticação, sem mudar o contrato das rotas.

## 15. Riscos de custo e abuso

| Risco | Mitigação atual | Pendência |
| --- | --- | --- |
| Uso anônimo da chave | Token obrigatório; CORS não autentica; bloqueado por padrão. | — |
| Token vazado | Cota diária e limite por titular; revogação por `enabled: false`; token não é persistido no app. | Rotação; tokens de curta duração com login. |
| Consumo ilimitado | Reserva de cota antes da chamada; limites de entrada/saída; simultaneidade. | Teto no painel do provedor. |
| Várias instâncias | — | `UsageStore` compartilhado obrigatório. |
| Requisições excessivas | Limite por minuto, corpo máximo, tempo limite, limites do servidor HTTP. | Limite por IP na borda (proxy). |
| Endpoints arbitrários / SSRF | Rotas fixas; endereços oficiais fixos no código; `baseUrl` só pelo operador (https ou loopback); corpo estrito. | — |
| Vazamento de credenciais | Chaves só no ambiente do servidor; corpo de erro do provedor descartado; checagem final da resposta; logs sem cabeçalhos. | — |
| Respostas enormes | Limite de bytes no gateway e no app; corte por `maxOutputTokens`. | — |
| Dados pessoais no provedor | Prévia, consentimento por solicitação, minimização, aviso explícito. | Depende das políticas de cada provedor. |
| Redirecionamento para outro destino | App usa `redirect: 'error'`, `credentials: 'omit'`, `no-referrer`. | — |
