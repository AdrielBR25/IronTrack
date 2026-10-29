# Mapa anatômico (IronTrack 2.0 F01 / P20)

## Taxonomia

Reaproveita os grupos da biblioteca (`LibraryMuscle`, P17). Cada grupo é desenhado como uma ou mais **regiões**
(`MusclePart`, `modules/exercises/demos/muscles.ts`): peitoral, deltoide, bíceps, tríceps, antebraço, trapézio, dorsal,
eretores, reto abdominal, oblíquos, glúteo máximo, glúteo médio, quadríceps, isquiotibiais, adutores e panturrilha.
`corpo_inteiro` não tem região própria: destaca todas as regiões (a legenda diz "Corpo inteiro").

`emphasisFor(primary, secondary)` devolve, por região, `primary`, `secondary` ou neutro. Uma região que é principal e
secundária ao mesmo tempo fica principal.

## Cores

| Papel | Cor | Observação |
| --- | --- | --- |
| Principal | vermelho `#dc2626` | |
| Secundário | laranja `#fb923c` | no 2D também com hachura |
| Demais músculos | neutro `#a3afc0` | |
| Corpo | `#cbd5e1` | |

As cores nunca são a única informação: a legenda em texto lista os grupos principais e secundários.

## Modos

- **3D** (`features/anatomy/Humanoid3D.tsx`): humanoide próprio (ver [ANIMACOES_EXERCICIOS.md](ANIMACOES_EXERCICIOS.md)),
  músculos como elipsoides presos aos segmentos do esqueleto. Girar (arrastar), zoom (pinça/roda), vistas Lado, Frente e
  Costas.
- **2D** (`features/anatomy/MuscleMap2D.tsx`): silhuetas de frente e de costas em SVG com as mesmas regiões. É o
  **fallback** quando não há WebGL, quando o contexto WebGL é perdido, quando o chunk 3D falha ao carregar (limite de
  erro) e também pode ser escolhido pela pessoa no botão de modo.

## Limitações honestas

- Regiões simplificadas (16), sem subdivisões (ex.: cabeças do deltoide, porção clavicular do peitoral).
- Representa a descrição usual do exercício, não medidas de ativação.
- Exercícios personalizados usam os grupos que a pessoa informou.
