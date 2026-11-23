#!/bin/sh
# Turns a fresh Ubuntu 24.04 LTS VM into a Polynovea CMS server image. Run once by Packer as root
# (aws.pkr.hcl, azure.pkr.hcl). On a plain Ubuntu VM, the cloud templates can run the same steps.
#
# Needs: POLYNOVEA_IMAGE_REF (pinned by digest), POLYNOVEA_CADDY_IMAGE_REF, POLYNOVEA_RELEASE_ID,
# POLYNOVEA_CLOUD (aws|azure), and the files from deploy/packer/files in /tmp/polynovea-files.
set -eu

: "${POLYNOVEA_IMAGE_REF:?}" "${POLYNOVEA_CADDY_IMAGE_REF:?}" "${POLYNOVEA_RELEASE_ID:?}" "${POLYNOVEA_CLOUD:?}"
case "$POLYNOVEA_IMAGE_REF" in *@sha256:*) ;; *) echo "POLYNOVEA_IMAGE_REF must be pinned by digest" >&2; exit 1 ;; esac
case "$POLYNOVEA_CADDY_IMAGE_REF" in *@sha256:*) ;; *) echo "POLYNOVEA_CADDY_IMAGE_REF must be pinned by digest" >&2; exit 1 ;; esac
FILES=/tmp/polynovea-files
export DEBIAN_FRONTEND=noninteractive

# Let cloud-init finish its own apt work first.
cloud-init status --wait >/dev/null 2>&1 || true

# 1. Patched base, Docker from Ubuntu's archive (so it gets Ubuntu's security updates), and automatic
#    security updates.
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold dist-upgrade
apt-get install -y --no-install-recommends docker.io unattended-upgrades ca-certificates e2fsprogs util-linux
install -m 0644 "$FILES/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades
install -m 0644 "$FILES/52polynovea-unattended-upgrades" /etc/apt/apt.conf.d/52polynovea-unattended-upgrades

# 2. Docker: logs to the journal (kept 14 days), containers keep running while the daemon restarts.
install -d -m 0755 /etc/docker /etc/systemd/journald.conf.d
install -m 0644 "$FILES/daemon.json" /etc/docker/daemon.json
install -m 0644 "$FILES/journald-polynovea.conf" /etc/systemd/journald.conf.d/polynovea.conf

# 3. Polynovea: scripts, units, the HTTPS proxy's config, and which image this VM image carries.
install -d -m 0755 /opt/polynovea /etc/polynovea
install -m 0755 "$FILES/run-cms.sh" "$FILES/run-caddy.sh" "$FILES/has-domain.sh" "$FILES/data-disk.sh" /opt/polynovea/
install -m 0644 "$FILES/Caddyfile" /etc/polynovea/Caddyfile
sed -i 's/\r$//' /opt/polynovea/*.sh /etc/polynovea/Caddyfile /etc/apt/apt.conf.d/52polynovea-unattended-upgrades /etc/apt/apt.conf.d/20auto-upgrades
cat >/etc/polynovea/image.env <<EOF
# Written when this VM image was built. /etc/polynovea/polynovea.env may override POLYNOVEA_IMAGE_REF.
POLYNOVEA_IMAGE_REF=$POLYNOVEA_IMAGE_REF
POLYNOVEA_CADDY_IMAGE_REF=$POLYNOVEA_CADDY_IMAGE_REF
POLYNOVEA_RELEASE_ID=$POLYNOVEA_RELEASE_ID
POLYNOVEA_CLOUD=$POLYNOVEA_CLOUD
EOF
chmod 0644 /etc/polynovea/image.env
for unit in polynovea-data-disk.service var-lib-polynovea.mount polynovea.service polynovea-caddy.service; do
  install -m 0644 "$FILES/$unit" "/etc/systemd/system/$unit"
  sed -i 's/\r$//' "/etc/systemd/system/$unit"
done
install -d -m 0755 /var/lib/polynovea /var/lib/polynovea-caddy

# 4. The images, pulled by digest (content-addressed: what runs is exactly what was signed).
systemctl enable --now docker.service
docker pull "$POLYNOVEA_IMAGE_REF"
docker pull "$POLYNOVEA_CADDY_IMAGE_REF"

systemctl daemon-reload
systemctl enable docker.service polynovea-data-disk.service var-lib-polynovea.mount polynovea.service polynovea-caddy.service

# 5. Clean up.
apt-get -y autoremove --purge
apt-get clean
rm -rf /var/lib/apt/lists/* "$FILES"
