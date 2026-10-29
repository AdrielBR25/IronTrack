# Decisões do calendário e desfazer inteligente

IronTrack 2.0 · Fase 01 · Prompt 16. Continua o [calendário unificado](CALENDARIO_UNIFICADO.md) (P14) e a
[consolidação de agendas](CONSOLIDACAO_AGENDAS.md) (P15).

Duas peças:

1. **Decisões lembradas**: a pessoa pode dizer "mantenha meu planejamento e não me avise de novo enquanto nada mudar"
   sobre uma divergência entre o planejamento semanal e a agenda anterior. A escolha é persistida, sobrevive ao reload,
   é isolada por perfil e **perde o efeito sozinha** quando algo relevante muda.
2. **Desfazer inteligente** da importação da agenda antiga: prévia item por item e, quando parte do que foi importado
   já foi alterada depois, a opção de desfazer **só os itens seguros**, sem nunca sobrescrever alterações posteriores.

Código: `src/modules/planner/decisions.ts` (registro, Zod, limites, erros), `src/modules/calendar/fingerprint.ts`,
`conflicts.ts` (identidade e impressão digital), `decisionMatch.ts` (aplicação), `decisions.ts` (situação, regras de
gravação), `src/db/calendarDecisions.ts` (transação), `src/features/calendar/decisionActions.ts` e `decisionUi.ts`
(camada única usada pelas três telas), `ConflictCenter.tsx`, `ConflictNotice.tsx`, `RememberedDecisions.tsx`;
desfazer: `src/modules/planner/legacyImport.ts` (`previewUndoImport`), `src/db/legacyImport.ts` (`undoLastImport`),
`src/pages/LegacyImportPage.tsx`.

## 1. O que é (e o que não é) uma decisão

| Ação | Tipo | Grava em |
| --- | --- | --- |
| **Manter planejamento e lembrar** | decisão de exibição | `calendarDecisions` |
| **Ocultar esta observação e lembrar** (só observações informativas) | decisão de exibição | `calendarDecisions` |
| **Voltar a mostrar aviso** | decisão de exibição | `calendarDecisions` (a decisão fica, sem efeito) |
| **Continuar exibindo (recolher só agora)** | visual, só nesta tela | nada |
| **Usar a agenda antiga só neste dia** | **alteração de planejamento**, com confirmação | `planEntries` (exceção da data) |

Uma decisão de exibição **nunca** altera planejamento, rotação, sessões, rotinas, agenda anterior ou configurações, e
nunca muda a precedência do calendário (o que vale no dia continua o mesmo; só o aviso deixa de aparecer como novo).
As telas mostram as duas famílias em blocos rotulados: "Decisão de exibição · não altera treinos" e "Alteração de
planejamento · modifica a exceção do dia".

Não existe "ignorar tudo", "ignorar este tipo" nem "ignorar daqui pra frente": cada decisão vale para **uma**
divergência, **numa** data.

## 2. Modelo

```ts
interface CalendarDecision {
  id: string;              // `${profileId}~${conflictId}` — determinístico
  profileId: string;
  conflictId: string;      // identidade do conflito (§3)
  conflictType: DecisionConflictKind;
  scope: 'conflict_day' | 'info_notice';
  date: string;            // AAAA-MM-DD
  subject: string | null;  // atividade/sessão envolvida, quando o tipo tem uma
  decision: 'keep_plan' | 'hide_info' | 'show';
  severity: 'warning' | 'info';
  sourceFingerprint: string; // impressão digital no momento da decisão (§4)
  summary: string;         // texto do aviso na hora (só exibição; nunca usado para casar)
  createdAt: number; updatedAt: number; revision: number;
}
```

- **Escopo** (`scopeOf`): `conflict_day` — "apenas este conflito neste dia" (padrão, `keep_plan`); `info_notice` —
  ocultar uma observação informativa (`hide_info`). `show` herda o escopo do tipo.
- **Permissões** (`decisionAllowed`): `keep_plan` só para tipos `plan_*` (planejamento × agenda anterior);
  `hide_info` só para observações informativas que não são `plan_*`; `show` sempre. Um aviso relevante não pode ser
  "ocultado" — só reconhecido com "manter planejamento".
