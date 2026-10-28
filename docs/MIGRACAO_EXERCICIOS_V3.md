# Modelo de exercícios v3 (modalidades)

IronTrack 2.0 · Fase 01 · Prompt 10. Implementa a proposta de [MODELO_EXERCICIOS_V2.md](MODELO_EXERCICIOS_V2.md):
exercícios por tempo, cardio, unilaterais, de peso corporal, com carga adicional e com assistência. Todos os
campos novos são **opcionais**: registros antigos continuam válidos, sem reescrita, e ausência de campo significa
"desconhecido", nunca zero.

Código principal: `src/modules/training/exerciseModel.ts` (vocabulário, limites, validação, medidas por
modalidade), `src/modules/training/types.ts`, `src/features/workout/modelFormat.ts` (formatação),
`src/lib/integrity.ts` (códigos novos), `src/lib/backupFormat.ts` (v3) e `src/modules/training/routineSchema.ts`
(ficha v2).

## 0. Matriz de impacto

| Área | Arquivos | Mudança | Risco para dados antigos |
| --- | --- | --- | --- |
| Tipos | `modules/training/types.ts` | campos opcionais em exercício e série | nenhum (só adição) |
| Validação | `modules/training/exerciseModel.ts`, `lib/integrity.ts` | limites, erros e avisos novos | registros sem campos novos não geram problema |
| Banco (Dexie) | — | **sem nova versão** (seção 3) | nenhum: nada é reescrito |
| Backup | `lib/backupFormat.ts` | v3 (migração 2 → 3 identidade) | v0/v1/v2 importados como antes |
| Ficha JSON | `modules/training/routineSchema.ts` | versão 2 com campos opcionais | fichas v1 iguais; sem campos novos exporta v1 |
| Sessão | `modules/training/session.ts`, `volume.ts`, `rotation.ts`, `stats.ts` | pré-preenchimento por modalidade; série concluída por tempo/distância | volume, recordes, gráfico e 1RM antigos usam as mesmas funções de antes |
| Editor | `pages/WorkoutEditorPage.tsx` | campos dinâmicos por modalidade | exercício antigo abre e salva igual |
| Treino ativo | `features/workout/SetEditor.tsx`, `ExerciseCard.tsx`, `pages/ActiveWorkoutPage.tsx` | duração, distância, lado, assistência, carga adicional | exercício antigo: mesma tela |
| Histórico | `pages/SessionDetailPage.tsx` | colunas por modalidade | sessões antigas: mesmas colunas |
| Analytics | `modules/analytics/domain/*`, `application/indicators.ts`, `pages/TrainingAnalyticsPage.tsx` | contratos do P09 ligados | números de exercícios antigos idênticos (testado) |
| IA | — | nada muda; campos novos não são enviados (testado) | — |
| Gateway, perfil, consentimentos, PWA | — | nada muda | — |

## 1. Modelo

### Exercício (ficha `ExerciseTemplate` e cópia na sessão `SessionExercise`)

| Campo | Tipo | Significado |
| --- | --- | --- |
| `modality` | `'resistance' \| 'bodyweight' \| 'timed' \| 'cardio'` | musculação com carga, peso corporal, por tempo, cardio |
| `laterality` | `'bilateral' \| 'unilateral'` | execução |
| `loadMode` | `'externa' \| 'corporal' \| 'adicional' \| 'assistida'` | o que o campo de carga significa |
| `secondaryMuscles` | `string[]` | grupos secundários (só informativo; nunca recebem séries) |
| `distanceUnit` | `'m' \| 'km' \| 'mi'` | unidade de **exibição e digitação**; a distância é sempre gravada em metros |
| `targetDurationSec` | inteiro (s) | duração planejada por série |
| `targetDistance` | número (m) | distância planejada |

### Série (`SessionSet`)

| Campo | Tipo | Significado |
| --- | --- | --- |
| `durationSec` | inteiro (s) | duração da série |
| `distance` | número (m) | distância percorrida |
| `side` | `'direito' \| 'esquerdo' \| 'ambos'` | lado de uma série unilateral |
| `assistanceKg` | número (kg) | assistência (elástico, contrapeso) |
| `plannedDurationSec`, `plannedDistance` | como acima | plano copiado da ficha ao iniciar o treino |

`weight` continua sendo a carga **externa** em kg. Em `loadMode = 'adicional'` é a carga extra; nunca inclui o
peso do corpo. Unidades persistidas: kg, segundos e metros.

