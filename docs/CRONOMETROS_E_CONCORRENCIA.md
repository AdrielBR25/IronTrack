# Cronômetros de série, registro rápido e concorrência

IronTrack 2.0 · Fase 01 · Prompt 11. Torna mais rápida e confiável a execução dos exercícios do modelo v3
([MIGRACAO_EXERCICIOS_V3.md](MIGRACAO_EXERCICIOS_V3.md)): cronômetro de execução por série, cardio, unilaterais,
peso corporal × assistência, conclusão segura de séries, várias abas e proteção contra perda de campos novos por um
app antigo. **Sem mudança no banco (Dexie continua na versão 2), sem mudança no backup (continua v3), sem tabela nova.**

| Código | Papel |
| --- | --- |
| `src/modules/training/setTimer.ts` | regras puras do cronômetro (estado, transições, recuperação, relógio, formato) |
| `src/modules/training/sessionMerge.ts` | mescla em três vias do treino em andamento |
| `src/modules/training/modelCompat.ts` | fotografia dos campos de modalidade, detecção e restauração, capacidade |
| `src/features/workout/setTimerStore.ts` | estado compartilhado do cronômetro (localStorage + BroadcastChannel) |
| `src/features/workout/SetTimerWatcher.tsx` | recuperação, batida periódica, outras abas, limpeza (montado no `App`) |
| `src/features/workout/SetTimerPanel.tsx` | interface do cronômetro e chip ao lado do descanso |
| `src/features/workout/SetEditor.tsx` | cardio rápido, lado em destaque, alternância, peso corporal × assistência |
| `src/pages/ActiveWorkoutPage.tsx` | fila de gravação protegida, conclusão segura, indicador de salvamento |
| `src/db/repo.ts` | `saveSessionGuarded`, `completeSession` idempotente, `restoreRoutineModel` |
| `src/db/modelGuard.ts` | fotografia e capacidade em localStorage, ganchos do Dexie |
| `src/features/compat/CompatGuard.tsx` | aviso de regravação por app antigo e de app desatualizado |

## 1. Arquitetura do cronômetro

- **Dois cronômetros, dois estados.** O descanso continua em `session.rest` (`RestState`, gravado no treino, como
  antes). O cronômetro de execução é um `SetTimerState` separado, guardado em `localStorage`
  (`irontrack.setTimer.v1`). Nenhuma função de um lê ou altera o outro (testado).
- **Um cronômetro por vez, preso a uma série** (`sessionId + exerciseId + setId`). Iniciar na mesma série não cria
  outro; iniciar em outra série é recusado e a tela mostra qual série está com o cronômetro ("Ir para a série").
  Cronômetros de exercícios diferentes nunca se misturam.
- **Estados:** sem cronômetro → `running` ⇄ `paused` → `stopped`. Reiniciar (com confirmação) volta a "sem
  cronômetro". Ações fora de ordem não fazem nada.
- **O cronômetro nunca grava na série sozinho.** A duração entra na série quando a pessoa toca em Encerrar
  (preenche a duração), em "Usar mm:ss na série" ou em "Encerrar e usar" ao concluir.
- **Interface:** tempo grande (`00:42`, `01:23:45`), botões de 56 px de altura, estado "PAUSADO" com borda e rótulo
  em cor de alerta, reiniciar como ícone separado (longe do toque principal). Aparece em exercícios por tempo e cardio,
  só no treino em andamento. Durante o descanso, um chip mostra o cronômetro de execução com Pausar/Continuar.

## 2. Precisão

- **Referência:** relógio de parede (`Date.now()`) gravado no início de cada trecho. Tempo medido =
  `acumulado + (agora − início do trecho)`. O `setInterval` (250 ms na tela, 1 s na batida) só redesenha e
  confirma; nunca é somado. Por isso aba em segundo plano, timers reduzidos pelo navegador, re-renderização,
  rotação de tela e navegação interna não alteram a medida.
