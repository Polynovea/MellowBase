#!/usr/bin/env bash
# Builds the server image and checks it end to end on this machine. Heavy: run one at a time.
#
#   scripts/image/run-smoke.sh [--no-build] [--keep]
#
# 1. Builds polynovea-cms:smoke for this machine's architecture (prints build time and image size).
# 2. Tunnel route: starts the image with a data volume, HOSTNAME=127.0.0.1, no published port.
#    From inside the container (the same loopback an SSH tunnel lands on): /api/health = setup,
#    the setup code works, "On this server" provisions the bundled PostgreSQL with backups, and the
#    wizard reaches the owner step. Checks the bundled database listens on 127.0.0.1 only and refuses
#    password-less and remote sign-ins. Restarts the container: PostgreSQL comes back by itself.
# 3. Published-port route: HOSTNAME=0.0.0.0 with -p: setup over plain HTTP is refused (by design).
# 4. Proxy route: the same image behind Caddy in its network namespace, setup over HTTPS.
# Cleans up its containers, volumes and network unless --keep.
set -euo pipefail

export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
# Git Bash would rewrite container paths such as /app into Windows paths; host paths are converted
# explicitly below.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
HOST_ROOT="$ROOT"
if command -v cygpath >/dev/null 2>&1; then HOST_ROOT="$(cygpath -w "$ROOT")"; fi
IMAGE=polynovea-cms:smoke
RELEASE_ID="smoke+$(git rev-parse --short HEAD)"
PREFIX=p5w1-smoke
BUILD=1
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --keep) KEEP=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

cleanup() {
  [ "$KEEP" = 1 ] && return
  docker rm -f "$PREFIX-tunnel" "$PREFIX-public" "$PREFIX-proxy" "$PREFIX-caddy" >/dev/null 2>&1 || true
  docker volume rm "$PREFIX-data" "$PREFIX-data2" "$PREFIX-data3" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }

setup_code() { # container
  local code=""
  for _ in $(seq 1 90); do
    code="$(docker logs "$1" 2>&1 | sed -n 's/.*Setup code: \([^ ]*\).*/\1/p' | tail -1)"
    [ -n "$code" ] && break
    sleep 2
  done
  [ -n "$code" ] || { echo "no setup code in $1's log" >&2; docker logs "$1" 2>&1 | tail -30 >&2; return 1; }
  printf '%s' "$code"
}

wait_healthy() { # container
  for _ in $(seq 1 90); do
    if docker exec "$1" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "$1 did not become healthy" >&2; docker logs "$1" 2>&1 | tail -40 >&2; return 1
}

smoke() { # container, env...
  local container="$1"; shift
  docker exec -i "$@" "$container" node --input-type=module - < "$ROOT/scripts/image/smoke-test.mjs"
}

cleanup
if [ "$BUILD" = 1 ]; then
  step "Building $IMAGE"
  start=$(date +%s)
  docker buildx build --load --build-arg POLYNOVEA_RELEASE_ID="$RELEASE_ID" --build-arg POLYNOVEA_REVISION="$(git rev-parse HEAD)" -t "$IMAGE" .
  echo "build time: $(( $(date +%s) - start ))s"
fi
docker image inspect "$IMAGE" --format 'image size: {{.Size}} bytes ({{.Architecture}})'
RELEASE_ID="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "io.polynovea.release-id"}}')"

step "Image basics"
docker run --rm --entrypoint sh "$IMAGE" -c 'echo "user: $(id -u):$(id -g)"; node --version; postgres --version; pgbackrest version; test ! -e /app/.env && echo "no .env in /app"'
docker run --rm --entrypoint node "$IMAGE" -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<24||(a===24&&b<7)) process.exit(1); console.log('node >= 24.7')"
docker run --rm --entrypoint node -w /app "$IMAGE" scripts/polynovea-cms.mjs --help >/dev/null && echo "operator command (polynovea-cms --help) runs"

