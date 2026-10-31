#!/bin/sh
# Início do irontrack-web (Prompt 21.1). Confere as variáveis antes de subir o Caddy: sem elas o proxy da API
# apontaria para lugar nenhum. Valores vêm das referências da Railway (ver docs/RAILWAY_FULLSTACK.md).
set -eu

fail() { echo "irontrack-web: $1" >&2; exit 1; }

[ -n "${PORT:-}" ] || fail "PORT não definida (a Railway define sozinha)."
case "$PORT" in *[!0-9]*) fail "PORT inválida." ;; esac

# Endereço privado da API: referência ${{irontrack-api.RAILWAY_PRIVATE_DOMAIN}} e a porta da API (${{irontrack-api.PORT}}).
[ -n "${API_HOST:-}" ] || fail "API_HOST não definida (referência ao domínio privado do irontrack-api)."
[ -n "${API_PORT:-}" ] || fail "API_PORT não definida (referência à PORT do irontrack-api)."
case "$API_PORT" in *[!0-9]*) fail "API_PORT inválida." ;; esac
# Só nomes de host simples (letras, números, ponto e hífen) ou o IP local dos testes: nada de esquema, caminho ou espaço.
case "$API_HOST" in *[!a-zA-Z0-9.-]*) fail "API_HOST inválido: use só o nome do host, sem http:// nem porta." ;; esac

# Proxies confiáveis para o X-Forwarded-For (a borda da Railway). Padrão do guia da Railway para Caddy: todos, porque a
# única entrada pública do serviço é a borda. Ver "IP do cliente" em docs/RAILWAY_FULLSTACK.md.
export TRUSTED_PROXIES="${TRUSTED_PROXIES:-0.0.0.0/0 ::/0}"
case "$TRUSTED_PROXIES" in *[!0-9a-fA-F.:/\ ]*) fail "TRUSTED_PROXIES inválido (só faixas CIDR separadas por espaço)." ;; esac

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