- **Tempo em segundo plano / tela bloqueada:** conta, porque é tempo real de exercício (uma prancha não para quando
  a tela apaga). Se a página continuar viva, ao voltar o valor já está certo.
- **Suspensão do navegador sem recarregar:** idem; conta pelo relógio de parede.
- **Pausa explícita:** não conta. O tempo pausado nunca entra na medida.
- **Mudança do relógio do sistema** (`reconcileClock`): a cada batida compara o avanço do relógio de parede com o do
  relógio monotônico (`performance.now()`). Diferença acima de 5 s com a página **visível** (relógio voltou ou
  adiantou) → conta só o tempo monotônico do intervalo. Com a página **oculta**, um avanço é mantido, porque o relógio
  monotônico pode parar durante a suspensão do aparelho. Um trecho com início "no futuro" conta zero, nunca negativo.
- **Exibição:** segundos inteiros, arredondados para baixo (como um cronômetro comum). Redesenho a cada 250 ms.
- **Gravação:** `measuredSeconds` = segundos inteiros, para baixo — **o que aparece é o que é gravado**. Menos de
  1 s não é gravado; o limite é o da série (24 h).
- **Limites honestos:** não é um cronômetro profissional. A precisão é a do relógio do aparelho e do toque
  (décimos de segundo). Navegadores móveis podem congelar ou descartar abas em segundo plano (ver §11).

## 3. Retomada após recarregar ou fechar

Estratégia escolhida: **recuperar a duração confirmada e exigir que a pessoa continue manualmente** (a mais segura
com a arquitetura atual, que não tem processo em segundo plano).

1. Enquanto a página está visível, a batida de 1 s grava `checkpointAt` (última confirmação). Ao ocultar ou fechar
   (`visibilitychange`, `pagehide`), grava de novo.
2. Ao carregar, `setTimerStore.recover()` pergunta pelo `BroadcastChannel` se alguma página viva mantém o
   cronômetro (outra aba). Se alguma responde em 400 ms, nada muda.
3. Sem resposta, a página anterior foi recarregada ou fechada: o cronômetro volta **pausado** com o tempo medido até
   `checkpointAt`. O intervalo entre a última confirmação e agora fica em `awayMs` e aparece na tela.
4. Se o tempo fora estiver entre 1 s e 6 h, a pessoa pode tocar em **Somar tempo fora** (ex.: o navegador descartou
   a aba com a tela bloqueada no meio de um cardio). Acima de 6 h, só ajuste manual.

Garantias (testadas): a série em edição não se perde (o treino continua salvo a cada alteração, como antes); nenhuma
duração é gravada na recuperação; nenhuma série é concluída automaticamente; nenhum cronômetro novo é iniciado;
nenhuma série é duplicada; cronômetros de séries que deixaram de estar pendentes são descartados.

**Armazenamento auxiliar:** `localStorage`, chave `irontrack.setTimer.v1`, com versão (`v: 1`). Finalidade: só o
cronômetro em andamento. Não fica no IndexedDB nem em backups; estado malformado é ignorado. Se o armazenamento
falhar (modo privado, cota), o cronômetro funciona em memória e a tela avisa que não será recuperado.

## 4. Conflitos de duração e conclusão de série

- **Medida × valor digitado.** Encerrar substitui a duração sem perguntar só quando ela está vazia, é a meta da ficha
  (valor pré-preenchido) ou é o próprio valor que o cronômetro gravou antes. Qualquer outro valor (digitado ou vindo do
  treino anterior) abre "Substituir a duração da série?" com **Manter** e **Usar**. Manter não altera nada.
- **Concluir com o cronômetro rodando ou pausado** abre a escolha: "Encerrar e usar mm:ss", "Concluir com <valor>"
  (se o valor atual é válido) ou "Cancelar" (não muda nada, o cronômetro continua).
