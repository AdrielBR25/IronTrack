# IronTrack — gateway de IA

Servidor mínimo (Node 22.18+, `node:http`, sem dependências) que permite ao assistente do IronTrack usar
OpenAI, Anthropic e Gemini **sem chaves no navegador**. Bloqueado por padrão.

Documentação completa: [docs/IA_GATEWAY.md](../../docs/IA_GATEWAY.md).

```bash
npm run gateway:token -- <titular>     # na raiz do repositório
AI_GATEWAY_CONFIG=services/ai-gateway/config/development.json npm run gateway:dev
npm run test:gateway
```

Nunca versionar `config/*.json` reais, `.env` ou tokens. Não publicar este serviço sem a estratégia de
implantação da seção 14 da documentação.
