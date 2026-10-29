# Migrações do banco local (IndexedDB / Dexie)

Implementação em `src/db/db.ts`; testes em `tests/unit/migrations.test.ts`.

## Versões

| Versão Dexie | Publicada em | Alterações |
| ------------ | ------------ | ---------- |
| 1 | Primeira versão do app | Tabelas `settings`, `routines`, `sessions`, `rotations`, `overrides`, `bodyEntries`, `photos` (ver [INTEGRIDADE_DADOS.md](INTEGRIDADE_DADOS.md)). |
| 2 | IronTrack 2.0 F01/P02 | Tabela `profiles` (`id`) e índice `profileId` em `routines`, `sessions`, `bodyEntries`, `photos` (ver [PERFIL_LOCAL.md](PERFIL_LOCAL.md)). |
| 3 | IronTrack 2.0 F01/P12 | Tabela `goals` (`id, profileId, status, updatedAt`), sem função de upgrade; nenhuma tabela antiga muda (ver [METAS_TREINAMENTO.md](METAS_TREINAMENTO.md) §4). |
| 4 | IronTrack 2.0 F01/P13 | Tabela `planEntries` (`id, profileId, scope, date, routineId, updatedAt`), sem função de upgrade; nenhuma tabela antiga muda (ver [PLANEJAMENTO_SEMANAL.md](PLANEJAMENTO_SEMANAL.md) §7). |
| 5 | IronTrack 2.0 F01/P16 | Tabela `calendarDecisions` (`id, profileId, date, updatedAt`), sem função de upgrade; nenhuma tabela antiga muda (ver [DECISOES_CALENDARIO.md](DECISOES_CALENDARIO.md) §8). |
| 6 | IronTrack 2.0 F01/P17 | Tabelas `customExercises` (`id, profileId, updatedAt`) e `exerciseFavorites` (`id, profileId, target`), sem função de upgrade; nenhuma tabela antiga muda (ver [BIBLIOTECA_EXERCICIOS.md](BIBLIOTECA_EXERCICIOS.md) §13). |

O Prompt 18 (reconhecimento de exercícios antigos, catálogo versão 2) **não** criou versão nova: a associação grava
só a referência de origem opcional que a instância já tinha desde a versão 6 (ver
[RECONHECIMENTO_EXERCICIOS.md](RECONHECIMENTO_EXERCICIOS.md) §15).
O Prompt 01 não alterou o esquema (só criou a infraestrutura). O Prompt 02 criou a versão 2 (`DB_SCHEMA_VERSION = 2`).
O Prompt 10 (modelo de exercícios v3) **não** criou versão nova: os campos de modalidade ficam dentro dos registros,
sem índice e sem transformação, e o app anterior continua abrindo o banco. Justificativa e testes em
[MIGRACAO_EXERCICIOS_V3.md](MIGRACAO_EXERCICIOS_V3.md) §3.
O Prompt 12 criou a versão 3 (`DB_SCHEMA_VERSION = 3`) só para a tabela de metas. A migração v2 → v3 não transforma
registros. Um app anterior com Dexie 4 que declara só a v2 continua abrindo o banco v3 (o Dexie 4 abre na versão
instalada) e ignora a tabela nova; verificado no Chromium e em `tests/unit/goals-db.test.ts`.
O Prompt 13 criou a versão 4 (`DB_SCHEMA_VERSION = 4`) só para a tabela do planejamento; mesmas garantias (app do P12
abrindo v4 testado em `tests/unit/planner-db.test.ts`).
O Prompt 16 criou a versão 5 (`DB_SCHEMA_VERSION = 5`) só para as decisões lembradas do calendário; mesmas garantias
(migração aditiva, sem transformar registros; declarações v1–v4 intactas, testado em `tests/unit/migrations.test.ts`).
O Prompt 17 criou a versão 6 (`DB_SCHEMA_VERSION = 6`) só para a biblioteca de exercícios (personalizados e
favoritos); mesmas garantias. As fichas ganharam campos opcionais (`catalogId`, `catalogVersion`, `customExerciseId`)
dentro dos registros, sem índice e sem transformação: fichas antigas não são reescritas nem associadas ao catálogo por
nome. App do P16 abrindo o banco v6 e migração v5 → v6 testados em `tests/unit/library-db.test.ts`.

## Migração v1 → v2 (perfil local)

