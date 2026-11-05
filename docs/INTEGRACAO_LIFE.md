# IronTrack Life — Fase 06: integração total, IA pessoal e planejamento

Esta fase não cria módulos novos. Ela junta os que já existem (treino, alimentação, RPG/hábitos/missões/rotinas,
conhecimento e Bíblia) em três telas (Início, Minha Semana e Minha Evolução) e dá à IA central ferramentas para
consultar várias áreas de uma vez e propor planos que envolvem vários módulos.

## 1. Fonte da verdade

- Cada registro continua no seu módulo. A agenda **não copia** treinos, refeições, hábitos, metas ou planos bíblicos:
  ela é montada a cada consulta (`services/api/src/planner/service.ts`, `buildAgenda`) a partir das tabelas de origem.
- Só três coisas novas são gravadas (migração `0008_integration.sql`, só aditiva):
  - `planner_items`: atividades livres ou criadas pela IA (estudo, leitura, rotina, descanso, período livre, outra).
    `client_id` único (idempotência de reenvio) e `dedupe_key` único (mesmo título + dia + horário não duplica).
  - `planner_overrides`: ajustes da pessoa sobre um item que vem de outro módulo (horário, duração, posição, "não
    realizado" ou "pausado"). O registro original não muda.
  - `life_home_layout`: ordem e visibilidade dos cartões do Início (por conta, vale em todos os aparelhos).
- Também na 0008: `assistant_memories` ganha `category`, `confirmed`, `expires_on`, `updated_at`; `assistant_actions`
  aceita o status `partial` e os tipos `create_planner_items` e `apply_life_plan`.

## 2. Minha Semana (`/semana`)

- 7 dias (até 14 na API), visão **Semana** e **Dia**, filtro por categoria (lembrado no aparelho), reordenar no dia,
  ajustar horário e duração, criar atividade, abrir o registro de origem.
- Categorias: treino, refeição, hábito, missão, estudo, leitura, Bíblia, rotina, outra, descanso, período livre.
- Situações: Planejado, Em andamento, Concluído, Não realizado, Pausado.
  - **Concluído** só vem de um registro real (treino salvo, refeição consumida, hábito marcado, sessão de estudo,
    leitura do plano) ou de uma marcação explícita da pessoa numa atividade livre. **O horário passar nunca conclui
    nada.** Um registro concluído sempre vence uma marcação de "não realizado".
  - **Em andamento**: treino ativo ou cronômetro de estudo/leitura aberto.
- Fuso: o dia é calculado no fuso da conta (`life_profiles.timezone`, padrão America/Sao_Paulo).
- Conflitos: sobreposição de horários entre itens não concluídos (sem duração assume 15 min; descanso não conflita
  com item curto). Sobrecarga: mais de 600 min ou 14 itens no dia. Função pura `findConflicts` em
  `shared/planner/protocol.ts`.
- Planejar não gera XP. O XP continua vindo só do motor do RPG ao registrar hábitos, missões, treinos etc.

## 3. Início personalizável (`/`)

Uma chamada (`GET /api/v1/planner/today`) traz: treino do dia, próxima refeição planejada, próxima sessão de
estudo/leitura/Bíblia, próximas atividades da agenda, metas da semana e sugestões discretas. Os cartões (personagem,
dia, próximas atividades, treino, alimentação, próxima refeição, conhecimento, próxima sessão, Bíblia, metas da
semana, sugestões, IA, conquistas) podem ser escondidos e reordenados em **Personalizar Início**. Se `/planner/today`
falhar, os cartões dos módulos continuam funcionando.

## 4. Minha Evolução (`/minha-evolucao`)

`GET /api/v1/insights/evolution?period=week|month|last7|last30&offset=N`. Calculado no servidor, **sem IA** e sem
chamada paga: frequência de treino, evolução de cargas (maior carga da primeira × última sessão), dias com diário
alimentar, dias dentro da meta de calorias, média de proteína, hábitos cumpridos, XP e níveis, minutos de leitura, de
estudo e de Bíblia, dias do plano bíblico. Comparação com o período anterior. Regras:

- Ausência de registros aparece como "Sem dados", nunca como zero de desempenho.
- Observações descrevem coincidências ("nas semanas com mais treinos…"), nunca causa.
- "Pedir interpretação" só abre o chat com a pergunta pronta; a chamada à OpenAI acontece se a pessoa enviar.

## 5. IA multi-módulo (`services/api/src/assistant/tools/integration.ts`)

Leitura (sem aprovação):

| Ferramenta | O que devolve |
| --- | --- |
| `get_life_overview` | Resumo por período (últimos 7/30 dias, semana, mês) de todas as áreas: registrado, sem dados, cargas, planejado × realizado, observações calculadas. Agregado, nunca o banco inteiro. |
| `get_week_agenda` | A agenda unificada de um intervalo (até 14 dias). |
| `check_schedule_conflicts` | Conflitos e sobrecarga de um intervalo + itens candidatos. |
| `get_personal_context` | Preferências confirmadas × inferidas, metas nutricionais e restrições, meta de treino, fichas, rotinas, hábitos, metas de conhecimento, planos bíblicos, se reflexões podem ser lidas. |

Escrita (sempre proposta → prévia → aprovação):

- `propose_schedule_items`: atividades na agenda; valida datas (hoje até +60 dias), duplicados na proposta e na
  agenda ("já está na agenda, será ignorada"), conflitos e sobrecarga na prévia.
- `propose_life_plan`: plano com 2+ etapas que reutilizam as ferramentas de escrita existentes de cada módulo (hábito,
  rotina, missão, refeição, metas, planos de leitura etc.) + atividades na agenda. Cada etapa passa pela mesma
  validação (`args` + `prepare`) da ferramenta original; etapas repetidas são recusadas.

Execução do plano: cada etapa roda em um `SAVEPOINT`. Se uma falhar, as outras ficam gravadas e a ação fica
**Parcial**: o cartão mostra o que foi gravado e o que falhou, e a mensagem para a IA diz "o app aplicou SÓ PARTE do
plano" (a IA não pode afirmar que tudo foi salvo). "Tentar de novo" reaplica só as etapas pendentes (as já aplicadas
são puladas: sem duplicar). Desfazer reverte as etapas aplicadas em ordem inversa. Na prévia a pessoa pode desmarcar
etapas e ajustar horários (`POST /assistant/actions/:id/approve` com `{ skip, times }`).

