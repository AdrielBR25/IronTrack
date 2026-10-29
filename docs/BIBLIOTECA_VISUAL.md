# Biblioteca visual de exercícios (IronTrack 2.0 F01 / P20)

Complementa [BIBLIOTECA_EXERCICIOS.md](BIBLIOTECA_EXERCICIOS.md) (P17). Nenhuma mudança de banco: Dexie continua v6.
O backup passou para v8 por causa da edição do histórico ([EDICAO_HISTORICO.md](EDICAO_HISTORICO.md)), não pela biblioteca.

## 1. O que a pessoa vê

- **Lista da biblioteca** (`/exercicios`): cada linha tem uma miniatura do mapa muscular (frente ou costas, conforme o
  grupo principal) e o selo **3D** (demonstração animada) ou **3D posição** (exercício isométrico mostrado na posição).
  Novo filtro **Padrão de movimento** (empurrar, puxar, agachar, dobradiça de quadril…), somado aos de grupo, equipamento
  e modalidade.
- **Detalhes do exercício**: seção visual antes de "Como executar" (ver [ANIMACOES_EXERCICIOS.md](ANIMACOES_EXERCICIOS.md)
  e [MAPA_ANATOMICO.md](MAPA_ANATOMICO.md)) e o atalho **Perguntar ao assistente**.
- **Navegador da biblioteca** (`features/library/LibraryBrowser.tsx`): usado no treino em andamento (trocar e adicionar
  exercício) e na edição do histórico. Abas Todos, Favoritos, Recentes e Meus exercícios; busca e filtros iguais aos da
  biblioteca; detalhes com o visual e as instruções antes de escolher. Escolher não grava nada: quem chama mostra a
  prévia e confirma.

## 2. Substituição durante o treino

Fluxo: **Trocar** no exercício → navegador da biblioteca (sem os exercícios que já estão no treino) → **prévia**
(`SwapPreviewDialog`) → Confirmar.

A prévia mostra: atual → novo, séries feitas/planejadas (e aquecimento), cargas registradas, séries pendentes, o que
acontece com os cronômetros e o que não é compatível (modalidade, medidas, lateralidade).

Política (pura, em `modules/training/sessionEdit.ts`, `swapPreview`/`applySwap`):

| Situação | O que acontece |
| --- | --- |
| Nenhuma série feita (`replace`) | O novo ocupa a posição do atual, que sai da sessão (não foi executado). Registro compatível mantém séries, faixa de repetições e descanso do plano. |
| Há séries feitas (`split`) | O atual fica só com as séries feitas, marcado `replacedBy`; o novo entra logo depois (`replacesExerciseId`) com as séries restantes. |
| Cargas | Nunca passam do atual para o novo. Sugestões vêm só do histórico do PRÓPRIO novo exercício. |
| Modalidade/medidas diferentes | Nada é convertido; as séries feitas continuam como foram registradas. |
| Descanso em curso | Continua e passa a apontar para o novo exercício. |
| Cronômetro de execução de uma série pendente do atual | Descartado (a série deixou de existir). |
| Ficha e metas | A ficha não muda; metas ligadas ao exercício anterior não são redirecionadas. |

Identidade: o novo exercício recebe ID novo, sem `templateId`, com `catalogId`/`customExerciseId` (+ `catalogVersion`)
da biblioteca. Assim recordes, desempenho e metas continuam separados por exercício (ver
[DESEMPENHO_EXERCICIOS.md](DESEMPENHO_EXERCICIOS.md)).

**Adicionar exercício** (botão no fim do treino): mesmo navegador, sem prévia de troca; entra no fim com o plano do
catálogo e cargas sugeridas só do histórico dele.

## 3. Desempenho e pacote

- O catálogo, o navegador, o visual e o three.js são carregados sob demanda. O pacote principal ficou em ~327 kB
  (gzip ~100 kB); o chunk do 3D (~504 kB, gzip ~128 kB) só baixa ao abrir um detalhe com 3D e entra no precache do PWA,
  então funciona offline depois da primeira visita.
- Miniaturas são SVG estáticos (sem WebGL) para listas longas.

## 4. Acessibilidade

- Nada depende só da cor: legenda em texto (principais, secundários) e hachura nos secundários do mapa 2D.
- Controles com rótulos; o canvas tem descrição textual; com "reduzir movimento" a animação começa pausada.
- Tela de 360 px sem rolagem horizontal (verificado nos E2E).

## 5. Testes

- Unitários: `tests/unit/anatomy-demos.test.ts` (geometria das demonstrações, manifesto, taxonomia),
  `tests/unit/session-edit.test.ts` (troca, adição, política).
- E2E: `e2e/visual-history-ai.spec.ts` (Android 360 e desktop).
