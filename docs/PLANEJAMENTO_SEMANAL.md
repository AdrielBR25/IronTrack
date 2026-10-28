# Planejamento semanal, agenda e consistência

IronTrack 2.0, Fase 01, Prompt 13. Organizar a semana de treinos e acompanhar o planejado × o realizado, **só no
aparelho**. Código em `src/modules/planner` (domínio puro), `src/db/planner.ts` (persistência),
`src/hooks/usePlanner.ts`, `src/features/planner/*` e `src/pages/WeeklyPlannerPage.tsx` (tela `#/planejamento`).

Princípio: o planejamento é uma **camada por cima** da rotação. Ele não avança a rotação, não inicia nem conclui
sessões sozinho, não cria treinos fictícios, não altera fichas e não gera planos automaticamente.

## 0. Auditoria e pontos de integração (antes de implementar)

| Ponto | Como funciona hoje (não mudou) | Uso pelo planejamento |
| ----- | ------------------------------ | --------------------- |
| Rotação | `rotations` guarda `nextIndex` por rotina (`modules/training/rotation.ts`). Abrir o app nunca avança. | Só **leitura** do ponteiro para mostrar "próximo da rotação". |
| Quando avança | `completeSession` (`db/repo.ts`), conforme a política (`finish` ou `threshold`), para o treino **seguinte ao realizado** (`indexAfter`). Também por ação manual: pular, escolher o próximo. | Nada. Concluir um treino iniciado pelo painel segue exatamente essa regra, igual a iniciar pela tela Treinos. |
| Início de sessão | `startSession(routineId, workoutId)` numa transação; se já há treino em andamento, devolve o existente (não duplica); não mexe na rotação. | Reutilizado via `useStartWorkout` (mesma tela de treino). |
| Sessões manuais | Qualquer treino escolhido em Treinos é uma sessão normal; ao concluir, a rotação continua a partir dele. | Mesmo comportamento. |
| Agenda antiga (`overrides` + `Settings.trainingDays`) | Projeção da rotação na Início/Treinos (descanso/reagendar um dia). | **Intacta e independente.** O planejamento não lê nem grava `overrides`/`trainingDays`. |
| Histórico | `sessions` (`active`, `completed`, `discarded`). | Só leitura; contagem pelas regras das metas (`countableSessions`). |
| Perfis | `profileId` explícito; ganchos do banco preenchem e impedem troca de dono. | `planEntries` entrou em `OWNED_COLLECTIONS`. |
| Metas (P12) | `computeGoalProgress` (semana segunda–domingo, calendário local). | Reutilizado sem fórmula nova. |
| Dexie v3 / backup v4 | — | Evoluídos para **Dexie v4** e **backup v5** (só acréscimos). |

Linha de base confirmada no commit `001c8ae`: 697 unitários, 157 do gateway, 64 E2E, typecheck e build OK.

## 1. Modelo (`src/modules/planner/types.ts`)

Uma tabela, `planEntries`; cada registro (`PlanEntry`) é **uma atividade** ou **um marcador** num lugar da agenda:

| Campo | Significado |
| ----- | ----------- |
| `id` | UUID estável, gerado uma vez por formulário (repetir o envio não duplica) |
| `profileId` | dono (preenchido pelo banco) |
| `scope` | `weekly` (modelo recorrente) ou `date` (exceção de uma data) |
| `weekday` | 0 = domingo … 6 = sábado (mesma convenção de `Settings.trainingDays`); só no modelo |
| `date` | `yyyy-mm-dd` local; só na exceção |
| `kind` | `workout`, `rest` (descanso) ou `free` (dia livre) |
| `routineId` | rotina planejada (só `workout`) |
| `workoutId` | treino específico da rotina (A, B…) ou `null` = **próximo da rotação** daquela rotina |
| `enabled` | entrada recorrente pausada (preservada, não vale); exceções são sempre `true` |
| `validFrom` / `validUntil` | vigência da entrada recorrente (ver §2) |
| `sourceEntryId` | numa exceção copiada do modelo, a entrada de origem |
| `createdAt`, `updatedAt`, `revision` | carimbos e versão (concorrência otimista) |

Rotina ≠ treino: a entrada sempre referencia a rotina e, opcionalmente, o treino dentro dela. Vários treinos no
mesmo dia são permitidos; a mesma atividade repetida no mesmo dia é recusada (`duplicate`). Dias sem nada planejado
não têm registro. Nenhuma relação nova foi inventada: só IDs que já existem (rotina e treino).

## 2. Recorrência e política de edição

- O modelo vale **toda semana** naquele dia, de `validFrom` (dia da criação) em diante. Nada é gerado para o futuro:
  cada data é resolvida sob demanda (`planForDate`).
