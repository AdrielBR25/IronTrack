# Metas de treinamento e conquistas locais

IronTrack 2.0, Fase 01, Prompt 12. Metas pessoais (frequência, sessões, carga, repetições, duração, distância e 1RM
estimado) acompanhadas a partir dos treinos concluídos, **só no aparelho**. Código em `src/modules/goals` (domínio
puro), `src/db/goals.ts` (persistência), `src/features/goals` e `src/pages/TrainingGoalsPage.tsx` (tela `#/metas`).

## 1. Matriz de impacto

| Área | Mudança | Compatibilidade |
| ---- | ------- | --------------- |
| IndexedDB | Dexie **v3**: nova tabela `goals` (`id, profileId, status, updatedAt`); nenhuma tabela antiga muda | v1/v2 → v3 sem transformação; app anterior (Dexie 4) continua abrindo (§4) |
| Backup | formato **v4** com `data.goals` | importa v0–v4; v3 → v4 acrescenta `goals: []`; app anterior recusa v4 com "Atualize" |
| Sessões, fichas, rotação | nenhuma | metas nunca escrevem nessas tabelas (teste de arquitetura e de persistência) |
| Analytics | `exercisePoint` exportado pela API pública; linhas de meta nos gráficos | fórmulas e 1RM histórico inalterados |
| IA / gateway | nenhuma | metas não entram no ContextBuilder nem saem do aparelho |
| Navegação | `#/metas` (carregada sob demanda) acessível por Evolução e Análise | continua com 6 itens; "Evolução" fica destacada em `/metas` |
| localStorage | nenhuma chave nova | metas só no IndexedDB |

## 2. Modelo (`src/modules/goals/types.ts`)

`TrainingGoal`: `id` (UUID estável), `profileId`, `type`, `title`, `exercise` (ou `null`), `targetValue`, `unit`,
`period`, `params`, `startDate`, `targetDate` (ou `null`), `status`, `pauses`, `createdAt`, `updatedAt`, `revision`.

| Tipo | Unidade gravada | Período | Parâmetros |
| ---- | --------------- | ------- | ---------- |
| `weekly_frequency` | `sessoes_semana` (1–14) | `semanal` | — |
| `session_count` | `sessoes` (1–400) | `janela` | `windowDays` (1–366); sem `targetDate` (a janela é o prazo) |
| `max_load` | `kg` (≤ 1000) | `recorde` | `side` (só unilateral) |
| `reps` | `reps` (≤ 1000) | `recorde` | `minLoadKg`, `side` |
| `duration` | `s` (≤ 86 400) | `recorde` | — |
| `distance` | `m` (≤ 1 000 000) | `recorde` | — |
| `e1rm` | `kg` (≤ 1000) | `recorde` | `side` |

Valores sempre finitos e positivos; unidade e período coerentes com o tipo; datas `yyyy-mm-dd` válidas; prazo ≥
início. Libras são convertidas para kg ao gravar e de volta ao exibir; cardio mostra km ou mi conforme a ficha e
minutos para duração. Validação por campo em `goalFieldErrors` (mensagens em português) e do registro completo em
`goalIssues` (usada pela persistência e pela integridade do backup).

### Identidade do exercício

Metas de exercício guardam `exercise.templateIds` (IDs do `ExerciseTemplate` da ficha), `routineId` e os atributos
de medição (modalidade, modo de carga, lateralidade, equipamento, unidade de distância). As sessões copiam o ID como
`templateId`. Regras:

- **Nunca por nome:** sessões sem `templateId` não entram; um "Supino reto" de outra ficha é outro exercício.
- O mesmo exercício em vários treinos **da mesma ficha** (mesmo nome normalizado e mesmos atributos) vira uma opção
  só, com todos os IDs. Fichas diferentes nunca são agrupadas.
- Exercício **substituído** no treino (`substitutedFrom`) não conta; modalidade diferente da gravada na meta também
  não (`incompatible`) e a tela informa quantos treinos ficaram de fora.
