#!/usr/bin/env bash
# Local checks for the VM image files (release/packer, docker/Caddyfile). No cloud account, no VM.
#
#   scripts/image/test-vm-files.sh
#
# 1. provision.sh and verify-images.sh in an Ubuntu 24.04 container, with apt-get, systemctl, docker and cloud-init
#    replaced by recorders:
#    - the image-build path (Packer) and the plain-Ubuntu path (POLYNOVEA_START_NOW=1) install exactly
#      the same files and enable the same units; only the second starts them;
#    - running it a second time changes nothing, and leaves an already-mounted data disk alone.
# 2. console-code.sh: the setup-code line reaches the console in setup mode only; nothing in running
#    mode, nothing when the CMS does not answer, and no other log line ever.
# 3. The Caddyfile with and without POLYNOVEA_ACME_EMAIL (caddy adapt).
set -euo pipefail

export PATH="/c/Program Files/Docker/Docker/resources/bin:$PATH"
cd "$(dirname "$0")/../.."
UBUNTU="ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289"
CADDY="$(sed -n 's/^ *image: \(caddy:.*\)$/\1/p' docker/compose.yaml)"
SRC="$(pwd)"
if command -v cygpath >/dev/null 2>&1; then SRC="$(cygpath -w "$SRC")"; fi
export MSYS_NO_PATHCONV=1

echo "== 1. provision.sh: both boot paths, run twice"
docker run --rm -i -v "$SRC:/src:ro" "$UBUNTU" bash -euo pipefail <<'EOF'
mkdir -p /stubs
for tool in apt-get systemctl cloud-init; do
  printf '#!/bin/sh\necho "%s $*" >> /tmp/calls.log\nexit 0\n' "$tool" > "/stubs/$tool"
  chmod +x "/stubs/$tool"
done
# docker stand-in: a registry (/tmp/registry-down makes it unreachable), a local image store
# (/tmp/local), and cosign: `docker run ... verify ... <ref>` succeeds only for refs in /tmp/signed.
cat > /stubs/docker <<'STUB'
#!/bin/sh
echo "docker $*" >> /tmp/calls.log
for a; do last="$a"; done
case "$1" in
  pull) [ -e /tmp/registry-down ] && exit 1; echo "$last" >> /tmp/local; exit 0 ;;
  image) grep -qxF "$last" /tmp/local 2>/dev/null; exit $? ;;
  run) case " $* " in *" verify "*) [ -e /tmp/registry-down ] && exit 1; grep -qxF "$last" /tmp/signed 2>/dev/null; exit $? ;; esac; exit 0 ;;
esac
exit 0
STUB
chmod +x /stubs/docker
export PATH="/stubs:$PATH"
export POLYNOVEA_IMAGE_REF="ghcr.io/polynovea/cms@sha256:$(printf 'a%.0s' $(seq 64))"
export POLYNOVEA_CADDY_IMAGE_REF="caddy:2.10-alpine@sha256:$(printf 'b%.0s' $(seq 64))"
export POLYNOVEA_RELEASE_ID="0.4.0+abc1234" POLYNOVEA_CLOUD=aws

