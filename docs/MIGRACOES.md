# Migrações do banco local (IndexedDB / Dexie)

Implementação em `src/db/db.ts`; testes em `tests/unit/migrations.test.ts`.

## Versões

| Versão Dexie | Publicada em | Alterações |
| ------------ | ------------ | ---------- |
| 1 | Primeira versão do app | Tabelas `settings`, `routines`, `sessions`, `rotations`, `overrides`, `bodyEntries`, `photos` (ver [INTEGRIDADE_DADOS.md](INTEGRIDADE_DADOS.md)). |
| 2 | IronTrack 2.0 F01/P02 | Tabela `profiles` (`id`) e índice `profileId` em `routines`, `sessions`, `bodyEntries`, `photos` (ver [PERFIL_LOCAL.md](PERFIL_LOCAL.md)). |

O Prompt 01 não alterou o esquema (só criou a infraestrutura). O Prompt 02 criou a versão 2 (`DB_SCHEMA_VERSION = 2`).

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
