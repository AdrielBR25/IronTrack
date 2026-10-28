# Desempenho por exercício

IronTrack 2.0 · Fase 01 · Prompt 19. Área `#/desempenho` e detalhe `#/desempenho/exercicio/:identidade`.
Motor puro em `src/modules/performance` (sem React, sem Dexie, sem rede, sem IA), hook `src/hooks/usePerformance.ts`,
interface em `src/pages/PerformancePage.tsx`, `src/pages/ExercisePerformancePage.tsx` e `src/features/performance/`.
Testes em `tests/unit/performance-domain.test.ts`, `tests/unit/performance-ui.test.tsx` e `e2e/performance.spec.ts`.

A área responde, só com dados locais: estou levantando mais carga? fazendo mais repetições? meu volume subiu? estou
sustentando mais tempo? percorrendo mais distância? qual foi meu melhor desempenho? como a sessão atual se compara à
anterior? em quais exercícios houve evolução e quais ficaram estáveis?

A análise geral do P08/P09 (`#/evolucao/desempenho`, agrupada por nome) **não mudou**: os dois se ligam por links.

## 1. Identidades

O IronTrack tem quatro identidades de exercício: item do catálogo (`catalogId`), exercício personalizado
(`customExerciseId`), instância da ficha (`ExerciseTemplate.id`) e a cópia executada na sessão (snapshot). O desempenho
usa um resolvedor próprio (`identity.ts › resolveIdentity`), que lê **só o que a sessão registrou**:

| Nível | Chave | Quando | Observação |
| ----- | ----- | ------ | ---------- |
| Instância da ficha | `i:<templateId>` | a cópia tem `templateId` e **não** foi trocada no treino | mesma identidade das metas (P12) |
| Histórico sem vínculo | `h:<hash>` | sem `templateId` (sessões antigas) ou trocado durante o treino (`substitutedFrom`) | agrupado só dentro do mesmo treino da mesma rotina, com mesmo nome normalizado, equipamento e família de medida; sem rotina/treino/nome, fica isolado na própria sessão |
| Visão agregada (catálogo) | `c:<catalogId>` | a cópia registrou `catalogId` no momento do treino | rotulada "Visão agregada de instâncias vinculadas a este exercício." |
| Visão agregada (meu exercício) | `p:<customExerciseId>` | idem com `customExerciseId` | idem |

Regras garantidas (testadas): nada é agrupado só pelo nome; nenhuma sessão recebe origem retroativa (o vínculo feito
depois na ficha, P18, não reclassifica sessões antigas: só aparece na visão agregada a sessão que registrou a origem);
nenhum snapshot é alterado; instâncias diferentes nunca são unidas automaticamente; exercício trocado durante o treino
não conta para a instância original (mesma regra das metas); metas não são redirecionadas; o agrupamento do analytics
não muda.

A chave do histórico é um hash FNV‑1a de 64 bits sobre os componentes, para a rota não carregar o nome. IDs com
caracteres fora de `[A-Za-z0-9._~-]` não viram identidade de instância (caem no histórico). A rota usa a chave
codificada (`/desempenho/exercicio/i%3A<id>`); chaves fora do formato mostram "Endereço de exercício inválido".

## 2. Fontes de dados

Somente sessões `completed`, com `startedAt` válido e do perfil atual (sem dono = legado do perfil principal). Planejadas,
em andamento e descartadas nunca contam. A data é a data local de `startedAt` (mesma regra do analytics), nunca
`updatedAt`. As séries pendentes não foram executadas e não aparecem.

## 3. Métricas e séries

Cada série executada é classificada (`classifySets`): `trabalho`, `drop`, `aquecimento`, `incompleta` (concluída sem a
medida exigida pela família, ou com carga adicional e assistência ao mesmo tempo) e `pulada`. Só `trabalho` e `drop`
entram nas medidas. A ordem das séries normais (1, 2, 3…) conta também incompletas e puladas, para não deslocar a
comparação; em unilaterais, por lado.

Família de medida (`measureFamilyOf`): pela modalidade gravada; sem ela, equipamento "peso corporal" = peso corporal e o
resto = musculação (como no analytics P09).

