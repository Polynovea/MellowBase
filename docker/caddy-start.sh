#!/bin/sh
# Starts Caddy for docker/compose.yaml's "proxy" profile, after checking its two inputs the same way
# release/packer/files/run-caddy.sh does on the VM. Caddy substitutes them into the Caddyfile before
# parsing it, so a value with spaces or braces could otherwise change the configuration.
#
#   caddy-start.sh          validate, then `caddy run`
#   caddy-start.sh adapt    validate, then print the adapted JSON config (tests)
set -eu

domain="${POLYNOVEA_DOMAIN:-}"
if ! printf '%s' "$domain" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
  echo "caddy-start: POLYNOVEA_DOMAIN is missing or not a valid domain name" >&2
  exit 1
fi

email="${POLYNOVEA_ACME_EMAIL:-}"
POLYNOVEA_CADDY_EMAIL_OPTION=""
if [ -n "$email" ]; then
  if ! printf '%s' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
    echo "caddy-start: POLYNOVEA_ACME_EMAIL is not a valid email address" >&2
    exit 1
  fi
  POLYNOVEA_CADDY_EMAIL_OPTION="email $email"
fi
export POLYNOVEA_DOMAIN POLYNOVEA_CADDY_EMAIL_OPTION

if [ "${1:-}" = adapt ]; then
  exec caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile
fi
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
