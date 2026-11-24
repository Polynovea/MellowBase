#!/usr/bin/env bash
# End-to-end test of in-app upgrades, the forced-failure switch-back and the restore test, entirely on
# this machine. Heavy (one image build, several containers): run under the heavy-job lock.
#
#   scripts/release/test-upgrade.sh
#
# The layout mirrors a Polynovea VM (release/packer/files):
# - Release A is built and signed by the real scripts/release/build-and-sign.mjs (--rollback compatible),
#   pushed to a throwaway registry on 127.0.0.1, signed with a throwaway cosign key.
# - Release B (0.4.1, rollback compatible) and B' (0.4.2, no compatible rollback, its health never
#   reports 0.4.2) are A with a different POLYNOVEA_RELEASE_ID, pushed and signed with the real cosign;
#   their release.json files are signed with the real `cosign sign-blob` and served as a channel.
# - The CMS runs with host networking, the data disk and the agent's status folder as on the VM.
# - The real upgrade-agent.py runs as root in a small container standing in for the VM host, with the
#   Docker socket; systemctl is a stand-in that starts the CMS the way run-cms.sh does.
#   Not covered here: systemd itself and verify-images.sh as ExecStartPre (the agent verifies first).
#
# Checks: the native release.json verifier against the real cosign signature (and a changed byte);
# setup "On this server" (bundled PostgreSQL + pgBackRest); a forced-failed upgrade to B' switches back
# to A, restoring the pre-upgrade backup; an upgrade to B succeeds; the restore test passes on a healthy
# backup and fails (an alert row and audit event) on a corrupted one, leaving nothing behind.
# Removes every container, volume, image and folder it made.
set -euo pipefail

export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

PREFIX=p5w3-e2e
REG_PORT=35100
CH_PORT=35101
IMAGE="localhost:$REG_PORT/polynovea-cms"
CMS="$PREFIX-cms"
AGENT="$PREFIX-agent"
VMDATA=/var/lib/$PREFIX-data       # paths inside Docker's VM (what dockerd binds), like /var/lib/polynovea
VMSTATUS=/var/lib/$PREFIX-status
VMETC=/var/lib/$PREFIX-etc
REGISTRY_IMAGE="registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
PY_IMAGE=python:3.12-slim
DOCKER_CLI_IMAGE=docker:27-cli
COSIGN="$(node -e "import('./scripts/release/build-and-sign.mjs').then(m=>console.log(m.TOOLS.cosign))")"
BUILDER_IMAGE="$(node -e "import('./scripts/release/build-and-sign.mjs').then(m=>console.log(m.BUILDER.image))")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/$PREFIX.XXXXXX")"
KEYS="$WORK/keys"; OUT_A="$WORK/release-a"; CHANNEL="$WORK/channel"
mkdir -p "$KEYS" "$OUT_A" "$CHANNEL/0.4.1" "$CHANNEL/0.4.2"

