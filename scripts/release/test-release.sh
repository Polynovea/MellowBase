#!/usr/bin/env bash
# End-to-end test of scripts/release/build-and-sign.mjs, entirely on this machine. Heavy (image build).
#
#   scripts/release/test-release.sh [--platforms linux/amd64,linux/arm64] [--allow-dirty]
#
# - A throwaway registry (registry:2, pinned by digest) bound to 127.0.0.1 only.
# - A throwaway cosign key pair with a random password, in a temporary folder, deleted afterwards.
# - Build, push, SBOM, sign, attest, release.json, verify: the real script, unchanged.
# - Negative checks: another key does not verify; an unsigned image does not verify; a changed
#   release.json does not verify.
# Removes the registry container, its volume, the keys and its local images at the end.
set -euo pipefail

export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
# Git Bash would rewrite container paths such as /keys into Windows paths; host paths go through
# winpath/mixed below.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
REGISTRY_IMAGE="registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
PORT=35000
NAME=p5w1-registry
IMAGE="localhost:$PORT/polynovea-cms"
COSIGN="$(node -e "import('./scripts/release/build-and-sign.mjs').then(m=>console.log(m.TOOLS.cosign))")"
PLATFORMS=linux/amd64
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --platforms) PLATFORMS="$2"; shift 2 ;;
    --allow-dirty) EXTRA+=(--allow-dirty); shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/p5w1-release.XXXXXX")"
KEYS="$WORK/keys"; OTHER="$WORK/other-keys"; OUT="$WORK/out"
mkdir -p "$KEYS" "$OTHER" "$OUT"
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

BUILDER_EXISTED=0
docker buildx inspect polynovea-release >/dev/null 2>&1 && BUILDER_EXISTED=1
cleanup() {
  # The release builder (and its cache) is removed unless it was already here before the test.
  if [ "$BUILDER_EXISTED" = 0 ]; then
    docker buildx rm polynovea-release >/dev/null 2>&1 || true
    docker rmi -f "$(node -e "import('./scripts/release/build-and-sign.mjs').then(m=>console.log(m.BUILDER.image))")" >/dev/null 2>&1 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME-data" >/dev/null 2>&1 || true
  docker image ls --format '{{.Repository}}:{{.Tag}}' | grep "^localhost:$PORT/" | xargs -r docker rmi -f >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

COSIGN_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
export COSIGN_PASSWORD

echo "== Throwaway registry on 127.0.0.1:$PORT"
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5000" -v "$NAME-data:/var/lib/registry" "$REGISTRY_IMAGE" >/dev/null

echo "== Throwaway key pairs"
docker run --rm -e COSIGN_PASSWORD -v "$(winpath "$KEYS"):/keys" -w /keys "$COSIGN" generate-key-pair >/dev/null
docker run --rm -e COSIGN_PASSWORD -v "$(winpath "$OTHER"):/keys" -w /keys "$COSIGN" generate-key-pair >/dev/null
ls "$KEYS"

echo "== Release"
node scripts/release/build-and-sign.mjs --image "$IMAGE" --version 0.0.0-test.1 --key "$(winpath "$KEYS/cosign.key")" \
  --platforms "$PLATFORMS" --out "$(winpath "$OUT")" "${EXTRA[@]}"

DIGEST="$(node -e "console.log(require(process.argv[1]).digest)" "$(winpath "$OUT/release.json")")"
echo "release.json: $(node -e "const r=require(process.argv[1]);console.log(r.releaseId, r.digest, Object.keys(r.platforms).join(','), 'SBOM packages:', Object.keys(r.sboms).map(a=>a+'='+require(require('path').join(require('path').dirname(process.argv[1]), r.sboms[a].file)).packages.length).join(' '))" "$(winpath "$OUT/release.json")")"

TAGGED="$(docker buildx imagetools inspect "$IMAGE:0.0.0-test.1" --format '{{json .Manifest}}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).digest))")"
if [ "$TAGGED" = "$DIGEST" ]; then echo "ok    the version tag was added after verification and points at the signed digest"; else echo "FAIL: tag points at $TAGGED, signed digest is $DIGEST"; exit 1; fi

echo "== Negative checks"
fails() { if "$@" >/dev/null 2>&1; then echo "FAIL: expected this to fail: $*" >&2; exit 1; fi; }
fails docker run --rm --network host -v "$(winpath "$OTHER"):/keys:ro" "$COSIGN" verify --key /keys/cosign.pub --insecure-ignore-tlog=true "$IMAGE@$DIGEST"
echo "ok    another key does not verify the image"
docker pull -q "$REGISTRY_IMAGE" >/dev/null
docker tag "$REGISTRY_IMAGE" "$IMAGE:unsigned"
docker push -q "$IMAGE:unsigned" >/dev/null
UNSIGNED="$(docker buildx imagetools inspect "$IMAGE:unsigned" --format '{{json .Manifest}}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).digest))")"
fails docker run --rm --network host -v "$(winpath "$OUT"):/out:ro" "$COSIGN" verify --key /out/cosign.pub --insecure-ignore-tlog=true "$IMAGE@$UNSIGNED"
echo "ok    an unsigned image does not verify"
cp "$OUT/release.json" "$WORK/tampered.json"
sed -i 's/"version": "0.0.0-test.1"/"version": "9.9.9"/' "$WORK/tampered.json"
cp "$OUT/release.json.sig" "$WORK/tampered.json.sig"; cp "$OUT/cosign.pub" "$WORK/cosign.pub"
fails docker run --rm -v "$(winpath "$WORK"):/w:ro" "$COSIGN" verify-blob --key /w/cosign.pub --insecure-ignore-tlog=true --signature /w/tampered.json.sig /w/tampered.json
echo "ok    a changed release.json does not verify"

echo "== The VM's start check (release/packer/files/verify-images.sh) with real cosign"
mixed() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
vm_check() { # key-file image-ref
  rm -rf "${WORK:?}/etc" "${WORK:?}/verified"; mkdir -p "$WORK/etc"
  cp "$1" "$WORK/etc/release.pub"
  printf 'POLYNOVEA_IMAGE_REF=%s\n' "$2" > "$WORK/etc/image.env"
  POLYNOVEA_ETC="$(mixed "$WORK/etc")" POLYNOVEA_VERIFIED_DIR="$(mixed "$WORK/verified")" sh release/packer/files/verify-images.sh
}
vm_check "$OUT/cosign.pub" "$IMAGE@$DIGEST" >/dev/null && echo "ok    the signed release passes the VM's start check"
fails vm_check "$OTHER/cosign.pub" "$IMAGE@$DIGEST"
echo "ok    with another key, the VM's start check refuses it"
fails vm_check "$OUT/cosign.pub" "$IMAGE@$UNSIGNED"
echo "ok    an unsigned image fails the VM's start check"

echo "== Key handling"
grep -q "ENCRYPTED SIGSTORE PRIVATE KEY" "$KEYS/cosign.key" && echo "ok    the throwaway private key is password-encrypted"
if grep -rl "PRIVATE KEY" "$OUT" >/dev/null 2>&1; then echo "FAIL: a private key landed in the release folder" >&2; exit 1; fi
echo "ok    no private key in the release output"
echo "== Release signing test passed"
