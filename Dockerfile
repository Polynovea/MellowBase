# syntax=docker/dockerfile:1.7
#
# Polynovea CMS server image: the Next.js standalone server, the delivery worker, and PostgreSQL 16
# with pgBackRest for the setup wizard's "On this server" option. Runs as uid/gid 10001.
#
# Build (amd64 and arm64): see docs/self-hosting/release-signing.md, or
#   docker buildx build --platform linux/amd64 --build-arg POLYNOVEA_RELEASE_ID=0.4.0+abc1234 -t polynovea-cms:dev .
#
# Base images are pinned by digest. To update one, look up the new digest with
#   docker buildx imagetools inspect node:24-trixie-slim
# and change it here; the release script records every digest in the SBOM.

ARG NODE_IMAGE=node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0

# ---- 1. Build: once, on the build machine's own architecture (the output is JavaScript) -------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY . .
# The delivery worker runs as one bundled JavaScript file (no TypeScript loader in the image).
RUN POLYNOVEA_STANDALONE=1 npm run build \
 && node scripts/build-delivery-worker.mjs \
 && node docker/trace-runtime.mjs /src /src/.next/standalone \
 && rm -rf /src/.next/standalone/node_modules/sharp /src/.next/standalone/node_modules/@img

# sharp (image resizing) is the one native module: fetch the binary for the image's architecture.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS sharp
ARG TARGETARCH
WORKDIR /sharp
COPY package-lock.json /tmp/package-lock.json
RUN SHARP_VERSION="$(node -p "require('/tmp/package-lock.json').packages['node_modules/sharp'].version")" \
 && case "$TARGETARCH" in amd64) CPU=x64 ;; arm64) CPU=arm64 ;; *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; esac \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund --loglevel=error --os=linux --cpu="$CPU" --libc=glibc "sharp@$SHARP_VERSION"

# The PostgreSQL apt repository's signing key, checked against its published fingerprint.
FROM ${NODE_IMAGE} AS pgdg-key
ARG PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/pgdg.asc \
 && gpg --batch --show-keys --with-colons /tmp/pgdg.asc | awk -F: '$1=="fpr"{print $10; exit}' | grep -qx "$PGDG_KEY_FINGERPRINT" \
 && gpg --batch --dearmor -o /pgdg.gpg /tmp/pgdg.asc

# ---- 2. Runtime ---------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG POLYNOVEA_RELEASE_ID=dev
ARG POLYNOVEA_VERSION=0.0.0-dev
ARG POLYNOVEA_REVISION=unknown

LABEL org.opencontainers.image.title="Polynovea CMS" \
      org.opencontainers.image.description="Polynovea CMS server: app, worker and bundled PostgreSQL 16 for the On this server option" \
      org.opencontainers.image.source="https://github.com/Polynovea/MellowBase" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${POLYNOVEA_VERSION}" \
      org.opencontainers.image.revision="${POLYNOVEA_REVISION}" \
      io.polynovea.release-id="${POLYNOVEA_RELEASE_ID}"

COPY --from=pgdg-key /pgdg.gpg /usr/share/keyrings/pgdg.gpg
# PostgreSQL 16 and pgBackRest from the PostgreSQL project's repository (Debian's pgBackRest is too old
# for cloud-identity backups). postgresql-common must not create its own cluster: local-db.sh does.
# Packages are pinned by major version (PostgreSQL 16) on a base pinned by digest, so each build gets
# that series' security fixes; the exact versions of every package are recorded in the release SBOM.
# hadolint ignore=DL3008
RUN set -eux \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && mkdir -p /etc/postgresql-common/createcluster.d \
 && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/polynovea.conf \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16 pgbackrest \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && groupadd --gid 10001 polynovea \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /var/lib/polynovea --shell /usr/sbin/nologin polynovea \
 && install -d -o 10001 -g 10001 -m 0700 /var/lib/polynovea \
 && install -d -o 10001 -g 10001 -m 0700 /var/run/postgresql \
 && chmod g-s /var/run/postgresql \
 && rm -f /etc/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf

WORKDIR /app
COPY --from=build --chown=0:0 /src/.next/standalone ./
COPY --from=build --chown=0:0 /src/.next/static ./.next/static
COPY --from=build --chown=0:0 /src/public ./public
COPY --from=build --chown=0:0 /src/supabase/migrations ./supabase/migrations
COPY --from=build --chown=0:0 /src/lib/setup/database/ca ./lib/setup/database/ca
COPY --from=sharp --chown=0:0 /sharp/node_modules/sharp ./node_modules/sharp
COPY --from=sharp --chown=0:0 /sharp/node_modules/@img ./node_modules/@img
COPY --chown=0:0 --chmod=0755 docker/local-db.sh /opt/polynovea/bin/local-db.sh
COPY --chown=0:0 --chmod=0755 docker/entrypoint.mjs /opt/polynovea/bin/entrypoint.mjs
COPY --chown=0:0 --chmod=0644 docker/entrypoint-lib.mjs /opt/polynovea/bin/entrypoint-lib.mjs
# Files checked out on Windows may have CRLF endings; the shell script must not.
RUN sed -i 's/\r$//' /opt/polynovea/bin/local-db.sh

# HOSTNAME=127.0.0.1: the CMS listens on this machine only. Reach it through an SSH tunnel, or put an
# HTTPS proxy on the same machine (or in the same network namespace) and set POLYNOVEA_TRUSTED_PROXIES.
# See docs/self-hosting/container.md.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.1 \
    PORT=3000 \
    POLYNOVEA_IMAGE=1 \
    POLYNOVEA_CONFIG_DIR=/var/lib/polynovea \
    POLYNOVEA_RELEASE_ID=${POLYNOVEA_RELEASE_ID} \
    PATH=/usr/lib/postgresql/16/bin:/usr/local/bin:/usr/bin:/bin

USER 10001:10001
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/polynovea/bin/entrypoint.mjs"]
