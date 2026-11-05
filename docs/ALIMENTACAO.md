# Alimentação — IronTrack Life, Fase 02

Diário alimentar, metas, planejamento, análises e ferramentas da IA central. Só no modo conta (dados no PostgreSQL,
por usuário). Não há reconhecimento por foto nesta fase: existe apenas o contrato de rascunho revisável (§8).

## 1. Telas (rotas)

| Rota | O que faz |
| --- | --- |
| `#/alimentacao` | Dia: anel de kcal × meta, barras de P/C/G, fibras, água (+250 ml), refeições consumidas e planejadas (separadas), "Repetir" por tipo, copiar dia, atalhos da IA, faixa da semana. `?dia=AAAA-MM-DD` abre outro dia; `?registrar=1` abre o editor. |
| `#/alimentacao/planejar` | Semana de refeições planejadas, "Comi", copiar dia, plano × consumido por dia. |
| `#/alimentacao/analise` | Kcal por dia, média semanal, proteína, distribuição de macros, frequência, planejado × consumido, lista de dias. |
| `#/alimentacao/metas` | Objetivo, kcal/macros/água (opcionais), estimativa inicial com premissas, horários, preferências/restrições. |
| `#/alimentacao/alimentos` | Busca no catálogo, favoritos, alimentos do rótulo (próprios), refeições salvas. |

Acesso: cartão "Alimentação" no Início e grupo "Alimentação" em Mais. O editor de refeição (`MealEditor`) é um
bottom sheet: tipo, horário, Comi/Planejar, busca com Recentes/Favoritos/Refeições salvas, quantidade em g/ml com
porções (medidas caseiras marcadas com ≈ são aproximadas), total ao vivo.

## 2. Dados (migração `0004_nutrition.sql`)

- `nutrition_foods`: alimentos próprios (valores por 100 g ou 100 ml, estado de preparo, porção, fonte, arquivado).
- `nutrition_food_favorites`, `nutrition_saved_meals` (itens em JSON, contador de uso).
- `nutrition_meals` (data local, tipo, horário, `planned|consumed`, origem `user|ai|photo|copy|saved`,
  `planned_totals` guardado ao marcar "Comi", `client_id` único por usuário para idempotência, `version`).
- `nutrition_meal_items`: **cópia** do nome e dos valores por 100 no momento do registro. Editar ou arquivar um
  alimento depois não muda refeições antigas.
- `nutrition_goals` (uma linha por usuário, `version`), `nutrition_water` (ml por dia).
- CHECKs ampliados: `life_xp_events.source` + `nutrition`, `life_missions.metric` + `nutrition_days`,
  `assistant_actions.kind` + 7 ações de alimentação.

Catálogo: `services/api/src/nutrition/catalog/taco.json`, gerado por `scripts/build-taco-catalog.py` a partir dos CSV
da TACO 4ª ed. (NEPA/UNICAMP; via projeto MIT raulfdm/taco-api). 591 alimentos com energia; os sem energia na tabela
ficam de fora; macro ausente = `null` (não é zero). Três "modelos genéricos" (leite integral/desnatado UHT, whey)
aparecem com o rótulo "Modelo genérico (não oficial) — confira o rótulo". Referência de alimento:
`taco:N`, `generic:slug`, `custom:uuid`.

Unidades: sem conversão g ↔ ml. Cru, cozido e preparado são estados distintos; alimentos crus de grupos que se comem
cozidos mostram o aviso "Valores do alimento CRU: use o peso antes do preparo".

## 3. Regras do diário

- Só refeições **consumidas** entram no consumo. Planejadas aparecem à parte até "Comi".
- Datas futuras só aceitam planejadas; copiar para o futuro gera planejadas.
- Dias sem registro **não** são consumo zero: médias e gráficos usam só dias com refeições consumidas.
- Idempotência: `clientId` em criar/duplicar/usar refeição salva; repetir o envio devolve a mesma refeição.
- Concorrência: PATCH/consume/unconsume exigem `version` (409 se outra tela mudou antes).

