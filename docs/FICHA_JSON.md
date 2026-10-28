# Formato JSON da ficha de treino

O IronTrack importa e exporta fichas (rotinas) neste formato. A validação é feita com Zod
(`src/modules/training/routineSchema.ts`) e os erros apontam o treino e o exercício com problema, por exemplo:

```
Treino 1 › Exercício 2 › series: mínimo de 1 série
Treino 2 › Exercício 1 › repeticoes: faixa de repetições inválida ("12-8"). Use, por exemplo, 10, "6-10" ou "8–12", com mínimo ≤ máximo
```

## Estrutura

```jsonc
{
  "formato": "irontrack.ficha",   // obrigatório, fixo
  "versao": 1,                     // obrigatório
  "nome": "ABC Hipertrofia",       // nome da rotina
  "descricao": "opcional",
  "treinos": [
    {
      "rotulo": "A",               // 1 a 4 caracteres, único na ficha
      "nome": "Peito e tríceps",
      "observacoes": "opcional",
      "exercicios": [
        {
          "nome": "Supino reto com barra",
          "grupo": "Peito",              // grupo muscular (novos grupos são criados automaticamente)
          "tipo": "composto",            // "composto" | "isolado"  (padrão: composto)
          "equipamento": "barra",        // barra | halteres | maquina | polia | peso_corporal | outro
          "series": 3,                   // 1 a 20 séries válidas
          "repeticoes": "6-10",          // 10, "10", "6-10", "6–10", "8 a 12" ou {"min": 6, "max": 10}
          "descanso": 150,               // segundos (padrão: 150 composto / 90 isolado)
          "aquecimento": 1,              // séries de aquecimento (0 a 5)
          "carga": 50,                   // carga planejada em kg (carga total externa)
          "observacoes": "Escápulas retraídas",
          "substitutos": ["Supino com halteres", "Supino máquina"]
        }
      ]
    }
  ]
}
```

### Regras

| Campo | Regra |
|---|---|
| `formato` | sempre `"irontrack.ficha"` |
| `versao` | `1` ou `2`. A versão `2` só é necessária com os campos de modalidade abaixo; o app exporta `1` quando a ficha não os usa |
| `treinos` | 1 a 10 treinos; a ordem define a rotação (A → B → C → A…) |
| `repeticoes` | número fixo ou faixa com mínimo ≤ máximo (1–100) |
| `carga` | sempre a **carga total externa** do exercício: barra + anilhas, soma dos dois halteres, carga da máquina |

### Campos de modalidade (versão 2, todos opcionais)

Só são lidos quando escritos explicitamente. A modalidade **nunca** é deduzida do nome ou do equipamento, e um
número em `repeticoes` nunca vira duração ou distância. Detalhes em [MIGRACAO_EXERCICIOS_V3.md](MIGRACAO_EXERCICIOS_V3.md).

```jsonc
{
  "nome": "Corrida",
  "grupo": "Cardio",
  "series": 1,
  "repeticoes": 1,
  "modalidade": "cardio",          // musculacao | peso_corporal | tempo | cardio
  "lateralidade": "bilateral",     // bilateral | unilateral (cardio não pode ser unilateral)
  "grupos_secundarios": ["Glúteos"], // até 4 textos
  "duracao": 1800,                 // segundos, inteiro de 1 a 86400; só com modalidade tempo ou cardio
  "distancia": 5,                  // só com modalidade cardio e unidade_distancia; até 1000 km
  "unidade_distancia": "km"        // m | km | mi
}
```

| Combinação | Resultado |
|---|---|
| `tipo_carga` que não vale na modalidade | erro. Valem: `musculacao` → `externa`; `peso_corporal` → `corporal`, `adicional`, `assistida`; `tempo` → `corporal`, `adicional`, `externa`; `cardio` → nenhum |
| `duracao` sem `modalidade` `tempo`/`cardio` | erro |
| `distancia` sem `modalidade` `cardio` ou sem `unidade_distancia` | erro |
| campos novos com `"versao": 1` | aceitos (a versão é só o máximo suportado) |
| `"versao"` maior que 2 | recusado: atualize o IronTrack |

Um exemplo completo e fictício está em [`public/examples/ficha-abc-exemplo.json`](../public/examples/ficha-abc-exemplo.json).

# Formato JSON de avaliações corporais

Importe em **Evolução › Corpo › Importar JSON**. Valores são estimativas.

```json
{
  "formato": "irontrack.avaliacoes",
  "versao": 1,
  "avaliacoes": [
    { "data": "2026-10-01", "peso": 80.5, "gordura": 18, "cintura": 84, "abdomen": 88, "braco": 37, "coxa": 58, "observacoes": "em jejum" }
  ]
}
```

Todos os campos, exceto `data` (AAAA-MM-DD), são opcionais. Peso em kg, medidas em cm, gordura em %.

# Backup completo

Gerado em **Configurações › Exportar backup** (`"app": "irontrack", "kind": "backup", "schemaVersion": 3`).
Formatos e versões em [BACKUP_RESTAURACAO.md](BACKUP_RESTAURACAO.md).
Na restauração o arquivo é validado; versões antigas são migradas automaticamente e versões mais novas são recusadas.
Você pode **mesclar** (adiciona só o que não existe, sem duplicar) ou **substituir** tudo (pede confirmação).
