# Media storage

Media (images, video, PDFs) is stored through a **storage connection** on the workspace environment
(Admin > Connections). Each connection type is an adapter behind `lib/media/storageProvider.ts`.

| Connection type | Where files live | Authentication | Browser uploads | Read links |
| --- | --- | --- | --- | --- |
| `storage.local` | This server's data disk (`POLYNOVEA_STORAGE_DIR`) | none (same machine) | CMS signed upload link | CMS signed link, 1 hour |
| `storage.azure-blob` | Azure Blob container | VM managed identity | CMS signed upload link | User delegation SAS, 1 hour |
| `storage.s3` / `storage.r2` / `storage.minio` | S3-compatible bucket | access key | S3 presigned PUT | S3 presigned GET, 1 hour, or public URL |
| `storage.supabase` | Supabase Storage bucket (optional connector for existing installs) | service role key | not offered; authenticated upload route | Supabase signed URL or public URL |

Every browser upload is bound to one key, one content type and one exact size, valid for 15 minutes.
S3 enforces this through the signed `Content-Type` and `Content-Length`. Azure SAS and the local disk
have no way to sign a size, so for those the browser uploads to the CMS (`PUT /api/storage/upload/<token>`),
which checks the type, counts the bytes as they stream, checks the file signature (magic bytes) and only
commits the object when the body is exactly the signed size. Objects are never overwritten.

## On this server (`storage.local`)

For the "on this server" install without a bucket.

- Files are written under `POLYNOVEA_STORAGE_DIR` (default `/var/lib/polynovea/storage`), one directory
  per workspace. The directory is created with mode `0750`, files with `0640`; run the CMS as its own
  user that owns this directory.
- Files are served by `GET /api/storage/files/<token>/<name>`. The token is an HMAC-SHA256 signature over
  the key and an expiry (1 hour), checked in constant time. Links need no session, so public pages can
  embed them, and they stop working when they expire. Range requests are supported for video.
- Files are served only as an allowlisted media type detected from their bytes, with `nosniff` and a
  sandboxing `Content-Security-Policy`; anything else is a download.
- Storage keys are validated segment by segment, resolved under the root, and the real path (after
  symlinks) must stay inside the root's real path. The final file is opened with `O_NOFOLLOW`.
- Uploads are refused when they would leave less than `POLYNOVEA_STORAGE_MIN_FREE_BYTES` free on the disk
  (default 1 GiB), because the database may share it.
- Set **CMS URL for File Links** (`appUrl`) on the connection to the public URL of the CMS, so stored
  links work outside the admin.

**Backups.** This directory is data, exactly like the database. Include it in the server's backup set
alongside the pgBackRest repository (for example a nightly `restic`/`azcopy`/`aws s3 sync` of
`/var/lib/polynovea/storage` to the same off-server bucket or container pgBackRest uses), and restore it
together with a point-in-time database restore. A database restored without its media directory has
asset rows that point at missing files.

## Azure Blob (`storage.azure-blob`)

- Give the VM a managed identity and grant it **Storage Blob Data Contributor** on the container (this
  role can also request the user delegation key used to sign read links). For a user-assigned identity,
  put its client ID in **Managed Identity Client ID**. No storage key is stored anywhere.
- Read links are user delegation SAS URLs: read-only, one blob, HTTPS only, 1 hour. The delegation key
  is cached for under two hours and renewed automatically.
- Outside Local environments the endpoint must be an HTTPS Azure blob host (`*.blob.core.windows.net` or
  a sovereign-cloud equivalent). A Storage private endpoint in the VM's network is supported: those names
  may resolve to private addresses, unlike the generic rule for other connections.
- A connection string (with `AccountKey`) is accepted only for Local and Development environments, for
  Azurite or a developer account.
- Set **CMS URL for Upload Links** (`appUrl`) to the public URL of the CMS.

## Signing key

Signed CMS links use `POLYNOVEA_STORAGE_SIGNING_KEY`: base64 of at least 32 random bytes
(`openssl rand -base64 32`). To rotate, put the new key first and keep the old one after a comma until
links signed with it have expired (1 hour): `POLYNOVEA_STORAGE_SIGNING_KEY=<new>,<old>`. When it is unset,
the key is derived from `CMS_CONFIG_ENCRYPTION_KEY` with HKDF under a storage-only label.

## Local development with Azurite

`node scripts/dev-db/setup.mjs` also starts an Azurite blob service for this checkout and writes
`POLYNOVEA_TEST_AZURITE_CONNECTION_STRING` to `.env.test.local`; `lib/media/azureBlobStorage.azurite.test.ts`
runs against it and is skipped when it is not configured.