| Família | Medidas por sessão |
| ------- | ------------------ |
| Musculação | carga máxima (com repetições), mais repetições numa série (com a carga), repetições totais, volume, 1RM |
| Peso corporal | repetições só com o corpo, carga adicional, menor assistência, duração (se registrada) |
| Tempo | maior duração, duração total |
| Cardio | distância e duração somadas; ritmo só com duração e distância nas mesmas séries |

Valores ausentes ficam ausentes (nunca zero). Cópias da mesma identidade na mesma sessão são somadas (`copies`).

## 4. Recordes

Recalculados das sessões a cada leitura (`records.ts`), nunca gravados. Por família: musculação (maior carga, mais
repetições numa série, maior volume da sessão, melhor 1RM), peso corporal (mais repetições só com o corpo, maior carga
adicional, **menor** assistência, maior duração), tempo (maior duração sustentada), cardio (maior distância, maior
duração, melhor ritmo **por faixa de distância**: até 1 km, 1–3, 3–5, 5–10, 10–21,1 e acima de 21,1 km).

- Aquecimento, incompletas e puladas nunca entram.
- Empate não renova o recorde: fica a primeira data e o empate é listado ("igualado em…", sem contar como recorde novo).
- "Recorde novo" (evento, usado nos recordes recentes e na contagem do período) só depois de
  `MIN_PRIOR_SESSIONS_FOR_RECORD` (2) sessões anteriores com a mesma medida, a mesma regra do analytics P08. A primeira
  sessão é só a primeira marca.
- Mais assistência nunca é recorde; duração maior de cardio aparece como marca, mas não como evolução.
- Sessões de outra família (modalidade alterada) não entram.

## 5. Gráficos

`series.ts › buildSeries`: um ponto por sessão, na data real, só quando a medida existe. Eixo X temporal (`scale=time`).
Pausas acima de `CHART_GAP_DAYS` (28 dias, o mesmo limiar de pausa longa do P09) interrompem a linha e aparecem como
área cinza "pausa". Unidade na legenda; resumo textual (quantidade, período, menor, maior, última, pausas); navegação
por teclado (setas, Home, End, Esc) com anúncio `aria-live`; tabela "Ver dados em tabela". Métricas por família:
musculação (carga, repetições, volume, 1RM), peso corporal (repetições, carga adicional, assistência, duração), tempo
(duração), cardio (distância, duração, ritmo). Só aparecem no seletor as métricas com pelo menos um ponto.

Sem dependência nova: Recharts, que o app já usa.

## 6. Comparação de sessões

`compare.ts › compareSessions`: o usuário escolhe as duas sessões (padrão: a mais recente e a anterior; pelo histórico,
a sessão aberta). A ordem é sempre cronológica (diferença = comparada − anterior). Diferenças absolutas sempre que os
dois valores existem; percentuais só com base positiva e nunca em contagens. Dados ausentes aparecem como "dado
ausente".

Condições não equivalentes (`issues`): família diferente, tipo de carga diferente, lateralidade diferente, instâncias
diferentes numa visão agregada, mesma sessão. Com qualquer uma delas o resumo diz que as diferenças são só registro.
Distâncias em faixas diferentes bloqueiam só o ritmo. Com condições equivalentes, o resumo descreve sem exagero
("Carga máxima maior… com repetições iguais ou maiores", "Mesma carga máxima, com mais repetições").

## 7. Comparação entre séries

`compareSets`: só séries normais, pela ordem (e pelo lado em unilaterais). Estados: `comparavel`, `incompleta`
(incompleta ou pulada em uma das sessões), `ausente_a`/`ausente_b` (sem correspondente; nunca zero). Aquecimentos e drops
ficam fora e são contados. Sem comparação série a série em cardio (sessão inteira), com família diferente, sem séries
normais ou em unilateral sem lado registrado em todas as séries. A interface lembra que a posição não garante a mesma
finalidade.

## 8. Modalidades

Ver §3–4. Cardio não tem volume nem 1RM; peso corporal não mistura assistência com carga; tempo usa a maior duração
sustentada; ritmo só entre distâncias semelhantes; velocidade/duração maiores não são tratadas como melhora universal.

