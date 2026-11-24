# Upgrades, health checks and restore tests

The **System** page (Admin → System) shows the server's health, finds newer signed releases, upgrades
to them, and lists restore tests. This page explains what happens behind it.

## Release channel

Set `POLYNOVEA_RELEASE_CHANNEL_URL` in `/etc/polynovea/polynovea.env` (VM) or `polynovea.env` (compose)
to an HTTPS folder you trust. Unset, the server never looks for updates. The folder holds:

| File | Written by | Trusted? |
| --- | --- | --- |
| `latest.json`: `{"schema":1,"releaseId":"0.4.1+abc1234","release":"0.4.1/release.json","signature":"0.4.1/release.json.sig"}` | whoever publishes | No: a pointer only |
| `release.json` | `scripts/release/build-and-sign.mjs` | Only after its signature verifies |
| `release.json.sig` | `cosign sign-blob` | — |
| changelog (optional) | release machine | Only if its SHA-256 matches `release.json`'s `changelog.sha256` |

`release.json` may carry `"rollback": "compatible"`: the previous release runs correctly on this
release's database schema. Without it, a failed upgrade restores the pre-upgrade backup (see below),
and the System page asks the admin to confirm that before starting.

Every channel fetch is HTTPS only (redirects too), size-capped and time-limited. The page shows a
release only after `release.json`'s signature verifies with the installed release key
(`/etc/polynovea/release.pub`, mounted read-only into the CMS).

## What an upgrade does

The CMS has no Docker access. When an admin clicks **Upgrade**, it writes
`/var/lib/polynovea/upgrade-requests/request.json`. The systemd path unit `polynovea-upgrade.path` starts
the root agent `/opt/polynovea/upgrade-agent.py`, which reads only the release ID from that file:

1. **Verify**: fetch `release.json` from the channel itself, check its signature and the image's signature with
   the pinned cosign image and the installed key. A release that is not newer than the running one is refused.
2. **Backup**: on the bundled database, a pgBackRest incremental backup. On a managed database, a `pg_dump` to
   `/var/lib/polynovea/backups/pre-upgrade/` (the last two are kept).
3. **Pull** the image by digest.
4. **Migrate**: a one-shot container of the new image applies pending migrations while the old release keeps serving.
5. **Start**: pin the new digest (`POLYNOVEA_IMAGE_REF`) and restart `polynovea.service`. `verify-images.sh` checks it again.
6. **Health**: `/api/health` must report `"state":"running"` and the new release within 2 minutes.
7. **Switch**: the new release stays; it is recorded as the last good one.

If step 6 fails, the agent switches back to the previous digest. If the release did not declare
compatible migrations, it first restores the pre-upgrade pgBackRest backup (bundled database). On a
managed database it cannot do that, so the status is "restore needed": restore the pre-upgrade dump or
the cloud's point-in-time backup from just before the upgrade.

Every step is written to `/var/lib/polynovea-upgrade/status.json` (root-owned, read-only for the CMS)
and copied into the audit log (`system.upgrade.*` events).

**Known limits.** The switch stops the old release before starting the new one, because the bundled
PostgreSQL lives inside the CMS container. The CMS is unavailable for about 20–40 seconds. Zero-downtime
switching for managed-database installs is a later improvement.

## Health checks (System Doctor)

Database answers; database connection encrypted and its CA bundle current; data disk under 80 %; a backup
in the last 26 hours (or the cloud's automated backups for managed databases); a restore test passed in
the last 35 days; no pending migrations; the background worker reported in the last 2 minutes; the
sign-in library not in `lib/system/advisories.json`. The same checks appear in the infrastructure
doctor on the server image.

## Restore tests

The worker restores the newest pgBackRest backup into `/var/lib/polynovea/restore-test/<id>` once after
setup's first backup and then monthly, at the lowest CPU and IO priority. It starts a temporary PostgreSQL
there with no network listener and no archiving, compares the migration ledger and core row counts with the
live database, then stops it and deletes the folder. With less free disk than 1.2 × the database plus its
WAL, the test is skipped with a warning. A failed test is a blocking health finding, an audit event and a
red banner on the System page. Managed databases are tested in the cloud console.
