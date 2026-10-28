# Biblioteca de exercícios e construtor de fichas

IronTrack 2.0 · Fase 01 · Prompt 17. Uma biblioteca local de exercícios (catálogo padrão + exercícios personalizados
+ favoritos), em `#/exercicios`, e um construtor de fichas que monta o treino a partir dela sem mudar como fichas,
sessões, metas e analytics já funcionavam.

Código: `src/modules/exercises/` (domínio puro: `types.ts`, `vocab.ts`, `catalog/index.ts`, `search.ts`, `custom.ts`,
`favorites.ts`, `instance.ts`, `workoutOps.ts`, `suggestions.ts`, `references.ts`), `src/db/library.ts` (transações),
`src/hooks/useLibrary.ts`, `src/pages/ExerciseLibraryPage.tsx`, `src/pages/WorkoutEditorPage.tsx`,
`src/features/library/*` (`ExerciseDetailDialog`, `CustomExerciseDialog`, `AddToWorkoutFlow`, `SubstituteDialog`,
`WorkoutPreviewDialog`) e `src/features/routines/ExerciseDialog.tsx` (formulário de configuração, extraído do editor).

## 1. Modelo do catálogo

O catálogo padrão é **estático**, versionado no código (`CATALOG_VERSION = 2` desde o P18; ver §21) e nunca vai para o banco nem para o
backup. Cada entrada (`CatalogExercise`):

```ts
interface CatalogExercise {
  catalogId: string;            // slug estável: 'supino-reto-barra'
  name: string;                 // nome exibido (pt-BR)
  aliases: string[];            // outros nomes usados na busca ('pulldown', 'serrote')
  modality: TrainingModality;   // resistance | bodyweight | timed | cardio (modelo v3, P10)
  primaryMuscles: LibraryMuscle[];
  secondaryMuscles: LibraryMuscle[];
  equipment: LibraryEquipment[]; // o primeiro é o principal
  movementPattern: MovementPattern;
  laterality: ExerciseLaterality;
  loadMode: LoadMode | null;    // null em cardio
  mechanics: 'compound' | 'isolation' | null; // null em cardio e por tempo
  difficulty: 'iniciante' | 'intermediario' | 'avancado';
  instructions: string[]; commonMistakes: string[]; safetyNotes: string[];
  tags: string[];
  source: 'irontrack-base';
  version: number;              // versão da entrada (sobe quando o conteúdo muda)
  since: number;                // versão do catálogo em que a entrada apareceu (P18)
}
```

No P17 eram 53 entradas; o P18 acrescentou 57 (total **110**, ver §21 e `docs/RECONHECIMENTO_EXERCICIOS.md`), cobrindo peito, costas, ombros, bíceps, tríceps, pernas, glúteos, panturrilhas, abdômen, cardio,
exercícios por tempo e calistenia. Duplicatas semânticas foram fundidas numa entrada com apelidos ("Flexão de braços" =
"flexão", "apoio"; "Barra fixa" = "pull-up", "chin-up"; "Prancha" = "prancha isométrica"; "Afundo" já é unilateral;
"Remada unilateral com halter" = "serrote"; "Rosca alternada" é unilateral). Variações com execução realmente diferente
ficam separadas: "Agachamento livre com barra" × "Agachamento livre sem carga"; "Elevação lateral" × "Elevação lateral
unilateral"; "Cadeira extensora" × "Cadeira extensora unilateral".

O catálogo fica em `@/modules/exercises/catalog` (sub-entrada própria, **não** reexportada pelo `index.ts` do módulo)
e é construído na primeira chamada de `getCatalog()` (memorizado e congelado). Assim ele só entra no pedaço da tela da
biblioteca, carregado sob demanda, e não no pacote principal.

## 2. Identidade

Quatro identidades diferentes, que nunca se confundem:

| O quê | ID | Onde vive |
| --- | --- | --- |
| Exercício do catálogo | `catalogId` (slug, `CATALOG_ID_RE`) | código |
| Exercício personalizado | `cx_<uid>` (`CUSTOM_ID_RE`) | tabela `customExercises` |
| Exercício **na ficha** (instância) | `ExerciseTemplate.id` (uid novo a cada adição) | `routines[].workouts[].exercises[]` |
| Exercício **executado** | `SessionExercise.id` + `templateId` | `sessions[]` (cópia, snapshot) |