- **Campos válidos antes de concluir** (`setCompletionErrors`, P10). Com o cronômetro ativo, a medida conta como
  duração para habilitar o botão; a escolha final é confirmada no diálogo.
- **Ação repetida:** o botão Concluir só fica ativo 300 ms depois de a série aparecer (o segundo toque de um toque
  duplo não conclui a série seguinte), e `doComplete` só age se a série ainda está pendente na versão mais recente.
- **Erros de gravação:** a tela mantém os dados, o cabeçalho mostra "não salvo · tentar de novo" e um aviso; a nova
  tentativa grava tudo o que ficou pendente. O indicador mostra "salvando…" e "salvo".

## 5. Cardio

- Duração (min), distância e unidade. Unidade de **digitação** m/km/mi só nesta tela; o valor gravado continua em
  metros (`toMetersFrom`/`fromMetersTo`, 1 mi = 1 609,344 m). A unidade padrão é a do exercício.
- Linha de equivalências ("3.219 m = 3,22 km = 2 mi") e ritmo derivado da duração e da distância registradas
  (`paceSecPerUnit`), na unidade do exercício.
- Atalhos "Meta 20:00" e "Meta 3 km" quando a ficha tem meta e o valor atual é diferente.
- Cronômetro opcional (preenche a duração), entrada manual sempre disponível.
- Validação: duração **ou** distância (P10). Sem GPS, percurso, calorias ou frequência cardíaca.

## 6. Unilaterais

- Lado em destaque no topo da série ("Lado: Esquerdo" ou "Lado não informado", em cor de alerta). Ausente continua
  ausente: nunca vira bilateral nem "ambos".
- Seletor Direito/Esquerdo/Ambos (tocar de novo limpa) e botão de **alternância** (D ⇄ E). Sem lado na série atual,
  o atalho sugere o oposto da última série concluída daquele exercício. Só aparece na série pendente; a edição de
  série concluída permite corrigir o lado, sem atalho.
- Nenhuma série é duplicada automaticamente; o lado nunca é pré-preenchido (P10).
- Sem diagnóstico de desequilíbrio muscular.

## 7. Peso corporal e assistência

- **Carga adicional (+kg):** peso acrescentado ao exercício (colete, cinto, anilha). Campo `weight`.
- **Assistência (−kg):** ajuda mecânica que reduz a exigência (elástico, contrapeso). Campo `assistanceKg`, com o
  aviso "Assistência é ajuda, não carga".
- "Só peso corporal: sem carga registrada" quando o tipo de carga é corporal.
- As duas medidas na mesma série continuam bloqueadas ao concluir (P10). Nenhum volume usa o peso do corpo.

## 8. Compatibilidade e downgrade

### O risco

Um app publicado antes do P10 (o P09 ou a versão em produção) pode abrir o mesmo IndexedDB (Dexie v2) e, ao salvar
um exercício no editor, regravar a rotina **sem** os campos de modalidade. As séries não são afetadas; a
classificação da ficha some.

### O que não é possível

- Não há como acrescentar uma proteção a um app já publicado que não conhece nenhum marcador novo.
- Impedir de fato que o app antigo grave exigiria **mudar a versão física do banco** (Dexie v3) ou **alterar o app
  antigo**. Nenhum dos dois foi feito.

### Opções analisadas

| Opção | Efeito real | Decisão |
| --- | --- | --- |
| Marcador de capacidade nos dados | o app antigo não lê | só vale para apps a partir do P11 (implementado em localStorage) |
| Detecção de app desatualizado | o app antigo não se detecta | o P11 detecta **ele mesmo** desatualizado em relação a dados de um app mais novo e bloqueia o editor |
| Detecção depois da regravação | verificável | **implementado**: fotografia + aviso + restauração confirmada |
| Bloquear edição | só no app novo | implementado para app desatualizado (P11 ou mais novo) |
| Orientação de atualização | já existe para backup v3 e `VersionError` | mantida; texto novo no aviso |
| Exportação de segurança | backup v3 já existente | botão "Backup" no próprio aviso |
| Dexie v3 | o app antigo deixaria de abrir o banco (`VersionError`) | **não executado** (impacto abaixo) |