- Renomear o exercício na ficha mantém a meta (o cartão mostra o nome atual); removê-lo preserva a meta e os treinos
  já registrados, com aviso (`goalExerciseAvailability`).

## 3. Persistência (`src/db/goals.ts`)

Toda gravação lê o registro e aplica a regra pura na **mesma transação rw** (o navegador serializa transações entre
abas). Criar usa o ID gerado uma vez por abertura do formulário: repetir o envio devolve a meta já gravada (sem
duplicar); um ID igual com conteúdo diferente é recusado. Editar e excluir conferem `revision` (concorrência
otimista) e lançam `GoalConflictError` (`changed`, `deleted`, `exists`) sem gravar nada. Pausar, retomar, arquivar e
restaurar são aplicados sobre a versão gravada e são idempotentes. Metas de outro perfil não são listadas, lidas nem
alteradas; o gancho de dono do banco impede trocar `profileId`. "Apagar todos os dados" limpa as metas.

## 4. Migração e downgrade

`DB_SCHEMA_VERSION = 3` acrescenta só a tabela `goals`, sem função de upgrade. Bancos v1 e v2 chegam à v3 numa
abertura, com todos os registros idênticos (teste compara o dump antes/depois).

**Downgrade (voltar para o app do P11):** verificado no Chromium e no fake-indexeddb que um app Dexie 4 que declara
só a v2 **abre** o banco v3 (o Dexie 4 abre na versão instalada), lê e grava normalmente e ignora `goals`, que
continuam lá ao voltar para a versão nova. A afirmação do P11 de que uma v3 causaria `VersionError` vale para Dexie
3, não para o Dexie 4 usado por todas as versões publicadas (produção usa `dexie ^4.4.7`). Ressalvas: o app
anterior não mostra metas; "apagar tudo" nele não apaga a tabela `goals`; ele recusa backups v4 com a mensagem de
atualização. Os arquivos de backup antigos continuam sendo aceitos pela versão nova.

## 5. Backup v4

`data.goals` é exportado com todos os campos. Importação: v0–v3 recebem `goals: []`. Substituir troca as metas pelas
do arquivo (um backup antigo **sem metas apaga as metas locais**; a prévia mostra "Metas: aqui N → arquivo 0").
Mesclar: ID novo é acrescentado; ID existente com conteúdo diferente mantém a local e exige confirmação de
restauração parcial; mesmo conteúdo com outro ID é ignorado como duplicado; mesmo tipo e título com valores
diferentes é mantido com aviso (`SIMILAR_GOAL`); a rotina referenciada é remapeada quando a rotina do arquivo já
existe aqui com outro ID. Meta inválida (`INVALID_GOAL`), de outro dono ou com ID repetido bloqueia a restauração
inteira: nada é descartado em silêncio. Backup de outro perfil: mesclar bloqueado; substituir com transferência adota
as metas no perfil local. Falha no meio desfaz tudo (mesma transação das demais tabelas).

## 6. Motor de progresso (`src/modules/goals/progress.ts`)

Determinístico, sem React, Dexie, rede, IA, `Date.now` ou aleatoriedade; recebe meta, sessões e o dia local e
devolve `GoalProgress`. Nada é persistido: o progresso é sempre recalculado.

- **Sessões contadas:** só `completed`, do perfil da meta, sem repetidas (mesmo ID ou mesmo `startedAt` +
  treino). Em andamento e descartadas não contam.
- **Medidas por série:** as mesmas do analytics (`normalizeSessions` + `exercisePoint`): séries válidas, sem
  aquecimento. Assistência nunca é carga; corpo ≠ carga externa (famílias de medida carga/corporal/tempo/cardio).
- **1RM:** sempre o canônico `epley-1a12-v1` (`canonicalE1rmKg`); o 1RM histórico não foi alterado (decisão do
  P09 pendente).
- **Unilateral:** sem lado escolhido, vale o melhor de qualquer lado; com `side`, só séries daquele lado.
- **Duração:** exercício por tempo = maior série; cardio = duração somada da sessão. **Distância:** soma da sessão.
- **Comparação:** tolerância 1e-6 (dízimas de lb → kg).