BUILDER_EXISTED=0
docker buildx inspect polynovea-release >/dev/null 2>&1 && BUILDER_EXISTED=1
DOCKER_CLI_EXISTED=0
docker image inspect "$DOCKER_CLI_IMAGE" >/dev/null 2>&1 && DOCKER_CLI_EXISTED=1
cleanup() {
  docker rm -f "$CMS" "$AGENT" "$PREFIX-registry" "$PREFIX-channel" >/dev/null 2>&1 || true
  docker volume rm "$PREFIX-registry-data" >/dev/null 2>&1 || true
  docker run --rm -v /var/lib:/vl "$PY_IMAGE" rm -rf "/vl/$PREFIX-data" "/vl/$PREFIX-status" "/vl/$PREFIX-etc" >/dev/null 2>&1 || true
  docker image ls -q --filter "reference=localhost:$REG_PORT/*" | sort -u | xargs -r docker rmi -f >/dev/null 2>&1 || true
  docker rmi -f "$PREFIX-agent-image" >/dev/null 2>&1 || true
  [ "$DOCKER_CLI_EXISTED" = 0 ] && docker rmi -f "$DOCKER_CLI_IMAGE" >/dev/null 2>&1 || true
  if [ "$BUILDER_EXISTED" = 0 ]; then
    docker buildx rm polynovea-release >/dev/null 2>&1 || true
    docker rmi -f "$BUILDER_IMAGE" >/dev/null 2>&1 || true
  fi
  docker builder prune -f >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
ok() { echo "ok    $*"; }
fail() { echo "FAIL  $*" >&2; exit 1; }
field() { node -e "console.log(require(process.argv[1])[process.argv[2]])" "$(winpath "$1")" "$2"; }
health() { docker exec "$AGENT" python3 -c "import urllib.request,json;print(urllib.request.urlopen('http://127.0.0.1:3000/api/health',timeout=5).read().decode())" 2>/dev/null || echo '{}'; }
wait_state() { # state [release]
  for _ in $(seq 1 90); do
    local h; h="$(health)"
    if echo "$h" | grep -q "\"state\":\"$1\"" && { [ -z "${2:-}" ] || echo "$h" | grep -q "\"release\":\"$2\""; }; then return 0; fi
    sleep 2
  done
  echo "health: $(health)" >&2; docker logs "$CMS" 2>&1 | tail -30 >&2; return 1
}
psql_cms() { docker exec "$CMS" psql -h /var/run/postgresql -U postgres -d polynovea -Atc "$1"; }
cosign_key() { docker run --rm --network host -e COSIGN_PASSWORD -v "$(winpath "$KEYS"):/keys:ro" "$@"; }

COSIGN_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
export COSIGN_PASSWORD

step "Throwaway registry (127.0.0.1:$REG_PORT) and key pair"
docker run -d --name "$PREFIX-registry" -p "127.0.0.1:$REG_PORT:5000" -v "$PREFIX-registry-data:/var/lib/registry" "$REGISTRY_IMAGE" >/dev/null
docker run --rm -e COSIGN_PASSWORD -v "$(winpath "$KEYS"):/keys" -w /keys "$COSIGN" generate-key-pair >/dev/null
PUB_SHA="$(node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex'))" "$(winpath "$KEYS/cosign.pub")")"

step "Release A: the real build-and-sign.mjs (0.4.0, rollback compatible)"
start=$(date +%s)
node scripts/release/build-and-sign.mjs --image "$IMAGE" --version 0.4.0 --key "$(winpath "$KEYS/cosign.key")" \
  --platforms linux/amd64 --out "$(winpath "$OUT_A")" --rollback compatible --allow-dirty
echo "release A built and signed in $(( $(date +%s) - start ))s"
REF_A="$(field "$OUT_A/release.json" image)@$(field "$OUT_A/release.json" digest)"
RELEASE_A="$(field "$OUT_A/release.json" releaseId)"
[ "$(field "$OUT_A/release.json" rollback)" = compatible ] && ok "release.json records rollback: compatible"

make_release() { # version releaseId healthRelease rollback(compatible|"") dir
  local version="$1" release_id="$2" health_release="$3" rollback="$4" dir="$5"
  printf 'FROM %s\nENV POLYNOVEA_RELEASE_ID=%s\nLABEL io.polynovea.release-id=%s org.opencontainers.image.version=%s\n' "$REF_A" "$health_release" "$health_release" "$version" \
    | docker build -q -t "$IMAGE:$version" - >/dev/null
  docker push -q "$IMAGE:$version" >/dev/null
  local digest; digest="$(docker image inspect "$IMAGE:$version" --format '{{index .RepoDigests 0}}')"; digest="${digest##*@}"
  cosign_key "$COSIGN" sign --yes --key /keys/cosign.key --tlog-upload=false "$IMAGE@$digest" >/dev/null 2>&1
  printf '## %s\n- End-to-end test release.\n' "$version" > "$dir/CHANGELOG.md"
  node -e '
    const [dir, version, releaseId, image, digest, rollback, pub] = process.argv.slice(1);
    const fs = require("fs"), crypto = require("crypto"), path = require("path");
    const changelog = fs.readFileSync(path.join(dir, "CHANGELOG.md"));
    const release = { schema: 1, releaseId, version, image, digest, ref: `${image}@${digest}`, tag: `${image}:${version}`,
      ...(rollback ? { rollback } : {}), changelog: { file: "CHANGELOG.md", sha256: crypto.createHash("sha256").update(changelog).digest("hex") },
      publicKeySha256: pub, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(release, null, 2) + "\n");
  ' "$(winpath "$dir")" "$version" "$release_id" "$IMAGE" "$digest" "$rollback" "$PUB_SHA"
  docker run --rm --network host -e COSIGN_PASSWORD -v "$(winpath "$KEYS"):/keys:ro" -v "$(winpath "$dir"):/out" "$COSIGN" \
    sign-blob --yes --key /keys/cosign.key --tlog-upload=false --output-signature /out/release.json.sig /out/release.json >/dev/null 2>&1
  cp "$KEYS/cosign.pub" "$dir/cosign.pub"
  echo "$IMAGE@$digest"
}
point_channel() { # releaseId folder
  printf '{"schema":1,"releaseId":"%s","release":"%s/release.json","signature":"%s/release.json.sig"}\n' "$1" "$2" "$2" > "$CHANNEL/latest.json"
}