echo "$POLYNOVEA_IMAGE_REF" > /tmp/signed
FAKE_KEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtestonlytestonlytestonlytestonly
-----END PUBLIC KEY-----'
stage() {
  rm -rf /tmp/polynovea-files; cp -r /src/release/packer/files /tmp/polynovea-files; cp /src/docker/Caddyfile /tmp/polynovea-files/
  printf '%s\n' "$FAKE_KEY" > /tmp/polynovea-files/polynovea-release.pub
}
# What systemd does to start a unit: every ExecStartPre in order, then (stubbed) ExecStart. 0 = started.
start_unit() {
  grep '^ExecStartPre=' "/etc/systemd/system/$1" | sed 's/^ExecStartPre=//' | while IFS= read -r cmd; do
    sh -c "$cmd" >/dev/null 2>&1 || exit 1
  done
}
snapshot() {
  find /etc/polynovea /opt/polynovea /etc/systemd/system /etc/docker /etc/systemd/journald.conf.d /etc/apt/apt.conf.d \
    -type f \( -path '*polynovea*' -o -name daemon.json -o -name 20auto-upgrades -o -name '52polynovea*' \) \
    -exec sha256sum {} + | sort -k2
  stat -c '%n %a %u:%g' /var/lib/polynovea /var/lib/polynovea-caddy /opt/polynovea/*.sh
}
clean() { rm -rf /etc/polynovea /opt/polynovea /etc/systemd/system/polynovea* /etc/systemd/system/var-lib-polynovea.mount /var/lib/polynovea /var/lib/polynovea-caddy /var/lib/polynovea-verified /tmp/calls.log /tmp/local; }

stage; sh /src/release/packer/provision.sh >/dev/null
snapshot > /tmp/image-path.txt
grep '^systemctl enable docker.service polynovea' /tmp/calls.log > /tmp/image-enable.txt
if grep -q '^systemctl start' /tmp/calls.log; then echo "FAIL: the image-build path started services"; exit 1; fi
echo "ok    image-build path: files installed, units enabled, nothing started"

stage; sh /src/release/packer/provision.sh >/dev/null
snapshot > /tmp/image-path-2.txt
diff /tmp/image-path.txt /tmp/image-path-2.txt && echo "ok    running it again changes nothing"

clean; stage; POLYNOVEA_START_NOW=1 sh /src/release/packer/provision.sh >/dev/null
snapshot > /tmp/plain-path.txt
grep '^systemctl enable docker.service polynovea' /tmp/calls.log > /tmp/plain-enable.txt
diff /tmp/image-path.txt /tmp/plain-path.txt && diff /tmp/image-enable.txt /tmp/plain-enable.txt && echo "ok    plain-Ubuntu path ends with the same files and enabled units"
grep -q '^systemctl start --no-block polynovea-data-disk.service var-lib-polynovea.mount polynovea-console-code.service polynovea.service polynovea-caddy.service$' /tmp/calls.log && echo "ok    plain-Ubuntu path starts the services at once"

# A box whose data disk is already mounted and owned by the CMS user: left alone.
chown 10001:10001 /var/lib/polynovea && chmod 0700 /var/lib/polynovea
echo "keep" > /var/lib/polynovea/master.key
stage; POLYNOVEA_START_NOW=1 sh /src/release/packer/provision.sh >/dev/null
[ "$(stat -c '%a %u:%g' /var/lib/polynovea)" = "700 10001:10001" ] && [ "$(cat /var/lib/polynovea/master.key)" = keep ] && echo "ok    an existing data folder keeps its owner, mode and contents"
grep -q "^POLYNOVEA_IMAGE_REF=$POLYNOVEA_IMAGE_REF$" /etc/polynovea/image.env && echo "ok    image.env records the digest-pinned image"
if [ -e /etc/polynovea/polynovea.env ]; then echo "FAIL: provision.sh wrote polynovea.env"; exit 1; fi
echo "ok    polynovea.env is left to the templates"

echo "-- image check before every start (verify-images.sh), on both paths"
UNSIGNED="ghcr.io/polynovea/cms@sha256:$(printf 'c%.0s' $(seq 64))"
for path in image plain; do
  clean; rm -f /tmp/registry-down; stage
  if [ "$path" = plain ]; then export POLYNOVEA_START_NOW=1; else unset POLYNOVEA_START_NOW; fi
  sh /src/release/packer/provision.sh >/dev/null
  start_unit polynovea.service && echo "ok    [$path] signed, pinned image: polynovea.service starts"
  start_unit polynovea-caddy.service && echo "ok    [$path] pinned Caddy image: polynovea-caddy.service starts"

  echo "POLYNOVEA_IMAGE_REF=$UNSIGNED" > /etc/polynovea/polynovea.env
  if start_unit polynovea.service; then echo "FAIL: [$path] an unsigned image started"; exit 1; fi
  echo "ok    [$path] bad signature: polynovea.service does not start"

  echo "POLYNOVEA_IMAGE_REF=ghcr.io/polynovea/cms:latest" > /etc/polynovea/polynovea.env
  if start_unit polynovea.service; then echo "FAIL: [$path] an image by tag started"; exit 1; fi
  echo "ok    [$path] image not pinned by digest: does not start"

  echo "POLYNOVEA_CADDY_IMAGE_REF=caddy:latest" > /etc/polynovea/polynovea.env
  if start_unit polynovea-caddy.service; then echo "FAIL: [$path] Caddy by tag started"; exit 1; fi
  echo "ok    [$path] Caddy not pinned by digest: does not start"
  rm -f /etc/polynovea/polynovea.env

  touch /tmp/registry-down
  start_unit polynovea.service && echo "ok    [$path] registry unreachable: the image already verified with this key still starts"
  echo "POLYNOVEA_IMAGE_REF=$UNSIGNED" > /etc/polynovea/polynovea.env
  if start_unit polynovea.service; then echo "FAIL: [$path] unverified image started with the registry down"; exit 1; fi
  echo "ok    [$path] registry unreachable: a not-yet-verified image does not start"
  rm -f /etc/polynovea/polynovea.env /tmp/registry-down

  mv /etc/polynovea/release.pub /tmp/release.pub.bak; rm -rf /var/lib/polynovea-verified/*
  if start_unit polynovea.service; then echo "FAIL: [$path] started without a release key"; exit 1; fi
  echo "ok    [$path] no release public key: does not start"
  mv /tmp/release.pub.bak /etc/polynovea/release.pub
done
unset POLYNOVEA_START_NOW

clean; stage; cp /tmp/signed /tmp/signed.bak; : > /tmp/signed
if POLYNOVEA_START_NOW=1 sh /src/release/packer/provision.sh >/dev/null 2>&1; then echo "FAIL: provision accepted an unsigned image"; exit 1; fi
if grep -q '^systemctl start' /tmp/calls.log; then echo "FAIL: services started after a failed check"; exit 1; fi
echo "ok    provision.sh stops before starting anything when the image's signature is bad"
mv /tmp/signed.bak /tmp/signed

clean; stage; rm /tmp/polynovea-files/polynovea-release.pub
if sh /src/release/packer/provision.sh >/dev/null 2>&1; then echo "FAIL: provision ran without the release key"; exit 1; fi
echo "ok    provision.sh refuses to run without the release public key"
EOF

echo "== 2. console-code.sh: setup mode only"
docker run --rm -i -v "$SRC:/src:ro" "$UBUNTU" bash -euo pipefail <<'EOF'
mkdir -p /stubs
# curl stand-in: answers with /tmp/health, or fails like an unreachable server when it is missing.
printf '#!/bin/sh\n[ -f /tmp/health ] || exit 7\ncat /tmp/health\n' > /stubs/curl; chmod +x /stubs/curl
export PATH="/stubs:$PATH" POLYNOVEA_CONSOLE=/tmp/console POLYNOVEA_HEALTH_WAIT=2
LOG='[setup] This CMS is not set up yet.
[setup] Open http://127.0.0.1:3000/setup to finish setup.
[setup] Setup code: ABCD-EFGH-JKMN-PQRS-TVWX-YZ  (works once, for 1 hour; a restart issues a new one)
[auth] some other line with a secret=xyz'
run() { : > /tmp/console; printf '%s\n' "$LOG" | sh /src/release/packer/files/console-code.sh; }

echo '{"state":"setup","release":"0.4.0+abc1234"}' > /tmp/health; run
[ "$(cat /tmp/console)" = "Polynovea CMS setup code: ABCD-EFGH-JKMN-PQRS-TVWX-YZ (works once, for 1 hour; a restart issues a new one)" ] && echo "ok    setup mode: exactly the one code line on the console"

echo '{"state":"running","release":"0.4.0+abc1234"}' > /tmp/health; run
[ ! -s /tmp/console ] && echo "ok    running mode: nothing on the console"

rm -f /tmp/health; run
[ ! -s /tmp/console ] && echo "ok    CMS not answering: nothing on the console (fails closed)"

echo '{"state":"setup"}' > /tmp/health
: > /tmp/console
printf '%s\n' '[setup] Setup code: $(reboot)  (works once' 'x [setup] Setup code: ABCD-EFGH-JKMN-PQRS-TVWX-YZ  (works once, for 1 hour)' | sh /src/release/packer/files/console-code.sh
[ ! -s /tmp/console ] && echo "ok    malformed or embedded code lines are ignored"

UNIT=/src/release/packer/files/polynovea-console-code.service
EXEC="$(grep '^ExecStart=' "$UNIT")"
printf '%s' "$EXEC" | grep -q "journalctl .*_SYSTEMD_UNIT=docker.service CONTAINER_NAME=polynovea " && ! printf '%s' "$EXEC" | grep -q SYSLOG_IDENTIFIER \
  || { echo "FAIL: the console service must read only dockerd's entries for the polynovea container"; exit 1; }
echo "ok    the console service reads only journald-attested dockerd entries for the polynovea container"
for setting in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes; do
  grep -qx "$setting" "$UNIT" || { echo "FAIL: console service lacks $setting"; exit 1; }
done
echo "ok    the console service is sandboxed (NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp)"
EOF

echo "== 3. Caddyfile with and without POLYNOVEA_ACME_EMAIL"
adapt() { docker run --rm -e POLYNOVEA_DOMAIN=cms.example.com -e "POLYNOVEA_CADDY_EMAIL_OPTION=$1" -v "$SRC/docker/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY" caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null; }
without="$(adapt "")"
with="$(adapt "email ops@example.com")"
printf '%s' "$without" | grep -q '"host":\["cms.example.com"\]' && ! printf '%s' "$without" | grep -q '"email"' && echo "ok    no email: config valid, automatic HTTPS for the domain, no email option"
printf '%s' "$with" | grep -q '"email":"ops@example.com"' && echo "ok    with email: the ACME account email is set"
printf '%s' "$with" | grep -q '"dial":"127.0.0.1:3000"' && echo "ok    forwards to the CMS on 127.0.0.1:3000"

echo "== VM file checks passed"
