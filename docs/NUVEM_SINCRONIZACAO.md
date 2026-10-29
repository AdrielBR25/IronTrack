# Sincronização e importação (Prompt 21)

Protocolo `irontrack.sync.v1`. Código: `shared/sync/*` (contrato e mesclagem, usados pelos dois lados),
`src/cloud/syncEngine.ts` (aparelho), `services/api/src/modules/sync.ts` e `records.ts` (servidor).

## 1. Princípios

1. **Offline primeiro.** O app grava sempre no IndexedDB do aparelho; a rede só leva e traz alterações.
2. **Nada de "última gravação vence".** Cada alteração diz em qual versão do servidor se baseia. Se o servidor mudou, ou
   a mesclagem é provadamente segura, ou vira **conflito explícito**, com os dois lados preservados até a pessoa decidir.
3. **Idempotência.** Cada operação tem `opId` (UUID). Reenviar (resposta perdida, nova tentativa) devolve o mesmo
   resultado e não aplica duas vezes.
4. **"Sincronizado" só com confirmação do servidor**: nada pendente, nada sem varrer, último ciclo concluído.
5. O horário do aparelho é só informativo; nunca decide nada.

## 2. O que sincroniza

`settings`, `routines`, `sessions`, `rotations` (ID = rotina), `overrides` (ID = `rotina|data`), `bodyEntries`, `goals`,
`planEntries`, `calendarDecisions`, `customExercises`, `exerciseFavorites`.

**Não sincroniza:** `photos` (ficam só no aparelho e aparecem como "não sincronizadas": não há armazenamento privado
de objetos nesta fase, e não usamos bucket público) e `profiles` (o perfil da conta é fixo: `data_profile_id`).

O servidor normaliza cada registro: força `profileId` = perfil da conta, confere a identidade (o ID no corpo tem de
bater com `entityId`; IDs que dependem do perfil, `<perfil>~<alvo>`, têm de usar o perfil da conta), valida o tipo,
recusa registros acima de 512 KB e o caractere nulo.

## 3. No aparelho

- Um banco por conta: `irontrack-acct-<conta>` (o banco `irontrack` do modo sem conta nunca é alterado; só lido na
  importação). O perfil principal desse banco tem o ID de dados da conta, igual em todos os aparelhos.
- Versão 7 do esquema, só nesse banco: `syncMeta` (última versão do servidor conhecida de cada entidade e o JSON
  canônico dela), `syncOutbox` (no máximo uma operação pendente por entidade) e `syncKv` (ID do aparelho, cursor,
  última sincronização).
- `localStorage['irontrack.account.v1']`: qual conta abrir (IDs, nome e e-mail para exibir). Sem senha nem token: a
  sessão é um cookie HttpOnly que o app não lê.

## 4. Ciclo

1. **Varrer**: compara cada registro local com `syncMeta` (JSON canônico). Mudou → cria/atualiza a operação `put` com
   `baseVersion` = versão conhecida; sumiu → `delete`; criado e apagado antes de sair do aparelho → nada é enviado.
2. **Enviar** em lotes (≤100 ops, ≤~4 MB). Resultado por operação:
   - `applied` → `syncMeta` passa à nova versão; a operação sai da fila. Se a entidade mudou de novo durante o envio,
     a operação nova passa a se basear na versão recém-gravada.
   - `conflict` (versão do servidor ≠ base) → tenta a mesclagem (§5). Sem sobreposição: grava o resultado no aparelho e
     reenvia sobre a versão atual. Com sobreposição: estado **conflito**, nada é sobrescrito.
   - `rejected` (dado inválido) → estado **recusado**, com opções "tentar de novo" ou "descartar esta alteração".
3. **Baixar** a partir do cursor (páginas de 500, ordem de `server_seq`). Para cada mudança: se há operação pendente da
   entidade, o aparelho mantém a sua (o envio resolve); se o registro local mudou depois da última varredura, não toca;
   senão aplica. Cursor à frente do servidor (banco restaurado) → `reset` e baixa de novo do zero, sem apagar nada local.

Disparos: alteração local (aguarda 1,5 s para agrupar), voltar a ficar online, aba visível, a cada 60 s, "Sincronizar
agora". Falhas: nova tentativa com espera crescente (2 s → 5 min, com variação). Várias abas: um ciclo por vez
(Web Locks). No servidor, `users.sync_seq` é incrementado com trava da linha da conta: o cursor não tem buracos.

## 5. Mesclagem de três vias (`shared/sync/merge.ts`)