## 9. 1RM

Usa **só** o contrato canônico `epley-1a12-v1` do P09 (`canonicalE1rm`): 1 repetição = carga real ("direta"), 2 a 12 =
Epley, acima de 12 = sem estimativa; só musculação. O método é exibido no gráfico e nos recordes, e a estimativa nunca é
apresentada como teste real.

Fórmulas legadas **inalteradas** (teste garante): gráfico antigo da aba Treino (Epley para qualquer repetição, inclusive
1 → ×1,033) e recordes antigos (`estimate1RM`, sem teto). O aviso de recordes no detalhe da sessão do histórico
(`sessionPRs`) continua usando a fórmula antiga e a identidade por nome; por isso pode divergir dos recordes desta área.
A migração dessas telas continua pendente de aprovação (proposta em `ANALYTICS_TREINAMENTO.md` §4).

## 10. Tendências e observações

`insights.ts`, determinístico, cada texto com o critério e as sessões de origem:

- Comparações recentes: sessão mais recente contra até 3 anteriores comparáveis do período (`RECENT_WINDOW`):
  "Sua carga máxima registrada aumentou…", "Você manteve a mesma carga e registrou mais repetições.", volume maior com o
  mesmo número de séries, mais repetições só com o corpo, carga adicional maior, mais tempo sustentado, distância maior,
  ritmo mais rápido na mesma faixa. Essas formam "Sua evolução recente".
- Tendência: `computeTrend` do analytics (médias das metades contra o maior entre o limiar da métrica e 2 erros‑padrão;
  mínimo 4 sessões em 14 dias). Métrica principal: 1RM ou carga (musculação), repetições só com o corpo (peso corporal),
  duração (tempo), distância ou ritmo como velocidade, na faixa mais recente (cardio). Resultados: "A média das sessões
  mais recentes ficou acima…", "Os registros mais recentes ficaram abaixo…" (neutro), "Os registros recentes apresentam
  variação." (limiar elevado pelo ruído), "Desempenho estável no período." ou "Ainda não há sessões suficientes para
  avaliar uma tendência.".
- Sessões com outra modalidade: aviso de que não foram comparadas.

Sem IA remota, sem gateway, sem diagnóstico.

## 11. Estabilidade

Opcional e ocultável (interruptor na área e no detalhe; estado só na tela, sem gravação). Critério: pelo menos
`STABILITY_MIN_SESSIONS` (4) sessões comparáveis cobrindo `STABILITY_MIN_SPAN_DAYS` (21) dias dentro do período,
tendência "estável" e nenhum recorde novo no período. Estados distintos: estável, variando, sem registros (ausência não é
estabilidade nem regressão), poucas sessões, incompatível (só sessões de outra modalidade). Texto sempre "Desempenho
estável no período", nunca alerta.

## 12. Sugestões locais

Conservadoras, opcionais, com o motivo e o aviso "Sugestões locais e opcionais… não são prescrição profissional e nada é
alterado na sua ficha.":

- Progressão gradual: nas 3 sessões comparáveis mais recentes, todas as séries de trabalho com a mesma carga chegaram ao
  topo da faixa planejada, sem incompletas ou puladas → "Se a execução estiver confortável e consistente, avalie uma
  progressão gradual com orientação adequada." (sem número de carga).
- Estável (musculação/peso corporal) → "Você pode revisar sua meta de repetições."
- Variação ou valores abaixo do início → "Considere comparar suas últimas sessões antes de alterar a carga."

Nunca aumenta carga, altera fichas, calcula carga obrigatória ou interpreta fadiga/lesão.

## 13. Integração com a biblioteca

No detalhe do exercício da biblioteca, seção "Desempenho" com "Ver evolução", "Ver recordes" e "Ver sessões", que abrem a
visão agregada (`c:`/`p:`) com a seção correspondente. Sem treino concluído com essa origem, estado vazio claro
("Treinos antigos não são associados automaticamente."). Nada é associado.

## 14. Integração com o histórico

