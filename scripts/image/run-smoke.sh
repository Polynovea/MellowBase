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
# 4. Proxy route: the same image joined to Caddy's network namespace (as in compose), setup over
#    HTTPS, then a CMS restart: HTTPS must keep working.
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
# The address the owner opens through the tunnel: the wizard's passkey and sign-in belong to it. This
# plain docker run passes it as docs/self-hosting/container.md says; the compose tunnel profile sets the
# same default in docker/tunnel.env and the VM's run-cms.sh when there is no domain
# (scripts/release/compose-tunnel.test.ts checks both).
docker run -d --name "$PREFIX-tunnel" -e POLYNOVEA_PUBLIC_URL=http://localhost:3000 -v "$PREFIX-data:/var/lib/polynovea" "$IMAGE" >/dev/null
wait_healthy "$PREFIX-tunnel"
docker logs "$PREFIX-tunnel" 2>&1 | grep -q "peer\|Setup code" || true
CODE="$(setup_code "$PREFIX-tunnel")"
smoke "$PREFIX-tunnel" -e SETUP_CODE="$CODE" -e EXPECT_RELEASE="$RELEASE_ID" -e STEPS=health,forged,code,local,owner-step,schema-roundtrip | tee "/tmp/$PREFIX-roundtrip.log"
SMOKE_MODEL="$(grep -o "SCHEMA_ROUNDTRIP_MODEL=[a-z0-9_]*" "/tmp/$PREFIX-roundtrip.log" | cut -d= -f2)"
rm -f "/tmp/$PREFIX-roundtrip.log"
[ -n "$SMOKE_MODEL" ] || { echo "FAIL  schema round trip did not finish"; exit 1; }
docker exec -e SMOKE_MODEL="$SMOKE_MODEL" "$PREFIX-tunnel" sh -ec '
  states="$(psql -h /var/run/postgresql -U postgres -d polynovea -Atc "select string_agg(l.status, \$\$,\$\$ order by l.created_at) from schema_migration_ledger l join content_models m on m.id = l.content_model_id where m.api_key = \$\$$SMOKE_MODEL\$\$ and l.status <> \$\$superseded\$\$")"
  case "$states" in *pending*|*running*|*failed*|"") echo "FAIL  ledger for the smoke model: [$states]"; exit 1;; *) echo "ok    every schema change of the smoke model succeeded ($states)";; esac
  reads="$(psql -h /var/run/postgresql -U postgres -d polynovea -Atc "select s.read_source from content_model_storage s join content_models m on m.id = s.content_model_id where m.api_key = \$\$$SMOKE_MODEL\$\$")"
  [ "$reads" = "table" ] && echo "ok    the smoke model reads from its table" || { echo "FAIL  smoke model read source [$reads]"; exit 1; }
'

step "Bundled database: 127.0.0.1 and socket only, no password sign-in, no remote roles"
docker exec "$PREFIX-tunnel" sh -ec '
  sql() { psql -h /var/run/postgresql -U postgres -d polynovea -Atc "$1"; }
  check() { if [ "$1" = "$2" ]; then echo "ok    $3"; else echo "FAIL  $3: got [$1], expected [$2]"; exit 1; fi; }
  check "$(sql "show listen_addresses")" "127.0.0.1" "listens on 127.0.0.1 only"
  check "$(sql "show archive_command")" "pgbackrest --config=\"/var/lib/polynovea/etc/pgbackrest.conf\" --log-path=\"/var/lib/polynovea/log/pgbackrest\" --lock-path=/tmp/pgbackrest --stanza=polynovea archive-push \"%p\"" "archive_command uses the fixed data root, every path quoted"
  check "$(sql "select string_agg(rolname, \$\$,\$\$ order by rolname) from pg_roles where rolname like \$\$polynovea\\_%\$\$")" "polynovea_app,polynovea_owner" "polynovea_owner and polynovea_app exist"
  # Sign-in rules (pg_hba): nothing accepts a connection except the superuser over the socket by peer,
  # and polynovea_owner/polynovea_app to the polynovea database from 127.0.0.1/32 by SCRAM.
  check "$(sql "select count(*) from pg_hba_file_rules where error is null and auth_method <> \$\$reject\$\$ and not (type = \$\$local\$\$ and user_name = \$\${postgres}\$\$ and auth_method = \$\$peer\$\$) and not (type = \$\$host\$\$ and database = \$\${polynovea}\$\$ and user_name = \$\${polynovea_owner,polynovea_app}\$\$ and address = \$\$127.0.0.1\$\$ and netmask = \$\$255.255.255.255\$\$ and auth_method = \$\$scram-sha-256\$\$)")" "0" \
    "pg_hba accepts only: superuser by socket (peer), polynovea_* to one database from 127.0.0.1 by SCRAM"
  check "$(sql "select count(*) from pg_hba_file_rules where error is not null")" "0" "pg_hba has no rule errors"
  if PGPASSWORD=x psql -h 127.0.0.1 -U postgres -d polynovea -c "select 1" 2>&1 | grep -q "pg_hba.conf"; then echo "ok    superuser over TCP rejected by pg_hba"; else echo "FAIL  superuser over TCP not rejected by pg_hba"; exit 1; fi
  mode="$(stat -c %a /var/run/postgresql)"
  case "$mode" in *00) echo "ok    socket directory has no group or other access ($mode)";; *) echo "FAIL  socket directory mode $mode"; exit 1;; esac
  if pgbackrest --config=/var/lib/polynovea/etc/pgbackrest.conf --log-path=/var/lib/polynovea/log/pgbackrest --stanza=polynovea info | grep -q "status: ok"; then echo "ok    pgBackRest stanza ok, full backup present"; else echo "FAIL  pgBackRest stanza"; exit 1; fi
  check "$(stat -c %a /var/lib/polynovea/etc/pgbackrest.conf)" "600" "pgbackrest.conf is 0600"
