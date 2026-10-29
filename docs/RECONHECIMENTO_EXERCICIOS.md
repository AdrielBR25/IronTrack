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

## 1. Reconhecimento assistido

Uma ficha importada antes do P17 guarda só uma cópia do exercício (nome, grupo, equipamento, configuração). Ela
funciona, mas não aparece como "na ficha" na biblioteca, não entra em "Mais utilizados" e não ganha detalhes. O
reconhecimento **sugere** a origem provável e a pessoa decide.

Regra de ouro: nada é associado sozinho, nada é deduzido pelo nome fora desta tela, e associar grava **apenas a
referência de origem** (`catalogId` + `catalogVersion`, ou `customExerciseId`) na instância da ficha.

Entrada: Biblioteca › "Reconhecer exercícios antigos" (com o selo "N sem vínculo") ou, no editor da ficha, o atalho
"N sem vínculo com a biblioteca", o botão "Reconhecer" e "Associar à biblioteca" no menu do exercício
(`?treino=<rotina>/<treino>` limita a lista àquele treino).

**Inventário** (`legacyInventory`): percorre as fichas do perfil e separa as instâncias sem referência das já
associadas. `recognitionSummary` dá os cinco contadores: sem referência, fichas (treinos) afetadas, com sugestão,
exigem busca manual e já associados. A lista é agrupada por rotina e treino ("Ficha A — Peito, ombros e tríceps ·
ABC Hipertrofia").

**Ações por exercício**: **Associar** (sugestão principal), **Escolher outro** (busca na biblioteca, com as sugestões
no topo) e **Ignorar por enquanto** (só esconde nesta visita; não grava nada; "Voltar à lista" desfaz).

**Auditoria (estado encontrado no P17) e riscos tratados**:

| Risco | Situação no P17 | Tratamento no P18 |
| --- | --- | --- |
| Formulário de edição aberto antes de outra aba associar apagaria a origem ao salvar | `update` gravava o objeto do formulário inteiro | `update` preserva a origem gravada (`withRefOf`): o formulário não edita a origem |
| Substituir um exercício que outra aba acabou de associar | `replace` não conferia o estado | `replace` aceita `expected` (impressão digital) e recusa com "mudou em outra aba" |
| Associar por similaridade de nome automaticamente | não existia | proibido; toda sugestão exige confirmação |
| Unir históricos por nome | não existia | mantido: sessões antigas não ganham origem; analytics usa o `exerciseKey` de sempre |
| Redirecionar metas | metas por `templateIds` | inalterado: associar não muda o ID; substituir cria ID novo e a meta fica no anterior |
| Catálogo maior pesar o pacote principal | catálogo em sub-entrada | mantido fora do pacote principal |
| Apelido igual em duas entradas | "agachamento livre" em `agachamento-livre` e `agachamento-peso-corporal` | documentado; o motor mostra as duas e avisa a diferença de modalidade |
| Menu de ações do editor ficava aberto atrás do detalhe da origem | (novo no P18) | encontrado no E2E e corrigido: "Ver detalhes na biblioteca" fecha o menu |

## 2. Regras de sugestão

Local, puro e determinístico (`recognize`). Cada instância sem origem é comparada com todos os itens ativos da
biblioteca (catálogo + personalizados não arquivados; arquivados nunca são sugeridos):

- **Nome**: `nameTokens` normaliza (minúsculas, sem acentos, sem pontuação), remove palavras vazias ("com", "na",
  "de"…) e plural simples; `nameSimilarity` vale 1 para nomes iguais e, fora isso, o coeficiente de Dice dos tokens.
  Contam o nome do item e cada apelido; vale o maior. Abaixo de 0,5 o item não é candidato.
- **Motivos**: mesmo grupo muscular, mesma modalidade (ou compatível, quando a ficha não informa), mesmo equipamento,
  mesma lateralidade.
- **Avisos**: grupo muscular diferente (ou principal na ficha e secundário na biblioteca); modalidade diferente
  ("Associar não muda a modalidade da ficha."); tipo de carga diferente; equipamento diferente; execução diferente.

| Classificação | Regra |
| --- | --- |
| Correspondência forte | nome ≥ 0,75 **e** nenhum aviso |
| Correspondência possível | nome ≥ 0,5, ou forte com algum aviso |
| Sem sugestão confiável | nenhum candidato: a pessoa usa "Escolher na biblioteca" |

No máximo 3 candidatos, ordenados por classificação, nota do nome, número de motivos, menos avisos e nome
(desempate estável). Cada um traz uma frase de explicação ("Mesmo nome, mesmo grupo muscular, modalidade compatível
e mesmo equipamento."). Mesmo uma correspondência forte só vira associação depois da confirmação.

## 3. Confirmação

`LinkConfirmDialog` mostra lado a lado o **exercício atual (ficha)** e o **exercício da biblioteca**, o motivo da
sugestão, os avisos destacados, **o que muda** (só a referência de origem) e **o que continua igual**
(`LINK_UNCHANGED`: nome atual na ficha, ID da instância, séries, repetições, carga, descanso, observações, metas,
sessões antigas, histórico, analytics). Nada é gravado antes de "Associar". A impressão digital da instância é
guardada quando a confirmação abre e conferida na gravação.

## 4. Associação em lote

"Selecionar vários" liga caixas por exercício. **Não existe "selecionar tudo".** "Revisar N selecionados" abre uma
revisão item a item ("Revisar 2 de 3"): confirmar a sugestão, escolher outro ou pular. O resumo lista o que será
associado e o que foi pulado; "Aplicar N associações" grava tudo de uma vez.

`applyLinks(requests)` roda numa transação rw única sobre `routines` e `customExercises`:

1. revalida cada pedido contra a versão gravada (rotina, treino e instância existem; impressão digital igual à da
   revisão; referência válida; personalizado existe e não está arquivado);
2. se qualquer pedido falha, **nada** é gravado e o resultado diz o motivo de cada um;
3. se tudo passa, grava as referências e atualiza `updatedAt` das rotinas tocadas.

Estados por entrada: aplicado, já estava associado a esta origem (idempotente), associado a outra origem, mudou em
outra aba, não encontrado, referência inválida, personalizado arquivado ou ausente.

## 5. Desassociação

Explícita e reversível: "Desfazer" na seção "Já associados" do reconhecimento ou "Desfazer associação com a
biblioteca" no menu do exercício no editor. Pede confirmação ("Desfazer associação"), remove só a referência e
confere a impressão digital. O exercício volta a aparecer como sem vínculo e pode ser associado de novo. Favoritos,
personalizados, metas e sessões não mudam.

## 6. Catálogo expandido

`CATALOG_VERSION = 2`: 53 entradas do P17 + 57 novas (`since: 2`) = **110 exercícios distintos**:

- peito: supino reto com halteres, inclinado com barra, declinado, máquina, voador (peck deck), pullover, flexão diamante;
- costas: remada cavalinho, articulada, puxada com pegada neutra, face pull, remada invertida, levantamento terra,
  hiperextensão lombar, encolhimento;
- ombros: desenvolvimento militar, na máquina, Arnold, elevação lateral na polia, remada alta;
- braços: rosca Scott, na polia, inversa, tríceps corda, unilateral na polia, coice, supino fechado;
- pernas: agachamento frontal, sumô, goblet, no Smith, hack, búlgaro, passada, subida no banco, pistola, flexora
  unilateral, flexão nórdica, cadeira adutora;
- glúteos e panturrilhas: ponte de glúteo, coice na polia, glúteo quatro apoios, panturrilha no leg press, unilateral;
- abdômen e por tempo: bicicleta, infra, canivete, russian twist, roda, dead bug, mountain climber, prancha lateral,
  hollow hold, farmer's walk, polichinelo;
- cardio: corrida intervalada, natação.

Metadados completos em todas (grupos principais e secundários, equipamento, padrão de movimento, lateralidade, tipo
de carga, mecânica, dificuldade, instruções, erros comuns, cuidados, apelidos, tags), validados pelos mesmos testes
do P17 (sem IDs ou nomes repetidos, vocabulário fechado, textos sem HTML).

## 7. Versionamento

Ver `BIBLIOTECA_EXERCICIOS.md` §21. IDs publicados nunca mudam, nunca são reaproveitados e nunca são redirecionados;
uma entrada alterada sobe a própria `version`; uma entrada descontinuada iria para `RETIRED_CATALOG_IDS` (vazia).
Quatro entradas subiram para a versão 2 para separar variações que ganharam entrada própria (`triceps-polia`,
`afundo`, `elevacao-de-pernas`, `elevacao-lateral-unilateral`). Fichas que apontam para elas continuam apontando.

## 8. Histórico de uso

O detalhe do exercício na biblioteca distingue:

- **"Já está em uma das suas fichas."**: a origem aparece em alguma instância das fichas do perfil (`sheetKeys`);
- **"Utilizado em uma sessão registrada com esta origem."**: alguma sessão concluída executou o exercício com essa
  origem gravada.

Associar uma ficha **não** muda o histórico: sessões antigas continuam sem origem.

## 9. Mais utilizados

`mostUsed` conta sessões **concluídas** do perfil, uma vez por sessão, por identidade de origem, só quando há ao
menos uma série concluída que não seja aquecimento. Não conta nomes, fichas, exercícios só planejados nem duplicatas.
Exercícios executados sem origem aparecem à parte como **"Sem vínculo com a biblioteca"** (quantidade e número de
sessões), sem entrar na classificação. A seção mostra quantas sessões foram consideradas e os 10 primeiros.

## 10. Adição múltipla

Na biblioteca aberta a partir do editor, "Selecionar vários" marca itens (o botão mostra a ordem de marcação). A
confirmação (`AddManyDialog`) lista as linhas na ordem, cada uma com um ID próprio criado ao abrir; selos "já na
ficha" e "repetido"; repetir um exercício só com "Adicionar outra vez"; "Tirar da seleção". Mostra as séries
planejadas acrescentadas (estimativa, não é volume executado). Grava com `addMany`: tudo ou nada, sem carga, no fim
da ficha, idempotente (repetir a confirmação não duplica), respeitando o limite de exercícios por treino.

## 11. Substituição múltipla

`#/treinos/:rotina/:treino/substituir`, em três etapas: **selecionar** → **escolher** substituto para cada um →
**prévia**. A prévia (`bulkReplacePreview`) mostra por exercício o que é preservado e o que é descartado, as metas
ligadas ao anterior, a nova identidade e a ordem final da ficha, com o texto fixo:

> As metas vinculadas ao exercício anterior continuarão vinculadas a ele.

`replaceMany` aplica tudo numa operação, confere a impressão digital de cada exercício (`changed` se outra aba
mexeu), é idempotente quando tudo já foi aplicado, e cada substituto entra na mesma posição com ID novo.

## 12. Identidades

As quatro identidades do P17 continuam separadas: item do catálogo (`catalogId`), personalizado (`cx_…`), instância
na ficha (`ExerciseTemplate.id`) e exercício executado (`SessionExercise`). Associar e desassociar **não** mudam o ID
da instância. Substituir (um ou vários) e adicionar criam IDs novos. Nenhuma identidade é inferida do nome.

## 13. Metas

Seguem ligadas por `templateIds`. Associar mantém o ID, então a meta continua com o mesmo progresso. Substituir deixa
a meta no exercício anterior, que passa a "O exercício não está mais em nenhuma ficha…" e continua usando o histórico
registrado. Nenhuma meta é redirecionada. Modelos multimodais preservados.

## 14. Analytics

Nada muda: agrupamento pelo `exerciseKey` de sempre (P08/P09), fórmulas de 1RM intactas, nenhuma sessão reescrita.
Associar uma ficha não junta históricos de nomes diferentes.

## 15. Persistência

**Sem esquema novo**: Dexie continua na versão 6. A referência de origem já existia na instância desde o P17; o P18
só passou a gravá-la em fichas antigas, sempre por operações sobre a versão gravada (`mutateWorkout`, `applyLinks`).

## 16. Backup

Backup continua na versão 7, com o mesmo formato. Exporta e restaura as referências e os IDs das instâncias como
estão (substituir, mesclar e transferência de perfil). Backups antigos (v6 e anteriores) restauram fichas sem origem,
que podem ser associadas depois.

## 17. Concorrência

- **Impressão digital** (`instanceFingerprint`): JSON com chaves ordenadas da instância, guardado quando a
  confirmação, a revisão ou a prévia abre e conferido dentro da transação rw.
- Operações sempre sobre a versão gravada; as telas são reativas e mostram na hora o que outra aba gravou.
- `link` é idempotente para a mesma origem e recusa outra origem já gravada; toque duplo grava uma vez só.
- `update` preserva a origem gravada; `replace` e `replaceMany` aceitam `expected`.
- Restaurar um backup durante a confirmação: se a instância voltou diferente, a associação é recusada.

## 18. Performance

O motor roda sobre 110 itens por instância (milissegundos para a ficha inteira). O catálogo continua fora do pacote
principal (324,46 kB, igual ao P17); a página de reconhecimento (19 kB) e a de substituição múltipla (9 kB) são
carregadas sob demanda. A busca manual pagina de 30 em 30.

## 19. UX

- Pensado para 360 px: contadores em grade de duas colunas, botões com rótulo, nada de rolagem horizontal (conferido
  no E2E em todas as telas novas).
- Editor: resumo no topo (exercícios, **séries planejadas (estimativa)**, "N sem vínculo com a biblioteca"), selo
  "sem vínculo" por linha, botões "Adicionar vários", "Substituir vários" e "Reconhecer"; ver a origem em modo somente
  leitura sem sair da edição.
- Acessibilidade: caixas de seleção com rótulo ("Selecionar Puxada frontal"), botões com `aria-pressed`, seções com
  `aria-label`, contagem de selecionados em `aria-live`, um diálogo por vez.
- Textos dizem o que vai acontecer e o que não muda; nada é gravado sem um botão explícito.

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
- `e2e/exercise-recognition.spec.ts` (Android 360 e desktop): os 28 passos do fluxo, com backup, restauração, duas
  abas e offline.

## 22. Limitações

- As sugestões comparam nome, grupo, modalidade, equipamento e lateralidade; não entendem descrições livres.
- "Ignorar por enquanto" não é lembrado entre visitas (por decisão: nada é gravado).
- Não há "substituir em todas as fichas"; a associação em lote é por exercício, com revisão de cada um.
- Sessões antigas não ganham origem; "Mais utilizados" só cresce com treinos feitos depois da associação.
- O apelido "agachamento livre" ainda aparece em duas entradas do catálogo (herdado do P17).

## Efeito no desempenho (P19)

Associar um exercício antigo à biblioteca grava a origem só na ficha. No desempenho por exercício
([DESEMPENHO_EXERCICIOS.md](DESEMPENHO_EXERCICIOS.md)) isso **não** reclassifica sessões antigas: a instância da ficha
continua com todo o seu histórico (identidade `i:<templateId>`), e a visão agregada do catálogo/personalizado só inclui
as sessões concluídas depois, que registraram a origem. Exercícios antigos sem `templateId` aparecem como "Histórico sem
vínculo", nunca juntados pelo nome a outros exercícios.
