# Assistente de IA — uso real (IronTrack 2.0 F01 / P20)

Complementa [IA_ARQUITETURA.md](IA_ARQUITETURA.md) (§17–19), [IA_GATEWAY.md](IA_GATEWAY.md) e
[IA_HOMOLOGACAO.md](IA_HOMOLOGACAO.md). As regras de privacidade e consentimento **não mudaram**: cada pergunta remota
continua passando pela prévia com o conteúdo exato e por uma autorização de uso único.

## 1. Conexão simplificada (modo remoto) — ajuste do Prompt 20

Na tela `/assistente`, com **Remoto via gateway**, o fluxo é **Provedor → Obter chave ou autenticar → Conectar →
Modelo → Conversar**, sem digitar endereço:

1. **Provedor** (obrigatório antes de conectar), entre os três que o gateway sabe chamar
   (`integrations/ai/providerPresets.ts`, mesmos IDs de `services/ai-gateway/src/config.ts`):

   | Provedor | Página oficial de chaves | API oficial (usada só pelo gateway) | Variável no gateway |
   | --- | --- | --- | --- |
   | OpenAI | https://platform.openai.com/api-keys | https://api.openai.com/v1 | `OPENAI_API_KEY` |
   | Anthropic / Claude | https://console.anthropic.com/settings/keys | https://api.anthropic.com | `ANTHROPIC_API_KEY` |
   | Google Gemini | https://aistudio.google.com/app/apikey | https://generativelanguage.googleapis.com | `GEMINI_API_KEY` |

2. **Obter chave de API**: link fixo para a página oficial (nova aba, `rel="noopener noreferrer"`,
   `referrerpolicy="no-referrer"`, sem parâmetros; o teste de arquitetura trava a lista de URLs). Instruções curtas
   explicam como gerar a chave e **onde colocá-la: no servidor seguro (variável acima), nunca no app**.
3. **Token de acesso ao servidor do IronTrack**: o ÚNICO campo de credencial. Máscara, mostrar/ocultar, colar,
   explicação do tipo esperado, validação (vazio, formato de 43+ caracteres base64url) e mensagens claras. Uma **chave
   de provedor** colada aqui (`sk-…`, `sk-ant-…`, `AIza…`, reconhecida pelo formato) é recusada antes de qualquer
   rede e o campo é limpo: chave de provedor e token do gateway não são intercambiáveis. Conectar pode ser
   **cancelado**. O token fica só na memória (como antes).
4. **Conectar** consulta só o catálogo (`GET /v1/models`) no endereço resolvido automaticamente (§1.1).
5. **Modelo**: só os modelos que o catálogo do gateway lista para o provedor escolhido; nenhum ID é inventado e nada
   é pré-selecionado. Provedor oferecido sem chave no servidor aparece como indisponível, com o seletor desativado e
   sem opções; provedor não oferecido pelo servidor tem aviso próprio.
6. **Começar a conversar** leva ao campo de pergunta. Cada pergunta continua com prévia e autorização de uso único.

**Não existe cadastro de chave pessoal de provedor no app.** O prompt condicionava isso a um mecanismo seguro no
backend (recebimento com consentimento, sem persistência insegura, sem exposição no frontend); ele **não foi
implementado** nesta etapa, então o app não pede nem aceita chave de provedor. A chave é configurada pelo operador no
gateway, como desde o P06.

### 1.1 Endereço automático do servidor seguro (`integrations/ai/gatewayEndpoint.ts`)

Ordem de resolução, sempre validada (`validateGatewayUrl`: HTTPS, ou HTTP só em loopback; só a origem, sem usuário,
caminho ou parâmetros) e recusando os hosts das APIs dos provedores (o navegador nunca fala com o provedor):

1. **Configurações avançadas** (recolhidas, no fim do cartão): origem salva neste aparelho em
   `localStorage['irontrack.aiGateway.v1'] = {"v":1,"origin":"https://…"}`. Só a origem pública; nunca token ou chave.
   "Esquecer endereço" apaga. Trocar o endereço desconecta. Fora do IndexedDB e do backup.
2. **Configuração pública da publicação**: `VITE_AI_GATEWAY_URL` no build (um endereço, não um segredo). Para ligar,
   acrescente ao passo "Build" de `.github/workflows/deploy.yml` `VITE_AI_GATEWAY_URL: ${{ vars.AI_GATEWAY_URL }}` e
   crie a variável de repositório `AI_GATEWAY_URL`. **Hoje não está configurada.**
