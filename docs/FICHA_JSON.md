# Formato JSON da ficha de treino

O IronTrack importa e exporta fichas (rotinas) neste formato. A validação é feita com Zod
(`src/lib/routineSchema.ts`) e os erros apontam o treino e o exercício com problema, por exemplo:

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
| `versao` | número inteiro; hoje só existe a versão `1` |
| `treinos` | 1 a 10 treinos; a ordem define a rotação (A → B → C → A…) |
| `repeticoes` | número fixo ou faixa com mínimo ≤ máximo (1–100) |
| `carga` | sempre a **carga total externa** do exercício: barra + anilhas, soma dos dois halteres, carga da máquina |

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

Gerado em **Configurações › Exportar backup** (`"app": "irontrack", "kind": "backup", "schemaVersion": 1`).
Na restauração o arquivo é validado; versões antigas são migradas automaticamente e versões mais novas são recusadas.
Você pode **mesclar** (adiciona só o que não existe, sem duplicar) ou **substituir** tudo (pede confirmação).
