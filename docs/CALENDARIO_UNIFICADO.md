# Calendário unificado

IronTrack 2.0, Fase 01, Prompt 14. Uma só interpretação dos dias de treino em todo o app, **sem migrar nem alterar**
nenhum dado. Código em `src/modules/calendar` (domínio puro), `src/hooks/useCalendar.ts` (leitura),
`src/features/calendar/*` (componentes) e nas telas `#/planejamento`, Início e Treinos.

Princípio: a visão do calendário é **calculada sob demanda e nunca persistida**. Ela combina quatro fontes que continuam
independentes e intactas. Nada aqui grava `planEntries`, `overrides`, `Settings.trainingDays`, rotação ou sessões.

## 1. Fontes de dados

| Fonte | Onde mora | Quem altera | Papel no calendário |
| ----- | --------- | ----------- | ------------------- |
| Sessões | `sessions` (`completed`, `active`, `discarded`) | fluxo de treino | **fatos** (só concluídas do perfil, sem repetidas: `countableSessions` das metas); a em andamento aparece à parte |
| Planejamento semanal (P13) | `planEntries` (recorrente + exceções por data) | tela Planejamento | **intenção explícita** |
| Agenda anterior | `Settings.trainingDays` + `overrides` da rotina ativa | Configurações (dias) e Treinos (reagendar/descanso) | **sugestão** quando não há planejamento |
| Rotação | `rotations.nextIndex` | concluir treino, pular, corrigir próximo | **previsão** (ponteiro atual + simulação) |

### Auditoria: o que cada tela usava antes do P14

| Tela | Sessões | Planejamento | Agenda anterior | Rotação |
| ---- | :-----: | :----------: | :-------------: | :-----: |
| Início · cartão "hoje" | concluídas hoje | — | `projectSchedule` (trainingDays + overrides) | ponteiro |
| Início · bolinhas da semana e consistência | concluídas | — | `trainingDays` | — |
| Treinos · agenda de 14 dias | concluídas hoje | — | `projectSchedule` + edição de `overrides` | ponteiro, pular, corrigir |
| Planejamento (P13) | concluídas + em andamento | `planEntries` | — | ponteiro (repetido em todos os dias futuros) |
| Configurações | — | — | edita `trainingDays` | política de avanço |
| Metas, Histórico, Evolução, Desempenho | concluídas | — | — | — |

Resultado: Início/Treinos e Planejamento podiam mostrar treinos diferentes para o mesmo dia. **Depois do P14**, Início,
Treinos e Planejamento usam a mesma resolução (`resolveRange`/`resolveWeek`/`resolveMonth`); Metas, Histórico e
Evolução não mudaram (só sessões).

## 2. Modelo unificado (`src/modules/calendar/types.ts`)

`ResolvedDay` (por data): o dia do planejamento exatamente como o P13 calcula (`plan`, via `buildWeek`), a agenda
anterior interpretada (`legacy`), as previsões das atividades que seguem a rotação (`forecasts`), a origem que define o
dia (`plan_exception`, `plan_recurring`, `legacy`, `none`), o estado unificado (`status`), as linhas resolvidas
(`entries`) e os conflitos (`conflicts`, `hasWarning`).

Cada `ResolvedEntry` tem: data local, origem (`session`, `active_session`, `plan_exception`, `plan_recurring`,
`legacy_override`, `legacy_rotation`, `legacy_off`), tipo (`workout`/`rest`/`free`), rotina, treino, estado em texto,
evidência (`sessionId`), atividade associada (`planEntryId`; null em sessão = extra), se segue a rotação, se está
**sombreada** (visível, mas não define o dia), se participa de conflito e o **grau de certeza**:

| Certeza | Significado |
| ------- | ----------- |
| `fact` | sessão concluída |
| `explicit` | escolhido pelo usuário (planejamento ou reagendamento) |
| `suggestion` | dedução dos dias de treino das Configurações |
| `current` | ponteiro atual da rotação |
| `forecast` | simulação a partir da rotação atual |
| `undetermined` | "Treino a definir pela rotação" |