- **Zod** (`calendarDecisionSchema`): datas reais, enums fechados, ID coerente com perfil + conflito, conflito
  coerente com tipo + data + assunto, escopo coerente, `updatedAt ≥ createdAt`, revisão ≥ 1, limites de tamanho.

## 3. Identidade de conflito

`conflictIdentity(kind, date, subject)` = `` `${kind}|${date}|${subject ?? ''}` ``.

- Estável e determinística: nada de IDs aleatórios no cálculo, nada de relógio, nada de nomes ou textos.
- O **assunto** só existe quando o tipo tem um alvo próprio: `rotation_differs` (a entrada do planejamento) e
  `session_off_plan` (a sessão). Os demais tipos têm no máximo um conflito por dia.
- Renomear rotina ou treino muda o texto do aviso, **não** a identidade (testado).

## 4. Impressão digital e invalidação

Cada conflito calculado carrega `fingerprint` (FNV-1a 64 bit duplo, `fingerprint.ts`) das partes que **definem**
aquele conflito, mais tipo, gravidade, data e assunto:

| Tipo | Entra na impressão digital |
| --- | --- |
| `plan_vs_legacy_workout` | entradas do dia (ID, revisão, tipo, rotina, treino), origem, marcador, atividades + treino previsto; indicação da agenda anterior **com** o treino |
| `plan_rest_vs_legacy_workout` | planejamento do dia (sem previsão); agenda anterior (treino só se vier de reagendamento) |
| `plan_workout_vs_legacy_rest` | planejamento do dia (sem previsão); agenda anterior (sem treino) |
| `exception_replaces_recurring` | IDs e revisões da exceção e do semanal |
| `rotation_differs` | ID, revisão e treino da entrada + próximo da rotação |
| `session_off_plan` | ID da sessão + planejamento do dia |

**Invalidam** (testado): nova revisão ou outro treino no dia, exceção nova ou alterada na data, reagendamento na data,
mudança de `trainingDays` que muda o dia, rotação que muda o treino indicado, treino renomeado de rótulo/removido,
rotina excluída (o conflito some), mudança de gravidade (previsão → hoje).

**Não invalidam** (testado): renomear rotina/treino, editar exercícios, planejar outro dia, exceção ou reagendamento
em outra data, dia de treino novo em outro dia, outra rotina, `updatedAt` sem nova revisão.

Nunca entram: `updatedAt`, textos, horário atual, nomes.

Aplicação (`applyDecisions`, depois de `detectConflicts`): uma decisão vale se for do perfil, do mesmo `conflictId`,
com a mesma impressão digital, permitida para a gravidade atual e diferente de `show`. Então o conflito ganha
`remembered` e sai de `hasWarning` (conta em `rememberedCount`); continua na lista do dia, consultável. Qualquer
diferença → o aviso volta como novo, sem apagar a decisão (ela aparece como "invalidada" em §7).

## 5. Regras de gravação (`planRemember`)

Dentro da transação, o dia é **recalculado com os dados atuais e sem decisões**:

- conflito sumiu → `gone`; impressão digital diferente da tela → `changed` (a tela estava desatualizada);
- data no passado → `past`; além de hoje + 400 dias → `horizon`;
- decisão não permitida → `not_allowed`; sem perfil → `no_profile`;
- mesma decisão já valendo → nada gravado (idempotente, toque duplo seguro);
- registro existente → só com a `revision` que a tela viu (senão `changed`); grava `revision + 1`.

`planShowAgain`, `planRemove` e `planCleanup` também conferem a revisão; a limpeza reavalia cada decisão na
transação e mantém a que voltou a valer em outra aba.

## 6. Interface

- **Revisar divergências** (Planejamento): por dia, bloco "Decisão de exibição" (Manter planejamento e lembrar /
  Ocultar esta observação e lembrar / Continuar exibindo) e bloco "Alteração de planejamento" (Usar a agenda antiga só
  neste dia, com confirmação que diz "Alteração de planejamento (não é só exibição)"). Contador "N avisos deste período
  têm decisão lembrada". Botão **Rever decisões anteriores** (`?decisoes=1` abre direto, inclusive com a tela aberta).
