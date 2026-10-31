#!/usr/bin/env bash
# Teste de integração dos contêineres da Railway (Prompt 21.1): constrói as imagens de produção (services/web e
# services/api), sobe Postgres + API + Caddy (services/web/compose.stack.yml) e roda e2e-stack/ pelo domínio do web.
# Requer Docker com Compose. Opcional: BUILD_CA=/caminho/ca.pem (CA extra para builds atrás de proxy corporativo).
set -euo pipefail
cd "$(dirname "$0")/.."

proxy_args=()
if [ -n "${HTTPS_PROXY:-}" ]; then proxy_args=(--network host --build-arg "HTTPS_PROXY=$HTTPS_PROXY" --build-arg "NO_PROXY=${NO_PROXY:-}"); fi

# Os Dockerfiles do repositório são exatamente os da Railway (sem RUN --mount, que o builder dela recusa). Só para builds
# locais atrás de proxy com CA próprio (BUILD_CA), constrói a partir de uma cópia temporária em que o `npm ci` recebe o
# CA por montagem secreta do BuildKit: o certificado nunca entra na imagem nem no repositório.
build() { # build <Dockerfile> <tag>
  local file="$1"
  if [ -n "${BUILD_CA:-}" ]; then
    file="$(mktemp)"
    sed 's#^RUN npm ci#RUN --mount=type=secret,id=build_ca NODE_EXTRA_CA_CERTS=/run/secrets/build_ca npm ci#' "$1" > "$file"
    DOCKER_BUILDKIT=1 docker build "${proxy_args[@]}" --secret "id=build_ca,src=$BUILD_CA" -f "$file" -t "$2" .
    rm -f "$file"
  else
    docker build "${proxy_args[@]}" -f "$1" -t "$2" .
  fi
}

if [ "${SKIP_BUILD:-}" != "1" ]; then
  build services/api/Dockerfile irontrack-api:stack
  build services/web/Dockerfile irontrack-web:stack
fi

export STACK_RATE_LIMIT_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
compose=(docker compose -f services/web/compose.stack.yml)
cleanup() { "${compose[@]}" logs --no-color api web > test-results-stack.log 2>&1 || true; "${compose[@]}" down -v --remove-orphans > /dev/null 2>&1 || true; }
trap cleanup EXIT

"${compose[@]}" up -d --wait
npx playwright test -c playwright.stack.config.ts "$@"