A instância guarda a origem só como **referência opcional**: `catalogId` + `catalogVersion`, ou `customExerciseId`.
Ela é sempre uma **cópia** (nome, grupo, equipamento, modalidade, configuração). Editar o personalizado ou uma versão
futura do catálogo não muda fichas nem sessões já gravadas.

O mesmo exercício pode entrar duas vezes no mesmo treino (duas instâncias, dois IDs, configurações próprias).

Nada é remapeado por nome: fichas antigas (sem origem) continuam como estavam e não são "adivinhadas" no catálogo;
metas seguem ligadas por `templateIds` (P12); analytics segue agrupando pelo `exerciseKey` de sempre (P08/P09).

## 3. Metadados

Vocabulário em `vocab.ts`:

- **Grupos musculares** (`LibraryMuscle`): os mesmos IDs do analytics (P09: `peitoral`, `costas`, `ombros`, `biceps`,
  `triceps`, `antebracos`, `quadriceps`, `posteriores`, `gluteos`, `panturrilhas`, `abdomen`, `lombar`, `trapezio`,
  `adutores`, `abdutores`) mais `corpo_inteiro` (cardio e exercícios globais).
- **Equipamentos** (`LibraryEquipment`): barra, halteres, máquina, polia, banco, peso corporal, elástico, esteira,
  bicicleta, outros. Mapeados para o `equipment` da ficha (`barbell`, `dumbbell`, `machine`, `cable`, `bodyweight`,
  `other`) por `templateEquipment`.
- **Padrão de movimento**, **mecânica** (composto/isolador) e **dificuldade**, só informativos.

Ao virar instância, o grupo usa o **texto que a pessoa já usa** (`muscleText`: se as configurações têm "Peito", o
exercício entra como "Peito"; senão, o rótulo canônico). Assim analytics, filtros do histórico e metas continuam
vendo o mesmo texto de grupo.

Os textos (instruções, erros comuns, segurança) são conservadores: sem cargas, percentuais, prescrições ou promessas.
Os detalhes mostram sempre um aviso geral ("Orientações gerais e conservadoras. Não substituem a avaliação de um profissional nem são prescrição individual.").

## 4. Busca

`buildIndex(items)` monta o índice uma vez por lista (a tela só refaz quando a lista muda) e `searchLibrary` aplica:

- texto dobrado (`foldText`): minúsculas, **sem acentos**, só letras/números, espaços simples ("TRÍCEPS" = "triceps");
- todos os termos precisam aparecer em algum campo: nome, apelidos, grupos (principais e secundários), equipamentos,
  modalidade, lateralidade e tags;
- relevância explícita: nome começa com a busca (5) > uma palavra do nome começa (4) > nome contém (3) > apelido (2) >
  todos os termos no nome (1) > outros campos (0);
- empate: nome em ordem pt-BR (`Intl.Collator`, criado sob demanda) e chave. Resultado **determinístico** e sem
  repetidos.

A tela usa `useDeferredValue` para não travar a digitação.

## 5. Filtros

`LibraryFilters`: grupo muscular (principais), equipamento, modalidade, bilateral/unilateral, só favoritos, só
personalizados, e arquivados (`hide` | `only`). Dentro de uma dimensão vale "qualquer um"; entre dimensões vale
"todos". "Limpar filtros" aparece com qualquer filtro ligado e volta tudo (`EMPTY_FILTERS`). No celular o painel fica
atrás do botão "Filtros (n)"; no desktop fica sempre visível ao lado da lista.

## 6. Favoritos

Tabela `exerciseFavorites`, um registro por perfil e alvo: `{ id: '<perfil>~<alvo>', profileId, target, createdAt }`,
com `target` = `catalog:<catalogId>` ou `custom:<cx_id>`. O ID determinístico torna "favoritar" idempotente: duas
abas que favoritam juntas gravam um registro só. A lista é observada pelo Dexie (`liveQuery`), então o que outra aba
grava aparece sozinho. Favorito de algo que não existe mais (personalizado excluído, item retirado do catálogo) fica
listado como indisponível em "Favoritos" e só sai com "Remover favoritos indisponíveis"; nunca é trocado por outro
exercício.