## 4. RPG / XP (servidor decide)

- Diário do dia: `nutrition:day:<data>` = 15 XP com ≥ 2 refeições consumidas com alimentos, só hoje/ontem.
  Caindo abaixo de 2 (excluir/desmarcar), o XP é estornado.
- Se a pessoa tem um hábito ativo com tag `nutrition` agendado no dia, o diário marca **o hábito** (que dá o XP dele)
  e o evento de alimentação vira um registro de 0 XP ligado ao hábito: nunca XP em dobro.
- Água: `nutrition:water:<data>` = 5 XP na primeira anotação do dia.
- Missão semanal automática "Registrar a alimentação em 4 dias" (40 XP, métrica `nutrition_days`) quando há metas
  ou refeição consumida nos últimos 14 dias. Conquista "Uma semana de diário alimentar".
- Tudo passa pelo motor da Fase 01 (teto diário 400 XP, chave única, estorno, dias de descanso). Nada recompensa comer
  menos, atingir peso ou ficar abaixo da meta.

## 5. IA central

Leitura: `get_food_diary`, `list_recent_meals`, `search_foods`, `get_nutrition_goals`, `get_meal_plan`,
`get_nutrition_totals`, `compare_nutrition_goals`.
Escrita (sempre proposta → aprovação → aplicar, com desfazer por 7 dias): `propose_create_meal`,
`propose_add_foods_to_meal`, `propose_update_meal`, `propose_create_food` (só com valores informados pela pessoa),
`propose_update_nutrition_goals` (recusa < 1.200 kcal), `propose_create_meal_plan` (só planejadas, até 14 dias),
`propose_update_meal_plan`. Instruções: planejado ≠ consumido, dia sem registro ≠ zero, não inventar números,
estimativa não é prescrição, respeitar restrições, sem análise de foto.

## 6. API (`/api/v1/nutrition`)

`GET days/:date|hoje`, `GET days?from&to`, `GET meals?from&to&status`, `GET stats?from&to`, `GET quick`,
`GET foods?q|mine=1`, `GET foods/:ref`, `POST foods`, `PATCH foods/:id`, `POST favorites`, `POST meals`,
`PATCH meals/:id`, `POST meals/:id/{consume,unconsume,duplicate}`, `DELETE meals/:id`, `POST days/:date/copy`,
`POST days/:date/water`, `GET|POST saved-meals`, `DELETE saved-meals/:id`, `POST saved-meals/:id/use`,
`GET|PATCH goals`, `POST goals/estimate`, `POST drafts/resolve`. Mutações devolvem `{..., day, outcome}`.

## 7. Estimativa de metas

Mifflin-St Jeor × fator de atividade (1,2/1,375/1,55/1,725). Ganho: +min(300, 10%). Redução: −min(500, 15%), nunca
abaixo do metabolismo basal estimado nem de 1.500 (M) / 1.200 (F) kcal. Proteína 1,6–1,8 g/kg, gordura ≥ 0,6 g/kg e
≥ 25% das kcal, água 35 ml/kg. As premissas aparecem na tela; é ponto de partida, não prescrição.

## 8. Preparação da Fase 03 (foto)

`MealDraft`/`MealDraftItem` (rótulo, alimento sugerido, candidatos, quantidade, confiança, aviso) e
`MEAL_PHOTO_CONTRACT` (`storesPhotos: false`, aviso obrigatório antes de enviar imagem a provedor). `POST
drafts/resolve` transforma descrições em rascunho revisável; o `MealEditor` aceita `draft` para revisão antes de
salvar. Nenhuma imagem é processada ou armazenada nesta fase.

## 9. Testes

`services/api/tests/nutrition.test.ts`, `services/api/tests/assistant-nutrition.test.ts` (OpenAI simulada),
`e2e-cloud/nutrition.spec.ts` (fluxo principal no navegador).
