# Bíblia: leitura, versículo do dia, planos e diário espiritual (IronTrack Life, Fase 05)

Contrato: `irontrack.life.bible.v1` (`shared/bible/protocol.ts`). Servidor: `services/api/src/bible/` (texto, serviço e
rotas `/api/v1/bible/*`). App: `src/cloud/bible/`. Só no modo conta (PostgreSQL, por conta). A área é opcional.

## 1. Telas

| Rota | O que tem |
| --- | --- |
| `/biblia` | Passagem do dia, Ler/Continuar, leitura do plano, semana (minutos e capítulos), planos, metas, reflexões recentes, favoritos, atalho para a IA, créditos |
| `/biblia/ler?ref=JHN.3.16&plano=…&dia=…` | Leitor: livro/capítulo, versículos numerados, títulos da própria tradução, anterior/próximo, marcar como lido, progresso no livro, seleção de versículos (favoritar, destacar em 5 cores, nota, copiar e compartilhar com referência e tradução, perguntar à IA), busca "Ir para…", preferências (letra 14–30 px, espaçamento, tema escuro/sépia/claro), cronômetro de leitura e faixa do plano |
| `/biblia/planos`, `/biblia/planos/:id` | Modelos e plano personalizado (prévia), progresso, leitura de hoje, dias concluídos e histórico, pausar/retomar, reorganizar o que falta, excluir |
| `/biblia/diario` | Reflexões, gratidões e anotações privadas: data, passagem, título, etiquetas, favorita; busca sem acento e filtros |
| `/biblia/favoritos` | Favoritos e destaques com texto e etiquetas |
| `/biblia/buscar` | Referência abre o leitor; palavras buscam no texto (servidor) |
| `/biblia/versiculos` | Histórico das passagens do dia |
| `/biblia/progresso` | Capítulos registrados por livro |
| `/biblia/metas` | Metas opcionais, sessões, registro manual |
| `/biblia/ajustes` | Mostrar no Início, modo da passagem do dia, lembretes, silêncio, notificação do navegador, privacidade/IA, ficha da tradução, baixar para offline |

Acesso: cartão "Bíblia" no Início (some com "Mostrar no Início" desligado) e grupo "Bíblia" em Mais.

## 2. Tradução, fonte e licença

| Campo | Valor |
| --- | --- |
| Nome | Bíblia Portuguesa Mundial (BPM), português do Brasil |
| Fonte | eBible.org, id `porbrbsl` — https://ebible.org/porbrbsl/ (USFM `porbrbsl_usfm.zip`) |
| Versão/data | arquivo USFM de 25/04/2026 (verificado em 05/11/2026; página da eBible atualizada em 08/10/2026) |
| Licença | **Domínio público** (página de copyright da eBible.org: sem restrições; atribuição não exigida, mas feita no app) |
| Observação da fonte | "Este é um rascunho de tradução da Bíblia Sagrada e ainda em revisão" — exibido em Ajustes |
| Estrutura | 66 livros (39 AT + 27 NT, ordem protestante), 1.189 capítulos, 31.103 versículos |

Escolha: traduções populares em português (ARA, ARC, NVI, NAA, NTLH, ACF etc.) são protegidas e não foram usadas.
A BLIVRE (CC BY 4.0) também era possível; a BPM foi escolhida por ser domínio público. A BPM publica 15 livros
deuterocanônicos separadamente; o app usa o cânon de 66 livros do pacote USFM e respeita a versificação dele
(ex.: Malaquias 4, Romanos 16:25-27 conforme o texto-base).

Geração: `python3 -I services/api/scripts/build-bible.py <pasta-usfm> 2026-04-25` converte o USFM sem alterar o texto
(remove referências cruzadas e marcações de caractere, mantém títulos `\d`/`\s`, parágrafos e poesia). Versículos sem
texto no texto-base (ex.: Lucas 17:36) ficam marcados como ausentes com a nota da tradução — nunca completados.
Saída: `shared/bible/data/bpm/<LIVRO>.json` (≈4,7 MB) e `index.ts` (metadados, contagens, palavras por capítulo,
SHA-256 do USFM de origem e de cada JSON). Correções só de metadados (nomes de livros que vinham em inglês: Sofonias,
Ageu; abreviações).

Integridade: o servidor (`bible/text.ts`) e o app (`bible/text.ts`) conferem o SHA-256 de cada livro antes de usar;
arquivo alterado não é servido. Teste: `services/api/tests/bible.test.ts`.

Offline: os livros são arquivos próprios (`assets/bible/*.json`), fora do pré-cache do PWA; cada livro aberto vai para
o cache `irontrack-bible-bpm` (CacheFirst) e "Baixar para ler offline" busca todos. A busca por referência funciona
offline; a busca por palavras usa o servidor.

## 3. Dados (migração `0007_bible.sql`)

