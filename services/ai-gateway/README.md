# IronTrack — gateway de IA

Servidor mínimo (Node 22.18+, `node:http`, sem dependências) que permite ao assistente do IronTrack usar
OpenAI, Anthropic e Gemini **sem chaves no navegador**. Bloqueado por padrão.

Documentação completa: [docs/IA_GATEWAY.md](../../docs/IA_GATEWAY.md). Segurança operacional, rotação de
credenciais e homologação: [docs/IA_HOMOLOGACAO.md](../../docs/IA_HOMOLOGACAO.md).

```bash
CFG=services/ai-gateway/config/development.json     # na raiz do repositório
npm run gateway:token -- issue <titular> --expires-in 90d --config $CFG   # token mostrado UMA vez
npm run gateway:token -- rotate <keyId> --grace 30m --config $CFG
npm run gateway:token -- revoke <keyId> --config $CFG                     # vale no próximo recarregamento
AI_GATEWAY_CONFIG=$CFG npm run gateway:dev           # SIGHUP recarrega; SIGTERM encerra com graça; SIGUSR2 métricas
npm run test:gateway
# Homologação real (manual, travada, uma chamada paga por provedor):
# AI_GATEWAY_HOMOLOGATION=1 npm run gateway:homologate -- --provider <id> --model <id> --confirm-paid-call
```

Uma única instância (limites em memória). Nunca rode mais de uma réplica sem um `UsageStore` compartilhado.

Nunca versionar `config/*.json` reais, `.env` ou tokens. Não publicar este serviço sem a estratégia de
implantação da seção 14 da documentação.
