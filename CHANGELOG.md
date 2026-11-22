# Changelog

## Unreleased

- The Command Center's recent jobs, findings, releases, environments and audit events have a stable order when rows share a timestamp (both data paths). Local test databases are now one stack per checkout (`node scripts/dev-db/setup.mjs`; `--down` removes it), and `npm run test:dual` refuses to start until both databases and PostgREST are on the newest migration.
- The admin activity log, the admin profile lookup behind sign-in, and the Command Center can run on the direct PostgreSQL path (`admin=postgres`). The Command Center reads each table once (10 queries instead of 26), and a failed activity-log write is now logged on the server instead of disappearing.
- Delivery jobs (the operations area) can run on the direct PostgreSQL path (`operations=postgres`). On the direct path, messages that the SQL functions raise for the caller (such as "Only terminal jobs can be replayed") reach the API caller whatever SQLSTATE they use, as they did over PostgREST, while errors from statements inside a function stay hidden.
- Database install works with a managed database's non-superuser admin (RDS master user, Azure administrator): the role step no longer names superuser-only attributes, takes temporary SET membership in the owner role for the schema owner change, sends SCRAM verifiers instead of plaintext passwords, closes temporary tables to PUBLIC, and refuses to continue if the owner or app role holds a bypass attribute. Migration `0068` fixes 0067's default privileges (new functions are not executable by PUBLIC), revokes EXECUTE from Supabase's `anon` and `authenticated` roles, and refuses member role assignments across workspaces; any such existing rows are moved to `member_roles_cross_workspace_archive`. The Supabase path's actor resolver and audit logger now report query errors instead of hiding them, and a failed audit insert no longer sends its webhook.
- **Security:** the CMS actor resolver now ignores a member's role assignment when the role belongs to another workspace (both data paths). Before, a `member_roles` row pointing at another workspace's role granted that role's permissions. The platform area (workspace lookup, actor resolver, role and collaborator lists) can run on the direct PostgreSQL path (`platform=postgres`).
- Content models (the schema area) can run on the direct PostgreSQL path (`schema=postgres`). Schema validation, diff classification and the unsafe-change gate are shared by both paths. On the direct path, database errors from creating or applying a model no longer reach the browser; the duplicate-apiKey conflict keeps its message. Model metadata updates moved from the route into the service and are scoped by workspace.
- Redirects can run on the direct PostgreSQL path (`routing=postgres`). Updates write their history row, the change and the audit event in one transaction, and bulk imports are atomic. Locale filters are bound parameters instead of a PostgREST filter string.
- Routes (the routing area's route service) can run on the direct PostgreSQL path (`routing=postgres`). Registering a route is atomic: a failed registration no longer clears the entry's canonical route. Path changes and deletions commit with their dependency edges and audit events. The single-route lookup moved from the route handler into the service.
- Navigation can run on the direct PostgreSQL path (`POLYNOVEA_DATA_BACKEND=...,navigation=postgres`). Menu creation, draft saves, publishing and deletion are atomic with their dependency edges and audit events, and concurrent draft saves get consecutive version numbers. Menu rename and delete moved from the route into the navigation service. Fixed: "where used" for navigation always returned nothing on Supabase (ambiguous relationship).
- The shared platform audit logger follows the `platform` switch in `POLYNOVEA_DATA_BACKEND`. On the direct path the audit row and its webhook deliveries are written in one transaction, and a failure is logged on the server instead of being dropped silently.
- Database provisioning no longer emulates Supabase on a plain PostgreSQL target: it stops creating the `auth.jwt()` shim, an `auth` schema and the `pgcrypto` extension (nothing uses them), and creates the compatibility role names without `BYPASSRLS`. The `postgres.pgcrypto` preflight check is gone.
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
