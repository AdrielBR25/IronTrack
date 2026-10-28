# IronTrack

Aplicativo de musculação para uso pessoal: fichas de treino, rotação ABC contínua, execução de séries com
cronômetro de descanso, histórico, progressão de carga e evolução corporal. É um PWA: instala no Android e
no PC, funciona offline e guarda tudo **somente no seu aparelho** (IndexedDB), sem login e sem servidor.

**App publicado:** https://adrielbr25.github.io/IronTrack/

## Instalar no celular (Android)

1. Abra https://adrielbr25.github.io/IronTrack/ no **Chrome**.
2. Toque no menu **⋮ › Instalar app** (ou **Adicionar à tela inicial**).
3. Abra pelo ícone. Depois do primeiro carregamento ele funciona sem internet.
4. Em **Configurações › Avisos de descanso**, toque em **Permitir** para notificações (opcional) e teste som e vibração.

No PC (Chrome/Edge), use o ícone de instalar na barra de endereço.

## Primeiros passos

1. Na tela inicial, toque em **Usar ficha ABC de exemplo** ou **Importar ficha (JSON)** — formato em [docs/FICHA_JSON.md](docs/FICHA_JSON.md).
2. Ajuste exercícios em **Treinos** (arraste para reordenar, duplique, defina séries, faixas de repetição, descanso e aquecimento).
3. Toque em **INICIAR TREINO**. Para cada série: ajuste peso/repetições com − e +, toque em **CONCLUIR SÉRIE** e o descanso começa sozinho.
4. Ao final, **Finalizar** salva no histórico e avança a rotação.
5. Exporte backups com frequência em **Configurações › Dados e backup**.

## O que tem

- **Rotação contínua A → B → C**, de segunda a sexta (configurável). Continua de onde parou na semana seguinte; só avança ao concluir treino (política configurável), nunca por abrir o app. Pular, marcar descanso, reagendar um dia e corrigir o próximo treino manualmente.
- **Modalidades de exercício**: musculação com carga, peso corporal (só corpo, carga adicional ou assistência), por tempo (prancha, isometria) e cardio (duração e distância em m, km ou milhas), com execução bilateral ou unilateral (lado por série). Exercícios antigos continuam como estavam; nada é classificado por palpite. Detalhes em [docs/MIGRACAO_EXERCICIOS_V3.md](docs/MIGRACAO_EXERCICIOS_V3.md).
- **Execução do treino**: exercício atual em destaque, plano × executado, histórico recente, observações, valores pré-preenchidos da última sessão, séries de aquecimento/normal/drop-set, RIR/RPE, editar/desfazer/pular série, séries extras, substituir exercício, recuperação automática se o app fechar.
- **Cronômetro de descanso** por timestamps reais (correto mesmo com a tela bloqueada), ±15/±30 s, pausar, pular, som, vibração e notificação local quando suportados, com aviso visual sempre.
- **Sugestão de progressão** (progressão dupla): ao bater o topo da faixa em todas as séries com RIR/RPE compatível, sugere aumento; nunca aplica sem confirmação.
- **Histórico e gráficos**: carga, 1RM estimado, repetições, volume semanal, frequência, séries por grupo muscular e recordes pessoais.
- **Análise de desempenho** (Evolução › Análise de desempenho): frequência semanal, volume de carga, séries, evolução por exercício, recordes, tendências explicáveis e insights para 7, 30, 60, 90 dias ou todo o histórico, calculados no aparelho, sem internet e sem IA. Grupos musculares com nomes normalizados, métricas conforme o tipo de exercício (carga externa ou peso corporal), método do 1RM identificado e explicação de cada indicador. Critérios e fórmulas em [docs/ANALYTICS_TREINAMENTO.md](docs/ANALYTICS_TREINAMENTO.md); análises de tempo, cardio, lados e peso corporal para exercícios classificados ([docs/MIGRACAO_EXERCICIOS_V3.md](docs/MIGRACAO_EXERCICIOS_V3.md)).
- **Metas de treinamento** (Evolução › Metas): frequência semanal, quantidade de sessões, carga máxima, repetições, duração, distância e 1RM estimado, ligadas ao exercício da ficha (nunca por nome). Progresso, metas atingidas (com o treino que comprova) e conquistas calculados no aparelho; pausar, arquivar, editar e excluir com confirmação; linha do objetivo nos gráficos da análise. Sem pontuação, ranking ou envio para IA. Detalhes em [docs/METAS_TREINAMENTO.md](docs/METAS_TREINAMENTO.md).
- **Planejamento semanal** (Treinos › calendário, ou Início): escolha a rotina e o treino de cada dia da semana (ou "próximo da rotação"), descanso e dia livre, com exceções só para uma data. A agenda mostra o planejado × o realizado (sessões reais, sem duplicar e no dia em que aconteceram), consistência explicada e metas semanais. Inicia o treino planejado pelo fluxo normal, sem mexer na rotação sem você escolher. Fica só no aparelho, nunca vai para a IA. Detalhes em [docs/PLANEJAMENTO_SEMANAL.md](docs/PLANEJAMENTO_SEMANAL.md).
- **Calendário unificado**: Início, Treinos e Planejamento mostram a mesma agenda. O planejamento tem prioridade; sem ele, os dias de treino das Configurações e os reagendamentos (agenda anterior) aparecem como sugestão; a rotação futura aparece como previsão identificada. Divergências entre as agendas viram avisos (nada é resolvido sozinho). Visões semanal e mensal. Nenhum dado novo é gravado. Detalhes em [docs/CALENDARIO_UNIFICADO.md](docs/CALENDARIO_UNIFICADO.md).
- **Consolidação de agendas**: importe a agenda antiga para o planejamento quando quiser (Planejamento › Importar agenda antiga), sempre com prévia e confirmação, três modos (só dias vazios, revisar conflitos, só visualizar) e desfazer da última importação. A central "Revisar divergências" agrupa e explica os avisos, e as preferências de exibição escolhem a visão inicial (Semana ou Mês) e o que mostrar. A agenda antiga continua guardada. Detalhes em [docs/CONSOLIDACAO_AGENDAS.md](docs/CONSOLIDACAO_AGENDAS.md).
- **Decisões lembradas e desfazer inteligente**: em "Revisar divergências", "Manter planejamento e lembrar" faz o aviso daquele dia não voltar ao reabrir o app — até algo relevante mudar (planejamento, agenda antiga, rotação ou treino do dia), quando ele reaparece sozinho. Vale só para aquela divergência naquele dia, nunca altera treinos e pode ser revista em "Rever decisões anteriores" (voltar a mostrar, remover, limpar as sem efeito). O desfazer da importação mostra item por item o que é seguro e o que foi alterado depois, e permite desfazer só os itens seguros sem sobrescrever suas alterações. Tudo no aparelho, sem IA. Detalhes em [docs/DECISOES_CALENDARIO.md](docs/DECISOES_CALENDARIO.md).
- **Evolução corporal**: peso, % de gordura (estimado), cintura, abdômen, braço, coxa e fotos opcionais; importação via JSON.
- **Backup** completo em JSON com validação estrutural e de integridade, migração de versão, prévia antes de gravar (adicionados, duplicatas, conflitos e ignorados), mesclar sem sobrescrever ou substituir de forma atômica. Detalhes em [docs/BACKUP_RESTAURACAO.md](docs/BACKUP_RESTAURACAO.md), [docs/INTEGRIDADE_DADOS.md](docs/INTEGRIDADE_DADOS.md) e [docs/MIGRACOES.md](docs/MIGRACOES.md).
- **Perfil local**: identidade estável dos dados neste navegador (sem login nem conta), dono explícito dos registros e backups (v2 em diante) que registram o perfil. Detalhes em [docs/PERFIL_LOCAL.md](docs/PERFIL_LOCAL.md).
- **Assistente IA**: por padrão conversa com um provedor **simulado** que roda no aparelho, sem rede e sem chave. Opcionalmente, o **modo remoto** usa OpenAI, Anthropic Claude ou Google Gemini por meio de um **gateway seguro** (chaves só no servidor, token de acesso, limites de uso), com provedor e modelo escolhidos por você. Em qualquer modo, você escolhe quais dados podem ser usados (nenhum vem marcado), revisa na prévia exatamente o que será compartilhado e com qual destino, e autoriza cada pergunta separadamente. A conversa não é guardada. Detalhes em [docs/IA_ARQUITETURA.md](docs/IA_ARQUITETURA.md) e [docs/IA_GATEWAY.md](docs/IA_GATEWAY.md).