## 7. Personalizados

Tabela `customExercises` (`CustomExercise`): `id` (`cx_…`), `profileId`, `name`, `modality`, `primaryMuscle`,
`secondaryMuscles` (até 4), `equipment` (1 a 4), `laterality`, `loadMode`, `mechanics`, `instructions?`, `notes?`,
`archivedAt`, `createdAt`, `updatedAt`, `revision`.

Validação Zod estrita (`customFieldsSchema`, `customExerciseIssues`): nome 1–80, textos até 1000, **sem HTML nem
`javascript:`**, grupo principal fora dos secundários, sem repetidos, tipo de carga compatível com a modalidade
(cardio sem carga e sem unilateral), no máximo 500 por perfil. A tela mostra os erros em português e nada é gravado.

Ações: criar (ID gerado uma vez pela tela; repetir a mesma criação não duplica), editar (confere a `revision`),
duplicar (do catálogo ou de outro personalizado, como "… (cópia)"), arquivar e restaurar. Exclusão definitiva só
quando **não há referências** em fichas nem no histórico, conferido na mesma transação; o favorito sai junto.

## 8. Arquivamento

Arquivar (`setCustomArchived`) é o caminho normal para "não quero mais ver": o exercício sai da lista principal, vai
para "Meus › Arquivados" e não pode entrar em fichas novas (`mutateWorkout` recusa com "arquivado"). Fichas e sessões
que já o usam **não mudam**. Restaurar devolve tudo. Repetir arquivar/restaurar não muda a revisão.

## 9. Editor de fichas

O editor (`#/treinos/:rotina/:treino`) ganhou:

- **Adicionar da biblioteca** (abre `#/exercicios?para=<rotina>/<treino>`) e **Criar manualmente** (formulário de
  antes);
- adicionar abre o formulário já preenchido por `instanceFromItem` (séries, repetições/duração/distância, descanso
  pela mecânica e pelos descansos padrão das configurações; **nunca** carga), com a origem do item;
- **configuração anterior**: se o mesmo item (pela origem, nunca pelo nome) já está em alguma ficha da mesma
  modalidade, o formulário sugere "Usar como ponto de partida" (séries, repetições, duração, distância e descanso da
  ficha mais recente; **sem carga**). Nada muda até a pessoa tocar e confirmar;
- reordenar arrastando (como antes) **ou** pelos botões "Mover para cima/baixo" (acessíveis por teclado e leitor de
  tela);