step "Releases B (0.4.1, compatible) and B' (0.4.2, restore; its health never reports 0.4.2)"
REF_B="$(make_release 0.4.1 0.4.1+bbbbbbb 0.4.1+bbbbbbb compatible "$CHANNEL/0.4.1")"
REF_BAD="$(make_release 0.4.2 0.4.2+ccccccc 0.4.2+broken "" "$CHANNEL/0.4.2")"
echo "A  $REF_A ($RELEASE_A)"; echo "B  $REF_B"; echo "B' $REF_BAD"

step "Native release.json verifier against the real cosign sign-blob signature"
POLYNOVEA_COSIGN_FIXTURE="$(winpath "$CHANNEL/0.4.1")" npx vitest run lib/system/releaseChannel.cosign.test.ts 2>&1 | grep -E "Tests|✓|×|FAIL" || true
POLYNOVEA_COSIGN_FIXTURE="$(winpath "$CHANNEL/0.4.1")" npx vitest run lib/system/releaseChannel.cosign.test.ts >/dev/null 2>&1 \
  && ok "real cosign signature accepted; one changed byte refused (3 positions)" || fail "native verifier vs real cosign"

step "Release channel on 127.0.0.1:$CH_PORT and the host stand-in (agent container)"
docker run -d --name "$PREFIX-channel" --network host -v "$(winpath "$CHANNEL"):/srv:ro" "$PY_IMAGE" \
  python3 -m http.server "$CH_PORT" --bind 127.0.0.1 --directory /srv >/dev/null
docker run --rm -v /var/lib:/vl "$PY_IMAGE" sh -ec "
  mkdir -p /vl/$PREFIX-data /vl/$PREFIX-status /vl/$PREFIX-etc/work
  chown 10001:10001 /vl/$PREFIX-data; chmod 0700 /vl/$PREFIX-data
  chown 0:0 /vl/$PREFIX-status /vl/$PREFIX-etc; chmod 0755 /vl/$PREFIX-status /vl/$PREFIX-etc"
printf 'FROM %s AS cli\nFROM %s\nCOPY --from=cli /usr/local/bin/docker /usr/local/bin/docker\n' "$DOCKER_CLI_IMAGE" "$PY_IMAGE" \
  | docker build -q -t "$PREFIX-agent-image" - >/dev/null
docker run -d --name "$AGENT" --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$VMDATA:/var/lib/polynovea" -v "$VMSTATUS:/var/lib/polynovea-upgrade" -v "$VMETC:$VMETC" \
  -v "$(winpath "$ROOT/release/packer/files/upgrade-agent.py"):/opt/polynovea/upgrade-agent.py:ro" \
  "$PREFIX-agent-image" sleep infinity >/dev/null
