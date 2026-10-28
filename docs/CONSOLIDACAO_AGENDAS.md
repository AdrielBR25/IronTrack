# Consolidação de agendas

IronTrack 2.0, Fase 01, Prompt 15. Torna o calendário unificado (P14) mais simples no dia a dia: uma **importação
assistida e opcional** da agenda anterior para o planejamento semanal, uma **central de divergências**,
**preferências de exibição** e melhorias nas visões Semana e Mês. Nada é migrado automaticamente; a agenda anterior
continua guardada e funcionando.

Código: `src/modules/planner/legacyImport.ts` (motor puro de prévia e desfazer), `src/db/legacyImport.ts`
(transação), `src/hooks/useLegacyImport.ts`, `src/pages/LegacyImportPage.tsx` (`#/planejamento/importar`),
`src/modules/calendar/conflictCenter.ts` + `src/features/calendar/ConflictCenter.tsx` (central),
`src/features/calendar/calendarPrefs.ts` + `CalendarPrefsDialog.tsx` (preferências), `MonthGrid.tsx` e
`pages/WeeklyPlannerPage.tsx`.

## 1. Diagnóstico (auditoria antes de alterar)

Linha de base confirmada no commit `714c656` (P14): 818 unitários, 157 do gateway, 68 E2E, typecheck e build OK;
Dexie v4, backup v5.

| Fonte | Onde mora | Significado real |
| ----- | --------- | ---------------- |
| `Settings.trainingDays` | registro `settings` (global do aparelho, entra no backup) | **em quais dias da semana se treina**. Não diz *qual* treino: o treino de cada dia é o próximo da rotação da rotina ativa, projetado por `projectSchedule`. Não existe "segunda = Treino A". |
| Dias fora de `trainingDays` | — | **não é dia de treino**. `projectSchedule` mostra como descanso, mas a pessoa nunca escolheu "descanso" para aquele dia. |
| `overrides` | tabela `overrides` (`[routineId+date]`, sem `profileId`; o dono vem da rotina) | escolha para **uma data**: `rest` (descanso) ou `workout` + `workoutId` (reagendar um treino). Só os da **rotina ativa** são usados pela Início/Treinos. |
| Rotação | `rotations.nextIndex` | ponteiro do próximo treino; a projeção futura é **previsão**. |
| `planEntries` (P13) | Dexie v4 | intenção explícita: modelo semanal versionado por vigência + exceções por data; `workoutId: null` = "próximo da rotação". |
| Concorrência | — | o planejamento confere `revision` e a impressão digital do dia (`slotFingerprint`) dentro de transações `rw` (serializadas pelo navegador entre abas). |

Conclusões: a agenda anterior é uma combinação de dias habilitados e uma projeção dinâmica da rotação. Uma sugestão
dela **não** é um treino planejado. A única conversão semanticamente equivalente para `trainingDays` é "toda <dia>:
próximo da rotação da rotina ativa"; para `overrides`, exceções daquela data.

## 2. Regras de conversão

| Agenda anterior | Conversão | Observação |
| --------------- | --------- | ---------- |
| Dia de treino (`trainingDays`) | entrada **semanal** `workout`, rotina ativa, `workoutId: null`, vigente de hoje em diante | o treino continua sendo previsão da rotação; nenhum treino fixo é criado |
| Dia fora de `trainingDays` | **nada** (ignorado) | não vira descanso automaticamente ("dias sem informação") |
| Reagendamento de treino (hoje em diante) | **exceção da data** com o treino escolhido | nunca recorrência; a exceção substitui o dia inteiro, como o reagendamento substituía |
| Descanso reagendado (hoje em diante) | **exceção de descanso** da data | descanso explícito |
| Reagendamento em data passada | ignorado (agregado) | o planejamento não altera dias passados |
| Reagendamento de outra rotina | ignorado (agregado) | a agenda anterior só usa a rotina ativa |
| Reagendamento para treino removido da rotina | **decisão manual** (link para o dia) | não dá para converter com segurança |
| Sem rotina ativa com treinos | nada a importar | — |