### O que cada modalidade registra (`exerciseMeasures`)

| Modalidade / tipo de carga | Repetições | Carga | Assistência | Duração | Distância | Lado | Sugestão de progressão |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sem modalidade (exercício antigo) | ✔ | externa | — | — | — | — | ✔ (como antes) |
| musculação | ✔ | externa | — | — | — | se unilateral | ✔ |
| peso corporal, só corpo | ✔ | — | — | — | — | se unilateral | — |
| peso corporal + carga adicional | ✔ | adicional | — | — | — | se unilateral | — |
| peso corporal assistido | ✔ | — | ✔ | — | — | se unilateral | — |
| por tempo (corporal ou sem tipo) | — | — | — | ✔ | — | se unilateral | — |
| por tempo + adicional/externa | — | adicional/externa | — | ✔ | — | se unilateral | — |
| cardio | — | — | — | ✔ | ✔ | — | — |

## 2. Validação e limites

`MODEL_LIMITS` em `exerciseModel.ts`:

| Limite | Valor |
| --- | --- |
| Duração (série ou planejada) | inteiro, 1 a 86 400 s (24 h) |
| Distância | maior que 0 e até 1 000 000 m (1 000 km) |
| Assistência | 0 a 500 kg |
| Grupos secundários | até 4, cada um com 1 a 40 caracteres |

- **Erro** (`exerciseModelIssues` / `setModelIssues`, severidade `error`): valor fora do vocabulário, tipo errado
  ou fora dos limites. Na integridade vira `INVALID_MODALITY_FIELD` e **bloqueia a restauração** inteira (nada é
  descartado em silêncio).
- **Aviso** (`warning`): combinação contraditória, como tipo de carga que não combina com a modalidade, cardio
  unilateral, assistência com carga adicional na mesma série, assistência num exercício que não é assistido, lado
  num exercício que não é unilateral. Na integridade vira `MODALITY_CONTRADICTION`: os dados são **preservados
  como estão** e as análises ignoram a parte contraditória.
- Concluir uma série (`setCompletionErrors`) exige o que a modalidade mede: repetições > 0 quando mede repetições,
  duração válida no exercício por tempo, duração **ou** distância no cardio, nunca carga adicional e assistência
  juntas. O botão fica desativado e o motivo aparece na tela.

## 3. Migração: por que o Dexie continua na versão 2

Não houve nova versão do IndexedDB (`DB_SCHEMA_VERSION = 2`):

1. Os campos novos ficam **dentro** dos objetos já armazenados; nenhum é índice nem é consultado por índice.
2. Nenhum registro precisa ser transformado: ausência = desconhecido, e nada é deduzido do nome ou do equipamento.
3. Uma versão 3 do Dexie impediria abrir o banco com o app do P09 (`VersionError`), ou seja, voltar a versão do
   app deixaria o usuário sem acesso aos dados. Sem a versão nova, o app antigo abre o banco normalmente e
   ignora os campos que não conhece.

O que os testes (`tests/unit/exercise-model-db.test.ts`) comprovam:

- banco criado com o esquema congelado **v1** e banco **v2** abertos pelo app atual: todos os registros
  idênticos, IDs e relações (treino → rotina, foto → avaliação, rotação, agenda) intactos, fotos preservadas;
- banco novo: exercícios e séries com os campos novos gravados e lidos de volta;
- **vários perfis**: cada registro mantém o dono;
- **2 000 sessões** antigas: nada reescrito, leitura e análise normais;
- registros incompletos (séries sem `reps`, exercício sem `muscleGroup`) continuam abrindo;
- uma versão 3 hipotética que falha no meio do upgrade é desfeita: banco volta inteiro para v2 (rollback).

## 4. Backups

- `BACKUP_SCHEMA_VERSION = 3`. A migração 2 → 3 é **identidade**: o conteúdo de v2 já é válido em v3.
- Motivo do incremento: um app antigo (v2) recusa o arquivo v3 ("Atualize o IronTrack") em vez de restaurar
  dados de modalidade sem entendê-los.
- Importação: v0, v1, v2 e v3. Exportação: v3 com todos os campos novos.
- Mesclar, substituir, conflitos, prévia, rollback e integridade continuam iguais. Valores inválidos de
  modalidade bloqueiam a restauração; contradições aparecem como aviso na prévia.
- O comportamento de substituição de perfil **não mudou**.

## 5. Editor de treinos

