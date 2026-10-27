# Perfil local e propriedade dos dados

IronTrack 2.0 · Fase 01 · Prompt 02. Implementação em `src/lib/profile.ts` (regras puras),
`src/db/db.ts` (esquema v2, migração, criação e reparo do perfil, proteção de dono),
`src/db/profiles.ts` (camada de acesso) e `src/lib/backup.ts` (identidade na restauração).
Testes em `tests/unit/profile.test.ts`, `tests/unit/migrations.test.ts`, `tests/unit/backup-profile.test.ts`
e `e2e/profile.spec.ts`.

## Modelo

```ts
interface LocalProfile {
  id: string;          // UUID v4 aleatório, gerado uma única vez
  displayName: string; // "Meu perfil" por padrão; editável em Configurações › Perfil local
  createdAt: number;
  updatedAt: number;
  isDefault: boolean;  // perfil principal (nesta versão, o único)
}
```

Tabela `profiles` (chave `id`). O perfil local é a **identidade dos dados neste navegador**. Não é conta,
login, identidade do aparelho nem do navegador.

### Identificador

- Gerado por `generateProfileId()`: `crypto.randomUUID()` quando existe; senão, UUID v4 montado com
  `crypto.getRandomValues()` (disponível em todos os navegadores suportados, inclusive fora de contexto seguro).
  Sem fonte criptográfica o app **falha com mensagem clara** em vez de gerar um ID fraco.
- Nunca é derivado de nome, aparelho, navegador, data ou dado pessoal.
- Não muda ao reiniciar, reabrir o IndexedDB, atualizar o app, renomear o perfil, apagar os dados
  (Configurações › Apagar todos os dados preserva o perfil) nem ao restaurar qualquer backup.
- Formato validado por `isValidProfileId` (UUID v4 em minúsculas).

## Política de propriedade dos registros

| Coleção | Dono | Por quê |
| ------- | ---- | ------- |
| `routines` | **Explícito** (`profileId`) | Entidade raiz criada pelo usuário. |
| `sessions` | **Explícito** (`profileId`) | Um treino histórico precisa continuar com dono quando a rotina original for excluída (referência histórica legítima do Prompt 01). Não depende da rotina. |
| `bodyEntries` | **Explícito** (`profileId`) | Dados pessoais de saúde; entidade raiz. |
| `photos` | **Explícito** (`profileId`), igual ao da avaliação | Dado mais sensível. Fotos órfãs legítimas (preservadas pelo Prompt 01) não podem ficar sem dono, então o dono não é inferido pela avaliação. A integridade exige que foto e avaliação tenham o mesmo dono. |
| `rotations` | Indireto, pela rotina (`routineId`) | Estado derivado da rotina (só um índice). A chave já é o ID único da rotina. |
| `overrides` | Indireto, pela rotina (`routineId`) | Estado derivado da agenda da rotina. |
| `settings` | Registro único da instalação, usado pelo perfil principal | Mistura preferências do aparelho (tema, som, vibração, notificações) e do usuário (nome da saudação, objetivo, dias, rotina ativa). Não recebe `profileId` nesta etapa; separar em configurações por perfil é trabalho de uma fase futura de múltiplos perfis. |

**Registros indiretos órfãos** (rotação/agenda de rotina inexistente) não têm dono e não são ambíguos:
não contêm dados pessoais, a agenda os ignora e o diagnóstico já os informa (Prompt 01). Num futuro
isolamento por perfil eles seguem a rotina; sem rotina, continuam inertes.

Índices `profileId` em `routines`, `sessions`, `bodyEntries` e `photos` tornam o isolamento futuro
tecnicamente viável (consultas por perfil) sem varrer tabelas. Nesta etapa **as telas não filtram por perfil**:
existe um único perfil.

### Regras garantidas no banco (hooks Dexie em `IronTrackDB`)

1. **Registro novo sem dono** recebe o perfil atual (`creating`). Se o perfil ainda não foi carregado,
   a gravação falha — nunca grava sem dono.
2. **Um registro não muda de dono**: `put`/`update` que troque um `profileId` existente por outro é
   rejeitado (`ProfileError`) e nada é gravado. Regravar um objeto sem o campo mantém o dono atual.
3. Atribuir dono a um registro que **não tinha** (legado) é permitido — é a migração.

## Camada de acesso

| Função | Onde | O que faz |
| ------ | ---- | --------- |
| `ensureDefaultProfile(db)` | `src/db/db.ts` | Garante exatamente um perfil principal e o devolve. Roda em toda abertura do banco (`db.on('ready')`), antes de liberar o banco ao app. |
| `getCurrentProfileId()` / `getCurrentProfile()` | `src/db/profiles.ts` | Perfil atual (o principal). |
| `getProfileById(id)` | `src/db/profiles.ts` | Busca por ID (IDs inválidos devolvem `undefined`). |
| `renameProfile(id, nome)` | `src/db/profiles.ts` | Renomeia (1–40 caracteres). O ID nunca muda. |
| `useCurrentProfile()` | `src/hooks/data.ts` | Hook React para a tela. |

Componentes React não criam nem migram perfis. As funções de persistência existentes (`repo.ts`) não
mudaram de assinatura: o dono é aplicado pelos hooks do banco.

### `ensureDefaultProfile`: criação e reparo

Leitura e escrita acontecem na mesma transação `rw`, que o IndexedDB serializa entre abas: duas abas
abrindo ao mesmo tempo sempre convergem para o mesmo perfil (testado com 4 instâncias concorrentes).

