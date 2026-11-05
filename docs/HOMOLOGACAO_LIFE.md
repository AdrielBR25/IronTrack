# Checklist de homologação — IronTrack Life (Fases 00 a 06)

Use **antes** de publicar as fases Life. Nada aqui foi executado em produção. Faça num ambiente de homologação
separado (outro projeto/ambiente da Railway com Postgres próprio), nunca no serviço que atende a branch publicada
hoje (`feature/irontrack-2-p21-fullstack-cloud`).

Legenda: ☐ a fazer · cada item diz como verificar.

## 1. Banco e migrações

- ☐ **Backup antes de tudo**: `pg_dump --format=custom --no-owner "$DATABASE_URL" > irontrack-AAAAMMDD.dump`
  (ou snapshot do volume Postgres na Railway). Testar a restauração num banco vazio:
  `pg_restore --no-owner -d "$DB_VAZIO" irontrack-AAAAMMDD.dump` e abrir o app apontando para ele.
- ☐ Migrações em ordem: `0002_assistant` → `0003_life` → `0004_nutrition` → `0005_food_vision` →
  `0006_knowledge` → `0007_bible` → `0008_integration`. Rodam no preDeploy da API; checksums de migrações já
  aplicadas nunca mudam. Conferir `SELECT name, applied_at FROM schema_migrations ORDER BY name;` depois do deploy.
- ☐ Todas são aditivas (tabelas/colunas novas, `CHECK` ampliado). Rodar a sequência sobre uma **cópia** do banco
  atual de produção e conferir que contas, treinos e sincronização continuam abrindo.
- ☐ Rollback: a versão anterior do código ignora as tabelas/colunas novas; voltar o deploy não exige desfazer a
  migração. Se algo der errado com os dados, restaurar o dump.

## 2. Contas e isolamento

- ☐ Duas contas de teste (A e B): o que A cria (agenda, preferências, planos, refeições, leituras) não aparece para B
  nem pela API (`/planner/week`, `/insights/evolution`, `/assistant/memories`) nem pelas respostas da IA.
- ☐ Sem sessão, todas as rotas novas respondem 401.
- ☐ Mesma conta em dois aparelhos: atividade criada no celular aparece no outro após recarregar; edição com versão
  antiga recebe "desatualizado" em vez de sobrescrever.

## 3. Dados antigos

- ☐ Conta antiga (treinos do app local importados): Início abre, Minha Semana mostra fichas planejadas e treinos
  feitos, Minha Evolução mostra treinos e cargas. Nenhum registro é alterado só por abrir as telas.
- ☐ Modo sem conta (local) continua igual (navegação antiga, sem chamadas à API).

## 4. Railway — variáveis (serviço `irontrack-api`)

Obrigatórias: `NODE_ENV=production`, `HOST`, `PORT`, `DATABASE_URL` (referência), `APP_ORIGIN`,
`TRUST_PROXY_HOPS`, `RATE_LIMIT_SECRET`, `OPENAI_API_KEY` (só na API, nunca no web).

Opcionais da IA: `ASSISTANT_CONFIG_JSON`, `ASSISTANT_VISION_MODEL`, `ASSISTANT_VISION_ENABLED`,
`ASSISTANT_ENABLED`, `AI_REQUIRE_VERIFIED_EMAIL`.

- ☐ **E-mail (pendente)**: configurar `EMAIL_PROVIDER=resend`, `EMAIL_FROM` (domínio verificado no Resend) e
  `RESEND_API_KEY`. Sem isso não há confirmação de e-mail nem recuperação de senha.
- ☐ `AI_REQUIRE_VERIFIED_EMAIL=false` é só provisório para homologação. **Não é solução de produção**: depois do
  Resend, remover a variável (padrão = exige e-mail confirmado) para limitar abuso e custo.
- ☐ Serviço `irontrack-web`: `VITE_ACCOUNTS=on` no build e proxy `/api/v1` para a API (já documentado em
  `RAILWAY_FULLSTACK.md`).

## 5. OpenAI (validação real ainda não feita)

Tudo desta fase foi testado só com a OpenAI **simulada**. Antes de liberar:

- ☐ Os IDs `gpt-6.1-terra`, `gpt-6-luna`, `gpt-6.1-sol` aparecem na documentação oficial de modelos
  (developers.openai.com/api/docs/models), mas **acesso da conta não foi verificado**. Em Privacidade do assistente →
  **Testar conexão e modelos** (consulta grátis `GET /v1/models/{id}`): cada modelo deve aparecer como disponível.
  Se algum não estiver, trocar em `ASSISTANT_CONFIG_JSON`.
- ☐ Modelo de visão (`ASSISTANT_VISION_MODEL`, padrão `gpt-6.1-terra`) disponível e aceitando imagem.
- ☐ Limites de custo no painel da OpenAI (orçamento mensal e alerta) + cotas do app em `assistant.json`
  (mensagens/min, mensagens/dia, tokens/dia por conta).
- ☐ Com autorização de gasto, uma rodada curta de perguntas reais (poucos centavos): "Como foi minha última
  semana?", "Organize minha semana de segunda a sexta" (aprovar, conferir na Minha Semana, desfazer), foto de uma
  refeição. Conferir streaming, ferramentas, prévia, aprovação, desfazer e mensagens de erro (modelo indisponível,
  cota estourada).

## 6. Segurança das ferramentas da IA

- ☐ Nenhuma ferramenta de escrita grava sem aprovação (aprovar duas vezes devolve 409).
- ☐ Plano com etapa inválida: cartão mostra "Parcial", só as etapas válidas gravadas, IA não diz que salvou tudo.
- ☐ Planejar não gera XP (conferir XP antes/depois de aprovar um plano).
- ☐ Reflexões espirituais: com a permissão desligada a IA não as lê.

## 7. Desempenho inicial

- ☐ No celular (4G simulado), Início e Minha Semana abrem em menos de ~2 s com uma conta com alguns meses de dados.
  `/planner/week` faz consultas por intervalo de datas (no máximo 14 dias).
- ☐ Bundle principal sem crescimento relevante (telas novas são carregadas sob demanda).

## 8. Bíblia — licença do texto

- ☐ O texto é a Bíblia Portuguesa Mundial (BPM), domínio público, fonte eBible.org `porbrbsl` (USFM de
  25/04/2026). Conferir que os SHA-256 em `shared/bible/data/bpm/index.ts` batem com os JSON empacotados, que a
  página de copyright da eBible continua indicando domínio público e que o aviso de "rascunho em revisão" segue em
  Bíblia → Ajustes (detalhes em `docs/BIBLIA.md` §2).

## 9. Fluxo final de homologação (manual, no celular)

1. Criar conta, confirmar e-mail (com Resend).
2. Início → Personalizar (esconder/reordenar) → conferir em outro aparelho.
3. Minha Semana: criar atividade, ajustar horário, ver conflito, marcar concluída; registrar um treino e ver o item
   do treino virar "Concluído" sozinho pelo registro.
4. IA: pergunta multi-módulo; plano da semana com prévia, desmarcar uma etapa, ajustar horário, aprovar, desfazer.
5. Minha Evolução: semana e mês, comparação, "Sem dados" onde não há registro.
6. Privacidade: confirmar uma preferência inferida, editar, apagar.

Só depois de tudo marcado: abrir PR da fase para a branch de produção e publicar (decisão do Adriel).