Regras fixas: identidade só por ID (rotina e treino), nunca por nome; nada altera o ponteiro da rotação, sessões,
fichas, `overrides` ou `trainingDays`; nenhuma sessão fictícia; a mesma atividade nunca é criada duas vezes.

## 3. Modos de importação

Os três modos usam o **mesmo motor determinístico** (`previewLegacyImport`).

| Modo | O que faz |
| ---- | --------- |
| **A — Só dias vazios** (padrão) | adiciona só onde o planejamento está vazio; conflitos ficam como estão ("manter"); resumo antes de confirmar |
| **B — Revisar conflitos** | cada conflito tem três escolhas: **Manter planejamento atual** (padrão), **Usar a agenda antiga**, **Não importar este dia**. Não existe substituição em lote |
| **C — Só visualizar** | a mesma prévia, sem botão de gravar |

"Usar a agenda antiga" num dia da semana encerra as entradas semanais atuais daquele dia **ontem** (semanas anteriores
continuam como estavam) e cria a da agenda anterior a partir de hoje. Numa data: troca as exceções daquela data (ou,
se o dia vinha do semanal, cria a exceção sem mexer no semanal).

## 4. Prévia

A prévia (tela `#/planejamento/importar`, aberta por **Planejamento › Importar agenda antiga** e por um atalho na
tela Treinos) mostra: rotina, treinos da rotação, dias de treino encontrados, reagendamentos e descansos explícitos de
hoje em diante, planejamento já existente, conflitos, e quantas entradas serão **criadas**, **preservadas**,
**ignoradas** e quantas exigem **decisão manual**. Cada dia/data aparece como:

> **Terça-feira** · Agenda antiga: dia de treino, segue a rotação de ABC. · Planejamento atual: Toda terça-feira:
> Treino C. · Resultado proposto: **Manter Treino C e solicitar decisão.**

A prévia é recalculada ao vivo; se outra aba mudar o planejamento ou a agenda, aparece "A prévia foi atualizada".

## 5. Conflitos

Um conflito na importação é qualquer lugar (dia da semana ou data) em que o planejamento já tem algo diferente do que
a agenda anterior indica — inclusive entradas **pausadas** ou de **rotina excluída** (são planejamento da pessoa).
Planejamento igual é "sem alteração" (é isso que torna a importação idempotente). Nada é substituído sem decisão.

## 6. Transações

`applyImport` roda numa única transação `rw` (`planEntries`, `settings`, `routines`, `overrides`):

1. se a mesma operação (ID gerado por confirmação) já foi aplicada, devolve o resultado sem gravar de novo;
2. relê tudo e compara a **impressão digital** (planejamento do perfil com revisões, dias de treino, reagendamentos da
   rotina, treinos da rotina, rotinas do perfil, data) com a da prévia confirmada → divergência = `changed`, nada
   gravado;
3. recalcula a prévia com os dados atuais e valida as referências (rotina e treino do perfil);
4. grava as entradas e o registro do desfazer — **tudo ou nada** (qualquer falha desfaz tudo; testado com falha nas
   entradas e no registro).

## 7. Desfazer

- **Registro persistente**: um documento por perfil, chave `planImport.last.<perfil>`, na tabela `settings`
  (chave-valor). Guarda o ID da operação, dia, modo, contagens, as entradas **criadas**, as **alteradas** (antes →
  depois) e as **apagadas** (antes), e a impressão digital de cada lugar afetado depois da importação.
- **Sem migração**: não é tabela nova (Dexie continua **v4**); o backup lê só a chave `settings`, então o registro
  **não entra no backup** (backup continua **v5**). "Apagar tudo" e "Substituir" na restauração apagam o registro.
- Funciona **depois de reiniciar o app** (gravado na mesma transação da importação), até a próxima importação ou uma
  restauração por substituição. Só a **última** importação pode ser desfeita.
- Antes de reverter (com confirmação), `planUndoImport` confere cada lugar afetado e cada entrada: qualquer alteração
  posterior (edição, exclusão, nova atividade no mesmo dia, em qualquer aba) **bloqueia o desfazer inteiro** e lista os
  motivos. Dias não afetados não bloqueiam e não são tocados.