| Situação encontrada | Ação |
| ------------------- | ---- |
| Um perfil principal | Usa-o. |
| Vários perfis principais (corrupção) | Usa o mais antigo (desempate pelo ID); não apaga nenhum; o diagnóstico avisa. |
| Perfis, mas nenhum principal | Promove o mais antigo, **sem mudar o ID**. |
| Nenhum perfil, registros com **um único** dono válido | Recria o perfil **com esse mesmo ID** (nenhum registro muda de dono). |
| Nenhum perfil e nenhum dono (instalação nova) | Cria "Meu perfil" com ID novo. |
| Nenhum perfil e vários donos | Cria um perfil novo; registros de outros donos **não** são reatribuídos (o diagnóstico informa). |

Depois, registros sem dono (ex.: gravados por uma versão antiga do app ainda aberta em outra aba) são
atribuídos ao perfil principal. A detecção é barata (compara a contagem da tabela com a do índice `profileId`);
a varredura só roda se houver diferença.

## Esquema Dexie

| Versão | Tabelas e índices |
| ------ | ----------------- |
| 1 (congelada) | `settings: id` · `routines: id, updatedAt` · `sessions: id, status, startedAt, workoutId, routineId` · `rotations: routineId` · `overrides: [routineId+date], routineId, date` · `bodyEntries: id, date` · `photos: id, entryId` |
| 2 (atual) | v1 + `profiles: id` · `routines: …, profileId` · `sessions: …, profileId` · `bodyEntries: …, profileId` · `photos: …, profileId` |

A declaração v1 não foi alterada (teste compara com cópia congelada). Processo de migração em
[MIGRACOES.md](MIGRACOES.md).

## Backups e identidade

Formato v2 (detalhes em [BACKUP_RESTAURACAO.md](BACKUP_RESTAURACAO.md)):

```json
{
  "app": "irontrack",
  "kind": "backup",
  "schemaVersion": 2,
  "exportedAt": "2026-01-15T12:00:00.000Z",
  "profile": { "id": "0f8c2a4e-1b7d-4c3a-9e2f-5a6b7c8d9e0f", "displayName": "Meu perfil", "createdAt": 1767000000000 },
  "data": { "routines": [{ "id": "…", "profileId": "0f8c2a4e-1b7d-4c3a-9e2f-5a6b7c8d9e0f", "…": "…" }] }
}
```

| Caso | Mesclar | Substituir |
| ---- | ------- | ---------- |
| Backup do próprio perfil (mesmo ID) | Normal | Normal |
| Backup legado v0/v1 (sem perfil) | Registros atribuídos ao perfil local; a prévia informa | Idem |
| Backup de outro perfil (ID diferente) | **Bloqueado** (misturaria donos) | Só com confirmação explícita de transferência; os dados passam a pertencer ao perfil local |

- O ID e o nome do perfil local **nunca** são trocados por uma restauração; a tabela `profiles` só é lida.
- A atribuição ao perfil local é explícita (`assignOwner`), feita antes do plano de mesclagem, e aparece na prévia.
- Caso típico de "outro perfil": aparelho novo ou navegador limpo (o app cria um perfil novo ao abrir).
  Para restaurar ali: prévia › marcar a confirmação › Substituir.
- A impressão digital da prévia inclui os perfis: renomear o perfil entre a prévia e a confirmação cancela a restauração.
- Backup v2 adulterado (registro sem dono, dono diferente do arquivo, ID inválido, referência entre donos)
  é bloqueado pela integridade.

## Integridade

Novas verificações (`checkIntegrity(snapshot, { scope, profiles })`, ver [INTEGRIDADE_DADOS.md](INTEGRIDADE_DADOS.md)):
`PROFILE_INVALID_ID`, `PROFILE_DEFAULT_MISSING`, `PROFILE_DEFAULT_DUPLICATE`, `RECORD_UNOWNED`,
`RECORD_PROFILE_UNKNOWN`, `CROSS_PROFILE_REFERENCE`. As exceções históricas do Prompt 01 continuam:
treino de rotina excluída é só informativo.

## Limitações atuais

- Um único perfil: sem seletor, criação manual, exclusão, avatar, login, conta online ou sincronização.
- As telas não filtram por perfil (desnecessário com um perfil).
- `settings` ainda é único por instalação.
- Mesclar backups de perfis diferentes (ex.: histórico de dois aparelhos da mesma pessoa) está bloqueado;
  exigirá uma decisão explícita de "unificar perfis" numa fase futura.
- Registros com dono desconhecido não são reatribuídos automaticamente; aparecem no diagnóstico.

## Recuperação em caso de falha

1. **Falha ao preparar o perfil na abertura** (tela "IronTrack não conseguiu abrir seus dados"): nada foi
   apagado. Feche outras abas e recarregue. **Não limpe os dados do site.**
2. **Falha durante a migração v1 → v2:** a transação de upgrade é desfeita; o banco continua v1, intacto.
   Recarregar tenta de novo.
3. **Perfil apagado ou corrompido manualmente:** recarregue; o app restabelece o perfil sem trocar donos
   (ver tabela de reparo). Use **Verificar integridade dos dados** para conferir.
4. **Restauração de outro perfil feita por engano:** restaure o backup anterior do próprio perfil
   (exporte um backup antes de qualquer substituição).