- Seletores "Modalidade", "Execução" (bilateral/unilateral; oculto no cardio) e "Tipo de carga" (opções conforme
  a modalidade), mais grupos secundários como etiquetas.
- Campos dinâmicos: repetições (some no tempo e no cardio), duração (segundos no tempo, minutos no cardio),
  distância com unidade (cardio), carga planejada só quando a modalidade usa carga.
- **Exercício antigo** (sem modalidade) abre com "Não informada" e o formulário de sempre.
- **Trocar de modalidade não perde dados**: campos ocultos mantêm o valor original e voltam ao trocar de novo; só
  combinações contraditórias (tipo de carga ou lateralidade que não valem na nova modalidade) deixam de ser
  gravadas. Campos desconhecidos do registro são preservados.
- **Cancelar não grava nada.**

## 6. Treino ativo

- A linha da série mostra só o que a modalidade mede: lado (botões Direito, Esquerdo e Ambos), carga ou "Carga adicional",
  assistência, repetições, duração e distância (na unidade do exercício).
- Pré-preenchimento: duração, distância e assistência da última sessão ou da meta da ficha. **O lado nunca é
  pré-preenchido.**
- Unilateral: cada série registrada é uma série; nada é duplicado automaticamente por lado.
- Exercício por tempo começa sem repetições: **repetições nunca viram segundos**.
- Séries inválidas não são concluídas (seção 2). O treino em andamento continua salvo a cada alteração e é
  retomado depois de recarregar ou fechar o app; funciona offline.

## 7. Histórico

- O detalhe da sessão monta as colunas conforme o exercício: Lado, Carga ou Carga adic., Assist., Reps,
  Duração, Distância, RIR/RPE. Exercícios antigos continuam com Série, Carga, Reps e RIR/RPE.
- Valores ausentes aparecem como "—", nunca como zero. O registro não é alterado para exibição.
- O selo de volume não aparece em exercícios sem carga.

## 8. Analytics

- `normalizeSessions` lê duração e distância **só quando a modalidade é explícita** (tempo/cardio); séries sem a
  medida esperada entram em `quality.invalidModalitySets`. Lado e assistência entram nas observações.
- Os contratos do P09 recebem dados reais: `timedMetrics` (maior duração, total, tendência de duração),
  `cardioMetrics` (duração, distância, ritmo, velocidade, frequência), `compareSides` (só unilaterais, cada série
  uma vez) e `bodyweightMetrics` (só corpo, carga adicional, assistência, incompatíveis; nunca volume em kg).
- Modalidades não se misturam: tempo não entra em carga nem em repetições; assistência não conta como
  "repetições só com o corpo"; uma tendência usa uma métrica só.
- O 1RM canônico do P09 só aparece nas análises novas. **Gráfico antigo, recordes antigos e 1RM histórico não
  mudaram** (a decisão do P09 continua pendente).
- Séries por tempo e cardio contam como séries no total e no grupo principal (`isCompletedWorkSet`); volume,
  recordes e o gráfico antigo continuam usando `isValidWorkingSet`, sem alteração.
- Página Desempenho: painel da modalidade (tempo, cardio, lados, peso corporal) e métricas de duração e
  distância no gráfico do exercício. Detalhes em [ANALYTICS_TREINAMENTO.md](ANALYTICS_TREINAMENTO.md) §18–22.

## 9. Compatibilidade

| Situação | Resultado |
| --- | --- |
| App P10 abre banco do P09 | normal; nada é reescrito |
| App P09 abre banco usado pelo P10 | normal; campos novos ignorados e preservados, exceto ao salvar o exercício no editor antigo (seção 10) |
| Backup v0/v1/v2 no P10 | importado como antes |
| Backup v3 no app P09 | recusado com orientação para atualizar |
| Ficha v1 no P10 | importada como antes; nenhuma modalidade inventada |
| Ficha v2 no app P09 | recusada (versão não suportada) |
| Ficha sem campos novos exportada pelo P10 | sai como versão 1 |

## 10. Limitações

- Editar no app do P09 um exercício classificado no P10: o editor antigo monta o registro só com os campos que
  conhece e **descarta** os campos novos daquele exercício na ficha (as séries já registradas não são afetadas).
  Recomendação: não voltar a versão do app depois de classificar exercícios. **P11:** o app atual detecta essa
  regravação e oferece restaurar os campos (seção 13); não é possível impedi-la no app antigo.
