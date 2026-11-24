#!/bin/sh
# Finds the VM's data disk and gives it the POLYNOVEA_DATA label, so var-lib-polynovea.mount can mount
# it at /var/lib/polynovea. Runs at every boot (polynovea-data-disk.service) and does nothing once a
# disk with that label exists.
#
# It formats a disk ONLY when all of these hold: it is a whole disk, not the root disk, has no
# partitions, no filesystem or other signature, is not mounted, and it is the only such candidate.
# Candidates: POLYNOVEA_DATA_DEVICE from /etc/polynovea/polynovea.env when set; else Azure's data disk
# at LUN 0; else AWS EBS volumes (never instance-store disks). A disk that already has data is never
# touched: then set POLYNOVEA_DATA_DEVICE, or label it yourself (e2label <device> POLYNOVEA_DATA).
set -eu

LABEL=POLYNOVEA_DATA
ENV_FILE=/etc/polynovea/polynovea.env
WAIT_SECONDS=300

log() { echo "polynovea-data-disk: $*"; }

if [ -e "/dev/disk/by-label/$LABEL" ]; then
  exit 0
fi

configured=""
if [ -f "$ENV_FILE" ]; then
  configured="$(sed -n 's/^POLYNOVEA_DATA_DEVICE=//p' "$ENV_FILE" | tail -1 | tr -d '"'"'"'[:space:]')"
fi
case "$configured" in
  "" | /dev/*) ;;
  *) log "POLYNOVEA_DATA_DEVICE must be a /dev path"; exit 1 ;;
esac

root_disk="$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null | head -1)"

candidates() {
  if [ -n "$configured" ]; then
    readlink -f "$configured"
    return
  fi
  for azure in /dev/disk/azure/data/by-lun/0 /dev/disk/azure/scsi1/lun0; do
    if [ -e "$azure" ]; then
      readlink -f "$azure"
      return
    fi
  done
  lsblk -dpno NAME,TYPE,MODEL | awk '$2 == "disk" && /Amazon Elastic Block Store/ { print $1 }'
}

usable() { # device
  dev="$1"
  [ -b "$dev" ] || return 1
  [ "$(basename "$dev")" != "$root_disk" ] || return 1
  [ "$(lsblk -no TYPE "$dev" | head -1)" = disk ] || return 1
  [ "$(lsblk -no NAME "$dev" | wc -l)" -eq 1 ] || return 1          # no partitions
  [ -z "$(lsblk -no MOUNTPOINTS "$dev" | tr -d '[:space:]')" ] || return 1
  [ -z "$(wipefs --no-act --noheadings "$dev" 2>/dev/null)" ] || return 1   # no signature of any kind
  return 0
}

waited=0
while :; do
  found=""
  count=0
  for dev in $(candidates); do
    if usable "$dev"; then
      found="$dev"
      count=$((count + 1))
    fi
  done
  [ -e "/dev/disk/by-label/$LABEL" ] && exit 0
  if [ "$count" -eq 1 ]; then
    break
  fi
  if [ "$count" -gt 1 ]; then
    log "more than one empty disk; set POLYNOVEA_DATA_DEVICE in $ENV_FILE"
    exit 1
  fi
  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    log "no empty data disk found. Attach a separate disk for /var/lib/polynovea (the CMS will not use the root disk)."
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done

log "formatting $found as ext4 ($LABEL)"
mkfs.ext4 -q -L "$LABEL" -m 1 "$found"
udevadm settle
