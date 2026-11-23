# Modes and keys

## Modes

At start-up the CMS decides which of three modes it is in, and logs it.

| What it finds | Mode | What is served |
| --- | --- | --- |
| No database settings | **setup** | Only `/setup`, `/api/setup/*`, the wizard's static files and `/api/health`. Everything else answers 503 with a link to `/setup`. |
| Settings, database reachable, no `installation` row | **setup** (resuming) | The same; the wizard skips its database step. |
| Settings, database reachable, `installation` row | **running** | Everything except `/setup` and `/api/setup/*`, which answer 404. |
| Settings, but the database cannot be reached, `config.enc` cannot be decrypted, or migrations have not run on an existing install | **unavailable** | Only `/api/health`. Everything else answers 503. |

"Database settings" means `config.enc` (written by the wizard) or, for installs set up before the
wizard, `POLYNOVEA_DATABASE_URL` / `DATABASE_URL`.

- **An install with settings never drops back into setup mode.** A database outage gives 503s, not
  the wizard, so nobody can take over a live install while its database is down.
- Unavailable is retried every few seconds; when the database comes back the CMS carries on
  without a restart.
- Finishing setup inserts the single `installation` row in the same transaction that creates the
  owner. Two browsers finishing at once cannot both win: the second insert fails. The CMS's runtime
  login can insert that row but never change or delete it, so a stolen app password cannot reopen
  setup.
- `/api/health` always answers 200 with `{"state": "setup" | "running" | "unavailable"}`.

The rules are enforced twice: by the route gate (`middleware.ts`) and again by the database pool
and the setup routes themselves, because a framework bug can skip the gate (CVE-2025-29927).

While the CMS is in setup mode and listening on anything other than `127.0.0.1` or `localhost`, it
logs a warning every 5 minutes. Finish setup promptly, or bind the server to `127.0.0.1` until you
can.

### Upgrading an existing install

Migration `0072_installation` gives existing installs their `installation` row (owner: the oldest
active master admin), so they keep running. Run the migrations before starting the new release; if
the new release starts first, it reports unavailable ("migrations pending") until they have run.

## The master key

Everything the CMS encrypts is protected by one master key ring:

- `config.enc`: the database address, the two database role passwords, the session secret and
  the backup encryption password;
- secrets stored in the database: publication target settings, webhook signing secrets, credentials
  in the encrypted PostgreSQL secret store;
- the signing key for file and upload links.

The master key itself is never used directly; each of these gets its own key derived from it.

**Where it comes from.** Either you set `CMS_MASTER_KEY`, or the first start creates
`/var/lib/polynovea/master.key` (change the folder with `POLYNOVEA_CONFIG_DIR`). The wizard shows
the created key once.

**Keep a copy somewhere else.** It is the one secret that cannot be regenerated: without it,
`config.enc` and every stored secret are unreadable. Store it in your password manager or secrets
vault, never next to the database backups: a backup and its key stored together protect nothing.

**Files.** `POLYNOVEA_CONFIG_DIR` must belong to the user the CMS runs as (not root), mode 0700;
`master.key` and `config.enc` are 0600. The CMS refuses files other users can read.

**Hosts without a writable disk** (serverless platforms) must set `CMS_MASTER_KEY`.

### Rotating the key

```
CMS_MASTER_KEY=k20270101:<new key>,k20261123:<old key>
```

1. Put a new key first and keep the old one after it. Restart. New values use the new key; old
   ones still decrypt.
2. Run `npm run cms -- keys reencrypt` on the server (add `--dry-run` first to see the counts).
   It rewrites every stored secret and `config.enc` under the new key, in small batches, prints
   counts before and after, and is safe to run again. Run it as the user the CMS runs as.
3. Remove the old key and restart.

A key ID is letters, digits, `-` and `_`, up to 32 characters. Generate a key with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### Moving off CMS_CONFIG_ENCRYPTION_KEY

Installs from before the wizard encrypted stored secrets with `CMS_CONFIG_ENCRYPTION_KEY`. This
release still reads them with that key and writes new values with the master key ring.

1. Start this release with `CMS_CONFIG_ENCRYPTION_KEY` still set. The first start creates
   `master.key` (or set `CMS_MASTER_KEY`).
2. Run `npm run cms -- keys reencrypt`. When it reports `legacy 0` for every column, the old key is
   no longer needed for stored secrets.
3. File and media links signed before the upgrade still verify only while
   `CMS_CONFIG_ENCRYPTION_KEY` is set. Leave it set until the media links in your content have been
   re-saved, or ask for help before removing it.