step "Tunnel route: setup over loopback, On this server, owner step"
docker volume create "$PREFIX-data" >/dev/null
docker run -d --name "$PREFIX-tunnel" -v "$PREFIX-data:/var/lib/polynovea" "$IMAGE" >/dev/null
wait_healthy "$PREFIX-tunnel"
docker logs "$PREFIX-tunnel" 2>&1 | grep -q "peer\|Setup code" || true
CODE="$(setup_code "$PREFIX-tunnel")"
smoke "$PREFIX-tunnel" -e SETUP_CODE="$CODE" -e EXPECT_RELEASE="$RELEASE_ID" -e STEPS=health,forged,code,local,owner-step

step "Bundled database: 127.0.0.1 and socket only, no password sign-in, no remote roles"
docker exec "$PREFIX-tunnel" sh -ec '
  psql -h /var/run/postgresql -U postgres -d polynovea -Atc "show listen_addresses" | grep -qx 127.0.0.1 && echo "listen_addresses = 127.0.0.1"
  psql -h /var/run/postgresql -U postgres -d polynovea -Atc "select count(*) from pg_roles where rolname in (\x27polynovea_owner\x27,\x27polynovea_app\x27)" | grep -qx 2 && echo "polynovea_owner and polynovea_app exist"
  if PGPASSWORD=x psql -h 127.0.0.1 -U postgres -d polynovea -c "select 1" >/dev/null 2>&1; then echo "FAIL: superuser over TCP"; exit 1; else echo "superuser over TCP refused"; fi
  if PGPASSWORD=x psql -h 127.0.0.1 -U polynovea_app -d postgres -c "select 1" >/dev/null 2>&1; then echo "FAIL: app role on another database"; exit 1; else echo "app role limited to the polynovea database"; fi
  test "$(stat -c %a /var/run/postgresql)" = 700 && echo "socket directory is private (0700)"
  pgbackrest --config=/var/lib/polynovea/etc/pgbackrest.conf --log-path=/var/lib/polynovea/log/pgbackrest --stanza=polynovea info | grep -q "status: ok" && echo "pgBackRest stanza ok, full backup present"
  test "$(stat -c %a /var/lib/polynovea/etc/pgbackrest.conf)" = 600 && echo "pgbackrest.conf is 0600"
'

step "Restart: PostgreSQL comes back with the container"
docker restart -t 90 "$PREFIX-tunnel" >/dev/null
wait_healthy "$PREFIX-tunnel"
docker exec "$PREFIX-tunnel" sh -ec '/opt/polynovea/bin/local-db.sh status && echo "bundled PostgreSQL running after restart"'
docker exec "$PREFIX-tunnel" node -e "fetch('http://127.0.0.1:3000/api/setup/status').then(r=>r.json()).then(s=>{console.log('after restart:',JSON.stringify(s));process.exit(s.databaseReady?0:1)})"
docker logs "$PREFIX-tunnel" 2>&1 | grep -E "^\[entrypoint\]|\[local-db\]|delivery-worker" | tail -8 || true

step "Published port + 0.0.0.0: plain-HTTP setup refused"
docker volume create "$PREFIX-data2" >/dev/null
docker run -d --name "$PREFIX-public" -e HOSTNAME=0.0.0.0 -p 127.0.0.1:38080:3000 -v "$PREFIX-data2:/var/lib/polynovea" "$IMAGE" >/dev/null
wait_healthy "$PREFIX-public"
smoke "$PREFIX-public" -e STEPS=health,refused

step "Proxy route: HTTPS through Caddy in the CMS's network namespace"
docker volume create "$PREFIX-data3" >/dev/null
docker run -d --name "$PREFIX-proxy" -e POLYNOVEA_TRUSTED_PROXIES=127.0.0.1 -e POLYNOVEA_PUBLIC_URL=https://localhost -v "$PREFIX-data3:/var/lib/polynovea" "$IMAGE" >/dev/null
CADDY_IMAGE="$(sed -n 's/^ *image: \(caddy:.*\)$/\1/p' docker/compose.yaml)"
docker run -d --name "$PREFIX-caddy" --network "container:$PREFIX-proxy" -e POLYNOVEA_DOMAIN=localhost \
  -v "$HOST_ROOT/docker/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null
wait_healthy "$PREFIX-proxy"
CODE3="$(setup_code "$PREFIX-proxy")"
sleep 3
smoke "$PREFIX-proxy" -e SETUP_CODE="$CODE3" -e BASE_URL=https://localhost -e INSECURE_TLS=1 -e STEPS=health,code

step "All image checks passed"