- No mesmo dia: entradas criadas são apagadas e as substituídas voltam exatamente como eram. Em outro dia: semanais
  criadas são encerradas ontem (o passado não é reescrito), exceções de datas passadas ficam, substituídas voltam como
  nova versão a partir de hoje.
- Sessões, rotação e agenda anterior nunca são tocadas.

## 8. Preferências de exibição

Botão **Exibição** no Planejamento:

| Preferência | Efeito (só apresentação) |
| ----------- | ------------------------ |
| Abrir em Semana / Mês | visão inicial; `?visao=mes`/`?visao=semana` e `?data=` têm prioridade, também com a tela já aberta; alternância manual continua |
| Sugestões da agenda antiga | oculta, o dia fica sem sugestão; no dia selecionado aparece "oculta pelas preferências · Mostrar" |
| Previsões da rotação | oculta, aparece "pela rotação" no lugar de "Treino B (previsão)" |
| Sessões concluídas na grade | oculta as marcas ✓; os registros continuam no dia selecionado e no Histórico |
| Metas da semana | oculta o cartão (com link "Mostrar"); metas não mudam |
| Observações informativas | oculta só informações; **avisos relevantes sempre aparecem** e as informações continuam consultáveis no dia |

Persistência: estado de interface **deste aparelho, por perfil**, em `localStorage` (`irontrack.calendarPrefs.v1`,
`{ v: 1, profiles: { <perfil>: {...} } }`). Motivos: não é dado de treino, não precisa ir para o backup, o registro
`settings` é global (não por perfil) e uma tabela nova exigiria migração. Outras abas recebem a mudança pelo evento
`storage`; cada gravação relê o armazenado antes de escrever (não sobrescreve a mudança de outra aba). Armazenamento
indisponível ou corrompido: valem os padrões e a mudança vale só enquanto a tela estiver aberta (com aviso). A chave
entrou no estado auxiliar documentado do E2E de privacidade.

## 9. Central "Revisar divergências"

Botão no Planejamento (com a contagem de dias com aviso + dias só com observações; `?revisar=1` abre direto). Usa os
conflitos já detectados pelo P14 (nenhuma regra nova), **agrupados por tipo e gravidade**, sem mensagens repetidas,
com **Origem** e **Impacto** de cada grupo e, por dia:

- **Ver o dia** e **Editar planejamento** (seleciona o dia e leva aos ajustes);
- **Consultar agenda antiga** (Treinos);
- **Usar a agenda antiga só neste dia** — a única decisão gravada: com confirmação, cria a exceção daquela data
  (`replacePlanDate`: o treino reagendado, "próximo da rotação" para dia de treino, ou descanso). O semanal, a agenda
  anterior e a rotação não mudam; a divergência deixa de existir de fato;
- **Manter planejamento atual (só nesta tela)** / **Ocultar (só visual)** — recolhe o dia nesta tela, com o texto
  "Nada foi alterado; a divergência continua e volta ao reabrir". Nada é marcado como resolvido.

Decisão pendente herdada do P14: lembrar "manter planejamento atual" entre aberturas exigiria persistir uma decisão
que não altera nenhum modelo; continua **não persistido** (e rotulado assim). A importação reduz a maior parte dessas
divergências de forma real (planejamento e agenda passam a concordar).

## 10. Compatibilidade

- Dexie **v4** e backup **v5** inalterados; nenhum campo novo em `planEntries`.
- `trainingDays` e `overrides` não foram removidos nem alterados; a tela Treinos continua editando só eles.
- App anterior (P14) abrindo os dados: vê as entradas importadas como planejamento normal; ignora o registro do
  desfazer (chave diferente de `settings`).
- Depois de importar, o calendário mostra cada atividade **uma vez**: quando a agenda anterior diz o mesmo que o
  planejamento (`ResolvedDay.legacyAgrees`), aparece "A agenda anterior indica o mesmo" em vez de repetir.

## 11. Backup

