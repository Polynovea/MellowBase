#!/bin/sh
# Turns an Ubuntu 24.04 LTS VM into a Polynovea CMS server. Two callers, one script, same end state:
#
# - Packer, while building the AMI or Azure image (aws.pkr.hcl, azure.pkr.hcl). The services are
#   enabled and start when a VM is launched from the image.
# - The cloud templates' bootstrap on a plain Ubuntu VM, with POLYNOVEA_START_NOW=1: the same steps,
#   then the services start at once. Start it with systemd-run from user data, not inline: the first
#   step waits for cloud-init to finish, which would deadlock inside cloud-init itself.
#
# Safe to run again on a box that is already set up (it changes nothing that is already right, and
# never touches /etc/polynovea/polynovea.env or the data disk's contents).
#
# Needs: POLYNOVEA_IMAGE_REF (pinned by digest), POLYNOVEA_CADDY_IMAGE_REF, POLYNOVEA_RELEASE_ID,
# POLYNOVEA_CLOUD (aws|azure), and the files from release/packer/files plus docker/Caddyfile in
# /tmp/polynovea-files (or POLYNOVEA_FILES). They must include polynovea-release.pub, the release
# signing key's public half: without it this script stops, because no image could be verified.
set -eu

: "${POLYNOVEA_IMAGE_REF:?}" "${POLYNOVEA_CADDY_IMAGE_REF:?}" "${POLYNOVEA_RELEASE_ID:?}" "${POLYNOVEA_CLOUD:?}"
case "$POLYNOVEA_IMAGE_REF" in *@sha256:*) ;; *) echo "POLYNOVEA_IMAGE_REF must be pinned by digest" >&2; exit 1 ;; esac
case "$POLYNOVEA_CADDY_IMAGE_REF" in *@sha256:*) ;; *) echo "POLYNOVEA_CADDY_IMAGE_REF must be pinned by digest" >&2; exit 1 ;; esac
FILES="${POLYNOVEA_FILES:-/tmp/polynovea-files}"
COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v2.6.1@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037"
grep -q "BEGIN PUBLIC KEY" "$FILES/polynovea-release.pub" 2>/dev/null || {
  echo "provision: $FILES/polynovea-release.pub (the release public key) is missing" >&2
  exit 1
}
export DEBIAN_FRONTEND=noninteractive

# Let cloud-init finish its own apt work first.
cloud-init status --wait >/dev/null 2>&1 || true

# 1. Patched base, Docker from Ubuntu's archive (so it gets Ubuntu's security updates), and automatic
#    security updates.
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold dist-upgrade
# python3: the upgrade agent (upgrade-agent.py, standard library only).
apt-get install -y --no-install-recommends docker.io unattended-upgrades ca-certificates curl e2fsprogs util-linux python3
install -m 0644 "$FILES/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
install -m 0644 "$FILES/52polynovea-unattended-upgrades" /etc/apt/apt.conf.d/52polynovea-unattended-upgrades

# 2. Docker: logs to the journal (kept 14 days). live-restore stays off on purpose: the CMS runs in the
#    foreground of polynovea.service (docker run --rm), so when dockerd restarts (for example a security
#    update), systemd restarts the service and verify-images.sh checks the image again before it starts.
install -d -m 0755 /etc/docker /etc/systemd/journald.conf.d
install -m 0644 "$FILES/daemon.json" /etc/docker/daemon.json
install -m 0644 "$FILES/journald-polynovea.conf" /etc/systemd/journald.conf.d/polynovea.conf

# 3. Polynovea: scripts, units, the HTTPS proxy's config, and which image this VM image carries.
install -d -m 0755 /opt/polynovea /etc/polynovea
install -m 0755 "$FILES/run-cms.sh" "$FILES/run-caddy.sh" "$FILES/has-domain.sh" "$FILES/data-disk.sh" "$FILES/console-code.sh" "$FILES/verify-images.sh" /opt/polynovea/
install -m 0755 "$FILES/upgrade-agent.py" /opt/polynovea/upgrade-agent.py
install -m 0644 "$FILES/Caddyfile" /etc/polynovea/Caddyfile
install -m 0644 "$FILES/polynovea-release.pub" /etc/polynovea/release.pub
sed -i 's/\r$//' /opt/polynovea/*.sh /opt/polynovea/upgrade-agent.py /etc/polynovea/Caddyfile /etc/polynovea/release.pub /etc/apt/apt.conf.d/52polynovea-unattended-upgrades /etc/apt/apt.conf.d/20auto-upgrades
cat >/etc/polynovea/image.env <<EOF
# Written by provision.sh. /etc/polynovea/polynovea.env may override POLYNOVEA_IMAGE_REF.
POLYNOVEA_IMAGE_REF=$POLYNOVEA_IMAGE_REF
POLYNOVEA_CADDY_IMAGE_REF=$POLYNOVEA_CADDY_IMAGE_REF
POLYNOVEA_RELEASE_ID=$POLYNOVEA_RELEASE_ID
POLYNOVEA_CLOUD=$POLYNOVEA_CLOUD
EOF
chmod 0644 /etc/polynovea/image.env
# polynovea-upgrade.service has no [Install]: polynovea-upgrade.path starts it when the CMS asks.
UNITS="polynovea-data-disk.service var-lib-polynovea.mount polynovea-console-code.service polynovea.service polynovea-caddy.service polynovea-upgrade.path polynovea-upgrade-recover.service"
for unit in $UNITS polynovea-upgrade.service; do
  install -m 0644 "$FILES/$unit" "/etc/systemd/system/$unit"
  sed -i 's/\r$//' "/etc/systemd/system/$unit"
done
# Mount point and Caddy's state. Left alone when they exist (the data disk may already be mounted).
[ -d /var/lib/polynovea ] || install -d -m 0755 /var/lib/polynovea
[ -d /var/lib/polynovea-caddy ] || install -d -m 0700 /var/lib/polynovea-caddy
[ -d /var/lib/polynovea-verified ] || install -d -m 0700 /var/lib/polynovea-verified
# The upgrade agent's status folder (root-owned, mounted read-only into the CMS) and its "installed" marker.
install -d -o root -g root -m 0755 /var/lib/polynovea-upgrade
python3 -I -B /opt/polynovea/upgrade-agent.py --mark

# 4. The images, pulled by digest (content-addressed), and the CMS image's release signature checked
#    now, so a build or bootstrap with a bad image stops here. The units check again before every start.
systemctl enable --now docker.service
docker pull "$POLYNOVEA_IMAGE_REF"
docker pull "$POLYNOVEA_CADDY_IMAGE_REF"
docker pull "$COSIGN_IMAGE"
/opt/polynovea/verify-images.sh
/opt/polynovea/verify-images.sh caddy

systemctl daemon-reload
# shellcheck disable=SC2086 # UNITS is a list
systemctl enable docker.service $UNITS

# 5. Clean up.
apt-get -y autoremove --purge
apt-get clean
rm -rf /var/lib/apt/lists/* "$FILES"

# 6. Plain-Ubuntu bootstrap only: start now (a VM made from the image starts them at boot).
if [ "${POLYNOVEA_START_NOW:-0}" = 1 ]; then
  # shellcheck disable=SC2086 # UNITS is a list
  systemctl start --no-block $UNITS
fi