`base` = versão do servidor que o aparelho conhecia; `local` = versão do aparelho; `remote` = versão atual do servidor.

- Campo mudado só de um lado → vale a mudança. Igual nos dois → ok. Diferente nos dois → **conflito** naquele caminho.
- Listas de objetos com `id` (exercícios, séries, treinos da ficha) são mescladas item a item; item removido de um lado
  e alterado do outro é conflito; reordenação dos dois lados de formas diferentes é conflito.
- `updatedAt` e `revision` ficam com o maior valor (contadores, não decidem nada).
- **Guardas** em treinos: se `status`, `finishedAt` ou `timing` mudaram de um lado e qualquer outra coisa mudou do outro
  (ex.: finalizado num aparelho, séries registradas no outro), é conflito.
- Sem base (mesmo ID criado nos dois lados) → só aceita se idênticos.

## 6. Conflitos: resolução explícita (Conta → Sincronização)

Cada conflito mostra "Este aparelho" × "Nuvem (outro aparelho)" e onde se sobrepõem.

- **Manter deste aparelho** → reenvia com `reason: "conflict_resolution"` sobre a versão atual; o servidor guarda a
  versão substituída em `record_revisions` (últimas 20 por registro).
- **Usar a da nuvem** → o aparelho passa a ter a versão do servidor.
- **Manter os dois** (treinos, fichas, medidas, metas, exercícios personalizados) → a versão do aparelho vira um registro
  novo (treino em andamento vira finalizado) e o original segue a da nuvem.

Enquanto o conflito existe a operação fica na fila (não se perde ao fechar o app) e alterações novas no mesmo registro
são guardadas nela.

| Cenário pedido | Comportamento | Teste |
|---|---|---|
| Mesmo treino editado em dois aparelhos | Séries diferentes: mescla. Mesma série: conflito. | `tests/unit/cloud-sync.test.ts`, `e2e-cloud/sync.spec.ts` |
| Finalizado num, retomado/alterado no outro | Conflito pela guarda `status`; "manter os dois" | idem |
| Exercício substituído nos dois | Conflito em `exercises[id].name` | `cloud-sync.test.ts` |
| Série removida num, editada no outro | Conflito "removido em outro aparelho e alterado neste" | `cloud-sync.test.ts` |
| Backup importado com operações pendentes | Restaurar backup no aparelho vira alteração comum (varredura); pendências preservadas; conflito se o servidor mudou | `cloud-sync.test.ts` |
| Desconexão durante o treino | Fila guarda tudo; reenvio idempotente | `cloud-sync.test.ts`, `sync.spec.ts` |
| Sessão expirada durante a sincronização | Estado "Entrar de novo"; fila intacta; retoma após entrar | `cloud-sync.test.ts`, `sync.spec.ts` |

## 7. Importação de dados antigos

Origens: o perfil local deste navegador (modo sem conta) ou um arquivo de backup v0–v8 (ex.: o GitHub Pages).

1. **Detectar**: no modo conta, se o navegador tem dados sem conta, um aviso pergunta se a pessoa quer importar
   ("Agora não" fica lembrado por conta em `irontrack.importOffer.v1`).
2. **Mostrar** contagens por tipo (e quantas fotos ficam só no aparelho).
3. **Preparar** no aparelho: o leitor de backup existente valida e migra; `assignOwner` atribui ao perfil da conta
   (inclusive IDs que dependem do perfil); cada registro vira `{ coleção, id, doc canônico, hash SHA-256 }`; a impressão
   digital da origem é o hash da lista ordenada.
4. **Enviar** em lotes (≤500 itens, ≤3 MB) para uma área de preparo no servidor, que normaliza e confere o hash de cada
   item (lote com qualquer item inválido não grava nada).
5. **Prévia**: novos / iguais / diferentes por tipo; aviso se a mesma origem já foi importada.
6. **Confirmar** com política **mesclar** (padrão: novos entram, diferentes ficam com a versão da conta) ou
   **substituir** (exige marcar a confirmação; versão anterior vai para `record_revisions`).
7. **Efetivar** numa única transação PostgreSQL: qualquer falha desfaz tudo. Repetir a efetivação devolve o mesmo relatório.
8. **Verificar** lendo de volta: cada registro que deveria estar igual é comparado pelo hash canônico; contagens por tipo.
   Só então a tela diz "Importação concluída e conferida".
9. O aparelho baixa o que entrou (sincronização). Fotos podem ser copiadas só para o banco local da conta.

A origem nunca é apagada nem alterada. Importar de novo não duplica (registros iguais são ignorados).