'

step "Restart: PostgreSQL comes back with the container"
docker restart -t 90 "$PREFIX-tunnel" >/dev/null
wait_healthy "$PREFIX-tunnel"
docker exec "$PREFIX-tunnel" sh -ec '/opt/polynovea/bin/local-db.sh status && echo "bundled PostgreSQL running after restart"'
# The round trip finished setup (owner, organisation, keys), so after a restart the CMS runs, /setup is gone
# for good, and the built-in auth starts in SSH-tunnel mode (no proxy list needed on loopback).
docker exec "$PREFIX-tunnel" node -e "Promise.all([fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()),fetch('http://127.0.0.1:3000/api/setup/status').then(r=>r.status)]).then(([h,s])=>{console.log('after restart: health',JSON.stringify(h),'setup status',s);process.exit(h.state==='running'&&s===404?0:1)})" \
  && echo "ok    after restart: the CMS is running and setup is gone (404)" \
  || { echo "FAIL  after restart: the CMS is not running, or setup still answers"; exit 1; }
if docker logs "$PREFIX-tunnel" 2>&1 | grep -q "auth: SSH-tunnel mode (loopback only), shared sign-in rate limit"; then
  echo "ok    after restart: the built-in auth started in SSH-tunnel mode (no proxy list, shared sign-in limit)"
else
  echo "FAIL  the built-in auth did not log SSH-tunnel mode after the restart"; exit 1
fi
docker logs "$PREFIX-tunnel" 2>&1 | grep -E "^\[entrypoint\]|\[local-db\]|delivery-worker" | tail -8 || true

step "Delivery worker: the bundle (no TypeScript loader) is running and has recorded a heartbeat"
# Only node processes count: this sh -ec script is itself a process whose command line contains every
# word it searches for, so matching all processes would find itself.
docker exec "$PREFIX-tunnel" sh -ec '
  procs="$(for p in /proc/[0-9]*; do c="$(tr "\0" " " < "$p/cmdline" 2>/dev/null)"; case "$c" in node\ *|*/node\ *) echo "$c";; esac; done)"
  if echo "$procs" | grep -q "dist/delivery-worker.mjs"; then echo "ok    worker process runs dist/delivery-worker.mjs"; else echo "FAIL  no worker process running the bundle"; echo "$procs" | grep -i worker; exit 1; fi
  if echo "$procs" | grep -q -- "--loader"; then echo "FAIL  a process runs with a TypeScript loader"; exit 1; else echo "ok    no process uses --loader"; fi
  if [ -e /app/scripts/phase12_75-node-loader.mjs ] || [ -e /app/lib/developer/items/schedule.ts ]; then echo "FAIL  the loader or the worker TypeScript ships in the image"; exit 1; else echo "ok    no loader and no worker TypeScript in the image"; fi
  for i in $(seq 1 30); do
    beat="$(psql -h /var/run/postgresql -U postgres -d polynovea -Atc "select coalesce(extract(epoch from now() - worker_heartbeat_at)::int, -1) from cms_runtime_state where singleton")"
    if [ -n "$beat" ] && [ "$beat" -ge 0 ] && [ "$beat" -lt 120 ]; then echo "ok    worker heartbeat ${beat}s ago"; exit 0; fi
    sleep 2
  done
  echo "FAIL  no recent worker heartbeat (got [$beat])"; exit 1
'