docker exec -i "$AGENT" sh -c "cat > $VMETC/release.pub" < "$KEYS/cosign.pub"
docker exec -i "$AGENT" sh -c 'mkdir -p /etc/polynovea && cat > /etc/polynovea/upgrade.env' <<EOF
RUNTIME=systemd
CONTAINER=$CMS
SERVICE=polynovea
PUBKEY=$VMETC/release.pub
WORK_DIR=$VMETC/work
DATA_DIR=$VMDATA
CHANNEL_URL=http://127.0.0.1:$CH_PORT/
ALLOW_HTTP_CHANNEL=1
HEALTH_URL=http://127.0.0.1:3000/api/health
EOF
docker exec -i "$AGENT" sh -c 'cat > /etc/polynovea/polynovea.env' <<EOF
POLYNOVEA_IMAGE_REF=$REF_A
EOF
# systemctl stand-in: start/stop the CMS exactly as run-cms.sh does (host networking, loopback, data disk,
# read-only release key and status folder).
docker exec -i "$AGENT" sh -c 'cat > /usr/local/bin/systemctl && chmod 0755 /usr/local/bin/systemctl' <<EOF
#!/bin/sh
set -eu
ref="\$(sed -n 's/^POLYNOVEA_IMAGE_REF=//p' /etc/polynovea/polynovea.env | tail -1)"
case "\$1" in
  stop) docker stop -t 90 $CMS >/dev/null 2>&1 || true; docker rm -f $CMS >/dev/null 2>&1 || true ;;
  start|restart)
    docker stop -t 90 $CMS >/dev/null 2>&1 || true; docker rm -f $CMS >/dev/null 2>&1 || true
    docker run -d --name $CMS --network host --security-opt no-new-privileges:true --cap-drop ALL --stop-timeout 90 \
      -v $VMDATA:/var/lib/polynovea -v $VMSTATUS:/var/lib/polynovea-upgrade:ro -v $VMETC/release.pub:/etc/polynovea/release.pub:ro \
      --env-file /etc/polynovea/polynovea.env -e HOSTNAME=127.0.0.1 -e PORT=3000 "\$ref" >/dev/null ;;
  *) echo "systemctl stand-in: \$*" >&2; exit 2 ;;
esac
EOF
docker exec "$AGENT" python3 -I -B /opt/polynovea/upgrade-agent.py --mark && ok "agent installed (marker written)"

step "Install A: setup with \"On this server\" (bundled PostgreSQL, pgBackRest), then the installation row"
docker exec "$AGENT" systemctl restart polynovea
wait_state setup "$RELEASE_A"
CODE=""
for _ in $(seq 1 60); do CODE="$(docker logs "$CMS" 2>&1 | sed -n 's/.*Setup code: \([^ ]*\).*/\1/p' | tail -1)"; [ -n "$CODE" ] && break; sleep 2; done
[ -n "$CODE" ] || fail "no setup code in the CMS log"
docker exec -i -e SETUP_CODE="$CODE" -e STEPS=code,local "$CMS" node --input-type=module - < scripts/image/smoke-test.mjs
psql_cms "insert into public.installation (organisation_name, database_mode) values ('Upgrade E2E', 'local')" >/dev/null
docker exec "$AGENT" systemctl restart polynovea
wait_state running "$RELEASE_A" && ok "A is installed and running ($RELEASE_A)"

request() { # releaseId: written by the CMS user (uid 10001) into its own data disk, as the System page does
  docker exec "$CMS" node -e "const fs=require('fs');fs.mkdirSync('/var/lib/polynovea/upgrade-requests',{recursive:true,mode:0o700});fs.writeFileSync('/var/lib/polynovea/upgrade-requests/request.json',JSON.stringify({releaseId:process.argv[1],requestId:require('crypto').randomUUID()})+'\n',{mode:0o600})" "$1"
}
status_json() { docker exec "$AGENT" cat /var/lib/polynovea-upgrade/status.json; }
step_seconds() { # from-step from-outcome to-step to-outcome
  status_json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);const f=v.steps.find(x=>x.step==='$1'&&x.outcome==='$2');const t=[...v.steps].reverse().find(x=>x.step==='$3'&&x.outcome==='$4');console.log(f&&t?Math.round((Date.parse(t.at)-Date.parse(f.at))/1000):-1)})"
}

