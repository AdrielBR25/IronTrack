# RPG de desenvolvimento pessoal (IronTrack Life — Fase 01)

Só no **modo conta** (`VITE_ACCOUNTS=on` + API). Sem conta, o app continua exatamente como antes (navegação de 6 itens).

## 1. Visão geral

- **Personagem** por conta (`life_profiles`): XP total, nível, título, fuso horário, meta semanal de treinos,
  sequência (atual/melhor) e 5 atributos (`life_attributes`): Força, Conhecimento, Disciplina, Saúde, Espiritualidade.
- **Hábitos** (`life_habits`, `life_habit_logs`): diários, dias da semana ou N vezes por semana; meta numérica opcional,
  horário, atributo, XP dentro de limites; pausar, editar, arquivar.
- **Rotinas** (`life_routines`, `life_routine_items`, `life_routine_checks`): matinal, estudos, treino, noturna ou
  personalizada. Um item pode apontar para um hábito ou missão: marcar o item registra o hábito/missão (XP uma vez só).
- **Missões** (`life_missions`, `life_mission_entries`): diárias, semanais, personalizadas e especiais. Missões do
  sistema são geradas de forma idempotente por (modelo, data de início).
- **Conquistas** (`life_achievements`): primeira missão, 7 dias de hábitos, 10 treinos, 100 min de leitura (fica
  indisponível até existir registro de leitura em minutos) e sequência de 7 dias.
- **Dias de descanso** (`life_day_marks`): pausam as missões diárias do dia sem quebrar a sequência.

## 2. Motor de recompensas (`services/api/src/life/engine.ts`)

Único lugar que mexe em XP. Toda operação roda em `lifeTx`: transação PostgreSQL que começa com `SELECT … FOR UPDATE`
no perfil da conta (serializa a conta, sem bloquear outras).

- **Livro-razão** `life_xp_events`: linhas `grant` e `reversal`. Nada é apagado; estorno é uma linha negativa ligada
  ao ganho. Índice único parcial: um ganho ativo por `source_key` (`habit:<id>:<dia>`, `mission:<id>`,
  `workout:<id>`, `routine:<id>:<dia>`, `achievement:<code>`, `legacy:workouts`) → idempotência mesmo com
  requisições simultâneas.
- **Limites**: XP por atividade com teto (hábito 5–50, missão por tipo, rotina com bônus fixo); **teto diário de 400 XP**
  para hábito/missão/treino/rotina (conquista e bônus de histórico ficam fora). O excedente é registrado como
  `requested` > `amount` para auditoria.
- **Missões**: o progresso é derivado dos ganhos ativos do período; ao atingir a meta gera o ganho; se o progresso cair
  (desmarcar hábito, treino apagado) o ganho é estornado.
- **Hábitos**: só hoje ou ontem (`life_date_not_allowed`); dia não programado ou cota semanal cumprida registram sem XP.
- **Conquistas**: permanentes, 30 XP, nunca estornadas.

## 3. Progressão

- Nível: XP para passar do nível L = `50L + 50`; acumulado até L = `25(L−1)(L+2)`. Máximo 100.
- Atributo: `30L + 30`; acumulado `15(L−1)(L+2)`.
- Títulos automáticos nos níveis 1, 3, 5, 10, 15, 20, 30, 40, 50; a pessoa pode escolher qualquer título já liberado.
- Atributos medem atividades registradas; **não** são avaliação clínica, física ou psicológica.

## 4. Treinos

Reconciliados ao abrir o Início e em `POST /api/v1/life/reconcile` (o app chama depois da sincronização). Um treino
gera XP só se terminou depois da ativação do RPG, começou no máximo 1 dia antes dela e tem ao menos 1 série válida
concluída (sem aquecimento): `40 + min(30, 2 × séries)`, chave `workout:<id>`. Editar o treino não gera XP de novo;
apagar ou deixar de estar concluído estorna. Treinos antigos rendem um bônus único de 5 XP cada (máx. 500).

## 5. Dias e fuso

Cada conta tem `timezone` (IANA). O "dia" de todo registro, missão e sequência é calculado nesse fuso; o app envia o
fuso do aparelho na primeira carga e a pessoa pode trocar em Evolução → Ajustes. Trocar o fuso não recalcula dias
passados.

## 6. API (`/api/v1/life`)

`GET dashboard?tz=`, `POST reconcile`, `GET/PATCH profile`, `habits` (CRUD, `:id/log`, `:id/history`), `routines`
(CRUD, `:id/items/:itemId/check`), `missions` (CRUD, `:id`, `:id/entries`), `POST days/:date/rest`, `GET xp`,
`GET achievements`. Mutações devolvem `{…, outcome, profile}` (`outcome` lista XP ganho/estornado, subidas de nível e
conquistas, usado na animação). Erros: `life_stale` (409, versão mudou), `life_inactive`, `life_date_not_allowed`,
`life_limit`. Tudo filtrado por `user_id`; IDs de outra conta respondem 404; exclusão da conta apaga em cascata.

## 7. IA

Leitura: `get_rpg_profile`, `list_life_missions`, `list_habits`, `list_life_routines`, `get_life_progress`,
`list_achievements`. Escrita só por proposta aprovada (fluxo da Fase 00): `propose_create_habit`,
`propose_update_habit`, `propose_create_life_routine`, `propose_update_life_routine`, `propose_create_missions`,
`propose_update_mission`. A IA **nunca concede XP**: o valor das missões propostas é calculado pelo servidor e
registrar/concluir continua sendo ação da pessoa. Toda alteração aprovada pode ser **desfeita** em até 7 dias
(`POST /assistant/actions/:id/undo`), recusado se o item mudou depois.

## 8. Interface

Navegação do modo conta: Início, Missões, Evolução, IA, Mais (`src/cloud/life/nav.ts`). O antigo Início de treino
foi para `/treinar`; tudo de treino continua em Mais. Animações discretas de XP/nível/conquista respeitam
`prefers-reduced-motion`. Alimentação, leitura e Bíblia aparecem como "em breve" (contratos em `FUTURE_MODULES`).

## 9. Migração

`0003_life.sql`: só tabelas novas, mais a ampliação de `assistant_actions` (novos `kind`, status `reverted`,
`undo_data`, `reverted_at`). Nenhum dado existente é alterado.
