# Reconhecimento assistido de exercícios antigos

IronTrack 2.0 · Fase 01 · Prompt 18. Ferramenta para ligar os exercícios das fichas antigas (criadas antes da
biblioteca, sem origem) a um exercício da biblioteca, **sempre com confirmação da pessoa**. Junto vieram o catálogo
expandido (versão 2, 110 exercícios), o histórico de uso ("Mais utilizados"), a adição múltipla, a substituição
múltipla e o resumo do construtor de fichas.

Código: `src/modules/exercises/recognition.ts` (motor de sugestões, inventário, referências, comparação),
`src/modules/exercises/usage.ts` ("Mais utilizados"), `src/modules/exercises/bulk.ts` (adição e substituição
múltiplas), `src/modules/exercises/workoutOps.ts` (operações `link`, `unlink`, `addMany`, `replaceMany`),
`src/modules/exercises/catalog/expansion.ts`, `src/db/library.ts` (`applyLinks`, `unlinkExercise`),
`src/pages/ExerciseRecognitionPage.tsx` (`#/exercicios/reconhecer`), `src/pages/BulkReplacePage.tsx`
(`#/treinos/:rotina/:treino/substituir`), `src/features/library/LinkConfirmDialog.tsx`, `LibraryPickerDialog.tsx`
e `AddManyDialog.tsx`.

## 1. Objetivo e regra de ouro

Uma ficha importada antes do P17 guarda só uma cópia do exercício (nome, grupo, equipamento, configuração). Ela
funciona, mas não aparece como "na ficha" na biblioteca, não entra em "Mais utilizados" e não ganha detalhes. O
reconhecimento **sugere** a origem provável e a pessoa decide.

Nada é associado sozinho, nada é deduzido pelo nome fora desta tela, e associar grava **apenas a referência de
origem** (`catalogId` + `catalogVersion`, ou `customExerciseId`) na instância da ficha. Nome, ID da instância, séries,
repetições, carga, descanso, observações, metas, sessões, histórico e analytics ficam exatamente como estavam.

## 2. Auditoria (estado encontrado no P17) e riscos

| Risco | Situação no P17 | Tratamento no P18 |
| --- | --- | --- |
| Formulário de edição aberto antes de outra aba associar apagaria a origem ao salvar | `update` gravava o objeto do formulário inteiro | `update` agora preserva a origem gravada (`withRefOf`): o formulário não edita a origem |
| Substituir um exercício que outra aba acabou de associar | `replace` não conferia o estado | `replace` aceita `expected` (impressão digital da instância) e recusa com "mudou em outra aba" |
| Associar por similaridade de nome automaticamente | não existia | proibido; sugestões só aparecem nesta tela e exigem confirmação |
| Unir históricos por nome | não existia | mantido assim: sessões antigas não ganham origem; analytics usa o `exerciseKey` de sempre |
| Redirecionar metas | metas por `templateIds` | inalterado: associar não muda o ID da instância; substituir cria ID novo e a meta fica no anterior |
| Catálogo maior pesar o pacote principal | catálogo em sub-entrada | mantido: o catálogo continua num pedaço sob demanda |
| Apelido igual em duas entradas | "agachamento livre" em `agachamento-livre` e `agachamento-peso-corporal` (herdado) | documentado; o motor mostra as duas como candidatas e avisa a diferença de modalidade |
| Menu de ações do editor ficava aberto atrás do detalhe da origem | — (novo no P18) | encontrado no E2E e corrigido: "Ver detalhes na biblioteca" fecha o menu |

## 3. Inventário

`legacyInventory(routines, profileId)` percorre as fichas do perfil e separa as instâncias **sem referência**
(`unlinked`) das **já associadas** (`linked`), com rótulo, nome do treino e da rotina, e conta os treinos afetados.
`recognitionSummary` produz os cinco contadores da tela:

- sem referência;
- fichas (treinos) afetadas;
- com sugestão;
- exigem busca manual (nenhum candidato);
- já associados.

A lista é agrupada por rotina e treino ("Ficha A — Peito, ombros e tríceps · ABC Hipertrofia"). `?treino=r/w` limita
a tela a um treino (atalho vindo do editor).

## 4. Motor de sugestões

Local, puro e determinístico (`recognize`). Para cada instância sem origem compara com todos os itens ativos da
biblioteca (catálogo + personalizados não arquivados):

- **Nome**: `nameTokens` normaliza (minúsculas, sem acentos, sem pontuação), remove palavras vazias ("com", "na",
  "de"…) e plural simples; `nameSimilarity` vale 1 para nomes iguais e, fora isso, o coeficiente de Dice dos tokens.
  O nome do item e cada apelido contam; vale o maior.
- **Grupo muscular**, **modalidade**, **equipamento** e **lateralidade** produzem motivos ou avisos.

