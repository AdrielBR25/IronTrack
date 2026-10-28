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