### Frequência semanal

Semanas de segunda a domingo no calendário local (`weekStart` do analytics). A semana atual é a que importa para
"cumprida"; semanas anteriores aparecem como histórico (parciais e pausadas marcadas e fora da contagem de
"semanas completas cumpridas"). Sem diagnóstico negativo: semana não cumprida só mostra o número.

### Janela (quantidade de sessões)

Conta sessões de `startDate` até `startDate + windowDays - 1`. Atingida quando a contagem chega ao alvo dentro da
janela.

### Recordes (carga, repetições, duração, distância, 1RM)

Melhor medida desde `startDate`; atingida na primeira sessão que alcança o alvo (evidência: sessão, data, valor,
carga, repetições, lado). Melhor marca anterior ao início aparece como referência (`baseline`), nunca como conquista.
`personalRecord` indica que a evidência superou todo o histórico anterior.

## 7. Estados

Gravados: `active`, `paused` (com intervalos em `pauses`), `archived`. Exibidos (`displayState`, por prioridade):
`arquivada` → `pausada` → `nao_iniciada` (início no futuro) → `atingida` (metas não recorrentes, com evidência) →
`prazo_encerrado` (prazo passou sem atingir; texto neutro, a meta pode ser editada ou arquivada) → `ativa`. Meta
semanal é recorrente: fica "Em andamento" e mostra "Cumprida nesta semana". Atingir depois do prazo é registrado
como atingida, com a observação "depois do prazo". Dados insuficientes ≠ falha.

## 8. Conquistas locais (`achievements.ts`)

Derivadas dos fatos a cada cálculo (nenhuma tabela): primeira meta atingida, três metas atingidas, primeira semana
cumprida de cada meta semanal, recorde pessoal ao atingir. Sem pontuação, ranking, comparação, notificações ou
mensagens de culpa.

## 9. Interface

`#/metas`: resumo (em andamento, atingidas, arquivadas), próximos prazos, conquistas, seções e arquivadas
recolhidas. Cartão: título, tipo, exercício, valor atual, objetivo com unidade, barra de progresso com
`aria-valuetext`, estado em texto e ícone (nunca só cor), evidência, semanas, avisos. Ações: editar, pausar,
retomar, arquivar, restaurar e excluir com confirmação. Formulário: campos conforme o tipo, validação imediata,
unidade visível, referências reais do histórico (melhor marca, média das últimas 4 semanas), sem sugestões médicas
e sem alterar fichas. Tipo e exercício ficam fixos na edição. Testado a 360 px sem rolagem horizontal.

Análise (`#/evolucao/desempenho`): linha tracejada do objetivo no gráfico da métrica correspondente e lista "Metas
deste exercício"; meta de frequência como linha no gráfico semanal. Os valores vêm do mesmo motor (sem cálculo
paralelo).

## 10. Privacidade

Metas ficam no IndexedDB e nos backups. Não são enviadas ao gateway, não entram no ContextBuilder, não alteram o
consentimento de IA. Testes de arquitetura: IA, integrações e assistente não importam `modules/goals`,
`db/goals` nem `useGoals`; o domínio não usa rede nem armazenamento.

## 11. Concorrência entre abas

Consultas ao vivo (Dexie `liveQuery`) atualizam todas as abas. Formulário de edição detecta alteração ou exclusão em
outra aba ("Carregar versão atual") e não grava versão antiga. Criação com toque duplo não duplica. Exclusão e
arquivamento simultâneos: o segundo vê o estado atual (exclusão de meta já excluída não é erro; exclusão de meta
alterada é recusada).

## 12. Limitações

- Sessões antigas sem `templateId` (importadas de fichas antigas) não entram em metas de exercício.
- Metas não migram entre fichas diferentes; uma ficha duplicada gera exercícios novos.
- Sem lembretes ou notificações; sem sincronização entre aparelhos.
- O app anterior ao P12 não exibe nem restaura metas (recusa backup v4).
- Substituir por um backup sem metas apaga as metas locais (visível na prévia).

