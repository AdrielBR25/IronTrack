# Séries pelo último treino e séries em partes

Ajuste pedido depois do P21. Três mudanças no treino em andamento, sem migração de banco.

## 1. Preenchimento série a série

Ao iniciar um treino, cada série de trabalho recebe a carga e as repetições da **mesma série** do último treino com o
exercício (série 1 com a série 1, série 2 com a série 2…). Séries a mais que o último treino repetem a última série
feita. Isso já acontecia em `buildSets`, mas ao concluir a série 1 `carryForwardWeight` copiava a carga dela para todas
as séries seguintes e apagava o preenchimento.

Agora `carryForwardWeight(session, exId, setId, previous)` recebe as séries do último treino e **não** mexe nas séries
que têm correspondente nele (`previousSameSet`). Só as séries sem referência (primeiro treino do exercício, ou séries a
mais) seguem a carga da série concluída, como antes. Séries editadas à mão continuam intocadas.

O "Plano" de cada série, quando a ficha não tem carga planejada, também passou a ser a mesma série do último treino (antes
era a carga mais pesada para todas). Com carga planejada na ficha, o plano continua sendo a ficha.

O campo "Anterior" do painel da série mostra a mesma série do último treino (ex.: `Anterior: 45×8`); sem ela, o resumo do
último treino como antes.

## 2. Comparação com a mesma série

O selo de diferença de carga nas séries concluídas (`+2,5 kg`, `−5 kg`) compara com a **mesma série do último treino**.
Antes comparava com `plannedWeight`, que era a carga mais pesada do último treino: quem fez 35 → 45 → 50 e repetiu 35 na
série 1 via "−15 kg". Regras:

- há último treino e a série tem correspondente → compara com ela;
- há último treino mas a série não tem correspondente (série extra) → sem selo;
- não há último treino → compara com a carga planejada da ficha (comportamento antigo);
- drop-set não tem correspondente.

## 3. Série em partes

Uma série pode ter partes adicionais com outra carga, sem descanso (ex.: 8 × 35 kg e mais 4 × 40 kg). No painel da série:
"Trocou a carga no meio da série? Adicionar parte". Disponível só onde a modalidade registra carga × repetições
(`allowsSegments`: musculação e peso corporal com carga adicional; não em tempo, cardio, só corpo ou assistido).

### Formato

```ts
interface SetSegment { weight: number | null; reps: number | null } // kg
SessionSet.segments?: SetSegment[] // partes 2, 3…; a parte 1 continua sendo weight × reps
```

- Campo opcional, ausente nos registros antigos. Sem índice no IndexedDB: **sem nova versão do Dexie**.
- Backup: o esquema da série é `passthrough`, então `segments` é exportado e restaurado sem mudança de versão (continua
  v8). Uma versão antiga do app que abrir esses dados simplesmente ignora as partes (conta só a primeira).
- Máximo de 5 partes adicionais (`MAX_SET_SEGMENTS`). Cada parte precisa de repetições inteiras > 0 e carga ≥ 0 para a
  série ser concluída. A verificação de integridade avisa sobre partes malformadas sem descartar o treino.
- O próximo treino pré-preenche a mesma série com as mesmas partes.

### Como cada cálculo trata as partes

| Onde | Regra |
| --- | --- |
| Volume (`setVolume`, sessão, recordes de volume) | soma carga × reps de cada parte |
| Recordes e 1RM (`computeRecords`, `sessionPRs`, `exerciseSeries`) | cada parte é uma marca própria (40 × 4 conta como carga máxima 40) |
| Análises P08/P09 (`exercisePoint`) | volume, carga máxima, 1RM e reps somam/consideram as partes; `sets`/`loadedSets` contam a série uma vez |
| Metas P12 (carga, 1RM, repetições) | cada parte é uma marca possível |
| Desempenho P19 (`metricsOf`, família carga) | volume, carga máxima, 1RM, reps consideram as partes; `workSets` conta uma vez |
| Contagem de séries, progressão de carga | inalteradas: a série conta uma vez; a progressão olha a primeira parte |
| Assistente de IA | recebe só a primeira parte (sem mudança no contexto enviado) |
| Desempenho P19, peso corporal com carga adicional | só a primeira parte |

Exibição: `35×8 + 40×4` nos resumos e na lista de séries; no detalhe do histórico, `35 kg + 40 kg` / `8 + 4`.

Testes: `tests/unit/set-history.test.ts` e `e2e/set-history.spec.ts`.