Instruções novas (seção "Visão integrada" em `engine.ts`): rotular **Registrado / Planejado / Sem dados / Estimativa
/ Sugestão**; nunca afirmar atividade concluída sem registro; perguntar só o essencial; treino × alimentação com base
no histórico e no catálogo, sem prescrição nem restrição extrema; reflexões espirituais só quando pedidas e com a
permissão ligada.

## 6. Preferências (memória pessoal)

- Categorias: objetivo, alimentação, horários, treino, estudos, prioridade da semana, hábito, saúde, outro.
- Salvas só quando a pessoa pede ou aprova a proposta. O que a IA deduziu entra como **inferida, não confirmada** e
  aparece separado nas instruções. A pessoa confirma, edita ou apaga em Privacidade do assistente
  (`PATCH /assistant/memories/:id`). Preferência com validade (`expiresOn`) deixa de ser usada depois da data.
- Os registros dos módulos continuam sendo a fonte da verdade; a preferência é só contexto.

## 7. API nova

`GET /api/v1/planner/week`, `GET /planner/today`, `POST /planner/items`, `PATCH/DELETE /planner/items/:id`,
`POST /planner/overrides`, `POST /planner/reorder`, `GET/PATCH /planner/home-layout`,
`GET /insights/evolution`, `PATCH /assistant/memories/:id`. Todas com sessão; cada consulta filtra por `user_id`.

## 8. Testes

- API: `services/api/tests/integration-life.test.ts` (agenda multi-módulo sem cópias, plano × sessão, idempotência,
  conflitos, versão, ajustes, fuso, isolamento, layout, evolução, consulta multi-módulo da IA, plano multi-módulo com
  prévia/aprovação/desfazer, falha parcial e nova tentativa, preferências). OpenAI simulada.
- E2E (celular): `e2e-cloud/week.spec.ts`.