- **Alterar ou remover** uma entrada que já valia antes de hoje **não reescreve o passado**: a versão antiga recebe
  `validUntil = ontem` e uma nova entrada (novo ID) vale de hoje em diante. Entrada criada hoje é alterada no lugar.
  Assim, semanas anteriores continuam mostrando o que estava planejado nelas.
- Pausar/retomar segue a mesma regra.
- "Repetir o planejamento semanal" é o próprio modelo: o que está em "Toda segunda" se repete em todas as segundas
  até ser alterado.

## 3. Exceções de data

- Uma data com **pelo menos uma exceção substitui o dia inteiro**; o modelo não muda.
- "Só neste dia": a primeira alteração copia as entradas recorrentes daquela data (com `sourceEntryId`) e altera a
  cópia. Exemplos: "nesta segunda: descanso" (`setMarker`), "próxima quarta: B no lugar de C" (`updateActivity` com
  `onDate`), "acrescentar cardio só nesta sexta" (`addActivity` com `scope: 'date'`).
- Um dia de exceção nunca fica vazio por remoção (voltaria ao modelo sem a pessoa pedir): vira "dia livre".
- "Voltar ao semanal" apaga as exceções da data (com confirmação).
- Exceções só para **hoje ou datas futuras**; dias passados são somente leitura.

## 4. Datas

Semana de segunda a domingo, calendário local. Datas de calendário são aritmética pura em UTC
(`modules/planner/calendar.ts`), imunes a horário de verão (inclusive a meia-noite inexistente do horário de verão
brasileiro antigo) e ao fuso. Só o **instante** da sessão vira dia pelo fuso do aparelho (`localDate`, a mesma regra
do analytics e das metas). Nada compara `toISOString()` de um instante com um dia local. Virada de mês e de ano
testadas.

## 5. Associação planejado × realizado (`week.ts`)

- Sessões contadas: as mesmas das metas (`countableSessions`): só `completed`, do perfil, sem repetidas (mesmo ID ou
  mesmo início + treino). Em andamento e descartadas não contam (a em andamento aparece como tal).
- Por dia: primeiro as atividades com treino específico (mesma `routineId` **e** `workoutId`), depois as "próximo
  da rotação" (qualquer treino da mesma rotina). Nunca por nome, nunca por proximidade de horário. Cada sessão serve
  a uma atividade no máximo; as demais são **extras** ("fora do planejado", não são erro).
- Sessão feita em outro dia aparece **no dia em que ocorreu**; nada é movido.
- Estados do dia: `Concluído`, `Parcialmente realizado`, `Planejado`, `Sem atividade planejada`, `Dia futuro`
  (nunca "falhou"). Atividade: `Realizada`, `Em andamento`, `Para hoje`, `Sem registro`, `Planejada`.