`bible_prefs` (1 por conta), `bible_marks` (favorito/destaque, único por passagem), `bible_reflections` (id de cliente
único), `bible_plans` (cronograma em jsonb), `bible_plan_days` (dias concluídos), `bible_chapter_logs` (capítulo × data,
origem reader/session/plan/manual/ai), `bible_daily_verses` (histórico da passagem do dia). Sessões, cronômetro e metas
reaproveitam `knowledge_sessions/timers/goals` com `module = 'bible'` (colunas novas `ref`, `plan_id` nas metas; métricas
`chapters`, `plan_finish`). Amplia os CHECKs de `life_xp_events.source` (`bible`) e `assistant_actions.kind` (5 tipos).
Só tabelas/colunas novas: nenhum dado histórico de outros módulos muda.

## 4. Passagem do dia

Seleção editorial (`shared/bible/verses.ts`, ~100 passagens, 13 temas: sabedoria, coragem, gratidão, esperança,
disciplina, perseverança, paz, amor, fé, força, descanso, amizade, trabalho), conferida em teste: referências válidas,
frases completas e contexto curto quando a passagem precisa dele. Escolha determinística por conta e data local
(permutação com semente da conta), gravada em `bible_daily_verses`: a mesma ao recarregar e em outro aparelho. "Outra
passagem": até 10 extras por dia. Modos: uma vez ao dia, ao abrir a área, em intervalos (ao abrir depois de N horas) e
só quando pedir. Nunca pop-up; nenhuma chamada de IA.

## 5. Leitura, sessões e cronômetro

O cronômetro é o da Fase 04 (um por conta, presença, pausas, recuperação, fila offline). "Iniciar leitura" começa no
capítulo aberto; ao encerrar, a pessoa confirma até onde leu e os capítulos do início até lá são registrados
(`source = session`). Capítulo/versículo nunca vira "página". Excluir a sessão estorna o XP e os capítulos.
"Marcar como lido" é idempotente. Datas até 30 dias para trás.

## 6. Planos

Modelos: Conhecendo a Bíblia (30 dias, capítulos-chave), Evangelhos (45), Salmos (30), Provérbios (31), Leitura diária
de 15 min (NT por estimativa de palavras), 30 dias (Lucas e Atos), 90 dias (NT), Bíblia completa (365). Personalizado:
livros ou trecho, em N dias ou N capítulos por dia. O "próximo dia" é o primeiro não concluído (pausas não perdem
nada); "atrasado" é só informativo. Reorganizar redistribui o que falta e mantém os dias concluídos.

## 7. Diário espiritual

Privado por conta; não entra em compartilhamentos nem relatórios; não gera XP.

## 8. XP, metas e conquistas (atributo Espiritualidade)

| Origem | XP | Limites |
| --- | --- | --- |
| Sessão de leitura (cronômetro/manual) | régua da Fase 04 (≥10 min) | `bible` com teto diário próprio de 60 + teto global do RPG |
| Dia do plano concluído | 5 | 2 dias com XP por dia; só hoje/ontem |
| Plano concluído | 40 | só se a leitura ocupou ≥ min(7, dias) datas diferentes |
| Metas | regras da Fase 04 | 0 se vinculada a hábito/missão (quem paga é o hábito/missão) |

Marcar capítulo como lido, favoritos e reflexões não dão XP. Conquistas: primeira leitura bíblica, primeiro plano
concluído, sete dias com leitura, dez capítulos lidos (idempotentes, pelos registros reais).

## 9. IA

Ferramentas (`services/api/src/assistant/tools/bible.ts`). Leitura: `get_bible_passage`, `search_bible`,
`find_bible_passages_by_theme`, `get_bible_verse_of_day`, `get_bible_reading_progress`, `get_bible_plans`,
`get_bible_goals`, `get_bible_favorites`, `get_bible_reflections` (só sob pedido explícito, no máximo 10, pode ser
desligada em Ajustes), `get_bible_stats`. Escrita com prévia → aprovação → desfazer: `propose_create_bible_plan`,
`propose_update_bible_plan`, `propose_create_bible_goal`, `propose_add_bible_favorite`, `propose_save_bible_reflection`;
rotina de leitura via `propose_schedule_knowledge_routine`. Regras no prompt: nunca citar de memória (texto só das
ferramentas, com referência e tradução), separar texto/contexto/interpretações/reflexão, sem teologia única nem
denominação presumida, nunca "mensagem de Deus para você", sem julgamento da vida espiritual.

## 10. Lembretes e notificações

Opcionais (desligados por padrão): passagem do dia, horário de leitura, plano, reflexão; horário, dias, silêncio
(atravessa a meia-noite), fuso do aparelho. Com o app aberto: aviso discreto no app, uma vez por lembrete por dia.
Notificação do navegador/PWA só após ativar em Ajustes (permissão pedida por um toque) e só com o app aberto em
segundo plano. **Com o app fechado não há notificação**: exige Web Push no servidor (chaves VAPID, assinatura por
aparelho, envio agendado), ainda não implementado. Nunca durante treino em andamento ou sessão rodando.

## 11. Limitações e próximos passos

- Uma tradução (BPM). Outras só com licença verificada; deuterocanônicos da BPM podem virar um cânon opcional.
- A BPM é marcada pela fonte como rascunho em revisão; atualizar = rodar o script com o USFM novo e conferir os testes.
- Web Push para lembretes com o app fechado.
- Busca por palavras offline (índice local) e compartilhamento como imagem.
