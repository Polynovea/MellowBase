# Changelog

## Unreleased

- Migration `0067` adds the `polynovea_owner` and `polynovea_app` database roles: the app role gets row access through a row-level security policy on every table, executes every CMS SQL function (no longer executable by `PUBLIC`), and cannot run DDL. On a plain PostgreSQL database `db:migrate` first creates the NOLOGIN role names older migrations grant to (`anon`, `authenticated`, `service_role`, `postgres`), or says exactly what an administrator must run. Supabase installs keep every existing grant.
- **Breaking:** PostgreSQL connections now always verify TLS certificates. Set `DATABASE_CA_CERT` or `DATABASE_CA_CERT_FILE` for providers with their own CA (Supabase, AWS RDS), or `sslmode=disable` for a private network. See `docs/self-hosting/POSTGRESQL.md`.
- Extension network requests now resolve the target host and refuse any private, loopback, link-local or metadata address.
- Upgraded Next.js to 15.5.29 and zod to 4.6.6, and patched undici, sharp, source-map-js, vite, vitest and brace-expansion.
- Removed slow-regex paths in upload naming and markdown link extraction, tightened schema.org context checks, pinned AES-GCM tag length and set read-only CI token permissions.
- `DELETE /api/upload` only removes unregistered objects under the caller's own workspace prefix; registered assets are retired through the asset API. Deletions are audited.
- Outbound requests (webhooks, publication targets, connection verification, S3/R2/MinIO and Supabase Storage clients, extension network broker, delivery worker) validate destination addresses at connect time, closing the DNS-rebinding window. IPv4-mapped IPv6 and other reserved ranges are now blocked. The delivery worker previously had no destination check.
- Admin sessions resolve the profile by the immutable auth user ID. Email links a legacy profile once, only when the identity's email is confirmed. Migration `0066` makes `admin_users.auth_user_id` unique.
- **Breaking (API):** `POST /api/upload/sas` requires `size` in bytes. The size and content type are signed into the upload URL. Single files are capped at 10 MB (images) and 200 MB (video), and an optional `MEDIA_WORKSPACE_QUOTA_BYTES` caps each workspace.
- API errors no longer expose database, driver, network or provider messages; they return the route's message with a reference ID that is logged server-side.
- Schema-run history reports query failures instead of an empty list; website revalidation has a 5-second timeout and reports failures.
- The shared modal is an accessible dialog (labelled, focus-trapped, restores focus); login fields have associated labels, autocomplete and announced errors.

## 0.1.0-alpha.1 — 2026-09-21

- Removed the identity-specific master-account runtime bypass; every administrator now requires an auditable profile, workspace membership and role assignment.
- Added a server-only `bootstrap:admin` command and migration `0064` to retire the legacy client bootstrap policies safely.
- Admin create/update flows now keep default-workspace membership and system roles synchronized.
- Added a checksum-ledger-aware `db:migrate` command for fresh installs and controlled upgrades.
- Removed the bundled container runtime and its admin controls; OSS V1 now has one documented Node.js plus Supabase-compatible deployment path.
- Governed agent identity, provenance and constrained extension foundations.
- Governed MCP transport package.
- Supabase browser configuration now fails explicitly when absent; it no longer contains a Polynovea project fallback.
- Delivery Operations UI now lists every worker job kind, and publication delivery resolves its configured signing secret correctly.
- Expanded README, self-hosting, contribution and security documentation; direct generic PostgreSQL runtime support is explicitly deferred.
- CI/release gates now include the production build, SDK build, CLI smoke test and `git diff --check` in addition to type-check, lint, tests, audit and secret scanning.
- Added `npm run certify:live` and recorded a clean managed-Supabase install, owner bootstrap, authenticated Phases 8–13, worker execution, production restart and idempotent migration reconciliation.
- Added the idempotent `npm run seed:starter` onboarding command for a first Article model and welcome draft.

## Release status

Release engineering and repository certification evidence exist, but no version tag, package publication, deployment or public OSS release has been performed.
