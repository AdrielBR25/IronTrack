# Backup e restauração

Implementação em `src/lib/backupFormat.ts` (formato do arquivo, validação e migrações; funções puras),
`src/lib/backup.ts` (exportação e restauração em transações) e `src/lib/merge.ts` (política de mesclagem).
Interface em **Configurações › Dados e backup**.

## Formatos aceitos

| Formato | Identificação | Situação |
| ------- | ------------- | -------- |
| Backup v3 (atual, P10) | igual ao v2 com `"schemaVersion": 3`; exercícios e séries podem ter os campos de modalidade (`modality`, `laterality`, `loadMode`, `secondaryMuscles`, `distanceUnit`, `targetDurationSec`, `targetDistance`, `durationSec`, `distance`, `side`, `assistanceKg`), ver [MIGRACAO_EXERCICIOS_V3.md](MIGRACAO_EXERCICIOS_V3.md) | Exportado e importado. Valores inválidos bloqueiam (`INVALID_MODALITY_FIELD`); contradições são aviso (`MODALITY_CONTRADICTION`). |
| Backup v2 | `{"app": "irontrack", "kind": "backup", "schemaVersion": 2, "exportedAt": "...", "profile": {"id", "displayName", "createdAt"}, "data": {...}}`; registros de `routines`, `sessions`, `bodyEntries` e `photos` com `profileId` | Importado; migrado em memória v2 → v3 (identidade, nada muda). |
| Backup v1 | `{"app": "irontrack", "kind": "backup", "schemaVersion": 1, "exportedAt": "...", "data": {...}}` | Importado; migrado em memória para v2 com `profile: null` (legado sem dono) e depois para v3. |
| Backup v0 (preliminar) | `{"app": "irontrack", ...tabelas na raiz}` sem `schemaVersion` | Importado; migrado em memória v0 → v1 → v2 → v3. |
| Ficha `irontrack.ficha` v1/v2 | — | Não é backup: recusada com orientação para Treinos › Importar ficha. |
| Avaliações `irontrack.avaliacoes` v1 | — | Importadas em Evolução › Corpo (contrato inalterado). |
| `schemaVersion` maior que o suportado | — | Recusado: "Atualize o IronTrack antes de importar". |

`data` contém `settings`, `routines`, `sessions`, `rotations`, `overrides`, `bodyEntries` e `photos`.
Campos desconhecidos são preservados (`.passthrough()`), para que backups de versões futuras compatíveis não percam dados.

## Versionamento

- `BACKUP_SCHEMA_VERSION` (formato JSON) e `DB_SCHEMA_VERSION` (IndexedDB) são **independentes**.
- Mudou o formato do arquivo? Incremente `BACKUP_SCHEMA_VERSION` e acrescente uma função em `MIGRATIONS`
  (chave = versão de origem) que leve à versão seguinte. Nunca remova migrações antigas.
- v3 → v4 (P12) acrescenta `data.goals: []` (metas de treinamento; ver [METAS_TREINAMENTO.md](METAS_TREINAMENTO.md) §5).
  Um app anterior recusa arquivos v4 com a orientação de atualizar.
- v2 → v3 (P10) é identidade: o incremento existe para que um app antigo recuse arquivos com campos de modalidade
  em vez de restaurá-los sem entendê-los.
- Os arquivos do usuário nunca são reescritos; a migração acontece apenas em memória.

## Fluxo de importação (nada é gravado antes do passo 8)

1. Tamanho do arquivo conferido antes da leitura (limite de 100 MB).
2. Interpretação do JSON.
3. Identificação do formato e da versão.
4. Migrações de formato (v0 → v1 → v2 → v3).
5. Validação estrutural com Zod e limites de complexidade.
6. Verificação de integridade semântica (`checkBackupIntegrity`, inclui as regras de dono do formato); erros bloqueiam.
7. Prévia (`previewRestore`): mostra a relação de identidade (mesmo perfil, legado ou outro perfil), compara com os
   dados atuais e mostra o que acontecerá. **Cancelar não altera nada.**
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

