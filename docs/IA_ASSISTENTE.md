# Assistente de IA — uso real (IronTrack 2.0 F01 / P20)

Complementa [IA_ARQUITETURA.md](IA_ARQUITETURA.md) (§17–19), [IA_GATEWAY.md](IA_GATEWAY.md) e
[IA_HOMOLOGACAO.md](IA_HOMOLOGACAO.md). As regras de privacidade e consentimento **não mudaram**: cada pergunta remota
continua passando pela prévia com o conteúdo exato e por uma autorização de uso único.

## 1. Passo a passo de configuração (modo remoto)

Na tela `/assistente`, com **Remoto via gateway**, o cartão "Configurar" mostra os passos e o estado de cada um:

1. **Modo**: Local (simulado + catálogo) ou Remoto via gateway.
2. **Provedor** desejado (opcional): OpenAI (Responses API), Anthropic (Messages API) ou Google Gemini. Só os que o
   gateway suporta. Se o gateway oferecer e houver chave no servidor, ele é escolhido sozinho depois de conectar; se
   não oferecer, a tela avisa.
3. **Endereço** do gateway (HTTPS, ou HTTP só em loopback para desenvolvimento).
4. **Autenticação**: token do gateway (campo de senha, limpo após conectar, guardado só na memória). **Conectar**
   consulta só o catálogo do gateway (`/v1/catalog`), sem enviar pergunta nem dados.
5. **Testar conexão**: depois de conectado, refaz a consulta ao catálogo a qualquer momento e mostra o resultado
   (provedores e modelos atualizados, ou o estado de erro).
6. **Modelo**: escolhido da lista do catálogo, sem pré-seleção.
7. **Confirmar**: resumo (provedor, modelo e gateway) e **Começar a conversar**, que leva ao campo de pergunta.

O IronTrack nunca recebe nem guarda chave de provedor: as chaves ficam só no gateway (variáveis do servidor). Não há
`VITE_` com segredo, nada no bundle, nada em localStorage/IndexedDB/backup.

## 2. Estados da conexão

`assistantStatus` (puro) e o selo **Estado** no topo da tela:

| Estado | Quando |
| --- | --- |
| Local | Modo simulado/local. Nada sai do aparelho. |
| Conectado | Gateway conectado e provedor disponível. |
| Não configurado | Modo remoto sem gateway conectado. |
| Falha de autenticação | Gateway recusou o token (`access_denied`); o token é esquecido. |
| Gateway inacessível | Rede/endereço (`gateway_unreachable`), na conexão ou na última pergunta. |
| Provedor indisponível | Provedor sem chave no servidor, falha, limite, bloqueio de conteúdo ou modelo não suportado. |

## 3. Conversa

- **Limpar conversa**: apaga as mensagens da memória (nada estava gravado).
- **Cancelar**: interrompe a pergunta em andamento (o gateway aborta a chamada ao provedor).
- **Desconectar**: esquece token e provedores remotos e volta ao estado não configurado.
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
  gateway (ver [IA_GATEWAY.md](IA_GATEWAY.md)) com as chaves no servidor.
- Sem streaming, sem imagens, sem histórico multi-turno enviado ao provedor (cada pergunta vai sozinha, como antes).
