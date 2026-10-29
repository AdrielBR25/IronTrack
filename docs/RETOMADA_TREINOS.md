# Retomada de treinos finalizados (IronTrack 2.0 F01 / P20)

## 1. Quando usar

Finalizou sem querer, ou lembrou de mais séries depois. **Continuar** aparece no histórico, nos detalhes do treino e na
tela de edição (que retoma já com as correções).

## 2. Confirmação

O diálogo mostra a **duração acumulada** e avisa que o intervalo em que o treino ficou finalizado **não conta**. Ao
confirmar, o treino volta a ficar em andamento e o relógio recomeça do total acumulado.

## 3. Modelo de tempo por segmentos

`modules/training/timing.ts`. Treinos nunca retomados não mudam: duração = `durationSec` (concluído) ou relógio desde
`startedAt` (em andamento), como antes do P20. Depois de uma retomada, a sessão ganha `timing`:

| Campo | Significado |
| --- | --- |
| `accumulatedSec` | segundos dos segmentos ativos já encerrados |
| `activeSince` | início do segmento ativo atual (null quando concluído) |
| `segments` | segmentos encerrados (auditoria) |
| `finishes` / `resumes` | horários das finalizações anteriores e das retomadas |

Duração efetiva em andamento = `accumulatedSec + (agora − activeSince)`. Ao finalizar de novo, o segmento é fechado e
`durationSec` recebe o novo total. Relógio do aparelho voltando no tempo nunca gera duração negativa. Listas limitadas a
50 entradas.

## 4. Regras

- Só um treino em andamento por vez: se houver outro, a retomada é recusada com aviso.
- Retomada em outra aba: a segunda aba recebe "já está em andamento" e só abre o treino (não existe segundo
  cronômetro). A gravação é transacional e confere `updatedAt` (ver [EDICAO_HISTORICO.md](EDICAO_HISTORICO.md) §3).
- O descanso não recomeça e nenhum cronômetro de execução é iniciado.
- **Rotação**: ao finalizar de novo, a rotação **não avança outra vez** (mantém o `advancedRotation` da primeira
  finalização). O diálogo de finalizar avisa isso.
- Cada retomada gera uma revisão "Treino retomado".

## 5. Cronômetros entre abas

Inalterado em relação ao P11 ([CRONOMETROS_E_CONCORRENCIA.md](CRONOMETROS_E_CONCORRENCIA.md)): o cronômetro de execução
continua único entre abas. O relógio do treino é derivado da sessão gravada, então todas as abas mostram o mesmo valor.