3. Nenhum: a tela mostra "Para conectar uma IA real, é necessário configurar o servidor seguro do IronTrack.", o
   estado **Servidor não configurado** e o botão **Configurar servidor** (abre o avançado). Nenhuma requisição.

O IronTrack nunca recebe nem guarda chave de provedor: as chaves ficam só no gateway (variáveis do servidor). Não há
`VITE_` com segredo, nada no bundle, token nunca em localStorage/IndexedDB/backup/URL/logs, e nada disso vai ao
ContextBuilder.

## 2. Estados da conexão

`assistantStatus` (puro) e o selo **Estado** no topo da tela:

| Estado | Quando |
| --- | --- |
| Local | Modo simulado/local. Nada sai do aparelho. |
| Conectado | Gateway conectado e provedor disponível. |
| Servidor não configurado | Modo remoto sem endereço de gateway resolvido (ajuste P20). |
| Não conectado | Endereço resolvido, mas ainda sem conectar. |
| Falha de autenticação | Gateway recusou o token (`access_denied`); o token é esquecido. |
| Gateway inacessível | Rede/endereço (`gateway_unreachable`), na conexão ou na última pergunta. |
| Provedor indisponível | Provedor sem chave no servidor, chave recusada, cota/faturamento (429 do provedor), falha, bloqueio de conteúdo ou modelo não suportado. |

## 3. Conversa

- **Limpar conversa**: apaga as mensagens da memória (nada estava gravado).
- **Cancelar**: interrompe a pergunta em andamento (o gateway aborta a chamada ao provedor).
- **Desconectar**: esquece token e provedores remotos e volta ao formulário (o endereço resolvido continua).
- **Sessão em memória**: conexão e conversa sobrevivem à navegação dentro do app (ex.: ir ao treino e voltar), para os
  atalhos fazerem sentido. Continua sem persistência: recarregar ou fechar o app apaga tudo, e após **30 min sem uso** o
  token e a conversa são esquecidos sozinhos (`features/assistant/assistantSession.ts`). Mudança em relação ao P06,
  em que sair da tela já esquecia tudo.

## 4. Metas no contexto

Nova categoria **Metas** (`training_goals`), desmarcada por padrão como as demais e sujeita à mesma prévia e
autorização. Entram só metas ativas ou pausadas (até 10): título, tipo, alvo, unidade, valor atual, progresso (%),
estado, prazo e nome do exercício. Nunca IDs, perfil ou observações. Sem metas, a categoria aparece como "sem dados".
A leitura passa só por `integrations/ai/contextSources.ts` (`listGoals`), verificado no teste de arquitetura.

## 5. Respostas locais do catálogo

Perguntas que citam um exercício do catálogo (nome ou apelido) sobre execução, músculos, erros comuns ou cuidados são
respondidas **no aparelho**, com o texto do próprio catálogo, sem prévia e sem envio. A resposta tem o selo
"Catálogo local", cita a fonte e oferece **Perguntar à IA mesmo assim** (que segue o fluxo normal com prévia).
Funciona offline e no modo local.

## 6. Atalhos

- **Detalhes do exercício** (biblioteca e navegador): "Perguntar ao assistente" abre `/assistente?exercicio=<nome>`
  com a pergunta "Como executar <nome> corretamente?" já preenchida. Nada é enviado sozinho.
- **Treino em andamento**: botão de ajuda (?) no topo abre os detalhes do exercício atual (visual, instruções) e o
  mesmo atalho com `&origem=treino`; o assistente mostra **Voltar ao treino**. O treino continua salvo e o relógio segue.

## 7. O que não foi feito

- O gateway **não foi publicado** e nenhuma infraestrutura paga foi criada. Para usar o modo remoto, é preciso rodar o
  gateway (ver [IA_GATEWAY.md](IA_GATEWAY.md)) com as chaves no servidor e informar o endereço (§1.1). A conexão com
  provedores reais **não foi testada** (sem gateway publicado e sem chaves); os testes usam um gateway real local com
  provedor simulado.
- Sem cadastro de chave pessoal de provedor (§1).
- Sem streaming, sem imagens, sem histórico multi-turno enviado ao provedor (cada pergunta vai sozinha, como antes).