- **Aviso do dia** (Planejamento e diálogo do dia em Treinos): "Manter planejamento e lembrar"; linha "Decisão
  lembrada" com "Voltar a mostrar"; no detalhe, observações informativas com "Ocultar e lembrar".
- **Início**: sem aviso quando a divergência de hoje foi reconhecida; no lugar, um link discreto "Decisão lembrada:
  você manteve o planejamento de hoje".

As três telas usam a mesma camada (`decisionActions`/`decisionUi`) e o mesmo cálculo (`useCalendarInput` inclui as
decisões) — nenhuma decide sozinha.

## 7. Decisões lembradas (revisão)

Lista com dia, tipo da divergência, decisão, data da decisão, **situação atual** e o texto do aviso:

| Situação | Quando |
| --- | --- |
| Valendo | conflito idêntico existe e a decisão se aplica |
| Mostrando de novo | decisão `show` |
| Invalidada | o conflito existe mas mudou (impressão digital diferente) |
| Resolvida | o conflito não existe mais |
| Vencida | a data já passou |

Uma decisão sem efeito nunca aparece como ativa. Ações: abrir o dia, voltar a mostrar, remover, **limpar as sem
efeito** (seguro: reconferido na transação). Registros ilegíveis são contados à parte, nunca escondem avisos, e podem
ser removidos ("Remover registros ilegíveis").

## 8. Persistência

- **Dexie v5**: tabela `calendarDecisions` (`id, profileId, date, updatedAt`), migração aditiva (nenhum dado
  transformado). Escolhida em vez de um documento em `settings` porque cada decisão tem dono, identidade, revisão e
  precisa entrar no backup e nas rotinas de dono/apagar tudo como as demais coleções.
- Gravação sempre em `mutateCalendarDecisions`: transação `rw` sobre planejamento, sessões, rotinas, rotação,
  configurações, reagendamentos e decisões — leitura consistente, validação Zod de cada registro, dono = perfil local,
  limite de **200 decisões por perfil**, tudo ou nada. Nunca escreve fora de `calendarDecisions`.
- Leitura (`listCalendarDecisions`) filtra por perfil e valida; inválidos ficam em `invalidIds`.
- Entre abas: as gravações são serializadas pelo IndexedDB; as telas atualizam ao vivo (`useLiveQuery`).
- Nenhuma chave nova no `localStorage`.

## 9. Backup

- **Backup v6**: `data.calendarDecisions` (limite 1.000 no arquivo). Migração 5 → 6 acrescenta lista vazia; v0–v5
  continuam importáveis.
- **Substituir**: devolve as decisões exatamente; com transferência de perfil, `profileId` **e** `id` são remapeados.
- **Mesclar**: só acrescenta por ID; idênticas são ignoradas; em conflito de ID fica a **local** (exige confirmação de
  restauração parcial). Mesclar backup de outro perfil continua bloqueado.
- **Integridade**: decisão inválida, de outro dono ou com ID incoerente → erro `INVALID_CALENDAR_DECISION`, restauração
  recusada sem gravar (mesma política de metas e planejamento). Falha no meio → rollback.
- "Apagar tudo" apaga as decisões. O registro do desfazer da importação continua **fora** do backup.

## 10. Desfazer completo e parcial

`previewUndoImport(record, entries, ctx)` classifica cada lugar afetado pela importação:

| Situação | Significado | Desfaz? |
| --- | --- | --- |
| `safe` | igual ao que a importação deixou | sim |
| `modified` | alterado depois (edição, nova atividade, revisão diferente) | não — fica como está |
| `deleted` | entrada importada excluída depois | não |
| `past` | exceção de data já passada | não — o passado não é reescrito |
| `reverted` | já desfeito antes | — |