Declaração completa da v2 em `src/db/db.ts`; a v1 permanece idêntica. O upgrade, dentro da transação
`versionchange` (atômica, offline, sem rede nem timers):

1. procura um perfil principal em `profiles` (tabela nova, vazia) e, não havendo, cria **exatamente um**
   ("Meu perfil", UUID v4 aleatório);
2. atribui esse perfil a todo registro de `routines`, `sessions`, `bodyEntries` e `photos` que não tenha
   `profileId` (`modify`, sem trocar IDs, sem apagar, sem tocar em `settings`, `rotations` e `overrides`).

Instalação nova: o Dexie cria o banco direto na v2 (o upgrade não roda) e `ensureDefaultProfile`, executado
em `db.on('ready')`, cria o perfil numa transação serializada entre abas. O mesmo `ensureDefaultProfile` roda em
toda abertura e adota registros sem dono gravados por uma aba antiga (código v1) ainda aberta.

A versão do esquema Dexie é independente da versão do backup JSON (`BACKUP_SCHEMA_VERSION`).

## Regras

1. **Nunca altere** `this.version(1).stores(...)` nem nenhuma versão já publicada. O teste
   "versão 1 permanece idêntica à publicada" compara o esquema com uma cópia congelada.
2. Só crie uma versão nova quando houver mudança real de tabelas ou índices, ou transformação de dados necessária.
3. Declare apenas as tabelas que mudam; para remover uma tabela use `null` — e só com migração dos dados e justificativa.
4. Envolva o upgrade com `migration(versão, descrição, fn)`:

   ```ts
   this.version(2)
     .stores({ sessions: 'id, status, startedAt, workoutId, routineId, finishedAt' })
     .upgrade(
       migration(2, 'índice finishedAt', async (tx) => {
         await tx.table('sessions').toCollection().modify((s) => {
           /* transformação determinística, tolerante a campos ausentes */
         });
       }),
     );
   ```

5. A função de upgrade deve ser determinística, sem rede, sem IA, sem `setTimeout`/`fetch`, e usar só a
   transação `tx` recebida. Trate registros legados com campos opcionais ausentes.
6. Atualize `DB_SCHEMA_VERSION`, esta tabela de versões e os testes.

## Comportamento em falhas

- O upgrade roda dentro da transação `versionchange` do IndexedDB. Se a função lançar erro, **tudo é desfeito**:
  o banco continua na versão anterior com os dados intactos (testado).
- `migration()` converte o erro em `MigrationError` com versão e descrição.
- `src/main.tsx` abre o banco antes de montar o app. Se falhar, mostra uma tela com o motivo
  (`describeOpenError`) e a orientação de **não limpar os dados do site**. Nada é apagado nem recriado.

## Testes de compatibilidade

`tests/unit/migrations.test.ts`:

- cria um banco com Dexie puro usando a **cópia congelada do esquema v1**, grava dados representativos
  (configurações, rotina ABC, treinos concluídos, treino em andamento com descanso, rotação, substituições,
  avaliações e fotos) e abre com a classe atual — todos os registros são comparados;
- executa os fluxos (retomar treino, concluir, avançar rotação) sobre o banco legado e reabre;
- **migração real v1 → v2**: um único perfil criado, todos os registros com os mesmos IDs e campos, dono
  atribuído, relações (foto → avaliação, treino → rotina, rotação, agenda) intactas, treino em andamento e
  histórico de rotina excluída preservados, integridade sem erros; a migração não roda de novo ao reabrir;
- falha ao gerar o perfil e falha no meio da atribuição (fotos): rollback completo, banco continua v1 sem `profiles`
  e sem nenhum `profileId`; nova tentativa conclui;
- aba antiga (Dexie com esquema v1) gravando num banco v2: o registro sem dono é adotado na próxima abertura;
- simula uma versão 3 hipotética sobre a v2: upgrade, falha com rollback para v2, e o app v2 abrindo banco v3.

## Limitações de rollback

- Não existe "downgrade" de esquema no IndexedDB. Depois que um upgrade termina com sucesso, voltar o código
  não desfaz a transformação dos dados (os índices extras continuam). Dexie 4 consegue abrir o banco com o
  código antigo, mas os dados ficam no formato novo — por isso as transformações devem ser aditivas e
  compatíveis com a versão anterior sempre que possível.
- Recomende exportar um backup antes de publicar uma versão com migração de dados.
- Com várias abas abertas, a aba antiga é fechada pelo Dexie ao detectar a nova versão; recarregar resolve.
