# Animações de exercícios (IronTrack 2.0 F01 / P20)

## Cobertura real (sem cobertura inventada)

Do catálogo v2 (110 exercícios):

| Estado | Quantidade | O que aparece |
| --- | --- | --- |
| `animado` | 16 | Humanoide 3D executando o movimento, com textos sincronizados às instruções do catálogo |
| `posicao` | 3 | Humanoide 3D parado na posição (isométricos: prancha, wall sit, dead hang) |
| `anatomia` | 91 | Só o mapa muscular (3D parado em pé ou 2D) e o aviso "Sem demonstração animada para este exercício" |

Exercícios personalizados: sempre `anatomia`. O teste `tests/unit/anatomy-demos.test.ts` trava esses números: se uma
demonstração for associada a um exercício errado ou removida, ele falha.

Demonstrações animadas: supino reto (barra e halteres), supino inclinado com halteres, agachamento livre, leg press,
cadeira extensora, mesa flexora, puxada frontal, remada baixa, desenvolvimento com halteres, elevação lateral, rosca
direta, tríceps na polia, stiff, panturrilha em pé e abdominal tradicional.

## Como é feito

- **Modelo próprio** (`irontrack-humanoid-v1`): esqueleto puro em `modules/exercises/demos/rig.ts` (tronco por
  cinemática direta, braços e pernas por IK de dois ossos), desenhado com formas simples (cápsulas e elipsoides) em
  three.js. Nenhum modelo, textura, captura de movimento ou vídeo de terceiros.
- **Demonstração** = sequência de poses-chave (`path`) + ciclo (ida 0–45 %, sustentação, volta 55–100 %) + objetos
  (banco, barra, halteres, polia, máquina) + textos (`cues`) que apontam para os passos de "Como executar".
- Cada demonstração tem `version`; o manifesto (`manifest.ts`) informa estado, modelo, versão e validação.

## Validação ("geometria + inspeção")

1. **Geometria automática** (unitário, cada quadro amostrado): nenhum membro passa do alcance (sem joelho/cotovelo
   "esticado além"), nada abaixo do chão, simetria esquerda/direita, textos cobrindo o ciclo inteiro e apontando para
   instruções existentes, e invariantes por exercício (ex.: no agachamento o quadril desce e os pés não saem do lugar;
   no supino as mãos sobem na vertical; na rosca o cotovelo fica parado).
2. **Inspeção visual**: folha de contato de todas as 19 demonstrações renderizadas em Chromium (três fases por
   exercício), conferida a olho. Problemas achados e corrigidos: encosto do leg press atravessando o tronco, anilhas
   tapando o corpo, músculos pequenos demais.

Limite honesto: é uma demonstração esquemática para lembrar a execução, não uma análise biomecânica validada por
profissional.

## Controles

Reproduzir/pausar, recomeçar, repetir (loop), velocidade 0,5× ou 1×, vista Lado/Frente/Costas, girar e zoom, e alternar
para o mapa 2D. Com "reduzir movimento" do sistema, começa pausado. A animação só roda com a seção visível e a aba em
primeiro plano; o renderizador é descartado (inclusive o contexto WebGL) ao fechar.

## Licenças

| Item | Licença | Uso |
| --- | --- | --- |
| three.js 0.180.0 | MIT | renderização WebGL (chunk sob demanda) |
| @types/three 0.180.0 | MIT | só tipos (desenvolvimento) |
| Humanoide, poses e demonstrações | próprio do projeto | código em `src/modules/exercises/demos` |
| Silhuetas 2D | próprio do projeto | `src/features/body/silhouette.ts` |

Nenhum asset de terceiros (modelo 3D, imagem, vídeo, fonte nova) foi adicionado.
