# Assistente IA central (IronTrack Life — Fase 00)

Fundação da IA central do IronTrack: chat por conta com a **API da OpenAI** pelo servidor, histórico no PostgreSQL,
ferramentas de leitura dos registros reais e propostas de alteração que só são aplicadas com aprovação explícita.
Vale só no modo conta (`VITE_ACCOUNTS=on`). O modo sem conta (GitHub Pages) continua com o assistente anterior.

## 1. Arquitetura

```
app (src/cloud/assistant)                     irontrack-api (services/api/src/assistant)                 OpenAI
┌──────────────────────────┐  POST …/messages  ┌───────────────────────────────────────────┐  Responses API
│ AssistantChatPage        │ ───────────────▶  │ module.ts  rotas, limites, aviso, aprovação│ ─────────────▶
│ useAssistantChat         │ ◀─ text/event-    │ engine.ts  AI Core: contexto + rodadas     │ ◀── SSE ──────
│ Markdown (sem HTML)      │    stream         │ providers/ AI Providers (openai.ts)        │
│ AssistantPrivacyPage     │                   │ tools/     AI Tools (registro por módulo)  │
└──────────────────────────┘                   │ store.ts   AI Conversations / Memory       │
         ▲  sync pull                          └──────────────┬────────────────────────────┘
         └──────────────── PostgreSQL (routines, workout_sessions…, assistant_*) ◀──┘
```

| Conceito | Onde |
| --- | --- |
| AI Core | `services/api/src/assistant/engine.ts` (instruções, histórico, rodadas, execução das ferramentas) |
| AI Providers | `providers/types.ts` (contrato `ChatProvider`) e `providers/openai.ts` |
| AI Context | `tools/records.ts` (leitura filtrada por conta) e as ferramentas de leitura |
| AI Memory | `assistant_memories` + resumo em `assistant_conversations.summary` |
| AI Tools | `tools/registry.ts` (módulos), `tools/training.ts`, `tools/progress.ts` |
| AI Action Approval | `assistant_actions` + `module.ts` (`decide`) + `ActionHandler` de cada módulo |
| AI Conversations | `store.ts`, tabelas `assistant_conversations` e `assistant_messages` |
| Contrato compartilhado | `shared/assistant/protocol.ts` (esquemas Zod das propostas, visões, eventos do streaming) |

A integração Anthropic anterior (`/api/v1/ai/*`, `services/api/src/modules/ai.ts`) **não foi removida**. No modo conta
ela continua acessível em `#/assistente/classico`.

## 2. OpenAI

- API: **Responses** (`POST /v1/responses`), recomendada pela OpenAI para integrações novas e a única com ferramentas
  nos modelos atuais (documentação consultada em 2026-11-05).
- `store: false`; com raciocínio ativo, `include: ["reasoning.encrypted_content"]` para reenviar o raciocínio entre as
  rodadas do mesmo turno sem armazenamento no provedor. Streaming por `response.output_text.delta`; a resposta final
  (`response.completed`) traz as chamadas de função e o uso (`input_tokens`/`output_tokens`).
- Chave: só `OPENAI_API_KEY` no irontrack-api. Nunca vai ao app, a uma resposta ou a um log (há verificação que troca
  qualquer evento que contenha a chave por um erro genérico). Cada pessoa **não** precisa de chave própria.
- Assinatura do ChatGPT não dá acesso à API: a chave vem de platform.openai.com, com créditos da conta da API.
- Modelos permitidos (`services/api/config/assistant.json`): `gpt-6.1-terra` (padrão, esforço `low`), `gpt-6-luna`
  (rápido/barato, esforço `none`, também usado nos resumos) e `gpt-6.1-sol` (análises mais profundas). IDs conferidos
  na página oficial de modelos em 2026-11-05; confirme com o **Testar** (consulta `GET /v1/models/{id}`, sem custo).
  Trocar modelos = editar o JSON ou definir `ASSISTANT_CONFIG_JSON`, sem mexer no código.
- Erros do provedor viram códigos fixos (chave recusada, faturamento, limite, modelo indisponível, rede, tempo);
  o texto do provedor nunca é repassado. Redirecionamentos não são seguidos.

## 3. Contexto pessoal

A cada pergunta o modelo recebe: instruções fixas, data e fuso da pessoa, lista de módulos disponíveis/planejados,
preferências salvas, resumo das mensagens antigas e as mensagens recentes (até 16 / 24.000 caracteres). **Nenhum
registro vai junto automaticamente**: o modelo pede o que precisa pelas ferramentas de leitura, e cada uma devolve só
os campos necessários, sempre da conta da sessão (`user_id`), lendo a cópia sincronizada. O app sincroniza antes de
cada pergunta (até 5 s).

| Ferramenta | O que devolve |
| --- | --- |
| `get_account_overview` | nome de exibição, unidade, contagens, primeiro/último treino |
| `list_routines` / `get_routine` | fichas, treinos e exercícios (com IDs) |
| `list_recent_workouts` / `get_workout_details` | treinos concluídos, séries feitas, volume |
| `list_performed_exercises` | nomes já registrados (para achar "supino") |
| `get_exercise_progress` | por treino: melhor série, 1RM estimada (Epley), reps, volume; resumo e variação |
| `list_goals` | metas com progresso aproximado calculado dos treinos |
| `get_body_measurements` | avaliações corporais e variação (sem fotos) |
| `list_app_modules` | módulos disponíveis e planejados |

Quando não há dados, a ferramenta diz isso (`note`) e as instruções obrigam o modelo a avisar em vez de inventar.