## 13. Testes

- `tests/unit/goals-domain.test.ts`: validação, identidade, frequência, janela, recordes, lados, assistência,
  1RM canônico, estados, pausas, conquistas, determinismo.
- `tests/unit/goals-db.test.ts`: migração v1/v2 → v3, app do P11 abrindo v3, idempotência, perfis, revisões,
  duas conexões, rollback, nenhuma escrita fora de `goals`.
- `tests/unit/backup-goals.test.ts`: exportação v4, importação v0–v4, substituir, mesclar, conflitos, remapeamento,
  perfis, integridade, rollback.
- `tests/unit/goals-ui.test.tsx`: criar, editar, pausar, retomar, arquivar, excluir, exercício, progresso,
  conquistas, atualização após treino.
- `tests/unit/architecture.test.ts`: pureza, privacidade, rota sob demanda.
- `e2e/goals.spec.ts` (Android 360 px e desktop): perfil → ficha → meta → treino → atingida → conquista → backup →
  restauração → offline → duas abas → sem rolagem horizontal.

## 14. Uso pelo planejamento semanal (P13)

O painel `#/planejamento` mostra as metas de frequência semanal chamando `computeGoalProgress` e escolhendo a semana
exibida em `weekly.weeks` (e até 4 anteriores). Nenhuma fórmula foi duplicada: as sessões contadas pelo painel usam
`countableSessions`, exportado por este módulo. Descanso planejado não afeta metas; metas não leem o planejamento.
Detalhes em [PLANEJAMENTO_SEMANAL.md](PLANEJAMENTO_SEMANAL.md) §6. Backup atual: v5 (metas continuam em `data.goals`).

## 15. Calendário unificado (P14)

O calendário unificado ([CALENDARIO_UNIFICADO.md](CALENDARIO_UNIFICADO.md)) não criou fórmula de meta: as metas
semanais continuam vindo de `computeGoalProgress` via `weeklyGoalsForWeek`, e as sessões contadas pelo calendário,
pela Início e pelo Planejamento são as de `countableSessions`. Sugestões da agenda anterior e previsões da rotação não
entram em nenhum cálculo de meta nem na contagem de atividades planejadas.

## 16. Biblioteca de exercícios (P17)

A biblioteca ([BIBLIOTECA_EXERCICIOS.md](BIBLIOTECA_EXERCICIOS.md)) não mudou nenhuma regra de metas:

- a meta continua ligada aos `templateIds` da ficha. Adicionar o mesmo item do catálogo noutra ficha, ou noutro treino,
  cria uma instância com ID novo e **não** liga a meta a ela; a origem (`catalogId`/`customExerciseId`) nunca é usada
  para casar metas;
- **substituir** um exercício na ficha dá ID novo ao substituto. A prévia avisa "N metas continuam ligadas a X"; a meta
  fica no exercício antigo (estado "exercício removido da ficha") e continua usando o histórico já registrado. Nada é
  redirecionado sozinho;
- duplicar uma instância também não liga a meta à cópia;
- backup atual: v7 (metas continuam em `data.goals`, sem mudança de formato).

## 17. Reconhecimento de exercícios antigos (P18)

Nenhuma regra de metas mudou ([RECONHECIMENTO_EXERCICIOS.md](RECONHECIMENTO_EXERCICIOS.md)):

- **associar** um exercício antigo à biblioteca grava só a origem; o ID da instância é o mesmo, então a meta continua
  ligada a ele, com o mesmo progresso;
- **desfazer a associação** também não toca metas;
- **substituir vários** dá ID novo a cada substituto. A prévia mostra as metas ligadas e o texto fixo "As metas
  vinculadas ao exercício anterior continuarão vinculadas a ele."; nenhuma meta é redirecionada;
- modelos multimodais (carga, repetições, tempo, distância, frequência) e as fórmulas de 1RM ficam iguais.
