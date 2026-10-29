# Edição de treinos finalizados (IronTrack 2.0 F01 / P20)

Rota: `/historico/:id/editar` (botão **Editar** no histórico e nos detalhes do treino). Sem mudança de banco (Dexie v6);
campos novos são opcionais e o backup passou para v8.

## 1. Tela

- Faixa **"Editando treino finalizado"** e relógio **congelado** com a duração registrada: editar não faz o tempo andar.
- Duração corrigível em horas e minutos (até 24 h).
- Por exercício: cargas, repetições, duração, distância (conforme a modalidade), marcar/desmarcar série feita,
  adicionar e remover série, mover para cima/baixo, **Corrigir exercício** (cenário A) e **Remover exercício** (com
  confirmação).
- **Adicionar exercício esquecido** (cenário B) e observações do treino.
- Resumo das mudanças e lista de problemas que impedem salvar.
- Rodapé: **Cancelar** (pede confirmação se houver mudança), **Continuar** (retoma o treino com as correções, ver
  [RETOMADA_TREINOS.md](RETOMADA_TREINOS.md)) e **Salvar**.

Nada é gravado até Salvar ou Continuar: a tela trabalha num rascunho em memória.

## 2. Cenário A × cenário B

| | A: corrigir o exercício registrado | B: adicionar um exercício esquecido |
| --- | --- | --- |
| Quando | Registrou "Supino reto" mas fez "Supino inclinado" | Fez um exercício e esqueceu de registrar |
| Função | `correctExerciseIdentity` | `appendExercise(…, afterFinish = true)` |
| Séries | As registradas ficam (são do exercício real) | Novas, sem cargas sugeridas |
| Identidade | Troca nome/`exerciseKey`/origem na biblioteca; a identidade anterior fica em `correctedFrom` (auditoria) | Exercício novo, ID novo, `addedAfterFinishAt` |
| Restrição | Bloqueada se as medidas forem diferentes (ex.: força → cardio): nada é convertido | — |
| Efeito | Recordes, desempenho e metas passam a contar para o exercício correto | Passa a contar como feito nesse treino |

Recordes, gráficos, metas, desempenho e calendário são **calculados a partir das sessões na leitura**, então refletem
a correção sem duplicar nada e sem migração.

## 3. Gravação transacional e concorrência

`src/db/sessionEdits.ts`:

- `saveCompletedSessionEdit(base, draft)`: numa transação `rw`, relê o registro, confere `status === 'completed'` e
  `updatedAt` igual ao que a tela abriu. Se outra aba, uma restauração de backup ou uma retomada mudou o treino, **nada
  é gravado** e a tela mostra o aviso com **Recarregar**. Só exercícios, duração e observações vêm do rascunho; ID,
  perfil, início e finalização nunca mudam.
- Valida (`validateSessionEdit`): ao menos um exercício, séries válidas para a modalidade, duração dentro do limite.
- Sem mudança real → `unchanged` (nenhuma revisão nova).

## 4. Revisões (auditoria e desfazer)

Cada gravação no histórico (edição, retomada, restauração) cria uma `SessionRevision` com tipo, horário, resumo legível
e o estado **anterior** (exercícios, duração, observações). No máximo `MAX_SESSION_REVISIONS = 10` por treino (as mais
recentes). Em Detalhes do treino, o cartão **Revisões** lista cada uma e permite **Restaurar** o estado anterior; a
restauração é uma nova revisão (nada do histórico é apagado). O histórico marca treinos editados com "editado".

## 5. Backup v8

As revisões, `timing` e os campos de exercício (`replacedBy`, `replacesExerciseId`, `addedAfterFinishAt`,
`correctedFrom`, `catalogVersion`) viajam no backup. v7 → v8 não altera registros; um app anterior recusa v8 com
orientação para atualizar. Ver [BACKUP_RESTAURACAO.md](BACKUP_RESTAURACAO.md).

## 6. Testes

`tests/unit/session-edit.test.ts` (regras puras e gravação com conflito), `tests/unit/backup*.test.ts` (v8) e o E2E
`e2e/visual-history-ai.spec.ts`.