- ~~Sem cronômetro de série para exercícios por tempo (a duração é digitada).~~ P11: cronômetro de execução por série
  (seção 13).
- Distância e duração só por série; não há registro de percurso, ritmo por volta, calorias ou frequência cardíaca.
- O resumo para IA não inclui os campos novos (exigiria nova versão do contrato e consentimento próprio).
- Grupos secundários são informativos: não recebem séries nas contagens.
- Os limiares das tendências não foram calibrados com dados reais.

## 11. Testes

| Arquivo | Testes | Cobertura |
| --- | --- | --- |
| `tests/unit/exercise-model.test.ts` | 26 | vocabulário, limites, erros e avisos, medidas, conclusão de série, pré-preenchimento, substituição, ficha v1/v2 (campos explícitos, contradições, sem modalidade inventada) |
| `tests/unit/exercise-model-db.test.ts` | 18 | migração v1 → atual, v2 → atual, banco novo, vários perfis, 2 000 sessões, fotos, incompletos, rollback, IDs e relações; backup v3: exportação, v0–v3, mesclar, substituir, conflitos, malformados, inválidos, integridade |
| `tests/unit/exercise-model-analytics.test.ts` | 12 | tempo, cardio, lados, peso corporal, classificação explícita, registros antigos idênticos |
| `tests/unit/exercise-model-ui.test.tsx` | 13 | editor (modalidades, troca sem perda, cancelar), editor de série, histórico, Desempenho, privacidade da IA |
| `e2e/exercise-model.spec.ts` | 1 × 2 projetos | Android 360 px e desktop: editor → treino com recarga → histórico → Desempenho → backup v3 exportado e restaurado → offline → sem rolagem horizontal |

## 12. Riscos

| Risco | Mitigação |
| --- | --- |
| Voltar para o app do P09 depois de usar modalidades | banco sem versão nova (abre); backup v3 e ficha v2 recusados no app antigo; limitação do editor antigo documentada |
| Arquivo adulterado com valores absurdos | `INVALID_MODALITY_FIELD` bloqueia a restauração; limites em todos os campos |
| Mistura de métricas (segundos como repetições, assistência como corpo) | leitura só com modalidade explícita, testes específicos |
| Mudança silenciosa em números antigos | volume, recordes, gráfico e 1RM antigos usam as mesmas funções; teste compara relatório com e sem dados v3 |
| Vazamento para IA | o contexto da IA usa lista fechada de campos; teste garante que nenhum campo novo é enviado |

## 13. Prompt 11: cronômetros, registro rápido e proteção de compatibilidade

Detalhes em [CRONOMETROS_E_CONCORRENCIA.md](CRONOMETROS_E_CONCORRENCIA.md). Resumo do que mudou para o modelo v3:

- **Nenhuma mudança de formato.** Dexie continua na versão 2, backup continua v3, ficha continua v1/v2; nenhum campo
  novo em registros. Os estados auxiliares (cronômetro, fotografia dos campos de modalidade, capacidade) ficam em
  `localStorage`, fora do banco e dos backups.
- **Exercício por tempo e cardio:** cronômetro de execução por série; a duração medida (segundos inteiros, para
  baixo) entra em `durationSec` só por ação da pessoa, nunca substitui em silêncio um valor diferente.
- **Cardio:** unidade de digitação m/km/mi (gravação em metros), equivalências, ritmo derivado e atalhos de meta.
- **Unilateral:** lado em destaque, alternância só em série pendente; ausente continua ausente.
- **Peso corporal:** "Carga adicional (+kg)" e "Assistência (−kg)" com explicações distintas.
- **Concorrência:** o treino em andamento é gravado com mescla em três vias; finalizar é idempotente.
- **Downgrade:** detecção de regravação por app antigo (`detectModelLoss`) com restauração confirmada; app
  desatualizado em relação a dados mais novos bloqueia o editor. A migração para Dexie v3 foi analisada e **não**
  executada (impacto em CRONOMETROS_E_CONCORRENCIA.md §8).

Atualização da tabela de compatibilidade (seção 9):

| Situação | Resultado |
| --- | --- |
| App P09 regrava uma rotina classificada | campos de modalidade somem no banco; ao abrir o app atual, aviso com "Restaurar classificação" |
| App P11 abre dados já usados por um app com capacidade de modelo maior | aviso de app desatualizado; salvar no editor de fichas bloqueado |
| Backup v3 exportado pelo P11 | idêntico ao do P10 (sem estado de cronômetro nem fotografia) |