### O que foi implementado

1. **Fotografia dos campos de modalidade** (`irontrack.modelSnapshot.v1`, localStorage): para cada rotina, o
   `updatedAt` e os campos de modalidade da última gravação feita por **este** app. Atualizada por ganchos do Dexie
   (`creating`/`updating`/`deleting`) **só depois do commit** da transação (transação desfeita não altera nada). Rotina
   que este app ainda não viu (criada antes do P11) entra com o estado atual como referência. Nenhum registro do banco
   ganha campo novo.
2. **Detecção** (`detectModelLoss`): rotina com `updatedAt` diferente da fotografia **e** sem campos que a fotografia
   tinha, em exercícios que ainda existem (mesmo ID) → foi regravada por um app que não conhece os campos.
3. **Aviso** (`CompatGuard`, em qualquer tela): nome da rotina e dos exercícios afetados, com **Restaurar
   classificação** (devolve só os campos ausentes, nunca sobrescreve um valor presente, e não age se a rotina mudou de
   novo), **Manter como está** (aceita o estado atual) e **Backup**.
4. **Marca de capacidade** (`irontrack.capabilities.v1`, `exerciseModel: 3`): nunca diminui. Se um app futuro gravar
   uma capacidade maior, este app mostra que está desatualizado e **bloqueia salvar no editor de fichas**.

### Política de downgrade

- **Não é suportado** voltar para um app anterior ao P10 depois de classificar exercícios. Se acontecer, a perda fica
  restrita à classificação das fichas editadas no app antigo; ao voltar para o app atual, o aviso permite restaurar.
- Antes de qualquer downgrade: **exportar backup** (o backup v3 é recusado pelo app antigo, com orientação para
  atualizar, então ele serve para voltar ao app novo).
- Limites da proteção: depende do `localStorage` do mesmo navegador (limpar dados do site apaga as duas coisas juntas;
  outro navegador não tem a fotografia); só detecta exercícios com o mesmo ID; se o app antigo gravar duas vezes, a
  fotografia continua com o último estado conhecido pelo app novo, então ainda detecta.

### Impacto de uma migração Dexie v2 → v3 (não executada)

- **Efeito:** qualquer app que declare só a v2 recebe `VersionError` ao abrir o banco. O P09 mostra "Atualize o app";
  apps mais antigos podem só falhar ao carregar. Ou seja: impede a regravação, mas também bloqueia **todo** o acesso
  aos dados no app antigo (inclusive leitura do histórico).
- **Custo:** nova versão do esquema, testes de migração v1/v2 → v3, rollback testado, documentação em MIGRACOES.md e
  cuidado com o service worker (abas antigas abertas durante a atualização ficariam bloqueadas).
- **Recomendação:** só fazer junto com uma mudança que realmente precise de índice ou de reestruturação, e com
  autorização explícita.

## 9. Múltiplas abas

- **Cronômetro:** um só estado em `localStorage`; as outras abas recebem o evento `storage` e mostram o mesmo
  cronômetro (não há cronômetro duplicado). Toda ação relê o armazenamento antes de agir. Abrir outra aba não pausa
  o cronômetro (a aba viva responde ao chamado).
- **Treino:** cada aba grava pela fila `saveSessionGuarded`, numa transação de escrita do IndexedDB (que o navegador
  serializa entre abas):
  - banco igual à última versão conhecida → grava;
  - banco mudou (outra aba, aviso de descanso) → **mescla em três vias** por campo e por série (ID): mudanças
    diferentes nas duas abas ficam; a mesma coisa mudada nas duas → vale o que já estava no banco e a tela avisa;
  - treino finalizado ou descartado em outra aba → **nada é gravado** (o treino não "ressuscita") e a tela avisa.
