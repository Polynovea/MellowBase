# Running Polynovea CMS from the server image

The Polynovea server image holds everything the CMS needs on one server:

- the CMS itself (the Next.js server);
- the delivery worker (publishing, webhooks, search, scheduled releases);
- the schema worker, which applies the model changes saved in the CMS to the database;
- PostgreSQL 16 and pgBackRest, used only if you choose **On this server** in the setup wizard.

It runs as an unprivileged user (uid/gid 10001), never as root, on Node.js 24 (24.7 or later, needed for the password hashing). Every base image is pinned by digest, and every release is signed (see [release-signing.md](release-signing.md)). Always run the image by digest (`…@sha256:…`), never by a tag.

On AWS or Azure, use our VM images or cloud templates instead: they do all of this for you. See [vm-images.md](vm-images.md).

## Security: what the CMS process can reach today

Read this before you run the image. Inside the container, the CMS, both workers and (in **On this server** mode) PostgreSQL all run as the same user, 10001. That has two consequences:

- **The database owner login can be reached from the CMS process.** `config.enc` holds two database logins: `polynovea_app`, which the CMS uses for every request, and `polynovea_owner`, which owns every CMS table. Upgrades use the owner login to run migrations, and the schema worker uses it to apply model changes. The CMS process holds the master key, so it can decrypt `config.enc` and read the owner login too. With that login, anyone can read and change all content in every workspace and change the database structure, without the CMS's permission checks or row-level security.
- **On this server mode: the database administrator can be reached too.** PostgreSQL runs as the same user, and the administrator `postgres` signs in through the local socket by matching that user, with no password. So the CMS process can connect as the database administrator and read the database's files directly.

What this means in practice: nothing changes for normal use. Every request still goes through the `polynovea_app` login, the CMS's permission checks and row-level security. The risk is a flaw that lets an attacker run their own code inside the CMS process. Today, such an attacker would get the owner login and, in On this server mode, full administrator access to the database. Until that changes:

- run images by digest and upgrade as soon as a release is out;
- run only the CMS (and Caddy) on this server, and keep the setup routes as described below;
- prefer a managed database if you need the database administrator kept away from the CMS server.

**What comes next.** The next hardening change gives each process its own user:
- the CMS on 10001;
- the schema worker on 10002, with the owner login in a separate file only it can read;
- the bundled PostgreSQL on 10003, where the CMS user can no longer sign in as administrator.

This page will say when that change ships.

## What you need

- Docker on a Linux server.
- **A volume at `/var/lib/polynovea`.** It holds the master key, the encrypted settings (`config.enc`), the bundled database and its local backups, and logs. Without it, all of that disappears with the container, so the CMS warns at start and the wizard refuses **On this server**. A named Docker volume works as is. A folder on the host must be owned by uid/gid 10001:

  ```
  sudo install -d -o 10001 -g 10001 -m 0700 /srv/polynovea
  ```

- **Back up the master key** (`/var/lib/polynovea/master.key`) somewhere separate from the database backups. Without it, the settings and stored secrets cannot be read. A backup stored next to its key protects nothing.

## Reaching the setup wizard: two supported routes

The CMS in the image listens on **127.0.0.1:3000 only** (`HOSTNAME=127.0.0.1`). This is deliberate, and it decides how you reach it.

### Why not just publish port 3000?

With `docker run -p 3000:3000`, every connection reaches the CMS from Docker's gateway address (for example `172.17.0.1`), never from `127.0.0.1`, and the CMS has to listen on `0.0.0.0`. The setup wizard accepts plain HTTP only through a real SSH tunnel: the CMS listening on loopback only, and the connection coming from loopback. Through a published port it cannot tell your SSH tunnel from anyone on the network, so **it refuses setup over plain HTTP. This is by design, not a bug.** (Checked by `scripts/image/run-smoke.sh`: setup through a published port is answered 403.)

So use one of these:

| Route | Use it when | What you get |
| --- | --- | --- |
| **SSH tunnel** (host networking) | You have no domain yet, or you want setup to stay private | `http://localhost:3000/setup` through `ssh -L`. Free; no certificate needed |
| **HTTPS proxy** (Caddy) | The server has a domain pointing at it, with ports 80 and 443 open | `https://your-domain/setup`, with a Let's Encrypt certificate |

Both are in [`docker/compose.yaml`](../../docker/compose.yaml) as Compose profiles.

### Route 1: SSH tunnel (`tunnel` profile)

```
POLYNOVEA_IMAGE=registry.example/polynovea-cms@sha256:<digest> docker compose -f docker/compose.yaml --profile tunnel up -d
```

or, without Compose:

```
docker run -d --name polynovea --restart unless-stopped --network host \
  --security-opt no-new-privileges:true --cap-drop ALL \
  -v polynovea-data:/var/lib/polynovea \
  registry.example/polynovea-cms@sha256:<digest>
```

`--network host` puts the CMS on the server's own loopback, so an SSH tunnel reaches it from `127.0.0.1`. Then, on your own computer:

```
ssh -L 3000:localhost:3000 you@your-server
```

Open `http://localhost:3000/setup`, and enter the setup code from `docker logs polynovea`. Host networking needs a Linux server; Docker Desktop on Windows or macOS does not give containers the computer's own loopback.

### Route 2: HTTPS through Caddy (`proxy` profile)

Point your domain's DNS at the server, open ports 80 and 443, then:

```
POLYNOVEA_IMAGE=registry.example/polynovea-cms@sha256:<digest> POLYNOVEA_DOMAIN=cms.example.com \
  docker compose -f docker/compose.yaml --profile proxy up -d
```

