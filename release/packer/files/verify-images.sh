#!/bin/sh
# Checks the images before every start (ExecStartPre of polynovea.service and polynovea-caddy.service),
# on a VM made from our image and on the templates' plain-Ubuntu bootstrap alike. Any failure exits
# non-zero, so systemd does not start the unit (fail closed).
#
#   verify-images.sh        the CMS image: pinned by digest AND signed with the Polynovea release key
#   verify-images.sh caddy  the Caddy image: pinned by digest (it is Caddy's own image, not signed by us)
#
# Trust material is local and fixed: the release public key installed by provision.sh at
# /etc/polynovea/release.pub, and cosign's own image pinned by digest. The signature itself is read
# from the image's own (pinned) registry; nothing else is fetched. A digest that verified once with
# this exact key is remembered (/var/lib/polynovea-verified), so a restart while the registry is
# unreachable still starts the image it already checked, and never a different one.
#
# Environment (tests only): POLYNOVEA_ETC (default /etc/polynovea), POLYNOVEA_VERIFIED_DIR
# (default /var/lib/polynovea-verified).
set -eu

ETC="${POLYNOVEA_ETC:-/etc/polynovea}"
ENV_FILE="$ETC/polynovea.env"
IMAGE_FILE="$ETC/image.env"
PUBKEY="$ETC/release.pub"
VERIFIED_DIR="${POLYNOVEA_VERIFIED_DIR:-/var/lib/polynovea-verified}"
COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v2.6.1@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037"
PINNED='^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$'

fail() { echo "verify-images: $*" >&2; exit 1; }

value() { # key file
  [ -f "$2" ] || return 0
  sed -n "s/^$1=//p" "$2" | tail -1 | tr -d '"'"'"'[:space:]'
}

image_ref() { # key
  ref="$(value "$1" "$ENV_FILE")"
  [ -n "$ref" ] || ref="$(value "$1" "$IMAGE_FILE")"
  printf '%s' "$ref" | grep -Eq "$PINNED" || fail "$1 is missing or not pinned by digest (name@sha256:<64 hex>)"
  printf '%s' "$ref"
}

# Present locally under exactly this digest (a pull by digest checks the content against it).
ensure_local() { # ref
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null || fail "could not pull $1"
}

case "${1:-cms}" in
  caddy)
    ref="$(image_ref POLYNOVEA_CADDY_IMAGE_REF)"
    ensure_local "$ref"
    echo "verify-images: Caddy image pinned: $ref"
    exit 0
    ;;
  cms) ;;
  *) fail "usage: verify-images.sh [cms|caddy]" ;;
esac

ref="$(image_ref POLYNOVEA_IMAGE_REF)"
if ! grep -q "BEGIN PUBLIC KEY" "$PUBKEY" 2>/dev/null; then fail "no release public key at $PUBKEY; refusing to start an unverified image"; fi
key_sum="$(sha256sum "$PUBKEY" | cut -c1-64)"
digest="${ref##*@sha256:}"
marker="$VERIFIED_DIR/$digest.$key_sum"

ensure_local "$ref"
if [ -f "$marker" ]; then
  echo "verify-images: $ref already verified with this release key"
  exit 0
fi

docker image inspect "$COSIGN_IMAGE" >/dev/null 2>&1 || docker pull -q "$COSIGN_IMAGE" >/dev/null || fail "could not pull the pinned cosign image"
errors="$(mktemp)"
if ! docker run --rm --network host -v "$PUBKEY:/release.pub:ro" "$COSIGN_IMAGE" \
  verify --key /release.pub --insecure-ignore-tlog=true "$ref" >/dev/null 2>"$errors"; then
  tail -5 "$errors" >&2 || true
  rm -f "$errors"
  fail "the signature of $ref does not verify with the Polynovea release key; not starting it"
fi
rm -f "$errors"

umask 077
mkdir -p "$VERIFIED_DIR"
: >"$marker"
echo "verify-images: $ref signature verified"