## 4. Escrita com aprovação

Ferramentas de escrita só **preparam** propostas: `propose_create_routine`, `propose_update_routine` (renomear,
descrição, adicionar/renomear/remover treino, adicionar/alterar/remover/mover exercício) e `propose_save_preference`.

1. A pessoa pede; 2. a IA consulta (`get_routine`); 3. a proposta é validada (Zod + IDs reais) e gravada em
`assistant_actions` com a **versão atual** da ficha e a prévia; 4. o app mostra o cartão com a prévia; 5. a pessoa
aprova ou cancela; 6. o servidor revalida dono, estado, prazo (48 h) e versão; 7. aplica numa transação pelo mesmo
caminho da sincronização (`normalizeRecord` + `writeRow`, versão +1, cursor da conta); 8. o app sincroniza e mostra
"Aplicada" e um aviso do app na conversa.

Se a ficha mudou depois da proposta (outro aparelho, edição manual), a aprovação é recusada (`action_stale`) e nada é
sobrescrito. Não existe SQL livre, comando ou URL: só as ferramentas registradas, com argumentos validados; nome
desconhecido ou argumento inválido volta como erro ao modelo sem executar nada.

## 5. Memória e separação de fontes

- Histórico persistente por conta; conversas renomeáveis e apagáveis (uma ou todas).
- Resumo automático depois de 24 mensagens (modelo de resumo), rotulado como "gerado pela IA; NÃO é registro".
- Preferências explícitas (`assistant_memories`): pela tela de Privacidade ou por proposta aprovada.
- As instruções separam REGISTRO (ferramentas), PREFERÊNCIA (salva pela pessoa) e SUGESTÃO (da IA), e mandam conferir
  nas ferramentas em vez de confiar em respostas antigas. Avisos do app (aprovação/cancelamento) entram como
  "[Aviso automático do app]".
- O resultado das ferramentas não é gravado no banco (só o nome da ferramenta e se deu certo).

## 6. Segurança, limites e custos

- Sessão da conta + CSRF em toda rota; tudo filtrado por `user_id`; IDs de outra conta respondem 404.
- E-mail confirmado exigido se `AI_REQUIRE_VERIFIED_EMAIL` não for `false` (mesma regra da IA anterior).
- Aviso de processamento de dados aceito uma vez por conta (versionado); sem ele nada é enviado.
- Limites (configuráveis): 8 mensagens/min, 100 mensagens/dia e 400 mil tokens/dia por conta (PostgreSQL), 1 resposta
  simultânea por conta, 8 no total por instância, até 6 rodadas de ferramentas por resposta, 60 s por chamada e 80 s
  por resposta, saída máxima por modelo, saída de ferramenta cortada em 12 mil caracteres.
- Logs: só `assistant.turn` com modelo, estado, tokens e duração. Nunca conteúdo, chave ou corpo do provedor.
- Exclusão da conta apaga tudo do assistente em cascata.

## 7. Módulos futuros

`tools/registry.ts` declara os contratos. **Ativo desde a Fase 01:** RPG pessoal (hábitos, rotinas, missões,
XP/níveis/conquistas), ver `docs/RPG_DESENVOLVIMENTO.md`. **Ativo desde a Fase 02:** alimentação. **Fase 03:** foto de refeição
(`analyze_meal_photo`, anexo de imagem na mensagem; ver `docs/ALIMENTACAO_FOTO.md`). Ainda `planned`: leitura de rótulos por
foto, leitura e estudos, reflexões e metas pessoais. Para ativar um módulo: criar o arquivo de ferramentas
(`ReadTool`/`WriteTool`), os `ActionHandler` das escritas (com `apply` e `undo`), incluir o tipo em `ActionKind` e no
CHECK de `assistant_actions.kind` (nova migração) e trocar o status para `available`.

**Desfazer (Fase 01):** ao aplicar, o handler devolve `undo` (estado anterior), gravado em `undo_data`. A pessoa pode
desfazer em até 7 dias; se o item mudou depois, a reversão é recusada (`action_undo_stale`). Status final `reverted`.

**Diagnóstico da OpenAI (Fase 01):** Privacidade → "Testar conexão" usa o endpoint existente de teste, que consulta
`GET /v1/models/{modelo}` (gratuito, sem gerar texto) para cada modelo configurado e informa se a chave do servidor tem acesso.

## 8. Interface

`#/assistente` (modo conta): chat com streaming, Markdown seguro (elementos React, links só http/https em nova aba),
indicador de processamento com a ferramenta em uso, parar resposta, erros elegantes, contador para mensagens longas,
seleção de modelo, lista de conversas (abrir, renomear, apagar), cartão de proposta com prévia e aprovação, botão de
câmera para anexar 1 foto de refeição por mensagem (Fase 03; a foto não é guardada, só a marca de que houve foto).
`#/assistente/privacidade`: detalhes do processamento, preferências salvas, apagar conversas e preferências.

## 9. Testes

- `services/api/tests/assistant.test.ts` (PostgreSQL real, OpenAI simulada por `fetch` falso no formato SSE da
  Responses API): formato da chamada, streaming, persistência, leitura de registros reais, isolamento entre contas,
  proposta/aprovação/cancelamento/versão desatualizada, ferramentas não autorizadas, memórias, limites, erro 401.
- `e2e-cloud/assistant.spec.ts`: navegador real contra a API com OpenAI simulada em HTTP local.
- Nenhuma chamada real ou paga à OpenAI foi feita. A validação com a chave real está pendente.