Botão "Desempenho" no topo do Histórico e, no detalhe da sessão, "Ver desempenho deste exercício" em cada exercício
executado, abrindo a identidade daquela cópia (instância ou histórico sem vínculo) com a sessão pré-selecionada na
comparação. A sessão não é alterada. Também há acesso por Treinos, Evolução e pela análise geral.

## 15. Integração com metas

O detalhe mostra "Metas relacionadas" (componente do P12), só leitura: metas não arquivadas cujos `templateIds` incluem a
instância (ou, na visão agregada, as instâncias que a compõem). Nenhuma meta é criada, alterada, redirecionada ou tem
critério/evidência modificados.

## 16. Persistência

Nenhuma tabela nova, nenhum campo novo, Dexie continua **v6**. Tudo é derivado. Período fica na URL (`?periodo=`),
seção em `?ver=`, sessão em `?sessao=`; nada em `localStorage` (a lista `AUX_STORAGE_KEYS` do E2E não mudou).

## 17. Backup

Sem dados novos: o backup continua **v7**, sem mudança de formato, importação, mesclagem, substituição, rollback ou
remapeamento. Teste: exportar → apagar sessões → restaurar gera o mesmo índice e os mesmos recordes.

## 18. Concorrência

`usePerformanceIndex` observa as sessões com `useLiveQuery` do Dexie (inclui gravações de outras abas) e recalcula o índice
inteiro a partir do estado atual: sem duplicar, sem estado intermediário. Treino concluído, sessão excluída, backup
restaurado ou troca de perfil aparecem sozinhos. No detalhe, a comparação volta para um par válido se uma sessão sumir;
identidade sem sessões mostra o estado vazio.

## 19. Performance

Uma consulta ao IndexedDB por mudança (nunca por série). `buildPerformanceIndex` é O(séries) e indexa por chave de
identidade; períodos, gráficos e comparações reaproveitam o índice e são memorizados (`useMemo`). Teste: 2.000 sessões ×
8 exercícios em menos de 3 s no ambiente de teste. Telas carregadas sob demanda (`PerformancePage` ≈ 9 kB,
`ExercisePerformancePage` ≈ 31 kB); o pacote principal cresceu ≈ 0,8 kB (rotas).

## 20. UX e acessibilidade

Prioridade na área: período → resumo (4 indicadores) → evolução recente → recordes recentes → exercícios acompanhados →
visões agregadas → estabilidade. No detalhe: evolução → recordes → observações e sugestões → comparação → sessões → metas
→ identidade analisada. Rótulos curtos no seletor de período e de métrica com nome completo para leitores de tela; alvos
de 44 px; sem rolagem horizontal em 360 px (E2E); foco visível; tabelas com `caption` e `scope`.

## 21. Privacidade

Tudo local. O módulo e as telas não usam rede, armazenamento do navegador, IA, gateway nem `ContextBuilder` (teste
dedicado + regras de arquitetura). Sem rastreamento, sincronização ou login.

## 22. Testes e limitações

Testes: 43 unitários do motor (identidade, separação de instâncias, antigos, concluídas, séries, aquecimento, recordes,
empates, carga, repetições, volume, 1RM, cardio, ritmo, distância, duração, unilateral, assistência, comparações,
filtros, tendências, estabilidade, dados insuficientes, histórico grande), 14 de interface/integração (resumo, filtros,
detalhe, teclado, comparação, antigos, metas, histórico, backup v7, concorrência, analytics legado, privacidade) e 2 E2E
por projeto (Android 360 px e desktop) cobrindo os 28 passos pedidos.

Limitações:
- Exercícios antigos sem `templateId` só se agrupam dentro do mesmo treino/rotina/nome/equipamento; não há ainda
  associação manual de históricos (seria uma fase futura, sem alterar registros).
- Limiares de tendência e estabilidade herdados do P08, ainda não calibrados com dados reais.
- O aviso de recordes do detalhe da sessão e o gráfico antigo continuam com as fórmulas legadas (decisão pendente).
- Faixas de ritmo fixas; ritmo exibido em min/km mesmo quando a distância é registrada em milhas.
- Em visão agregada, cópias de famílias diferentes na mesma sessão não são somadas (vale a primeira).
