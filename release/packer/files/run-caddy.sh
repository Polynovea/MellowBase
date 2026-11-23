#!/bin/sh
# Starts Caddy (polynovea-caddy.service) when POLYNOVEA_DOMAIN is set: HTTPS on 443 with a Let's Encrypt
# certificate (HTTP-01 on port 80), forwarding to the CMS on 127.0.0.1:3000.
set -eu

ENV_FILE=/etc/polynovea/polynovea.env
IMAGE_FILE=/etc/polynovea/image.env

value() { # key file
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -1 | tr -d '"'"'"'[:space:]'
}

domain="$(value POLYNOVEA_DOMAIN "$ENV_FILE")"
printf '%s' "$domain" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || {
  echo "run-caddy: POLYNOVEA_DOMAIN is missing or not a valid domain name" >&2
  exit 1
}
image="$(value POLYNOVEA_CADDY_IMAGE_REF "$ENV_FILE")"
[ -n "$image" ] || image="$(value POLYNOVEA_CADDY_IMAGE_REF "$IMAGE_FILE")"
case "$image" in
  *@sha256:*) ;;
  *) echo "run-caddy: the Caddy image must be pinned by digest" >&2; exit 1 ;;
esac

docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
docker rm -f polynovea-caddy >/dev/null 2>&1 || true

exec docker run --rm --name polynovea-caddy \
  --network host \
  --security-opt no-new-privileges:true \
  --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --log-driver journald --log-opt tag=polynovea-caddy \
  -e "POLYNOVEA_DOMAIN=$domain" \
  -v /etc/polynovea/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /var/lib/polynovea-caddy:/data \
  "$image"
