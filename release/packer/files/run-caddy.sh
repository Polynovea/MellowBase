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
# Optional: where Let's Encrypt sends certificate-expiry warnings. Without it, certificates are still issued.
email="$(value POLYNOVEA_ACME_EMAIL "$ENV_FILE")"
email_option=""
if [ -n "$email" ]; then
  printf '%s' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || {
    echo "run-caddy: POLYNOVEA_ACME_EMAIL is not a valid email address" >&2
    exit 1
  }
  email_option="email $email"
fi
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
  -e "POLYNOVEA_ACME_EMAIL=$email" \
  -e "POLYNOVEA_CADDY_EMAIL_OPTION=$email_option" \
  -v /etc/polynovea/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /var/lib/polynovea-caddy:/data \
  "$image"