Estados do dia: Concluído, Parcialmente realizado, Em andamento, Planejado, Sugestão da agenda anterior, Descanso,
Dia livre, Sem registro, Treino realizado, Nada planejado. Nunca "falhou".

## 3. Política de precedência (só de apresentação)

1. **Sessões concluídas** são fatos e sempre aparecem, no dia em que aconteceram.
2. **Exceção** do planejamento define o plano daquele dia.
3. **Planejamento recorrente** define o plano.
4. **Agenda anterior** define o dia só quando não há planejamento (e de hoje em diante). Quando há, continua visível,
   sombreada ("Agenda anterior (não define o dia)").
5. **Rotação futura** aparece apenas como previsão.

Nenhum dado é alterado pela precedência; nenhuma fonte é escondida.

## 4. Conflitos (`conflicts.ts`)

Determinísticos, calculados a cada leitura, **nunca resolvidos automaticamente**.

| Tipo | Quando | Severidade |
| ---- | ------ | ---------- |
| `plan_rest_vs_legacy_workout` | planejamento diz descanso/dia livre; agenda anterior indica treino | aviso |
| `plan_workout_vs_legacy_rest` | planejamento diz treino; agenda anterior marcou descanso (reagendamento) | aviso |
| — | idem, mas o dia apenas não é dia de treino nas Configurações | informação |
| `plan_vs_legacy_workout` | treinos diferentes; agenda anterior explícita (reagendamento) ou de hoje (ponteiro) | aviso |
| — | idem, mas o treino da agenda anterior é previsão (dias futuros) | informação |
| `exception_replaces_recurring` | exceção difere do planejamento semanal daquele dia | informação |
| `rotation_differs` | hoje: treino específico planejado ≠ próximo da rotação | informação |
| `session_off_plan` | sessão concluída fora do planejado do dia | informação |

Conflitos planejamento × agenda anterior só são calculados para **hoje e dias futuros**. Se os dois lados "seguem a
rotação" da mesma rotina, não há conflito (é o mesmo próximo treino na hora de treinar).

Interface: "Seu planejamento indica Treino B (Costas e bíceps), mas a agenda anterior sugere Treino A (Peito…)." com
**Manter planejamento atual** (só recolhe o aviso nesta tela; nada é gravado e ele volta ao reabrir), **Ver
detalhes** (comparação lado a lado e todas as observações), **Editar o planejamento** e **Consultar a agenda antiga**.

## 5. Agenda anterior (`legacy.ts`)

Usa a mesma função de sempre (`projectSchedule`) a partir de hoje, com o ponteiro da rotina ativa e a sessão concluída
hoje. Por isso a Treinos mostra exatamente o que mostrava antes nos dias sem planejamento. Dias passados mostram só o
configurado (reagendamento ou dia de treino), sem inventar qual treino seria. Projeção limitada a 400 dias.

## 6. Previsão da rotação (`forecast.ts`)

No P13, "próximo da rotação" repetia o ponteiro atual em todos os dias futuros. Agora:

- a primeira atividade que segue a rotação de uma rotina, sem nada antes que mova o ponteiro, recebe o ponteiro atual
  (`current`, "próximo da rotação agora");
- as seguintes são simuladas como se as anteriores fossem concluídas e a rotação avançasse pela regra de sempre
  (`forecast`, "Previsão baseada na rotação atual"): "segue a rotação" consome o próximo; treino específico faz a
  rotação continuar a partir dele (`indexAfter`);
- treino em andamento da rotina conta como se fosse concluído (as previsões viram `forecast`);
- concluídas hoje já moveram o ponteiro e aparecem como fato;
- além de **14 dias** (`FORECAST_HORIZON_DAYS`), rotina sem treinos ou dia passado sem registro: "Treino a definir pela
  rotação".