step "Forced failure: upgrade A -> B' (health never reports 0.4.2; no compatible rollback)"
point_channel 0.4.2+ccccccc 0.4.2
request 0.4.2+ccccccc
start=$(date +%s)
if docker exec "$AGENT" python3 -I -B /opt/polynovea/upgrade-agent.py; then fail "the upgrade to B' reported success"; fi
echo "agent run: $(( $(date +%s) - start ))s"
status_json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log('status',v.status,'rollback',v.rollback);for(const x of v.steps)console.log('  ',x.at,x.step,x.outcome,x.detail||'')})"
[ "$(status_json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).status))")" = rolled_back ] || fail "status is not rolled_back"
DETECT="$(step_seconds start started health failed)"
BACK="$(step_seconds start started rollback ok)"
[ "$DETECT" -ge 0 ] && [ "$DETECT" -le 125 ] || fail "the failed health check took ${DETECT}s to detect"
ok "B' declared unhealthy ${DETECT}s after it was started (deadline 120 s); A healthy again ${BACK}s after B' started"
status_json | grep -q '"step": "restore"' && ok "the pre-upgrade pgBackRest backup was restored before A started (no compatible rollback)"
wait_state running "$RELEASE_A" && ok "A is serving again"
docker exec "$AGENT" grep -q "POLYNOVEA_IMAGE_REF=$REF_A" /etc/polynovea/polynovea.env && ok "the pin is back on A's digest"

step "Upgrade A -> B (0.4.1, compatible)"
point_channel 0.4.1+bbbbbbb 0.4.1
request 0.4.1+bbbbbbb
start=$(date +%s)
docker exec "$AGENT" python3 -I -B /opt/polynovea/upgrade-agent.py || fail "the upgrade to B failed: $(status_json)"
echo "agent run: $(( $(date +%s) - start ))s; switch (start -> healthy): $(step_seconds start started health ok)s"
wait_state running 0.4.1+bbbbbbb && ok "B is serving (/api/health reports 0.4.1+bbbbbbb)"
docker exec "$AGENT" grep -q "POLYNOVEA_IMAGE_REF=$REF_B" /etc/polynovea/polynovea.env && ok "the pin is B's digest"
docker exec "$AGENT" python3 -I -B /opt/polynovea/upgrade-agent.py && ok "the same request is not run twice"

step "Restore test on a healthy backup"
docker exec -w /app "$CMS" node scripts/polynovea-cms.mjs system restore-test --reason manual || fail "restore test failed on a healthy backup"
[ "$(psql_cms "select status from public.system_restore_tests order by started_at desc limit 1")" = passed ] && ok "restore test passed and recorded"
psql_cms "select checks_json->'ledger' from public.system_restore_tests order by started_at desc limit 1"
[ -z "$(docker exec "$CMS" sh -c 'ls -A /var/lib/polynovea/restore-test 2>/dev/null')" ] && ok "temporary restore folder removed"

step "Restore test on a corrupted backup raises an alert"
docker exec "$CMS" sh -ec '
  repo=/var/lib/polynovea/pgbackrest/backup/polynovea
  full="$(ls -1 "$repo" | grep -E "F$" | sort | tail -1)"
  # Data files only (pg_data/ or bundle/), not the manifest: the damage pgBackRest must catch on restore.
  find "$repo/$full" -type f -size +8k ! -name "backup.manifest*" | head -40 | while read -r f; do
    size=$(stat -c %s "$f"); printf "\377\377\377\377" | dd of="$f" bs=1 seek=$((size / 2)) conv=notrunc 2>/dev/null
  done
  echo "corrupted files in backup $full"'
if docker exec -w /app "$CMS" node scripts/polynovea-cms.mjs system restore-test --reason manual; then fail "restore test passed on a corrupted backup"; fi
ROW="$(psql_cms "select status || ' ' || coalesce(error_code, '') from public.system_restore_tests order by started_at desc limit 1")"
[ "$ROW" = "failed RESTORE_FAILED" ] && ok "restore test recorded as failed (RESTORE_FAILED): a blocking Doctor finding and a System page banner" || fail "unexpected restore test row: $ROW"
[ "$(psql_cms "select count(*) from public.platform_audit_events where action = 'system.restore_test.failed'")" -ge 0 ] && echo "audit events: $(psql_cms "select string_agg(action, ', ' order by created_at) from public.platform_audit_events where action like 'system.%'")"
[ -z "$(docker exec "$CMS" sh -c 'ls -A /var/lib/polynovea/restore-test 2>/dev/null')" ] && ok "temporary restore folder removed after the failure"

step "All upgrade checks passed"
