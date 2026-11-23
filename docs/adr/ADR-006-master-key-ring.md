# ADR-006: Master Key Ring

**Status:** Accepted
**Date:** 2026-11-23
**Phase:** Self-hosted upgrade, phase 2 (setup wizard)

## Context

Before phase 2 the CMS had one encryption secret, `CMS_CONFIG_ENCRYPTION_KEY`: a raw AES-256 key
used directly for every secret stored in the database, with no key ID, so it could not be rotated
without breaking every stored value. Storage link signing derived its key from the same variable.

The setup wizard adds a second kind of secret, the install's own settings (`config.enc`: database
address, role passwords, auth secret, backup password), which must be encrypted before any
database exists. A non-technical owner cannot be asked to supply a key at first boot.

## Decision

1. **One master key ring protects everything.** `CMS_MASTER_KEY=kid1:base64,kid2:base64`, each key
   exactly 32 bytes. The first key encrypts and signs; every key decrypts and verifies.
2. **Generated at first boot when not supplied.** With only the legacy `CMS_CONFIG_ENCRYPTION_KEY`
   set, the ring is that key under the key ID `legacy` and nothing is generated (decision 5).
   Without either variable the CMS creates
   `<POLYNOVEA_CONFIG_DIR>/master.key` (default `/var/lib/polynovea`): 32 random bytes, file 0600,
   folder 0700, owned by the service user. The CMS refuses to run these steps as root, and on POSIX
   refuses a key or config file that other users can read. The wizard shows the key once so the
   owner can store it away from the database backups.
3. **The master key is never used directly.** Each use derives its own key with HKDF-SHA256 (salt
   `polynovea-key-ring/v1`, info `polynovea/<purpose>/v1`) for the purposes `config`,
   `secure-config` and `storage-signing`. A flaw in one use cannot expose another's key.
4. **Self-describing ciphertext.** `config.enc` is `{v:1,kid,iv,tag,ct}` (AES-256-GCM, additional
   data `polynovea-config:v1`). Database secrets are `pv2.<kid>.<base64(iv|tag|ct)>` (AES-256-GCM,
   additional data `polynovea-secure-config:v2`). The key ID picks the key, so rotation is: put a new
   key first, run `polynovea-cms keys reencrypt`, remove the old key.
5. **Legacy for one release.** Unprefixed ciphertext is still read with `CMS_CONFIG_ENCRYPTION_KEY`.
   `keys reencrypt` moves those values (batched, one transaction per batch, safe to re-run, counts
   before and after). When `CMS_CONFIG_ENCRYPTION_KEY` is set and `CMS_MASTER_KEY` is not, the ring is
   the legacy key itself (kid `legacy`, HKDF purpose keys as for any master key) and no `master.key`
   is generated. A per-host generated key would split replicas, a worker on another host or user, or
   a non-persistent config folder into different keys; the shared variable keeps every process on
   the same `pv2.legacy.` values. Using the legacy key as HKDF input is safe: the derived keys use
   their own salt and labels, so they are independent of the raw key the old values used and of the
   old storage-signing derivation. When `CMS_MASTER_KEY` is added later, the legacy key stays in the
   ring for reading (unless the operator lists a `legacy` entry themselves) until `keys reencrypt` has
   moved its values.
6. **Storage links** are signed with the ring's `storage-signing` key. The key derived from
   `CMS_CONFIG_ENCRYPTION_KEY` still verifies (never signs) while that variable is set.
   `POLYNOVEA_STORAGE_SIGNING_KEY`, when set, still replaces both.

## Consequences

- Key rotation is possible for the first time, and a stolen database backup is useless without the
  key file or variable.
- **The master key cannot be regenerated.** Losing it loses `config.enc` and every stored secret.
  The wizard's owner step must make the owner save it; the docs say to back it up separately.
- Hosts without a writable disk (serverless platforms) must set `CMS_MASTER_KEY` (or keep the
  legacy variable).
- Permanent media links in content signed with the legacy-derived key stop verifying once
  `CMS_CONFIG_ENCRYPTION_KEY` is removed; `keys reencrypt` cannot rewrite links embedded in
  content. Before removing the variable, either keep the old links' key as the last entry of
  `POLYNOVEA_STORAGE_SIGNING_KEY`, or re-insert the media. A follow-up should rewrite them.
- Later: the ring can be backed by AWS KMS or Azure Key Vault (envelope encryption) without changing
  the ciphertext formats, since only the source of the master keys changes.
