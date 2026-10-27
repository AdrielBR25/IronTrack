# Migrações do banco local (IndexedDB / Dexie)

Implementação em `src/db/db.ts`; testes em `tests/unit/migrations.test.ts`.

## Versões

| Versão Dexie | Publicada em | Alterações |
| ------------ | ------------ | ---------- |
| 1 | Primeira versão do app | Tabelas `settings`, `routines`, `sessions`, `rotations`, `overrides`, `bodyEntries`, `photos` (ver [INTEGRIDADE_DADOS.md](INTEGRIDADE_DADOS.md)). |

A Fase 01 do IronTrack 2.0 **não alterou o esquema**: nenhuma mudança de tabela ou índice foi necessária,
então a versão continua 1 (`DB_SCHEMA_VERSION = 1`). Foi criada a infraestrutura e os testes para as próximas.

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
- simula uma versão 2 hipotética: upgrade real v1 → v2, transformação aplicada, novo índice funcionando, reabertura;
- simula falha no meio do upgrade e confirma que o banco segue em v1, idêntico;
- confirma que o app antigo (v1) ainda abre um banco já atualizado para v2 (Dexie 4 abre em modo compatível).

## Limitações de rollback

- Não existe "downgrade" de esquema no IndexedDB. Depois que um upgrade termina com sucesso, voltar o código
  não desfaz a transformação dos dados (os índices extras continuam). Dexie 4 consegue abrir o banco com o
  código antigo, mas os dados ficam no formato novo — por isso as transformações devem ser aditivas e
  compatíveis com a versão anterior sempre que possível.
- Recomende exportar um backup antes de publicar uma versão com migração de dados.
- Com várias abas abertas, a aba antiga é fechada pelo Dexie ao detectar a nova versão; recarregar resolve.
