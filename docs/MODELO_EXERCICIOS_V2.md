# Modelo de exercícios v2 (proposta do P09)

> **Situação (P10): implementado.** Os campos propostos aqui existem no app desde o Prompt 10, com as diferenças
> registradas em [MIGRACAO_EXERCICIOS_V3.md](MIGRACAO_EXERCICIOS_V3.md), que é a referência atual:
> distância gravada sempre em **metros** (`distanceUnit` só para exibição), metas de duração e distância por
> exercício (`targetDurationSec`, `targetDistance`), assistência de 0 a 500 kg, **sem nova versão do Dexie**
> (seção 4 abaixo foi revista: os campos não precisam de índice nem de transformação) e backup v3.
> O texto abaixo é mantido como registro da proposta.

IronTrack 2.0 · Fase 01 · Prompt 09. Proposta escrita quando nada disto estava implementado no banco, no editor
ou no backup. Os cálculos que usariam esses campos já existem como funções puras testadas com dados
fictícios em `src/modules/analytics/domain/modalities.ts` e `classification.ts` (ver
[ANALYTICS_TREINAMENTO.md](ANALYTICS_TREINAMENTO.md), seções 15 a 22).

## 1. Situação atual (Dexie v2)

| Nível | Campos que existem | Campos que faltam |
| --- | --- | --- |
| Exercício da ficha (`ExerciseTemplate`) e da sessão (`SessionExercise`) | `name`, `muscleGroup` (um texto), `category` (composto/isolado), `equipment` (barra, halteres, máquina, polia, peso corporal, outro), `repMin`, `repMax`, `restSec`, `targetWeight` | modalidade, grupos secundários, lateralidade, modo de carga, unidade de distância |
| Série (`SessionSet`) | `type` (aquecimento/normal/drop), `status`, `weight` (kg, carga externa total), `reps`, `rpe`, `rir`, `note`, `completedAt` | duração, distância, lado, carga adicional explícita, assistência |
| Sessão (`WorkoutSession`) | `startedAt`, `finishedAt`, `durationSec` (do treino inteiro) | — |

### Matriz de compatibilidade (tipo de exercício × dados disponíveis hoje)

| Tipo | Carga | Repetições | Duração por série | Distância | Lado | Assistência | Análise possível hoje |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Musculação com carga externa | ✔ `weight` | ✔ `reps` | ✘ | ✘ | ✘ | ✘ | completa: carga, 1RM, volume, repetições |
| Peso corporal | — | ✔ | ✘ | ✘ | ✘ | ✘ | repetições, séries |
| Peso corporal com carga adicional | ✔ (só a adicional) | ✔ | ✘ | ✘ | ✘ | ✘ | repetições + carga adicional, sem 1RM |
| Peso corporal com assistência | ✘ (sem campo) | ✔ | ✘ | ✘ | ✘ | ✘ | só repetições; assistência indistinguível |
| Temporizado (prancha, isometria) | — | ✘ (repetições não são segundos) | ✘ | ✘ | ✘ | — | indisponível |
| Unilateral | ✔ | ✔ | ✘ | ✘ | ✘ | — | como bilateral; comparação por lado indisponível |
| Cardio | — | — | ✘ (só a duração do treino) | ✘ | — | — | indisponível |

## 2. Campos propostos

### Exercício (ficha e cópia na sessão)

| Campo | Tipo | Obrigatório | Padrão para registros antigos |
| --- | --- | --- | --- |
| `modality` | `'resistance' \| 'bodyweight' \| 'timed' \| 'cardio'` | não | ausente = desconhecida (nunca deduzida do nome) |
| `laterality` | `'bilateral' \| 'unilateral'` | não | ausente = desconhecida |
| `loadMode` | `'externa' \| 'corporal' \| 'adicional' \| 'assistida'` | não | ausente = deduzido como hoje (equipamento + cargas) |
| `secondaryMuscles` | `string[]` (até 4) | não | ausente = nenhum; não recebe séries automaticamente |
| `distanceUnit` | `'m' \| 'km' \| 'mi'` | só com `modality = 'cardio'` | ausente |

### Série

| Campo | Tipo | Validação |
| --- | --- | --- |
| `durationSec` | número | inteiro > 0 e ≤ 86 400; obrigatório só para `timed`/`cardio` concluídos |
| `distance` | número | > 0, na unidade do exercício; ≤ 1 000 km |
| `side` | `'direito' \| 'esquerdo' \| 'ambos'` | só em exercícios `unilateral`; ausente = desconhecido |
| `assistanceKg` | número | > 0; só com `loadMode = 'assistida'`; exclusivo com `weight` |

Regras de validação (Zod, em `routineSchema`/`backupFormat` e no editor):

- `weight` continua sendo a carga **externa** em kg. Em `loadMode = 'adicional'` é a carga extra; nunca inclui o
  peso do corpo.
