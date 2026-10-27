# Backup e restauração

Implementação em `src/lib/backup.ts` (arquivo, validação, transações) e `src/lib/merge.ts` (política de
mesclagem). Interface em **Configurações › Dados e backup**.

## Formatos aceitos

| Formato | Identificação | Situação |
| ------- | ------------- | -------- |
| Backup v1 (atual) | `{"app": "irontrack", "kind": "backup", "schemaVersion": 1, "exportedAt": "...", "data": {...}}` | Exportado e importado. |
| Backup v0 (preliminar) | `{"app": "irontrack", ...tabelas na raiz}` sem `schemaVersion` | Importado; migrado em memória para v1. |
| Ficha `irontrack.ficha` v1 | — | Não é backup: recusada com orientação para Treinos › Importar ficha. |
| Avaliações `irontrack.avaliacoes` v1 | — | Importadas em Evolução › Corpo (contrato inalterado). |
| `schemaVersion` maior que o suportado | — | Recusado: "Atualize o IronTrack antes de importar". |

`data` contém `settings`, `routines`, `sessions`, `rotations`, `overrides`, `bodyEntries` e `photos`.
Campos desconhecidos são preservados (`.passthrough()`), para que backups de versões futuras compatíveis não percam dados.

## Versionamento

- `BACKUP_SCHEMA_VERSION` (formato JSON) e `DB_SCHEMA_VERSION` (IndexedDB) são **independentes**.
- Mudou o formato do arquivo? Incremente `BACKUP_SCHEMA_VERSION` e acrescente uma função em `MIGRATIONS`
  (chave = versão de origem) que leve à versão seguinte. Nunca remova migrações antigas.
- Os arquivos do usuário nunca são reescritos; a migração acontece apenas em memória.

## Fluxo de importação (nada é gravado antes do passo 8)

1. Tamanho do arquivo conferido antes da leitura (limite de 100 MB).
2. Interpretação do JSON.
3. Identificação do formato e da versão.
4. Migrações de formato (v0 → v1).
5. Validação estrutural com Zod e limites de complexidade.
6. Verificação de integridade semântica (`checkIntegrity`); erros bloqueiam.
7. Prévia (`previewRestore`): compara com os dados atuais e mostra o que acontecerá. **Cancelar não altera nada.**
8. Confirmação → restauração em transação única.

### Limites

| Item | Limite |
| ---- | ------ |
| Arquivo | 100 MB |
| Rotinas / treinos registrados / avaliações / fotos | 1.000 / 50.000 / 10.000 / 2.000 |
| Rotações / substituições de calendário | 1.000 / 20.000 |
| Uma foto (data URL) | 15 MB |
| Treinos por rotina · exercícios por treino · séries por exercício | 100 · 300 · 200 |

Os limites ficam muito acima do uso real (fotos têm ~100–400 KB após a compressão do app) e servem para
recusar arquivos absurdos com uma mensagem específica, em vez de travar o navegador.

## Substituir × mesclar

| | Substituir | Mesclar |
|-|-|-|
| O que faz | Apaga todos os dados locais e grava os do backup | Adiciona o que falta, sem tocar no que existe |
| Confirmação | Prévia + segunda confirmação | Prévia |
| Configurações | Vêm do backup | Locais mantidas (as do backup só entram se não houver locais) |
| Garantia | Transação única: se algo falhar, tudo é desfeito | Transação única; só inserções (`add`), nunca `put` sobre registro existente |

## Política de duplicidade e conflitos (mesclar)

| Situação | Resultado |
| -------- | --------- |
| Mesmo ID, mesmo conteúdo | Duplicata confirmada: não grava. |
| Mesmo ID, conteúdo diferente | **Conflito**: mantém o registro local, não aplica o do backup e lista na prévia. |
| IDs diferentes, conteúdo idêntico | Duplicata confirmada; referências dependentes do backup passam a apontar para o registro local. |
| IDs diferentes, conteúdo semelhante | Registros distintos: ambos mantidos, com aviso de "possível duplicata". |
| Registros distintos | Adicionados. |

"Conteúdo idêntico" ignora apenas o ID e metadados de inserção:

- rotinas: ignora `id`, `createdAt`, `updatedAt`;
- treinos registrados: ignora `id`;
- avaliações: ignora `id`, `createdAt`;
- fotos: compara `entryId` (após remapeamento) e `dataUrl`.

"Semelhante" (gera aviso, nunca descarte):

- treinos com o mesmo `startedAt` e `workoutName` (antiga regra de deduplicação, que descartava treinos distintos);
- avaliações na mesma data (antiga regra data + peso + cintura, que descartava avaliações distintas);
- rotinas com o mesmo nome.

Casos especiais:

- **Treino em andamento:** se já existe um neste aparelho, o do backup é ignorado e o motivo aparece na prévia
  (o app só suporta um). Use "Substituir" para restaurá-lo.
- **Fotos de avaliação em conflito:** não são aplicadas (seriam ligadas à avaliação errada); aparecem como ignoradas.
- **Fotos sem avaliação:** preservadas, com aviso.
- **Rotação e calendário:** se já existe estado local para a mesma rotina/data, o local é mantido.
  Se a rotina do backup foi reconhecida como idêntica a uma local (outro ID), o ponteiro e as substituições
  são associados à rotina local.
- **Concorrência:** o plano é refeito dentro da transação. Se os dados locais mudaram desde a prévia,
  a mesclagem é cancelada sem gravar nada e o usuário é orientado a abrir o backup de novo.

A prévia mostra: quantidade a adicionar, duplicatas confirmadas, conflitos, ignorados (com motivo),
avisos de integridade e o efeito da substituição.

## Exportação

`exportBackup()` lê todas as tabelas numa **única transação de leitura**, garantindo um retrato consistente
mesmo se um treino for concluído durante a exportação. O JSON é indentado (legível).

## Procedimentos de recuperação

1. **Antes de qualquer restauração arriscada**, exporte um backup do estado atual.
2. **Backup recusado por erro de integridade:** a mensagem informa coleção, ID e ação. Não edite o arquivo
   original; faça uma cópia, corrija a cópia e importe-a. O banco local não foi alterado.
3. **Falha durante a restauração** (ex.: falta de espaço): a transação é desfeita; os dados anteriores
   permanecem. Libere espaço e tente de novo. Não é necessária nenhuma limpeza.
4. **Mesclagem com conflitos:** os registros locais foram mantidos. Para preferir os do backup, exporte
   um backup local (segurança) e use "Substituir".
5. **Fotos órfãs ou rotação inconsistente:** use **Verificar integridade dos dados**; os registros estão
   preservados e entram nos backups exportados.
6. **App não abre os dados** (tela "IronTrack não conseguiu abrir seus dados"): **não limpe os dados do site**.
   Feche outras abas do IronTrack e recarregue; se o problema for de versão, atualize o app.
7. **Aparelho novo:** instale o app, abra Configurações › Restaurar backup, confira a prévia e escolha "Substituir".

## Limitações conhecidas

- Sem compressão nem criptografia: o arquivo contém fotos e medidas em texto claro. Guarde-o em local privado.
- Conflitos de mesmo ID não são resolvidos campo a campo; o registro local sempre vence na mesclagem.
- O backup é lido inteiro na memória (até 100 MB); aparelhos com pouca memória podem ficar lentos perto do limite.
