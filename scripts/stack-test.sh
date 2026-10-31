#!/usr/bin/env bash
# Teste de integração dos contêineres da Railway (Prompt 21.1): constrói as imagens de produção (services/web e
# services/api), sobe Postgres + API + Caddy (services/web/compose.stack.yml) e roda e2e-stack/ pelo domínio do web.
# Requer Docker com Compose. Opcional: BUILD_CA=/caminho/ca.pem (CA extra para builds atrás de proxy corporativo).
set -euo pipefail
cd "$(dirname "$0")/.."

secret_args=()
if [ -n "${BUILD_CA:-}" ]; then secret_args=(--secret "id=build_ca,src=$BUILD_CA"); fi
proxy_args=()
if [ -n "${HTTPS_PROXY:-}" ]; then proxy_args=(--network host --build-arg "HTTPS_PROXY=$HTTPS_PROXY" --build-arg "NO_PROXY=${NO_PROXY:-}"); fi

if [ "${SKIP_BUILD:-}" != "1" ]; then
  docker build "${proxy_args[@]}" "${secret_args[@]}" -f services/api/Dockerfile -t irontrack-api:stack .
  docker build "${proxy_args[@]}" "${secret_args[@]}" -f services/web/Dockerfile -t irontrack-web:stack .
fi

export STACK_RATE_LIMIT_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
compose=(docker compose -f services/web/compose.stack.yml)
cleanup() { "${compose[@]}" logs --no-color api web > test-results-stack.log 2>&1 || true; "${compose[@]}" down -v --remove-orphans > /dev/null 2>&1 || true; }
trap cleanup EXIT

"${compose[@]}" up -d --wait
npx playwright test -c playwright.stack.config.ts "$@"
