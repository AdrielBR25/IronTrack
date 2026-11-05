#!/usr/bin/env bash
# Fase 07 — prepara uma cópia SOMENTE LEITURA do código de produção (git worktree, sem push) e roda upgrade-check.ts.
# Uso: TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres scripts/homologacao/upgrade-check.sh [ref]
# ref padrão: origin/feature/irontrack-2-p21-fullstack-cloud (branch publicada na Railway).
set -euo pipefail
REF="${1:-origin/feature/irontrack-2-p21-fullstack-cloud}"
ROOT="$(git rev-parse --show-toplevel)"
OLD="$(mktemp -d)/irontrack-prod"
git -C "$ROOT" fetch --quiet origin "${REF#origin/}" || true
git -C "$ROOT" worktree add --detach --quiet "$OLD" "$REF"
trap 'git -C "$ROOT" worktree remove --force "$OLD" >/dev/null 2>&1 || true' EXIT
ln -s "$ROOT/node_modules" "$OLD/node_modules"
echo "código antigo: $REF ($(git -C "$OLD" rev-parse --short HEAD))"
OLD_API_DIR="$OLD" node "$ROOT/scripts/homologacao/upgrade-check.ts"