Caddy (its own container, pinned by digest) gets a certificate from Let's Encrypt and forwards to the CMS. The CMS joins Caddy's network namespace, so it sees Caddy at `127.0.0.1`; Caddy owns the namespace, so restarting or upgrading the CMS does not take HTTPS down. The profile sets:

- `POLYNOVEA_TRUSTED_PROXIES=127.0.0.1`, so the CMS believes Caddy's "this was HTTPS" and visitor-address headers, and nobody else's;
- `POLYNOVEA_PUBLIC_URL=https://<your domain>`, so the wizard accepts requests from that address only.

Open `https://cms.example.com/setup`. With `POLYNOVEA_PUBLIC_URL` set, setup must go through that address: the SSH tunnel is refused, because its address (`localhost`) is not the public one.

Using your own load balancer or proxy instead of Caddy: run it on the same machine (or in the container's network), forward to `127.0.0.1:3000`, and set `POLYNOVEA_TRUSTED_PROXIES` to the address it connects from and `POLYNOVEA_PUBLIC_URL` to its HTTPS address. Never trust a proxy address that other machines can reach directly.

## Settings the image sets for you

| Variable | Value in the image | Change it? |
| --- | --- | --- |
| `HOSTNAME` | `127.0.0.1` | No: see above |
| `PORT` | `3000` | Only together with your proxy |
| `POLYNOVEA_CONFIG_DIR` | `/var/lib/polynovea` | No |
| `POLYNOVEA_IMAGE` | `1` (enables **On this server**) | No |
| `POLYNOVEA_RELEASE_ID` | The release, e.g. `0.4.0+abc1234` | No: `/api/health` reports it |
| `NODE_ENV` | `production` | No |

Optional settings you may pass (`-e` or an env file): `POLYNOVEA_PUBLIC_URL`, `POLYNOVEA_TRUSTED_PROXIES`, `POLYNOVEA_DB_SECRET_REF` (the cloud templates' database secret), `AWS_REGION`, `POLYNOVEA_SETUP_DB_ALLOWLIST`, `POLYNOVEA_WORKER=0` (run without the worker). Never put passwords or keys in an env file: the wizard keeps secrets in `config.enc`.

## What runs inside

`tini` starts `entrypoint.mjs`, which:

1. checks `/var/lib/polynovea` is writable;
2. starts the bundled PostgreSQL **only if** this install chose **On this server** (installs on a managed database never run it);
3. starts the CMS. If the CMS stops, the container stops, and Docker or systemd restarts it;
4. starts the two workers once the install has a database (before that, it checks every 15 seconds), and restarts each with a back-off if it stops. The delivery worker signs in as `polynovea_app`. The schema worker signs in as `polynovea_owner` (see [Security: what the CMS process can reach today](#security-what-the-cms-process-can-reach-today));
5. on `docker stop`: stops the workers, then the CMS, then PostgreSQL (a clean, fast shutdown). Allow it 90 seconds (`--stop-timeout 90` or Compose's `stop_grace_period`).

`/api/health` answers `{"state": "setup" | "running" | "unavailable", "release": "<release ID>"}`. The image's health check calls it.

## On this server: the bundled database

When you choose **On this server** in the wizard:

- The database lives in `/var/lib/polynovea/postgresql`. The wizard refuses if that folder is on the container's own filesystem rather than a volume.
- PostgreSQL listens on `127.0.0.1:5432` and a unix socket in `/var/run/postgresql` (private to the CMS's user) only. With host networking, that is the server's own loopback, so nothing outside the server can reach it.
- Who may sign in:
  - the administrator `postgres`: through the unix socket only, and only as the image's own user (peer authentication). It has no password at all. The CMS also runs as that user, so it can sign in as the administrator too (see [Security: what the CMS process can reach today](#security-what-the-cms-process-can-reach-today)).
  - `polynovea_owner` and `polynovea_app`: the `polynovea` database only, from `127.0.0.1` only, with SCRAM passwords that the wizard generates and keeps in `config.enc`.
  - everything else is rejected.
- Backups: pgBackRest, encrypted, to your S3 bucket, Azure container or the data disk (see [setup/database.md](setup/database.md)). Its settings are in `/var/lib/polynovea/etc/pgbackrest.conf`, and its logs and the database's logs are in `/var/lib/polynovea/log` (database logs are kept for a week).
- For S3 or Azure backups, the container uses the server's instance role or managed identity. On AWS that needs the instance's metadata hop limit set to 2; our VM image and templates do that. A hop limit of 2 means any container on that VM, including ones on a bridge network, can obtain the instance role's credentials, so run only the CMS (and Caddy) there; see [vm-images.md](vm-images.md#instance-metadata-and-credentials-aws).
- PostgreSQL 16, pgBackRest and Node.js inside the image get security fixes only through new Polynovea release images, not from the host's updates. Upgrade when a release is out.

## Running the operator commands

```
docker exec -it polynovea node scripts/polynovea-cms.mjs --help
docker exec -it polynovea node scripts/run-migrations.mjs --all
```

## What is tested where

The image itself is checked end to end on a developer machine (`scripts/image/run-smoke.sh`): setup over the SSH-tunnel route and through Caddy, "On this server" with a full backup to the data disk, and the restart cases. Not run locally, by design: backups to a real S3 bucket or Azure container, a real Let's Encrypt certificate, and host networking on a real Linux server. Subrojit's first Azure deployment covers them. See also [vm-images.md](vm-images.md#what-is-tested-where).

## Building the image yourself

```
docker buildx build --platform linux/amd64 -t polynovea-cms:local .
scripts/image/run-smoke.sh            # builds and checks it end to end (heavy: several minutes)
```

Releases are built, signed and checked by `scripts/release/build-and-sign.mjs` ([release-signing.md](release-signing.md)).
