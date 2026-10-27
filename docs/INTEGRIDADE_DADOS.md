# Integridade de dados

O IronTrack guarda tudo no IndexedDB do navegador (Dexie). Este documento descreve as tabelas, as
relações entre elas, as regras de validação (`src/lib/integrity.ts`) e a política para inconsistências.

Princípio: **nenhum registro é apagado ou alterado automaticamente para "corrigir" uma inconsistência**.
O verificador apenas diagnostica; quem decide é o usuário.

## Tabelas e chaves (esquema Dexie v1)

| Tabela        | Chave primária          | Índices                               | Conteúdo                                    |
| ------------- | ----------------------- | ------------------------------------- | ------------------------------------------- |
| `settings`    | `id` (sempre `settings`) | —                                     | Preferências (um único registro)            |
| `routines`    | `id`                    | `updatedAt`                           | Rotinas com treinos e exercícios embutidos  |
| `sessions`    | `id`                    | `status`, `startedAt`, `workoutId`, `routineId` | Treinos realizados (retrato completo) |
| `rotations`   | `routineId`             | —                                     | Ponteiro do próximo treino da rotina        |
| `overrides`   | `[routineId+date]`      | `routineId`, `date`                   | Substituições de calendário (descanso/treino) |
| `bodyEntries` | `id`                    | `date`                                | Avaliações corporais                        |
| `photos`      | `id`                    | `entryId`                             | Fotos de progresso (data URL JPEG)          |

## Relações e classificação

| Relação                                   | Classe                        | Justificativa |
| ----------------------------------------- | ----------------------------- | ------------- |
| `photos.entryId → bodyEntries.id`         | Obrigatória                   | A foto só aparece dentro da avaliação. Excluir a avaliação exclui as fotos na mesma transação (`deleteBodyEntry`). |
| `rotations.routineId → routines.id`       | Obrigatória                   | O ponteiro só faz sentido para uma rotina existente. `deleteRoutine` remove o ponteiro junto. |
| `rotations.nextIndex` dentro de `workouts` | Obrigatória (tolerada)        | Fora dos limites, o app normaliza com `normIndex` ao exibir. |
| `overrides.routineId → routines.id`       | Obrigatória                   | `deleteRoutine` remove as substituições junto. |
| `overrides.workoutId → workouts[].id` (quando `kind = workout`) | Obrigatória (tolerada) | A agenda ignora substituições cujo treino não existe. |
| `sessions.routineId/workoutId` (concluídas ou descartadas) | **Histórica permitida** | A sessão guarda o retrato dos exercícios e séries executados; excluir a rotina não invalida o histórico. |
| `sessions.routineId/workoutId` (em andamento) | Opcional (tolerada)       | O treino pode ser concluído; só a rotação deixa de avançar. |
| `settings.activeRoutineId → routines.id`  | Opcional                      | Se faltar, o app usa a primeira rotina disponível. |
| `workouts[].id` e `exercises[].id` dentro da rotina | Devem ser únicos     | A rotação e o editor localizam treinos/exercícios por ID. |

## Regras de validação

Cada problema tem código estável, severidade, coleção, ID (quando há), descrição em português e ação
recomendada. As mensagens citam apenas coleção e ID — nunca nomes, medidas, observações ou imagens.

| Severidade | Efeito |
| ---------- | ------ |
| `error`    | Impede a restauração (aplicar causaria perda de dados ou estado inutilizável). |
| `warning`  | Permitido; o registro é preservado e o problema é mostrado. |
| `info`     | Situação legítima registrada para transparência. |

| Código | Severidade | Quando |
| ------ | ---------- | ------ |
| `INVALID_ID` | error | ID vazio/ausente (registro, treino ou exercício). |
| `DUPLICATE_ID` | error | Dois registros com a mesma chave e conteúdos diferentes (um sobrescreveria o outro). |
| `DUPLICATE_ID_IDENTICAL` | warning | Mesma chave e mesmo conteúdo (gravado uma única vez). |
| `MISSING_REQUIRED_FIELD` | error | Sessão sem `exercises` ou rotina sem `workouts`. |
| `INVALID_TIMESTAMP` | error / warning | `startedAt` ausente ou ≤ 0 (error); término inválido ou antes do início (warning). |
| `INVALID_NUMBER` | error / warning | `nextIndex` não inteiro (error); séries, repetições, cargas, durações ou medidas negativas/não numéricas (warning). |
| `INVALID_DATE` | warning | Data inexistente em avaliação ou substituição de calendário. |
| `ROUTINE_DUPLICATE_WORKOUT_ID` / `ROUTINE_DUPLICATE_EXERCISE_ID` | warning | IDs repetidos dentro de uma rotina. |
| `ROUTINE_INVALID_REP_RANGE` | warning | Repetições mínimas maiores que as máximas. |
| `ROTATION_ORPHAN` | warning | Ponteiro de rotação sem rotina. |
| `ROTATION_INDEX_OUT_OF_RANGE` | warning | Índice fora da quantidade de treinos. |
| `OVERRIDE_ORPHAN` / `OVERRIDE_WORKOUT_MISSING` | warning | Substituição sem rotina ou sem treino válido. |
| `SESSION_HISTORICAL_REFERENCE` | info | Treino do histórico de rotina/treino que não existe mais. |
| `SESSION_ACTIVE_ORPHAN` | warning | Treino em andamento sem rotina/treino. |
| `SESSION_MULTIPLE_ACTIVE` | warning | Mais de um treino "em andamento" (o app retoma só um). |
| `PHOTO_ORPHAN` | warning | Foto sem avaliação correspondente. |
| `PHOTO_INVALID_DATA` | error | Foto que não é `data:image/...;base64,` (o app nunca carrega imagens externas). |
| `SETTINGS_ACTIVE_ROUTINE_MISSING` | warning | Rotina ativa configurada não existe. |

## Política para inconsistências

- **Fotos órfãs:** preservadas, nunca apagadas automaticamente. Ficam no banco e em todo backup exportado,
  mas não aparecem na tela. São informadas no diagnóstico e na prévia de importação.
- **Treinos históricos sem rotina:** preservados; aparecem no histórico normalmente.
- **Rotação/substituições órfãs:** preservadas (inofensivas); a agenda as ignora.
- **Erros:** bloqueiam a restauração inteira — nada é gravado. O arquivo original nunca é modificado.

## Onde a verificação roda

- `checkIntegrity(snapshot)` — função pura, sem banco nem interface.
- `previewRestore(backup)` — antes de qualquer restauração (ver [BACKUP_RESTAURACAO.md](BACKUP_RESTAURACAO.md)).
- `restoreBackupReplace` / `restoreBackupMerge` — revalidam antes de abrir a transação de escrita.
- **Configurações › Dados e backup › Verificar integridade dos dados** — diagnóstico do banco local, somente leitura.

## Gravações atômicas existentes

`startSession`, `completeSession`, `addRoutine`, `deleteRoutine`, `saveRoutineKeepPointer`, `deleteBodyEntry`
e `saveBodyEntryWithPhotos` usam transações Dexie: ou tudo é gravado, ou nada.
`deleteSession` não altera a rotação de propósito (a correção é manual, pela tela inicial).