step "Schema worker: the bundle runs, as polynovea_owner from config.enc, with no credential in its environment"
docker exec "$PREFIX-tunnel" sh -ec '
  found=""
  for p in /proc/[0-9]*; do
    c="$(tr "\0" " " < "$p/cmdline" 2>/dev/null)"
    case "$c" in node\ *|*/node\ *) ;; *) continue ;; esac
    if echo "$c" | grep -q "dist/schema-migration-worker.mjs"; then found="$p"; fi
  done
  if [ -n "$found" ]; then echo "ok    schema worker process runs dist/schema-migration-worker.mjs (pid ${found#/proc/})"; else echo "FAIL  no schema worker process"; exit 1; fi
  # The worker process'"'"'s own environment (its pid above), never this shell'"'"'s; unreadable is a failure, not a pass.
  if [ ! -r "$found/environ" ] || ! tr "\0" "\n" < "$found/environ" | grep -q "^PATH="; then echo "FAIL  cannot read the schema worker environment (${found}/environ)"; exit 1; fi
  if tr "\0" "\n" < "$found/environ" | grep -qiE "^(POLYNOVEA_MIGRATION_DATABASE_URL|DATABASE_URL)=.*polynovea_owner|postgres(ql)?://polynovea_owner"; then echo "FAIL  the owner credential is in the schema worker environment"; exit 1; else echo "ok    no owner credential in the schema worker environment"; fi
'
for i in $(seq 1 30); do
  if docker logs "$PREFIX-tunnel" 2>&1 | grep -q "\"worker\":\"schema\",\"event\":\"started\".*\"connection\":\"config.enc\""; then echo "ok    schema worker started as polynovea_owner from config.enc"; break; fi
  if [ "$i" = 30 ]; then echo "FAIL  schema worker did not start"; docker logs "$PREFIX-tunnel" 2>&1 | grep "\"worker\":\"schema\"" | tail -5; exit 1; fi
  sleep 2
done
if docker logs "$PREFIX-tunnel" 2>&1 | grep -q "\"worker\":\"schema\",\"event\":\"loop_error\""; then echo "FAIL  schema worker loop errors"; docker logs "$PREFIX-tunnel" 2>&1 | grep "\"worker\":\"schema\"" | tail -5; exit 1; else echo "ok    schema worker loop without errors"; fi

step "Published port + 0.0.0.0: plain-HTTP setup refused"
docker volume create "$PREFIX-data2" >/dev/null
docker run -d --name "$PREFIX-public" -e HOSTNAME=0.0.0.0 -p 127.0.0.1:38080:3000 -v "$PREFIX-data2:/var/lib/polynovea" "$IMAGE" >/dev/null
wait_healthy "$PREFIX-public"
smoke "$PREFIX-public" -e STEPS=health,refused

step "A cluster left by an unfinished On this server attempt stays stopped after a restart"
docker exec "$PREFIX-public" /opt/polynovea/bin/local-db.sh start >/dev/null 2>&1
docker restart -t 90 "$PREFIX-public" >/dev/null
wait_healthy "$PREFIX-public"
if docker exec "$PREFIX-public" /opt/polynovea/bin/local-db.sh status; then
  echo "FAIL  the entrypoint started a bundled cluster that no saved setup uses"; exit 1
fi
docker logs "$PREFIX-public" 2>&1 | grep -q "setup has not saved a database yet; leaving the bundled cluster stopped" \
  && echo "ok    leftover cluster not started (no config.enc says local); the entrypoint logged why"

step "Proxy route: HTTPS through Caddy; the CMS joins Caddy's network namespace (as in compose)"
docker volume create "$PREFIX-data3" >/dev/null
CADDY_IMAGE="$(sed -n 's/^ *image: \(caddy:.*\)$/\1/p' docker/compose.yaml)"
docker run -d --name "$PREFIX-caddy" -e POLYNOVEA_DOMAIN=localhost \
  -v "$HOST_ROOT/docker/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null
docker run -d --name "$PREFIX-proxy" --network "container:$PREFIX-caddy" -e POLYNOVEA_TRUSTED_PROXIES=127.0.0.1 -e POLYNOVEA_PUBLIC_URL=https://localhost -v "$PREFIX-data3:/var/lib/polynovea" "$IMAGE" >/dev/null
wait_healthy "$PREFIX-proxy"
CODE3="$(setup_code "$PREFIX-proxy")"
sleep 3
smoke "$PREFIX-proxy" -e SETUP_CODE="$CODE3" -e BASE_URL=https://localhost -e INSECURE_TLS=1 -e STEPS=health,code

step "Proxy route: restarting the CMS keeps HTTPS working"
docker restart -t 90 "$PREFIX-proxy" >/dev/null
wait_healthy "$PREFIX-proxy"
sleep 2
smoke "$PREFIX-proxy" -e BASE_URL=https://localhost -e INSECURE_TLS=1 -e STEPS=health
if docker exec "$PREFIX-caddy" wget -q --no-check-certificate -O - https://localhost/api/health | grep -q '"state":"setup"'; then
  echo "ok    Caddy still serves the CMS over HTTPS after the CMS restarted"
else
  echo "FAIL  HTTPS through Caddy is down after the CMS restarted"; exit 1
fi

step "All image checks passed"
