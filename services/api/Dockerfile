# syntax=docker/dockerfile:1
# Imagem da API do IronTrack para a Railway (Prompt 21). Contexto de build: a RAIZ do repositório (a API usa shared/
# e o adaptador de IA de services/ai-gateway). Node 22.18+ executa TypeScript diretamente (sem etapa de compilação).
FROM node:22.18.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Só as dependências de execução (pg, argon2, zod...). Sem scripts de instalação; o argon2 vem pré-compilado.
COPY package.json package-lock.json ./
# `build_ca` é opcional: CA extra só para builds locais atrás de proxy corporativo (na Railway não existe e é ignorado).
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY shared ./shared
COPY services/ai-gateway/src ./services/ai-gateway/src
COPY services/api/package.json ./services/api/package.json
COPY services/api/config ./services/api/config
COPY services/api/migrations ./services/api/migrations
COPY services/api/scripts ./services/api/scripts
COPY services/api/src ./services/api/src

USER node
# PORT e HOST vêm das variáveis do serviço (.railway/railway.ts: PORT fixa para a referência do irontrack-web, HOST "::"
# para a rede privada IPv4/IPv6). Migrações: comando de pré-implantação, não na inicialização.
CMD ["node", "services/api/src/main.ts"]