- `assistanceKg` e `weight > 0` na mesma série são recusados no editor; no backup, a série é mantida mas o
  analytics a trata como incompatível (`bodyweightSetKind → 'incompativel'`).
- Unidades persistidas: kg, segundos e metros. A interface converte (lb, min:s, km/mi), como já faz com lb.
- Valores inválidos (negativos, `NaN`) ficam fora dos cálculos e entram em `quality`, como hoje.

## 3. Compatibilidade com registros antigos

- Todos os campos são **opcionais**. Registros antigos continuam válidos sem alteração e sem reescrita.
- Ausência de campo significa "desconhecido", nunca "zero". O analytics já trata assim (`classifyExercise`
  com `explicit` vazio, `measures.duration = false`).
- Nenhuma migração preenche modalidade, lado ou duração por palpite. O usuário classifica no editor, e só os
  treinos feitos depois disso ganham os novos dados.
- `exerciseKey` não muda: o histórico do exercício continua ligado mesmo depois de classificado.

## 4. Estratégia de migração

1. **Dexie v3 sem reescrita de dados.** Os campos novos ficam dentro dos objetos já armazenados (não são
   índices), então a v3 declara as mesmas tabelas e índices da v2 e **não** tem `.upgrade()` que altere
   registros. Se algum índice for necessário (ex.: `modality`), ele é adicionado sem tocar nos registros.
2. Seguir as regras de [MIGRACOES.md](MIGRACOES.md): declaração congelada da v2, teste de upgrade v2 → v3 com
   banco fictício, falha da migração reporta `MigrationError` e não perde dados.
3. Liberar o editor em etapas: modalidade e lateralidade primeiro; duração e lado por série depois; cardio
   por último (tela de registro própria).
4. Só então ligar as análises de tempo, lados e cardio na página Desempenho (os cálculos já existem).

## 5. Impacto em backups

- O formato de backup já preserva campos desconhecidos (`.passthrough()` em sessões, exercícios e séries;
  ver [BACKUP_RESTAURACAO.md](BACKUP_RESTAURACAO.md)). Um backup com os campos novos restaurado numa versão
  atual mantém os campos, mesmo sem usá-los.
- Proposta: backup **v3** com os campos validados (tipos e limites da seção 2) e leitura de v0/v1/v2 sem
  mudança (campos ausentes = desconhecidos). A verificação de integridade passa a recusar combinações
  impossíveis (ex.: `side` em exercício bilateral) apenas como aviso, sem apagar dados.
- Restauração transacional, mesclagem e prévia continuam iguais.

## 6. Impacto no editor de treinos

- Ficha: seletores opcionais "Tipo" (carga, peso corporal, tempo, cardio), "Execução" (bilateral/unilateral)
  e, em peso corporal, "Carga" (só corpo, adicional, assistência). Grupos secundários como etiquetas.
- Treino ativo: a linha da série muda conforme o tipo. Tempo: cronômetro ou campo mm:ss no lugar das
  repetições. Cardio: duração e distância. Unilateral: um seletor de lado por série (sem duplicar a série
  automaticamente). Assistência: campo próprio, mutuamente exclusivo com a carga.
- Importação de ficha JSON: campos opcionais novos em `docs/FICHA_JSON.md`, com os mesmos padrões.
- Progressão de carga (`progression.ts`): continua só para carga externa; tempo e cardio ficam fora.

## 7. Impacto no histórico

- Detalhe da sessão e histórico exibem duração, distância e lado quando existirem; registros antigos aparecem
  como hoje.
- Recordes (`computeRecords`, `sessionPRs`) continuam por carga/1RM; recordes de duração e distância seriam
  novos e separados (nunca comparados com carga).

## 8. Impacto no analytics

- `classifyExercise` recebe `explicit` a partir dos campos novos; a classificação muda de `dados_existentes`
  para `explicito` só nos exercícios classificados.
- `normalizeSessions` passa a levar `durationSec`, `distance`, `side` e `assistanceKg` para as observações; os
  cálculos `timedMetrics`, `cardioMetrics`, `compareSides` e `bodyweightMetrics` passam a receber dados reais.
- `exerciseAnalyses` marca as análises como disponíveis automaticamente (`measures.duration/distance/side`).
- Volume em kg continua só com carga externa; séries por grupo continuam contando cada série uma vez no grupo
  principal (grupos secundários poderiam ter uma visão própria, explicitamente rotulada, nunca somada ao total).
- O resumo para IA (`irontrack.analytics-summary.v1`) não muda; uma versão v2 só com consentimento próprio.

## 9. Fora do escopo

Calorias, frequência cardíaca, zonas de treino, avaliação de condicionamento, diagnóstico de desequilíbrio
muscular e prescrição automática. Sincronização entre aparelhos.
