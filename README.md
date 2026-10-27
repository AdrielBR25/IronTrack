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
- **Execução do treino**: exercício atual em destaque, plano × executado, histórico recente, observações, valores pré-preenchidos da última sessão, séries de aquecimento/normal/drop-set, RIR/RPE, editar/desfazer/pular série, séries extras, substituir exercício, recuperação automática se o app fechar.
- **Cronômetro de descanso** por timestamps reais (correto mesmo com a tela bloqueada), ±15/±30 s, pausar, pular, som, vibração e notificação local quando suportados, com aviso visual sempre.
- **Sugestão de progressão** (progressão dupla): ao bater o topo da faixa em todas as séries com RIR/RPE compatível, sugere aumento; nunca aplica sem confirmação.
- **Histórico e gráficos**: carga, 1RM estimado, repetições, volume semanal, frequência, séries por grupo muscular e recordes pessoais.
- **Evolução corporal**: peso, % de gordura (estimado), cintura, abdômen, braço, coxa e fotos opcionais; importação via JSON.
- **Backup** completo em JSON com validação estrutural e de integridade, migração de versão, prévia antes de gravar (adicionados, duplicatas, conflitos e ignorados), mesclar sem sobrescrever ou substituir de forma atômica. Detalhes em [docs/BACKUP_RESTAURACAO.md](docs/BACKUP_RESTAURACAO.md), [docs/INTEGRIDADE_DADOS.md](docs/INTEGRIDADE_DADOS.md) e [docs/MIGRACOES.md](docs/MIGRACOES.md).
- **Perfil local**: identidade estável dos dados neste navegador (sem login nem conta), dono explícito dos registros e backups v2 que registram o perfil. Detalhes em [docs/PERFIL_LOCAL.md](docs/PERFIL_LOCAL.md).

> Os dados ficam só neste navegador/aparelho. Não há sincronização entre dispositivos. Limpar os dados do site no navegador apaga os registros — por isso exporte backups.

## Desenvolvimento

```bash
npm install
npm run dev          # http://localhost:5173/IronTrack/
npm test             # testes unitários (Vitest)
npm run build        # gera dist/
npx playwright test  # testes end-to-end (sobe o preview automaticamente)
```

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
tests/unit/     testes unitários   ·   e2e/   testes Playwright (celular 360 px e desktop)
```

Limites entre camadas e domínios, e as regras que os testes conferem: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

O deploy é feito pelo GitHub Actions (`.github/workflows/deploy.yml`) a cada push no `main`: testes unitários,
build com base `/IronTrack/`, testes E2E e publicação no branch `gh-pages`.
