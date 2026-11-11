# Conhecimento: leitura, estudos e foco (IronTrack Life, Fase 04)

Contrato: `irontrack.life.knowledge.v1` (`shared/knowledge/protocol.ts`). Servidor: `services/api/src/knowledge/`
(serviço + rotas `/api/v1/knowledge/*`). App: `src/cloud/knowledge/`. Só no modo conta (PostgreSQL, por conta).

## 1. Telas

| Rota | O que tem |
| --- | --- |
| `/conhecimento` | Painel do dia: leitura/estudo de hoje, XP do dia, metas, livros em andamento, matérias da semana, últimos 7 dias, sessões recentes, iniciar sessão, registro manual |
| `/conhecimento/biblioteca` | Estante com capas, filtros por status e categoria, busca, adicionar livro |
| `/conhecimento/livro/:id` | Progresso, ritmo e previsão, ler agora, registrar, atualizar página, notas/trechos/reflexões, avaliação e resenha (livro concluído), sessões |
| `/conhecimento/estudos` | Matérias com tempo da semana, meta semanal e tópicos |
| `/conhecimento/materia/:id` | Tópicos (pendente → estudando → concluído), notas, histórico, arquivar/excluir |
| `/conhecimento/foco` | Escolher livro/matéria/tópico/atividade e o modo: cronômetro livre, temporizador ou pomodoro; tela mínima em andamento; encerrar com página e nota; resumo |
| `/conhecimento/metas` | Metas diárias/semanais/por prazo, vínculo com hábito ou missão, "pôr na rotina" |
| `/conhecimento/estatisticas` | Minutos por dia, horas por semana, páginas acumuladas, tempo por matéria, constância mensal, livros concluídos, horários |

Acesso: cartão "Conhecimento" no Início e grupo "Conhecimento" em Mais. A capa do livro é uma foto reduzida no aparelho
(até 360 px, JPEG, < 150 KB, guardada como data URL) ou uma capa gerada com a cor do título: nenhuma API externa.

## 2. Dados (migração `0006_knowledge.sql`)

`knowledge_books`, `knowledge_subjects`, `knowledge_topics`, `knowledge_sessions` (id de cliente único, trechos em
`segments`, páginas antes/início/fim, `module` + `ref`), `knowledge_timers` (um por conta), `knowledge_notes`,
`knowledge_goals` (hábito OU missão). Todas com `user_id` e consultas sempre filtradas pela conta. A migração também
amplia os CHECKs de `life_xp_events.source` (`knowledge`) e de `assistant_actions.kind` (7 tipos novos). Datas do
dia seguem o fuso da pessoa (`?tz=`), como no restante do RPG.

## 3. Cronômetro e tempo ativo

O **servidor** marca início, pausa e retomada com o próprio relógio e guarda o estado (um cronômetro por conta, visível
em qualquer aparelho). O app manda um sinal de presença (`seen`) a cada 60 s enquanto a tela está aberta e na hora em
que ela volta a ficar visível. O tempo que conta é calculado por `computeActive` (função pura, a mesma no app e no
servidor):

- trechos com presença (cada sinal cobre 150 s) contam inteiros;
- cada trecho **sem** presença (tela bloqueada, aba fechada, sem rede) conta até 60 min (no pomodoro/temporizador, até
  o tempo planejado da fase) e o resto fica de fora (`excludedSec`). Ler livro de papel com a tela apagada vale; um
  cronômetro esquecido não vira horas de estudo;
- teto de 6 h por sessão; pausas e pausas do pomodoro nunca contam;
- sem sinal há 12 h, a sessão aparece como **interrompida**: dá para retomar, salvar (com o tempo que valeu) ou descartar;
- ao encerrar, a pessoa só pode **reduzir** os minutos ("parei antes"); menos de 1 min só salva com páginas informadas;
- encerrar é idempotente (reenviar devolve a mesma sessão).