- **Conclusões concorrentes:** a mesma série concluída nas duas abas resulta em **uma** conclusão; séries nunca são
  duplicadas (IDs); uma tela desatualizada não volta a pendente uma série concluída na outra.
- **Finalizar duas vezes** não avança a rotação duas vezes nem cria dois registros (`completeSession` idempotente).
- **Limitação:** não há trava exclusiva entre abas (o IndexedDB não oferece; Web Locks não resolveria abas
  congeladas). A proteção é "nunca sobrescrever em silêncio": o primeiro a gravar prevalece no mesmo campo e o outro é
  avisado. Duas ações do cronômetro no mesmo instante em abas diferentes: vale a última (o cronômetro nunca grava na
  série sozinho, então isso não altera dados). Sem sincronização remota.

## 10. Testes

| Arquivo | Testes | Cobertura |
| --- | --- | --- |
| `tests/unit/set-timer.test.ts` | 15 | iniciar, pausar, continuar, encerrar, reiniciar, formato e arredondamento, segundo plano, relógio alterado (voltou/adiantou), recarga (pausado, tempo fora, limites), estado malformado, descanso independente, um cronômetro por vez, navegação, duas abas, falha de persistência, descarte |
| `tests/unit/session-concurrency.test.ts` | 10 | mescla (séries diferentes, mesma série concluída duas vezes, tela desatualizada, adição/remoção, descanso), gravação protegida, aviso de descanso preservado, treino fechado não ressuscita, finalização dupla, falha de gravação |
| `tests/unit/model-compat.test.ts` | 11 | fotografia (criar/alterar/excluir, transação desfeita, nada no banco), app antigo simulado (detecção, restauração, manter, mudança posterior, sem perda, exercício excluído, rotina sem fotografia), capacidade, backup v3 sem estado auxiliar |
| `tests/unit/workout-timers-ui.test.tsx` | 17 | cronômetro na série, conflito de duração, meta pré-preenchida, conclusão com cronômetro e cancelamento, reinício confirmado, outra série, cardio (m/km/mi, equivalências, ritmo, metas, validação), unilaterais, peso corporal × assistência, treino ativo (toque duplo, descanso + cronômetro, falha de gravação), editor bloqueado |
| `tests/unit/workout-timers-flow.test.ts` | 2 | do cronômetro ao histórico e ao analytics (tempo, cardio em milhas, lados, assistência, carga adicional); 1RM histórico inalterado |
| `e2e/workout-timers.spec.ts` | 3 × 2 projetos | Android 360 px e desktop: criar exercício por tempo, iniciar, navegar, pausar, continuar, encerrar, concluir, recarregar, conferir duração, cardio em milhas, unilateral, carga adicional/assistência, histórico, Desempenho, offline, duas abas (um cronômetro, sem conclusão dupla, sem ressuscitar), app antigo + restauração, sem rolagem horizontal |

## 11. Limitações

- **Navegadores móveis** podem congelar ou descartar abas em segundo plano (Chrome no Android, Safari no iOS). Se a
  aba for descartada, o cronômetro volta pausado no último tempo confirmado e oferece somar o tempo fora; se for só
  congelada, ao voltar a contagem está certa (relógio de parede).
- Sem aviso sonoro de meta atingida no cronômetro de execução (o aviso sonoro continua só no descanso).
- O tempo exibido é truncado em segundos; décimos não são registrados.
- A recuperação depende de `BroadcastChannel` (Safari 15.4+); sem ele, recarregar sempre pausa (comportamento
  seguro).
- A proteção de compatibilidade depende do `localStorage` do mesmo navegador e não impede a regravação no app antigo.
- Conflitos entre abas são resolvidos a favor de quem gravou primeiro, com aviso; não há trava exclusiva.