Só entram candidatos com nome ≥ 0,5. No máximo 3 candidatos, ordenados por classificação, nota do nome, número de
motivos, menos avisos e nome (desempate estável).

## 5. Classificações

| Classificação | Regra |
| --- | --- |
| Correspondência forte | nome ≥ 0,75 **e** nenhum aviso |
| Correspondência possível | nome ≥ 0,5, ou forte com algum aviso |
| Sem sugestão confiável | nenhum candidato: a pessoa usa "Escolher na biblioteca" |

Mesmo uma correspondência forte só vira associação depois da confirmação.

## 6. Motivos e avisos

Cada candidato traz uma frase de explicação ("Mesmo nome, mesmo grupo muscular, modalidade compatível e mesmo
equipamento.") e a lista de avisos:

- grupo muscular diferente (ou principal na ficha e secundário na biblioteca);
- modalidade diferente, com "Associar não muda a modalidade da ficha.";
- tipo de carga diferente;
- equipamento diferente;
- execução diferente (unilateral × bilateral).

## 7. Confirmação

`LinkConfirmDialog` mostra lado a lado o **exercício atual (ficha)** e o **exercício da biblioteca**, o motivo da
sugestão, os avisos destacados, **o que muda** (só a referência de origem) e **o que continua igual**
(`LINK_UNCHANGED`: nome atual na ficha, ID da instância, séries, repetições, carga, descanso, observações, metas,
sessões antigas, histórico, analytics). Nada é gravado antes de "Associar".

## 8. Associação individual

Ações por exercício: **Associar** (usa a sugestão principal), **Escolher outro** (abre a busca da biblioteca, com as
sugestões no topo) e **Ignorar por enquanto** (só esconde nesta visita; não grava nada; "Voltar à lista" desfaz).
A confirmação usa `applyLinks` com uma única entrada.

## 9. Lote assistido

"Selecionar vários" liga caixas por exercício. **Não existe "selecionar tudo".** "Revisar N selecionados" abre uma
revisão item a item ("Revisar 2 de 3"): confirmar a sugestão, escolher outro ou pular. O resumo lista o que será
associado e o que foi pulado; "Aplicar N associações" grava tudo numa transação.

`applyLinks(requests)` roda numa transação rw única sobre `routines` e `customExercises`:

1. revalida cada pedido contra a versão gravada (rotina, treino e instância existem; impressão digital igual à da
   revisão; referência válida; personalizado existe e não está arquivado);
2. se qualquer pedido falha, **nada** é gravado e o resultado diz o motivo de cada um;
3. se tudo passa, grava as referências e atualiza `updatedAt` das rotinas tocadas.

Estados por entrada: aplicado, já estava associado a esta origem (idempotente), associado a outra origem, mudou em
outra aba, não encontrado, referência inválida, personalizado arquivado ou ausente.

## 10. Desassociação

Explícita e reversível: "Desfazer" na seção "Já associados" do reconhecimento ou "Desfazer associação com a
biblioteca" no menu do exercício no editor. Confirmação ("Desfazer associação"); remove só a referência; o exercício
volta a aparecer como sem vínculo e pode ser associado de novo. Também confere a impressão digital.

## 11. Concorrência entre abas

- **Impressão digital** (`instanceFingerprint`): JSON com chaves ordenadas da instância. Guardada quando a
  confirmação, a revisão ou a prévia abre; conferida dentro da transação.
- Operações sempre sobre a versão gravada (`mutateWorkout` em transação rw); as telas são reativas (`useLiveQuery`)
  e mostram na hora o que outra aba gravou.
- `link` é idempotente para a mesma origem e recusa outra origem já gravada (`already_linked`).
- `update` preserva a origem gravada; `replace` e `replaceMany` aceitam `expected`.

## 12. Catálogo expandido e versionamento

`CATALOG_VERSION = 2`: 53 entradas do P17 + 57 novas (`since: 2`) = **110 exercícios distintos**, em peito, costas,
ombros, braços, pernas, glúteos, panturrilhas, abdômen, por tempo e cardio. Regras (ver
`BIBLIOTECA_EXERCICIOS.md` §21): IDs publicados nunca mudam, nunca são reaproveitados e nunca são redirecionados;
uma entrada alterada sobe a própria `version`. Quatro entradas subiram para a versão 2 para separar variações que
ganharam entrada própria (`triceps-polia`, `afundo`, `elevacao-de-pernas`, `elevacao-lateral-unilateral`).

## 13. Uso e "Mais utilizados"

- **"Já está em uma das suas fichas."**: a origem aparece em alguma instância das fichas do perfil (`sheetKeys`).
- **"Utilizado em uma sessão registrada com esta origem."**: alguma sessão concluída executou o exercício com essa
  origem gravada.
- **"Mais utilizados"** (`mostUsed`): conta sessões **concluídas** do perfil, uma vez por sessão, por identidade de
  origem, só quando há ao menos uma série concluída que não seja aquecimento. Não conta nomes, fichas, exercícios só
  planejados nem duplicatas. Exercícios executados sem origem aparecem à parte como **"Sem vínculo com a biblioteca"**
  (quantidade e número de sessões), sem entrar na classificação.

Associar uma ficha **não** muda o histórico: sessões antigas continuam sem origem e continuam fora da classificação.

## 14. Adição múltipla

Na biblioteca aberta a partir do editor, "Selecionar vários" marca itens (o botão mostra a ordem de marcação). A
confirmação (`AddManyDialog`) lista as linhas na ordem, cada uma com um ID próprio criado ao abrir; selos "já na
ficha" e "repetido"; repetir um exercício só com "Adicionar outra vez"; "Tirar da seleção". Mostra as séries
planejadas acrescentadas (estimativa). Grava com `addMany`: tudo ou nada, sem carga, no fim da ficha, idempotente
(repetir a confirmação não duplica), limite de exercícios por treino respeitado.

## 15. Substituição múltipla

`#/treinos/:rotina/:treino/substituir`, em três etapas: **selecionar** → **escolher** substituto para cada um →
**prévia**. A prévia (`bulkReplacePreview`) mostra por exercício o que é preservado e o que é descartado, as metas
ligadas ao anterior, a nova identidade e a ordem final da ficha, com o texto fixo:

> As metas vinculadas ao exercício anterior continuarão vinculadas a ele.

`replaceMany` aplica tudo numa operação, confere a impressão digital de cada exercício (`changed` se outra aba
mexeu), é idempotente quando tudo já foi aplicado e cada substituto entra na mesma posição com ID novo.

## 16. Construtor de fichas

Resumo no topo do editor: número de exercícios, **séries planejadas (estimativa, não é volume executado)** e
"N sem vínculo com a biblioteca" (atalho para o reconhecimento filtrado). Selo "sem vínculo" por linha. Botões
"Adicionar vários", "Substituir vários" e "Reconhecer". Menu do exercício: ver detalhes da origem (somente leitura,
sem sair da edição), desfazer associação ou associar. Reordenar com setas ou arrastando e duplicar seguem do P17.

## 17. Metas, analytics e sessões

Nada muda: metas seguem por `templateIds` (associar mantém o ID; substituir deixa a meta no anterior, que passa a
"não está mais em nenhuma ficha" e continua usando o histórico); modelos multimodais preservados; fórmulas de 1RM,
sessões, rotação e calendário intocados.

## 18. Persistência e backup

**Sem esquema novo**: Dexie continua na versão 6 e o backup na versão 7. A referência já existia na instância desde
o P17; o P18 só passou a gravá-la em fichas antigas. Backup v7 exporta e restaura as referências como estão.

## 19. Desempenho

O motor roda sobre ~110 itens por instância (milissegundos no total da ficha de exemplo). O catálogo continua fora
do pacote principal (324,46 kB, igual ao P17); a página de reconhecimento (19 kB) e a de substituição múltipla
(9 kB) são carregadas sob demanda.

## 20. Privacidade

Tudo local. Nenhum dado vai para a IA, o ContextBuilder ou o gateway; nenhuma chave nova no `localStorage`; nenhuma
requisição de rede. O reconhecimento funciona offline.

## 21. Testes

- `tests/unit/recognition-domain.test.ts`: tokens e similaridade, classificações, motivos e avisos, inventário,
  impressão digital, operações `link`/`unlink`/`addMany`/`replaceMany`, idempotência, "Mais utilizados", prévia da
  substituição múltipla, catálogo v2 e privacidade.
- `tests/unit/recognition-db.test.ts`: `applyLinks` tudo ou nada, revalidação, concorrência entre duas conexões,
  `update` preservando a origem, desassociação, metas e sessões intocadas, backup v7 com referências.
- `tests/unit/recognition-ui.test.tsx`: contadores, confirmação, lote sem "selecionar tudo", adição e substituição
  múltiplas.
- `e2e/exercise-recognition.spec.ts` (Android 360 e desktop): o fluxo completo, com backup, restauração, duas abas e
  offline.

## 22. Limitações

- As sugestões comparam nome, grupo, modalidade, equipamento e lateralidade; não entendem descrições livres.
- "Ignorar por enquanto" não é lembrado entre visitas (por decisão: nada é gravado).
- Não há "substituir em todas as fichas" nem associação entre rotinas diferentes de uma vez (é por exercício).
- Sessões antigas não ganham origem; "Mais utilizados" só cresce com treinos feitos depois da associação.
- O apelido "agachamento livre" ainda aparece em duas entradas do catálogo (herdado do P17).