> Os dados ficam só neste navegador/aparelho. Não há sincronização entre dispositivos. Limpar os dados do site no navegador apaga os registros — por isso exporte backups.

## Desenvolvimento

```bash
npm install
npm run dev          # http://localhost:5173/IronTrack/
npm test             # testes unitários (Vitest)
npm run build        # gera dist/
npx playwright test  # testes end-to-end (sobe o preview automaticamente)
npm run typecheck    # TypeScript (app, e2e e gateway)
npm run test:gateway # testes do gateway de IA (provedores simulados, sem rede externa)
```

Gateway de IA (opcional, só desenvolvimento local; nunca publicado por este repositório):

```bash
npm run gateway:token -- <titular>   # emite um token de acesso (guarde-o; o servidor fica só com o hash)
AI_GATEWAY_CONFIG=services/ai-gateway/config/development.json npm run gateway:dev
```

Sem configuração válida o gateway sobe bloqueado. Chaves de provedores vão só em variáveis de ambiente do
gateway (nunca `VITE_*`). Passo a passo e riscos em [docs/IA_GATEWAY.md](docs/IA_GATEWAY.md).

Stack: React 18 + TypeScript + Vite, Tailwind CSS + componentes no estilo shadcn/ui (Radix), Lucide, Framer Motion,
Dexie (IndexedDB), Zod, Recharts, vite-plugin-pwa, Vitest e Playwright.

Estrutura:

```
src/modules/    domínios com regras puras: training/ (rotinas, sessões, rotação, progressão, métricas)
                e body/ (avaliações, PDF, evolução corporal)
src/lib/        compartilhado: validação, datas, unidades, perfil, integridade, mesclagem e backup
src/db/         banco Dexie e operações de persistência (por domínio)
src/hooks/      consultas reativas para as telas
src/features/   componentes por funcionalidade (execução do treino, rotinas, corpo, backup)
src/pages/      telas
src/integrations/ai/  raiz de composição do assistente de IA e transporte até o gateway
services/ai-gateway/  gateway de IA opcional (servidor separado, sem dependências)
tests/unit/     testes unitários   ·   e2e/   testes Playwright (celular 360 px e desktop)
```

Limites entre camadas e domínios, e as regras que os testes conferem: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

O deploy é feito pelo GitHub Actions (`.github/workflows/deploy.yml`) a cada push no `main`: testes unitários,
build com base `/IronTrack/`, testes E2E e publicação no branch `gh-pages`.