**Quando a previsão muda:** ao concluir um treino diferente do previsto (a rotação continua a partir dele), ao concluir
abaixo do limiar da política `threshold` (não avança), ao pular ou corrigir o próximo, ao treinar em dia não planejado,
ao editar o planejamento ou a ordem dos treinos, ao reagendar na agenda anterior e com a passagem dos dias. Nada é
simulado como fato e nenhuma conclusão é criada.

## 7. Visão semanal (`#/planejamento`)

Faixa de 7 dias (segunda a domingo) com estado, atividades, sessões, descanso, exceções, **sugestões da agenda
anterior** ("Sug. Treino A") e **indicador de divergência** (triângulo). O dia selecionado mostra: aviso de conflito,
planejado (com previsão identificada), registros, "Agenda anterior" (se define o dia ou não, com link para Treinos) e
ajustes do planejamento. Consistência da semana (P13) + resumo das fontes (sugestões e divergências à parte).

## 8. Visão mensal

Alternância **Semana | Mês**. Grade compacta de segunda a domingo, navegação entre meses, "Voltar para hoje",
seleção de dia (o detalhe aparece embaixo), setas do teclado (±1 dia, ±1 semana), estado em texto no rótulo acessível
e legenda visível. Resumo do mês com as mesmas definições do P13. Os dias são resolvidos sob demanda; nenhum registro é
criado. `?data=yyyy-mm-dd` abre um dia; `?visao=mes` abre na visão mensal.

## 9. Integração com a Início

