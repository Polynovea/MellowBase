# ADR-014: Object Storage Provider Interface

**Status:** Accepted; provider interface implemented (see status update 2026-11-22)
**Date:** 2026-09-01
**Phase:** 1 (pre-Milestone-B cleanup)

## Status update — 2026-11-22

The interface this ADR deferred now exists. The decision text below is kept as
the historical record; this section describes the current code.

- `lib/media/storageProvider.ts` defines `StorageProvider` (`upload`,
  `remove`, `resolveReadUrl`, optional `createPresignedUpload`) and
  `getStorageProvider()`, which resolves the provider for a workspace and
  environment. The upload routes (`app/api/upload/route.ts`,
  `app/api/upload/sas/route.ts`), `app/api/assets/route.ts`,
  `app/api/v1/media/route.ts`, `lib/media/assetService.ts` and
  `lib/media/replacementService.ts` go through it.
- Adapters:
  - Cloudflare R2, AWS S3 and MinIO (`storage.r2`, `storage.s3`,
    `storage.minio` connections) share one adapter built on the AWS SDK
    (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
  - Supabase Storage (`storage.supabase` connections) uses the Supabase
    client. It does not implement `createPresignedUpload`; the direct-upload
    route returns an error for it and clients use the authenticated upload
    route instead.
  - A legacy R2 provider wraps `lib/r2Storage.ts` and its `R2_*` environment
    variables. It is used for assets recorded with provider key `r2`, when no
    workspace is given, or when no active storage connection exists and the
    `R2_*` credentials are set.
- Connection-backed adapters are configured per workspace environment through
  workspace connections (credentials resolved by
  `lib/infrastructure/credentialProvider`), not through process environment
  variables.
- `createPresignedUpload(key, contentType, contentLength)` now takes the
  declared size. Content type and content length are signed into the URL
  (15-minute expiry), so storage rejects a body of a different size or type.
- The asset record anticipated below exists: `assets`
  (`supabase/migrations/0011_assets.sql`) stores `storage_provider`,
  `storage_key`, `mime_type`, `size_bytes`, `checksum` and `metadata_json`,
  not a public URL. Connection-backed assets record `connection:<id>` as the
  provider key so reads and deletes resolve the same connection.
- Not implemented: Azure Blob and local-filesystem adapters. Any other storage
  connector type fails with "has no media data-plane adapter".

The "Current deployment" consequence below (a single implicit
`cloudflare_r2` provider) no longer holds.

## Context

`lib/r2Storage.ts` is Polynovea's real, intended media storage
implementation (Cloudflare R2, accessed via its S3-compatible API — not a
stand-in for AWS S3, and not being migrated to AWS S3/Azure Blob/Supabase
Storage for portability's own sake, per the corrected Phase 1 direction).
Its function names, however, carried provider-specific and historically
stale terminology: `generateUploadSasUrl` used "SAS" (an Azure Blob
Storage term, left over from an earlier implementation that predates R2),
and `uploadBlob`/`deleteBlob` named the operation after Azure's "blob"
terminology rather than the generic object-storage operation it actually
performs against an S3-compatible API.

## Decision

**Done now** (mechanical rename, no behavior change):
`lib/r2Storage.ts` exports `uploadObject`, `deleteObject`,
`createPresignedUpload`, and `resolveObjectUrl` — provider-neutral names,
updated at both call sites (`app/api/upload/route.ts`,
`app/api/upload/sas/route.ts`). No new abstraction layer, interface, or
class was introduced; this is naming cleanup only.

**Deferred, designed toward but not built in Phase 1**: a formal
`ObjectStorageProvider` interface (conceptually: `uploadObject`,
`deleteObject`, `createPresignedUpload`, `resolveObjectUrl` as an
interface `lib/r2Storage.ts` implements, alongside future implementations
for AWS S3, Azure Blob, MinIO, Supabase Storage, or local filesystem for
development). Building this now, with exactly one real implementation and
no second consumer, would be speculative abstraction with no current
payoff — the four function names above are already the shape that
interface would have, so introducing it later is a mechanical wrap, not a
redesign.

When the generic asset/media engine is eventually built (Phase 2+, per the
original roadmap — explicitly out of scope for Phase 1), the canonical
asset record must store `provider`, `storage_key`, `mime_type`, `size`,
`checksum`, and `metadata` — not a raw Cloudflare public URL as the asset's
canonical identity. `resolveObjectUrl(key)` already exists as the one place
that turns a key into a URL, which is exactly the seam that record shape
needs.

## Consequences

- Current deployment: `provider = "cloudflare_r2"` is implicit (there's
  only one implementation); it becomes an explicit column value once the
  assets table exists.
- No functional or behavioral change from this ADR — it is a pure rename at
  the module boundary, verified by TypeScript compilation catching every
  call site (there is no pre-existing test suite for the upload routes to
  regress; adding one is tracked as a test gap, not covered by this ADR).