- "Mais ações": editar configuração, duplicar (nova instância, mesma configuração), substituir, remover da ficha;
- origem visível em cada linha ("Da biblioteca", "Meu exercício");
- **Prévia** da ficha antes de iniciar (`WorkoutPreviewDialog`, também em Treinos › menu do treino › "Ver prévia da
  ficha"): só os parâmetros planejados, sem histórico; "Iniciar este treino" respeita o treino em andamento.

Cada ação vira uma operação (`WorkoutOp`: `add`, `update`, `remove`, `move`, `reorder`, `duplicate`, `replace`,
`meta`) aplicada à versão gravada (§15).

## 10. Substituição

"Substituir por outro da biblioteca" abre a biblioteca com `&substituir=<id>`; as sugestões priorizam o mesmo grupo
muscular, depois equipamento parecido, depois a mesma modalidade. Ao escolher, `substitutionPreview` mostra antes de
gravar:

- o que **continua**: séries e descanso; repetições, duração e distância só quando os dois exercícios medem isso;
- o que **não passa**: carga planejada, aquecimento, observações e o que a nova modalidade não usa;
- avisos de troca de modalidade ou de lateralidade;
- "O histórico de X continua como está";
- metas ligadas: "N metas continuam ligadas a X" (contadas por `goalsLinkedTo`).

Confirmar grava `replace`: o exercício novo recebe **ID novo** na mesma posição. Metas, histórico e analytics do
antigo **não** são redirecionados.

A troca rápida **durante o treino** (P10, por nome) continua igual e agora remove `catalogId`/`customExerciseId` da
cópia na sessão: o que foi executado não era o item original.

## 11. Sessões

`buildSession` copia `catalogId` ou `customExerciseId` da instância para o `SessionExercise` (snapshot). Nada mais muda
na sessão: `exerciseKey`, séries, cronômetros, multi-aba e recuperação são os mesmos. Sessões antigas não são
reescritas. "Usado recentemente" lê as origens gravadas nas 60 sessões concluídas mais recentes.

## 12. Metas

Nenhuma regra de metas mudou (ver [METAS_TREINAMENTO.md](METAS_TREINAMENTO.md)): a meta continua ligada aos
`templateIds` da ficha. Adicionar o mesmo item do catálogo em outra ficha **não** liga a meta a ele; substituir mantém
a meta no ID antigo (ela fica "exercício removido da ficha" e continua usando o histórico registrado).

## 13. Persistência

Dexie **v6** acrescenta só duas tabelas, sem tocar nas outras:

```ts
this.version(6).stores({ customExercises: 'id, profileId, updatedAt', exerciseFavorites: 'id, profileId, target' });
```

Ambas têm dono (`profileId`, entram nos ganchos de perfil). Personalizados e favoritos inválidos no banco são
ignorados pela tela (e preservados). Integridade (`src/lib/integrity.ts`): `INVALID_CUSTOM_EXERCISE` e
`INVALID_FAVORITE` (erro), `INVALID_LIBRARY_REF` (aviso: origem mal formada na ficha ou sessão), `LIBRARY_REF_MISSING`
e `FAVORITE_TARGET_MISSING` (informativo: o item citado não existe mais; nada é corrigido sozinho). A verificação não
carrega o catálogo (fica fora do pacote principal), então origens do catálogo só são conferidas no formato.

## 14. Backup

Backup **v7** (`BACKUP_SCHEMA_VERSION = 7`) com `data.customExercises` e `data.exerciseFavorites`. Backups v0–v6 são
aceitos e chegam com as duas listas vazias. Substituir restaura tudo com o dono local (`assignOwner` também refaz o ID
do favorito `<perfil>~<alvo>`); mesclar só acrescenta por ID e nunca sobrescreve o personalizado local. Registros
inválidos bloqueiam a restauração e nada é gravado. Fichas do backup mantêm a origem gravada nelas; nada é associado
por nome. Detalhes em [BACKUP_RESTAURACAO.md](BACKUP_RESTAURACAO.md).

## 15. Concorrência

- **Ficha**: `mutateWorkout(rotina, treino, op)` lê a rotina gravada dentro de uma transação de escrita (o navegador
  serializa entre abas) e aplica a operação nela. Duas abas adicionando ao mesmo treino gravam as duas adições;
  `reorder` com uma lista velha mantém no fim o que a tela não conhecia; `add`/`duplicate`/`replace` repetidos são
  idempotentes; editar ou substituir algo removido em outra aba é recusado com mensagem e nada é gravado.
- **Personalizados**: edição e exclusão conferem a `revision` que a tela mostrava; arquivar é aplicado à versão gravada.
- **Favoritos**: ID determinístico (§6).
- Tudo é observado com `liveQuery`, então as outras abas atualizam sozinhas.

## 16. Performance

- Catálogo fora do pacote principal: entra só no pedaço `ExerciseLibraryPage` (≈70 kB, carregado sob demanda e
  guardado pelo service worker para uso offline). O pacote principal ficou em ≈324 kB (≈100 kB gzip).
- Índice de busca montado uma vez por lista; a busca percorre arrays pré-dobrados (centenas de itens em poucos ms,
  conferido em teste).
- Lista paginada de 60 em 60 ("Mostrar mais").

## 17. UX

- Entrada pela tela **Treinos** (botão "Biblioteca de exercícios"); a navegação inferior não ganhou item novo (a aba
  Treinos fica ativa em `#/exercicios`).
- Abas Todos / Favoritos / Meus (com Ativos / Arquivados), busca no topo, filtros, sugestões com o motivo
  ("Usado recentemente.", "Mesmo grupo muscular.", "Está nos favoritos."...), contagem, estados vazios com ação.
- Faixa de destino ("Adicionando ao Treino A", "Substituindo X") com voltar à ficha.
- 360 px sem rolagem horizontal; alvos de toque ≥ 36 px; todos os botões de ícone com `aria-label`; favoritos com
  `aria-pressed`; contagem com `aria-live`; reordenação sem arrastar.

## 18. Privacidade

Tudo é local: catálogo estático, sem imagens, sem rede, sem rastreamento e sem IA. Nenhuma chave nova no
`localStorage`. Personalizados e favoritos ficam no IndexedDB do perfil e só saem do aparelho no backup que a pessoa
exporta. O assistente (ContextBuilder) e o consentimento não foram alterados.

## 19. Testes

- `tests/unit/library-domain.test.ts`: catálogo (IDs, metadados, duplicatas, textos), busca com acentos, relevância e
  desempenho, filtros, validação dos personalizados (HTML), favoritos, instâncias válidas no modelo v3, configuração
  anterior sem carga, operações da ficha, substituição, sessões, analytics inalterado, sugestões e referências.
- `tests/unit/library-db.test.ts`: migração v5 → v6, app anterior abrindo o banco novo, CRUD com revisão, isolamento
  de perfil, exclusão restrita, favoritos entre duas conexões, `mutateWorkout` concorrente, arquivados bloqueados,
  metas não redirecionadas, backup v7 (exportar, substituir, mesclar, v6 antigo, outro perfil, inválidos), integridade.
- `tests/unit/library-ui.test.tsx`: busca, filtros, favoritos de outra aba, criar/arquivar personalizado, adicionar
  à ficha, sugestão anterior, substituição com metas, mover, duplicar e prévia.
- `e2e/exercise-library.spec.ts` (Android 360 e desktop): o fluxo completo, com backup, duas abas e offline.

## 20. Limitações

- O catálogo é fixo nesta versão (sem atualização remota); itens futuros entram com nova `CATALOG_VERSION`.
- Fichas antigas não ganham origem automaticamente (por decisão: nada é associado por nome). Desde o P18 a pessoa pode
  associá-las com confirmação em "Reconhecer exercícios antigos" (`docs/RECONHECIMENTO_EXERCICIOS.md`).
- Sem imagens ou vídeos de execução.
- A substituição troca um exercício por vez ou vários do mesmo treino (P18, "Substituir vários"); não há
  "substituir em todas as fichas".
- A integridade só confere o formato das origens do catálogo (o catálogo não é carregado na verificação).
- Exercícios personalizados não têm metadados de padrão de movimento e dificuldade.

## 21. Versionamento do catálogo (P18)

- `CATALOG_VERSION` sobe quando entradas são acrescentadas ou alteradas. Versão 1 = 53 entradas do P17; versão 2 =
  110 entradas (57 novas em `catalog/expansion.ts`, com `since: 2`).
- Cada entrada tem a própria `version`, que sobe quando o conteúdo dela muda. A instância na ficha guarda a
  `catalogVersion` do momento em que foi adicionada ou associada; isso é só informação (a ficha é uma cópia).
- IDs publicados **nunca** são removidos, renomeados ou reaproveitados para outro exercício. Uma entrada
  descontinuada iria para `RETIRED_CATALOG_IDS` (hoje vazia) e continuaria resolvível para fichas antigas.
- Nada é redirecionado: se uma variação ganha entrada própria, as fichas que apontam para a entrada antiga continuam
  apontando para ela. Na versão 2, quatro entradas subiram para `version: 2` porque perderam apelidos ou instruções
  que passaram a ter entrada própria: `triceps-polia` (corda → `triceps-corda`), `afundo` (passada → `passada`),
  `elevacao-de-pernas` (abdominal infra → `abdominal-infra`) e `elevacao-lateral-unilateral` (só halteres; polia →
  `elevacao-lateral-polia`).
- Testes conferem que todo ID da versão 1 continua existindo, que não há IDs nem nomes repetidos e que o total é
  ≥ 100.