Cartão "hoje" pela visão unificada: treino em andamento continua com prioridade ("CONTINUAR TREINO"); planejado para
hoje (com origem: semanal, exceção, pela rotação), sugestão da agenda anterior, descanso ou dia livre, ou "feito ✓".
Mostra estado da rotação, **próxima atividade** (com "Planejada", "Sugestão da agenda anterior" ou "previsão baseada
na rotação atual") e aviso de divergência com link para o dia no Planejamento. Iniciar um treino específico diferente
do próximo da rotação pede a escolha (mesmo diálogo do P13). Nada é iniciado sozinho. A semana usa os mesmos dias e
números do Planejamento; sem planejamento, a consistência de 4 semanas continua pela agenda anterior, rotulada assim.

## 10. Integração com a Treinos

A agenda de 14 dias passou a usar a visão unificada (planejamento com marca, reagendamento com ponto, previsão em tom
mais claro, divergência com triângulo). O diálogo do dia separa: **o que vale**, avisos, **Planejamento semanal**
("Editar no planejamento") e **Agenda anterior (reagendar)** (descanso, reagendar, voltar ao padrão — inalterados).
Os controles "Próximo" e "Pular" dizem que alteram só a rotação. Lista de rotinas, início manual, edição de fichas e
histórico não mudaram.

## 11. Edição: qual modelo cada ação altera

| Ação | Onde | Modelo alterado |
| ---- | ---- | --------------- |
| Toda <dia> (acrescentar, descanso, dia livre, alterar, pausar, remover) | Planejamento | planejamento semanal |
| Só em dd/mm | Planejamento | exceção da data |
| Reagendar / marcar descanso / voltar ao padrão | Treinos › dia | agenda anterior (`overrides`) |
| Dias de treino | Configurações | agenda anterior (`trainingDays`) |
| Próximo / Pular | Treinos | rotação |

Cada tela diz isso em texto. Não há migração automática do legado nem alterações em lote.

## 12. Sessões reais, metas e datas

- Associação por IDs (P13), só concluídas do perfil, sem duplicar, sem mover entre dias; extras aparecem; em andamento à
  parte. Uma sessão concluída é fato, independentemente do plano.
- Metas: `weeklyGoalsForWeek` (P12/P13) sem mudança. Resumos reutilizam os números do `buildWeek` (teste confere a
  igualdade). "Planejadas" contam só o explícito; sugestões e previsões são informadas à parte.
- Datas de calendário em aritmética UTC pura; instante da sessão → dia local (`sessionDay`). Testado: segunda a
  domingo, virada de mês e de ano, horário de verão (Brasil 2018, EUA 2026), mudança de fuso, sessões perto da
  meia-noite, recorrências e exceções.

## 13. Persistência e privacidade

- **Nenhuma** tabela, migração, campo ou chave nova. Dexie **v4**, backup **v5** (testado). Nenhum registro existente é
  alterado só por exibir (teste compara o retrato completo antes e depois). Backups v0–v5, mesclar, substituir,
  integridade e rollback inalterados.
- "Manter planejamento atual" não persiste (estado da tela). Se for necessário lembrar a escolha entre sessões, isso
  exige persistência nova e autorização.
- Calendário não vai à IA: ContextBuilder, consentimento e gateway intocados; testes de arquitetura impedem IA,
  integrações, banco e outros domínios de importar `@/modules/calendar`. Sem sincronização, login ou serviços externos.

## 14. Testes

- `tests/unit/calendar-domain.test.ts` (29): agenda anterior, planejamento explícito, exceção, recorrência,
  precedência, conflitos, rotação, previsão incerta, sessões concluídas, extras, descanso, dia livre, semana, mês,
  virada de ano, fuso, horário de verão, imutabilidade e determinismo.
- `tests/unit/calendar-ui.test.tsx` (13): Planejamento (sugestão, aviso, manter sem gravar, previsão, mês, `?data=`),
  Início (sugestão, planejado + escolha + rotação intacta, descanso, treino em andamento, sessão de outro perfil),
  Treinos (agenda, diálogo, reagendar sem tocar o planejamento, rotação), versões do esquema e do backup.
- `tests/unit/architecture.test.ts`: pureza e dependências do domínio, privacidade, hook só leitura.
- `e2e/unified-calendar.spec.ts` (Android 360 px e desktop): os 20 passos do roteiro.

## 15. Limitações

- A agenda anterior considera só a **rotina ativa** (como sempre). Planejamento de outra rotina é comparado com ela.
- "Manter planejamento atual" vale só enquanto a tela está aberta (continua assim no P15, rotulado "só nesta tela").
- Previsão: horizonte fixo de 14 dias; supõe que cada atividade planejada será concluída e avançará a rotação.
- Conflitos com dias passados não são calculados (exceto treino fora do planejado).
- A consistência de 4 semanas da Início, sem planejamento, continua a fórmula antiga (`consistency`) baseada nos dias de
  treino; com planejamento, a Início mostra os números do planejamento.
- ~~Não há "copiar agenda anterior para o planejamento"~~ — desde o P15 existe a importação **assistida e opcional**
  (prévia + confirmação), ver [CONSOLIDACAO_AGENDAS.md](CONSOLIDACAO_AGENDAS.md).

## 16. Consolidação (P15)

O P15 acrescentou, sem mudar as regras de precedência e de conflito acima: importação assistida da agenda anterior
(`#/planejamento/importar`), central "Revisar divergências" (agrupa os conflitos deste documento, com "Usar a agenda
antiga só neste dia" como única decisão gravada), preferências de exibição por aparelho (visão inicial Semana/Mês e
o que mostrar) e `ResolvedDay.legacyAgrees` ("A agenda anterior indica o mesmo", sem repetir a atividade). `?visao=mes`
e `?visao=semana` passaram a ser aceitos, e os links são aplicados também com a tela já aberta. Detalhes em
[CONSOLIDACAO_AGENDAS.md](CONSOLIDACAO_AGENDAS.md).

## Decisões lembradas (P16)

Cada conflito agora tem **identidade** (`tipo|data|assunto`) e **impressão digital** das informações que o definem.
Uma decisão lembrada ("Manter planejamento e lembrar", "Ocultar observação") só muda a **apresentação** de um conflito
idêntico: ele sai de `hasWarning` (conta em `rememberedCount`) e continua consultável no dia; precedência, entradas,
estado e próxima atividade não mudam. Qualquer mudança relevante faz o aviso voltar como novo. Ver
[DECISOES_CALENDARIO.md](DECISOES_CALENDARIO.md).