A prévia mostra, por grupo, o que a importação fez, a consequência de desfazer (ex.: "A repetição criada termina
ontem") e os motivos dos bloqueios, mais o que fica intacto (agenda antiga, rotação, sessões, fichas).

- **Desfazer tudo**: só quando todos os pendentes são seguros (o comportamento do P15).
- **Desfazer só os itens seguros**: reverte os seguros e preserva os alterados; o registro fica **"desfeita em parte"**
  (`status: 'partial'`, `reverted: [...]`) e o botão vira "Rever itens pendentes". Nunca é marcado como desfeito
  inteiro enquanto houver pendentes.
- **Cancelar**: nada muda.
- A confirmação leva a impressão digital da prévia; mudou entre a prévia e a confirmação (outra aba) → `undo_changed`,
  nada desfeito. Sem itens seguros → `undo_nothing`.
- Registro do P15 (sem `reverted`) continua funcionando.

## 11. Transações e concorrência

| Situação | Resultado |
| --- | --- |
| Toque duplo em "lembrar" | um registro, revisão 1 |
| Outra aba mudou o dia antes de confirmar | `changed`, nada gravado |
| Outra aba voltou a mostrar; esta tenta remover a versão antiga | `changed` |
| Remover numa aba, voltar a mostrar na outra | `missing`, nada recriado |
| Limite atingido | `limit`, nada gravado |
| Falha no meio | rollback |
| Desfazer confirmado duas vezes (mesma prévia) | só um aplica |
| Planejamento editado entre a prévia e o desfazer | `undo_changed` |

## 12. Política temporal

- Decisões só para hoje até hoje + 400 dias; datas passadas → "vencida", sem efeito, removível pela limpeza.
- O desfazer não reescreve o passado: exceções de datas passadas ficam; repetições semanais criadas pela importação
  **terminam ontem** em vez de serem apagadas (semanas anteriores continuam como estavam), e a prévia explica.

## 13. Performance

- Impressão digital síncrona e barata, calculada junto com a detecção (que já existia).
- Índice das decisões por `conflictId` montado uma vez por cálculo (`decisionIndex`).
- `useCalendarInput` é memorizado pelas fontes e pelas decisões; cronômetros não recalculam o calendário.
- "Decisões lembradas" avalia tudo com **um** `resolveRange` sobre o intervalo das decisões, só quando aberta.

## 14. UX e acessibilidade

- Blocos rotulados (`role="group"` + `aria-label`) distinguem exibição × alteração de planejamento.
- Alvos de toque ≥ 44 px no Android; textos quebram sem rolagem horizontal a 360 px (E2E).
- Situação com ícone **e** texto; mensagens de erro em português via `CalendarDecisionError`.

## 15. Privacidade

Tudo local (IndexedDB). Nada vai para a IA: ContextBuilder, gateway e consentimento não foram alterados; nenhuma
sincronização, nenhum login, nenhuma conversa armazenada.

## 16. Testes

- `tests/unit/calendar-decisions-domain.test.ts` (31): identidade, mudanças irrelevantes × relevantes, aplicação só na
  apresentação, perfis/datas/tipos, `show`, central e contagens, opções, nada global, regras de gravação, situações,
  limpeza, Zod e limites, sem efeitos colaterais.
- `tests/unit/calendar-decisions-db.test.ts` (21): persistência após reabrir, idempotência, revisão, invalidação e nova
  decisão, tela desatualizada, passado, perfis, corrompidos, limite, limpeza, concorrência entre abas, falha no meio,
  backup (exportar, substituir, mesclar, transferência, v5 → v6, inválidos, rollback), apagar tudo, rotina removida.
- `tests/unit/undo-partial.test.ts` (9): prévia por item, bloqueio, desfazer só os seguros, pendente nunca
  sobrescrito, revalidação, concorrência, falha no meio, passado e recorrência, registro do P15.
- `tests/unit/calendar-decisions-ui.test.tsx` (7): central, reabrir, Início/Treinos, aviso do dia, mudança relevante,
  "Decisões lembradas", desfazer parcial e cancelar.
- `e2e/calendar-decisions.spec.ts` (Android 360 px e desktop): os 23 passos do roteiro.

## 17. Limitações

- O app tem um perfil local por aparelho (sem troca de perfil na interface); o isolamento é garantido no dado e testado.
- Decisões não sincronizam entre aparelhos (vão no backup).
- Só a última importação pode ser desfeita; itens alterados depois ficam para ajuste manual no Planejamento.
- O registro do desfazer continua em `settings` (fora do backup).
- Limite de 200 decisões por perfil: ao atingir, é preciso limpar as sem efeito.
