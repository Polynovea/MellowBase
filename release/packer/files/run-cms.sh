#!/bin/sh
# Starts the Polynovea CMS container (polynovea.service). The single source of the `docker run` line;
# docs/self-hosting/vm-images.md quotes it.
#
# Host networking: the CMS listens on 127.0.0.1:3000 of the VM itself, so the setup wizard's SSH-tunnel
# route works, and Caddy (polynovea-caddy.service, when POLYNOVEA_DOMAIN is set) reaches it from
# 127.0.0.1 as a trusted proxy.
set -eu

ENV_FILE=/etc/polynovea/polynovea.env
IMAGE_FILE=/etc/polynovea/image.env

value() { # key file
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -1 | tr -d '"'"'"'[:space:]'
}

image="$(value POLYNOVEA_IMAGE_REF "$ENV_FILE")"
[ -n "$image" ] || image="$(value POLYNOVEA_IMAGE_REF "$IMAGE_FILE")"
case "$image" in
  *@sha256:*) ;;
  *) echo "run-cms: POLYNOVEA_IMAGE_REF must be pinned by digest (name@sha256:...)" >&2; exit 1 ;;
esac

domain="$(value POLYNOVEA_DOMAIN "$ENV_FILE")"
if [ -n "$domain" ] && ! printf '%s' "$domain" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
  echo "run-cms: POLYNOVEA_DOMAIN is not a valid domain name" >&2
  exit 1
fi

docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
docker rm -f polynovea >/dev/null 2>&1 || true

set --
[ -f "$ENV_FILE" ] && set -- "$@" --env-file "$ENV_FILE"
# These win over anything in the env file: the CMS must listen on loopback only.
set -- "$@" -e HOSTNAME=127.0.0.1 -e PORT=3000
if [ -n "$domain" ]; then
  set -- "$@" -e "POLYNOVEA_PUBLIC_URL=https://$domain" -e POLYNOVEA_TRUSTED_PROXIES=127.0.0.1
fi
# Read-only for the CMS: the release key (it verifies release.json before offering an upgrade) and the
# upgrade agent's root-owned status folder (the CMS copies its steps into the audit log).
[ -f /etc/polynovea/release.pub ] && set -- "$@" -v /etc/polynovea/release.pub:/etc/polynovea/release.pub:ro
[ -d /var/lib/polynovea-upgrade ] && set -- "$@" -v /var/lib/polynovea-upgrade:/var/lib/polynovea-upgrade:ro

exec docker run --rm --name polynovea \
  --network host \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --stop-timeout 90 \
  --log-driver journald --log-opt tag=polynovea \
  -v /var/lib/polynovea:/var/lib/polynovea \
  "$@" \
  "$image"