- Entradas importadas são entradas de planejamento comuns: exportadas em `data.planEntries`, restauradas, mescladas
  (mesma atividade no mesmo dia = duplicata) e verificadas pela integridade como antes.
- O registro do desfazer e as preferências **não** vão para o backup.
- Restaurar por substituição um backup **anterior à consolidação** volta ao planejamento antigo; a agenda anterior
  continua; dá para importar de novo (testado).

## 12. Concorrência entre abas

| Situação | Resultado |
| -------- | --------- |
| Duas abas abrem a prévia | só leitura; cada uma se atualiza ao vivo |
| Uma aba edita o planejamento, outra confirma a importação | a confirmação é recusada (`changed`), nada gravado, a prévia mostra "atualizada" |
| Confirmar a mesma prévia duas vezes | aplicada uma vez (ID da operação) |
| Exclusão ou alteração de exceção depois da importação | o desfazer é bloqueado (nada revertido) |
| Desfazer em uma aba e na outra | a segunda recebe `undo_changed` |
| Preferência alterada em outra aba | chega pelo evento `storage` |

## 13. UX

Mobile-first (360 px, sem rolagem horizontal, botões de 44 px), linguagem simples, prévia por dia com "Agenda
antiga / Planejamento atual / Resultado proposto", confirmações com o resumo do que muda, estados vazios ("Não há
agenda antiga para importar"), barra de ações fixa no celular. Semana: "Hoje" escrito no dia atual, destaque do
**próximo treino** (planejado ou sugestão, com origem) e marca "Próximo". Mês: marcas de exceção (E), sessões (✓ n),
descanso, divergência, "hoje" sublinhado e em texto no rótulo acessível, Home/End na semana, legenda e **resumo do dia
selecionado**. Previsão nunca aparece como sessão confirmada. Início: linha **Hoje** com a origem (planejado,
sugestão, descanso, concluído) e "A agenda anterior indica o mesmo".

## 14. Testes

- `tests/unit/consolidation-domain.test.ts` (28): conversão segura, agenda e planejamento vazios, existente,
  pausado, rotina inexistente, descanso, reagendamento, passado, outra rotina, treino removido, identidade por ID,
  modos, decisões, impressão digital, idempotência, desfazer (mesmo dia, outro dia, bloqueios), decisão da central,
  agrupamento, `legacyAgrees`, preferências.
- `tests/unit/consolidation-db.test.ts` (19): transação, prévia desatualizada (outra aba, agenda, dias de treino),
  falha no meio (entradas e registro), rollback, toque duplo, revisão, desfazer após reabrir, bloqueios (edição e
  exclusão concorrentes), perfis, backup (exportação sem registro, substituir, backup anterior, mesclar, apagar tudo),
  Dexie v4.
- `tests/unit/consolidation-ui.test.tsx` (13): abrir, prévia, modos, confirmar, cancelar, desfazer (e bloqueado),
  prévia atualizada por outra aba, central (manter visual, usar agenda antiga, ver o dia, ocultar informações),
  preferências (sem gravar no banco, por perfil, outra aba, corrompidas), visão inicial e prioridade dos links, Início
  e Treinos.
- `tests/unit/architecture.test.ts`: pureza, escrita só no planejamento e no registro, nada para IA/rede, preferências
  fora do banco, rota sob demanda, navegação com 6 itens.
- `e2e/calendar-consolidation.spec.ts` (Android 360 px e desktop): os 19 passos do roteiro.

## 15. Limitações

- Só a **última** importação pode ser desfeita, e o desfazer é bloqueado (inteiro) se algo afetado mudou depois.
- A importação considera só a **rotina ativa** (a agenda anterior só existe para ela).
- Dias fora de `trainingDays` não viram descanso; quem quiser descanso explícito planeja no Planejamento.
- Preferências são por aparelho (não sincronizam e não entram no backup).
- "Manter planejamento atual" continua só visual (persistir exigiria autorização).
- O registro do desfazer mora na tabela `settings` com chave própria; se um dia houver um registro de operações mais
  amplo, ele deve virar uma tabela (com migração).