## Identidade do perfil

Política completa em [PERFIL_LOCAL.md](PERFIL_LOCAL.md#backups-e-identidade).

| Backup | Mesclar | Substituir |
| ------ | ------- | ---------- |
| Mesmo perfil | Normal | Normal |
| Legado (v0/v1) | Registros atribuídos ao perfil local (informado na prévia) | Idem |
| Outro perfil | Bloqueado (`PROFILE_MERGE_BLOCKED_MESSAGE`) | Exige `acceptProfileTransfer` (caixa na prévia); dados passam ao perfil local |

O perfil local (ID e nome) nunca é alterado por uma restauração. A tabela `profiles` entra nas transações
de restauração só para leitura e na impressão digital da prévia.

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
- **Rotina em conflito:** o ponteiro de rotação e as substituições de calendário do backup para essa rotina
  não são aplicados (referem-se à versão do backup, que não foi aplicada). Os treinos históricos dela são mantidos.
- **Confirmação explícita:** quando parte do backup não será restaurada (conflitos ou ignorados), a prévia lista
  o que será mantido deste aparelho, o que não será restaurado e o que será adicionado com aviso, e o botão
  "Mesclar" só é liberado após marcar "Entendo e quero mesclar mesmo assim". A API exige `acceptPartial: true`.
  Depois da mesclagem, um aviso informa quantos registros do backup não foram restaurados.
- **Referências:** antes de gravar, a integridade do resultado (dados locais + inserções) é verificada;
  se a mesclagem criaria qualquer erro novo, ela é cancelada sem gravar nada.
- **Prévia desatualizada:** a prévia guarda uma impressão digital determinística do conteúdo local
  (`snapshotFingerprint`: hash de cada registro, independente de ordem). Dentro da transação de restauração
  (mesclar ou substituir), o retrato local é lido de novo e comparado. Qualquer mudança, mesmo uma nota editada
  sem alterar a quantidade de registros, cancela a operação sem gravar nada e pede uma nova prévia.

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
7. **Aparelho novo:** instale o app, abra Configurações › Restaurar backup, confira a prévia, marque a confirmação
   de que os dados do backup passarão ao perfil deste aparelho e escolha "Substituir".

## Limitações conhecidas

- Sem compressão nem criptografia: o arquivo contém fotos e medidas em texto claro. Guarde-o em local privado.
- Conflitos de mesmo ID não são resolvidos campo a campo; o registro local sempre vence na mesclagem.
- Backups de outro perfil não podem ser mesclados nesta versão (só substituir).
- O backup é lido inteiro na memória (até 100 MB); aparelhos com pouca memória podem ficar lentos perto do limite.

## Metas de treinamento (backup v4, P12)

- Exportadas em `data.goals` com todos os campos (ID, versão do registro, estado, pausas).
- **Substituir** troca as metas pelas do arquivo. Um backup v0–v3 não tem metas: substituir por ele **apaga as metas
  locais**, e a prévia mostra a contagem "Metas" de cada lado antes de confirmar.
- **Mesclar:** ID novo é acrescentado; ID igual com conteúdo diferente mantém a meta local (conta como conflito e
  exige confirmar a restauração parcial); conteúdo igual com outro ID é ignorado; mesmo tipo e título com valores
  diferentes é mantido com aviso `SIMILAR_GOAL`; a referência à rotina é remapeada quando a rotina do arquivo já
  existe aqui com outro ID.
- Meta inválida (`INVALID_GOAL`), com ID repetido ou de outro perfil bloqueia a restauração inteira; metas nunca são
  descartadas em silêncio. Meta cujo exercício não está mais na ficha só gera aviso (`GOAL_EXERCISE_UNAVAILABLE`).
- Limite: 2000 metas por arquivo.