- Rotina excluída ou treino removido: a entrada é preservada e aparece com aviso ("rotina excluída", "treino
  removido da rotina"), com opção de trocar ou remover.

## 6. Metas

`weeklyGoalsForWeek` chama o motor do P12 (`computeGoalProgress`) e só escolhe a semana exibida e até 4 anteriores.
Nenhuma fórmula de frequência nova. Descanso planejado não entra em nenhum cálculo de meta.

## 7. Persistência

- **Dexie v4**: `planEntries: 'id, profileId, scope, date, routineId, updatedAt'`, sem função de upgrade. Bancos v1,
  v2 e v3 chegam à v4 numa abertura com todas as tabelas idênticas (teste compara o dump). Um app anterior (Dexie 4,
  declarando até a v3) abre o banco v4 e ignora a tabela.
- `planEntries` está em `OWNED_COLLECTIONS`, em `dataTables()` (backup e "apagar tudo") e nos ganchos de dono.
- Não usa `localStorage` (nenhuma chave nova).

## 8. Backup (v5)

- `data.planEntries` exportado com todos os campos. v0–v4 recebem `planEntries: []`.
- **Substituir** troca o planejamento pelo do arquivo (backup antigo sem planejamento apaga o local; a prévia mostra a
  contagem "Planejamento").
- **Mesclar**: ID novo acrescentado; mesmo ID e conteúdo diferente → mantém o local (conflito, exige confirmação);
  conteúdo igual com outro ID ou a **mesma atividade vigente no mesmo dia** → duplicata; `routineId` remapeado quando
  a rotina do arquivo já existe aqui com outro ID; entrada de uma rotina **em conflito** cujo treino só existe na
  versão do backup **não é aplicada** (`ROUTINE_CONFLICT_DEPENDENT`), para nunca ligar o dia ao treino errado.
- Integridade: entrada inválida (`INVALID_PLAN_ENTRY`), ID repetido ou ligação a rotina de outro perfil
  (`CROSS_PROFILE_REFERENCE`) **bloqueiam** a restauração. Rotina ou treino inexistente é **aviso** e a entrada é
  preservada (`PLAN_ROUTINE_MISSING`, `PLAN_WORKOUT_MISSING`); descanso junto com treinos no mesmo dia é aviso
  (`PLAN_DAY_CONFLICT`). Nada é descartado em silêncio. Transação única com rollback; prévia desatualizada cancela.
- Limite: 5000 entradas por arquivo.

## 9. Concorrência entre abas

- Toda gravação lê e grava na **mesma transação rw** (serializada pelo navegador entre abas).
- Alterar/remover/pausar uma entrada confere `revision`; operações num dia (acrescentar, descanso, dia livre, exceção,
  voltar ao semanal) conferem a **impressão digital do dia** (`slotFingerprint`) que a tela mostrava. Divergência →
  `PlanConflictError` sem gravar nada.
- Criação com o mesmo ID (toque duplo, duas abas com o mesmo envio) devolve a entrada existente.
- Remover o que outra aba já removeu não é erro. Consultas ao vivo (`useLiveQuery`) atualizam as abas abertas; o
  formulário de edição avisa "alterada ou removida em outra aba".

## 10. UX

- Faixa de 7 dias (segunda a domingo), anterior/próxima/voltar para hoje, setas do teclado. No celular (360 px) os
  dias mostram número + ícone de estado (com legenda e texto completo no rótulo acessível e no dia selecionado); no
  computador, colunas com as atividades.
- Dia selecionado em destaque: planejado (com estado em texto), "Iniciar este treino" (hoje), registros do dia,
  ajustes com escolha explícita **"Toda <dia>"** ou **"Só em dd/mm"**, descanso e dia livre com confirmação quando
  removem treinos, remoção com confirmação.
- Iniciar: com treino em andamento, oferece continuar (não cria outro). Se o treino planejado difere do próximo da
  rotação, pergunta qual iniciar e explica que a rotação segue a regra de sempre ao concluir.
- Acesso por Treinos (ícone de calendário) e Início ("Planejamento da semana"); a barra continua com 6 itens.
- Sem rolagem horizontal (testado), botões de 44 px, `motion-safe` nas transições, estados nunca só por cor.

## 11. Privacidade

Planejamento só no IndexedDB e nos backups. Não entra no ContextBuilder, não vai ao gateway, não altera o
consentimento, sem sincronização e sem login. Testes de arquitetura: IA, integrações e assistente não importam o
planejamento nem citam a tabela; o domínio não usa rede, storage, relógio nem aleatoriedade.

## 12. Testes

- `tests/unit/planner-domain.test.ts`: semanas, viradas de mês/ano, fusos e horário de verão, validação,
  recorrência com vigência, exceções, dias livres, várias atividades, associação por ID, em andamento, descartadas,
  outro perfil, duplicadas, extras, consistência, dados insuficientes, metas.
- `tests/unit/planner-db.test.ts`: migração v3 → v4 e v1 → v4, app do P12 abrindo v4, perfis, revisões, duas
  conexões, exclusão, rollback, nada gravado fora da tabela, rotação intacta, rotina excluída.
- `tests/unit/backup-planner.test.ts`: exportação v5, importação v0–v5, substituir, mesclar, remapeamento,
  conflitos, outro perfil, inválidos, rollback, prévia desatualizada.
- `tests/unit/planner-ui.test.tsx`: estado vazio, criar, editar, remover, exceção, navegação, metas, iniciar.
- `tests/unit/architecture.test.ts`: pureza, privacidade, rota sob demanda.
- `e2e/weekly-planner.spec.ts` (Android 360 px e desktop): os 16 passos do roteiro.

## 13. Limitações

- Exceções e o modelo só podem ser alterados de hoje em diante; corrigir o planejado de um dia passado não é possível
  (por desenho).
- Não há "copiar esta semana para o modelo" nem planejamento por intervalo de datas; o modelo semanal é o único
  recorrente.
- A agenda antiga da Início/Treinos (dias de treino das Configurações + reagendamentos) continua separada e não
  conversa com o planejamento; os dois podem mostrar coisas diferentes para o mesmo dia.
- "Próximo da rotação" mostra o ponteiro atual; para dias futuros ele é só indicativo (a rotação muda quando você
  treina).
- Iniciar pelo painel só é oferecido para hoje. Ao concluir, a rotação segue a regra existente (pode ir para o treino
  seguinte ao realizado, mesmo que outro estivesse na vez).
- O app anterior ao P13 não mostra nem restaura o planejamento (recusa backup v5); "apagar tudo" nele não limpa
  `planEntries`.
- Sem lembretes, notificações ou sincronização entre aparelhos.
