#!/bin/sh
# Checks the VM's systemd units with systemd-analyze (any Linux with systemd; no root, nothing installed):
#   sh release/packer/verify-units.sh
# `verify` catches syntax and dependency errors; `security` scores the upgrade agent's sandbox. Neither
# starts anything: that the agent works under the sandbox is only proven on a real VM (docs/self-hosting/upgrades.md).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$here"/files/*.service "$here"/files/*.path "$here"/files/*.mount "$work"/
chmod 0644 "$work"/*
for file in "$work"/*; do sed -i 's/\r$//' "$file"; done
# Stand-ins for units the base image provides.
printf '[Unit]\nDescription=stand-in\n[Service]\nExecStart=/bin/true\n' > "$work/docker.service"
printf '[Unit]\nDescription=stand-in\n' > "$work/network-online.target"
systemd-analyze --version | head -1
status=0
for unit in polynovea-upgrade.service polynovea-upgrade-recover.service polynovea-upgrade.path; do
  if out="$(SYSTEMD_UNIT_PATH="$work:" systemd-analyze verify --man=no "$work/$unit" 2>&1)" && [ -z "$out" ]; then
    echo "ok    systemd-analyze verify $unit"
  else
    echo "FAIL  systemd-analyze verify $unit"; echo "$out"; status=1
  fi
done
for unit in polynovea-upgrade.service polynovea-upgrade-recover.service; do
  SYSTEMD_UNIT_PATH="$work:" systemd-analyze security --offline=true --no-pager "$work/$unit" 2>/dev/null | tail -1 | sed "s/^/      $unit: /"
done
exit $status