Sem conexão, pausa/retomada/presença entram numa fila no aparelho (`irontrack.knowledge.timer.v1`, com o horário do
servidor estimado) e são reenviadas quando a conexão volta; o servidor limita cada horário ao intervalo válido. Pomodoro
e temporizador mudam de fase pelos horários: se o app estava fechado, o foco termina no horário planejado, nunca depois.
Som e vibração opcionais no fim da fase. Recarregar a página recupera tudo do servidor.

## 4. Metas

Métricas: minutos, páginas, sessões, dias (por semana) e terminar livro (por prazo). Escopo: leitura, estudo, foco ou
qualquer; opcionalmente um livro ou uma matéria. O progresso é calculado das sessões reais do período. Meta vinculada a
um **hábito** registra o hábito quando cumprida; vinculada a uma **missão**, cada sessão que conta alimenta a missão (uma
entrada por sessão, `source_key = knowledge:session:<id>`). "Pôr na rotina" cria um item com horário numa rotina da
Fase 01 (nova ou existente).

## 5. XP (RPG)

Fonte `knowledge` no motor do RPG (`grant`/`reverse`, idempotente por chave, dentro do teto diário geral de 400 XP).

| Evento | XP | Chave |
| --- | --- | --- |
| Sessão do cronômetro ≥ 10 min | 5 + 1 a cada 3 min, máx. 30 | `knowledge:session:<id>` |
| Registro manual | metade, máx. 10, só hoje/ontem, máx. 20/dia | `knowledge:manual:<id>` |
| Sessões no dia (módulo) | máx. 90 | — |
| Meta cumprida | diária 10, semanal 30, por prazo 40 (0 se vinculada a hábito/missão: o XP vem de lá) | `knowledge:goal:<id>:<início do período>` |
| Livro concluído (≥ 30 min lidos nele) | 40 | `knowledge:book:<id>` |

Atributo: Conhecimento; foco sem livro nem matéria vai para Disciplina. Excluir sessão/livro/meta ou reabrir livro
estorna. Conquistas: "100 minutos de leitura" passa a contar sessões de leitura (sem contar duas vezes o mesmo tempo
registrado também num hábito/missão), mais "Primeiro livro concluído" e "10 horas de estudo".

## 6. IA

Módulo `knowledge` em `services/api/src/assistant/tools/knowledge.ts`. Leitura: `list_books`, `get_book_progress`,
`list_reading_sessions`, `list_subjects`, `get_study_history`, `get_knowledge_goals`, `get_focus_stats`,
`get_knowledge_notes`. Escrita (sempre proposta → aprovação → desfazer): criar livro, atualizar progresso, criar
matéria, criar tópicos, plano de estudo (matéria + tópicos + meta), ajustar metas, adicionar atividade a missão,
organizar a rotina de leitura. As instruções proíbem inventar leituras/progresso e copiar trechos longos de obras
protegidas; a IA pode explicar, resumir as notas da própria pessoa, criar exercícios e sugerir revisões.

## 7. Estatísticas

`GET /knowledge/stats?from&to` devolve só dias **com** registro; médias usam esses dias. Semanas, meses (constância =
dias com registro / dias do mês no intervalo), tempo por matéria, livros concluídos, metas cumpridas, melhor sequência e
distribuição por hora.

## 8. Preparação para a Fase 05 (Bíblia) — implementada: ver docs/BIBLIA.md

Sessões, cronômetro, metas e notas têm `module` (`knowledge` | `bible`) e `ref` livre. A Bíblia poderá reutilizar o
cronômetro, as metas por minutos/dias, o histórico e as notas sem nova estrutura. Nada de traduções ou importação de texto
nesta fase.

## 9. Limitações conhecidas

- Sem notificação do sistema quando o pomodoro troca de fase com o app fechado (o app ajusta ao voltar).
- O tempo sem presença é uma regra conservadora: quem lê no papel por mais de 1 h com a tela bloqueada precisa abrir o
  app de vez em quando, ou corrigir com registro manual.
- Capa só por foto do aparelho (sem busca automática de capas/ISBN, de propósito).
- Estatísticas por hora usam o horário de início da sessão.
