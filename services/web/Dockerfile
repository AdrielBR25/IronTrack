# Serviço irontrack-web da Railway (Prompt 21.1): compila o app (React/Vite/PWA) e serve `dist` com o Caddy, que também
# repassa /api/v1/* para o serviço irontrack-api pela rede privada (mesma origem: cookie de sessão e CSRF funcionam).
# Contexto de build: a RAIZ do repositório. Nada secreto entra na imagem: o app só conhece a própria origem.

# ---- 1. build do app
FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app
ENV BASE_PATH=/ VITE_ACCOUNTS=on
COPY package.json package-lock.json ./
# Instalação determinística pelo package-lock.json. Sem RUN --mount: o builder da Railway só aceita montagens de cache.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.ts tailwind.config.js postcss.config.js tsconfig.json tsconfig.app.json tsconfig.node.json ./
# tsconfig.json da raiz referencia os dos serviços (o esbuild lê a cadeia); só os arquivos de configuração.
COPY services/ai-gateway/tsconfig.json ./services/ai-gateway/tsconfig.json
COPY services/api/tsconfig.json ./services/api/tsconfig.json
COPY public ./public
COPY shared ./shared
COPY src ./src
# Tipos conferidos no CI (`tsc -b`); aqui só o build de produção.
RUN npx vite build

# ---- 2. servidor estático + proxy
FROM caddy:2.10.2-alpine
COPY services/web/Caddyfile /etc/caddy/Caddyfile
COPY services/web/entrypoint.sh /usr/local/bin/irontrack-web
COPY --from=build /app/dist /srv
RUN chmod 0555 /usr/local/bin/irontrack-web
# Sem root: a Railway entrega a porta em PORT (acima de 1024); o Caddy não precisa de TLS (a borda da Railway termina o HTTPS).
USER nobody
ENV XDG_CONFIG_HOME=/tmp/caddy XDG_DATA_HOME=/tmp/caddy
ENTRYPOINT ["/usr/local/bin/irontrack-web"]
