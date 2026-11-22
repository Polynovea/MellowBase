# Polynovea CMS: Upgrade Implementation Plan

22 November 2026 · Subrojit Roy · updated 23 November 2026 with the Phase 0 results

How we deliver the [Self-Hosted Platform Upgrade Design](Polynovea%20CMS%20Self-Hosted%20Platform%20Upgrade%20Design.md), step by step.

## Summary

The upgrade takes about 28 weeks with three full-time engineers (about 40 with two), delivered in six phases that each end in a working, releasable product. Nothing is a big-bang rewrite: the Supabase path keeps working until each area has moved and passed its tests.

| Phase | Weeks | What ships |
| --- | --- | --- |
| 0. Spike and foundations | 1–2 | One area running on plain PostgreSQL with the new auth; a measured estimate for phase 1 |
| 1. Plain PostgreSQL and built-in auth | 3–12 | The CMS runs on any PostgreSQL 15+ with no Supabase services |
| 2. Setup wizard | 11–15 | A fresh server becomes a secured CMS from the browser |
| 3. Real tables | 16–23 | User models are real PostgreSQL tables with safe migrations |
| 4. Generated API and typed SDK | 22–27 | Per-model REST API and TypeScript types |
| 5. One-click install and upgrades | 20–27 | AWS and Azure templates, signed releases, in-app upgrades |

**The code makes phase 1 easier than it looked.** Four facts from `main` (commit e133a80):

- Every query runs server-side through the service-role client (94 files), and permissions are checked in our own code. Moving to a direct connection is therefore mechanical: same queries, new client. One catch found in Phase 0: row-level security is switched on for all 140 tables with no policies, which works today only because Supabase's service role bypasses it. The roles migration must add a policy for the app role (see phase 1, roles).
- All ten GoTrue calls already sit in one file, `lib/auth/supabaseProvider.ts`. The provider boundary exists; we add a second implementation.
- The database's only ties to GoTrue are one trigger on `auth.users` (migration 0065) and the `admin_users.auth_user_id` column.
- API tokens (`developer_api_tokens`) are our own already and do not change.

The work is still large: about 577 table calls and 46 database-function calls across 12 code areas. The phase 0 spike replaces the 28-week figure with a measured one.

## Ground rules

Every change lands small, behind a switch, and with the same checks, so `main` is always releasable.

1. **One area per pull request.** A pull request moves one code area (for example taxonomy), never a cross-cutting rewrite. Target under 800 changed lines.
2. **Feature switch per area.** `POLYNOVEA_DATA_BACKEND` chooses `supabase` or `postgres` per area while phase 1 runs, so a moved area can be switched back in production without a deploy. The switch is deleted once every area passes.
3. **Same tests on both paths.** Each area's tests run against the Supabase path and the direct path until the switch is removed. A test that passes on one and fails on the other blocks the merge.
4. **Local CI before every pull request.** PRs are tested locally, never on the organisation's GitHub Actions minutes: no workflow is added, enabled or triggered. The local run is the gate: type-check, lint, unit tests, build, `npm audit`, secret scan, and Semgrep (`semgrep scan --config p/default --metrics off --exclude node_modules --exclude dist --exclude .next`). A pre-push hook runs it.
5. **Migrations are additive and reversible for one release.** No migration drops or renames something the previous release still reads.
6. **Security review on four kinds of change:** auth, anything that accepts a host or URL, anything that runs DDL, anything that handles secrets. A second person reads these before merging.
7. **Docs move with code.** Each phase updates the self-hosting guide, `.env.example`, the changelog and an ADR for each decision it settles.
8. **Branch protection stays on.** Only the team merges to `main`; every merge needs one approval and resolved review threads.

## Timeline

Phase 1 is the critical path: the wizard cannot start until auth lands, and real tables wait for the whole data layer. Public beta lands in week 28; the data layer is the long pole.

| Workstream | Weeks | 1–4 | 5–8 | 9–12 | 13–16 | 17–20 | 21–24 | 25–28 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0. Spike and foundations | 1–2 | ■ | | | | | | |
| **1. Data layer, 5 waves** | **3–12** | **■** | **■** | **■** | | | | |
| 1. Roles and storage | 3–6 | ■ | ■ | | | | | |
| 1. Built-in auth | 5–10 | | ■ | ■ | | | | |
| 2. Setup wizard | 11–15 | | | ■ | ■ | | | |
| 3. Real tables | 16–23 | | | | ■ | ■ | ■ | |
| 4. API and typed SDK | 22–27 | | | | | | ■ | ■ |
| 5. Install and upgrades | 20–27 | | | | | ■ | ■ | ■ |
| Releases | | | | 0.2 (wk 13) | 0.3 (wk 16) | | | 0.4 beta (wk 28) |

Phase 5 runs alongside phases 3 and 4 because it needs only the wizard. Release 0.3 (week 16) is the first a non-technical person can install; 0.4 in week 28 is the public beta.

## Phase 0: spike and foundations (weeks 1–2)

Phase 0 proves the approach on one small area end to end and settles the decisions phase 1 depends on.

**Foundations (week 1)**

- [x] Add Kysely and a `lib/db/` module: one `pg.Pool` per process (a `globalThis` singleton so Next.js reloads do not leak pools), about 10 connections, connection, idle and statement timeouts, TLS built by the existing `postgresTls.mjs`.
- [x] Generate Kysely table types from the 69 existing migrations with `kysely-codegen` against a local PostgreSQL 16, and commit them.
- [x] Add a `withTransaction` helper and a typed `callFunction(name, args)` for the 56 SQL functions now reached through `.rpc()`.
- [x] Add the per-area backend switch and a test helper that runs one test file against both backends.
- [x] Replace Supabase's `Session` and `User` types in `lib/auth/provider.ts` with our own neutral types; adapt the Supabase provider to them.

**Spike (week 2)**

- [x] Move the taxonomy area to the direct path: `lib/taxonomy` (24 calls) and its 6 API routes.
- [ ] Add a Better Auth provider behind the interface with email, password and TOTP, on a scratch branch, and sign in to the admin UI with it. (Provider done; admin UI sign-in carried over.)
- [ ] Run the full test suite and the taxonomy certification script on PostgreSQL 15, 16 and 17. (16 done; 15, 17 and the certification script carried over.)
- [x] Time every task. Calls moved per engineer-day from the spike sets the real phase 1 estimate. (Agent times recorded; an engineer timing is still needed, see Phase 0 results.)

**Decisions to sign off by the end of week 2**

| Decision | Proposed | Evidence the spike gives |
| --- | --- | --- |
| Data layer | Kysely | How the taxonomy move went |
| Auth library | Better Auth, pinned, four plugins | Whether it fits our interface without forking |
| Migration engine for phase 3 | Evaluate pgroll | A one-day test of pgroll on a copy of `content_entries` |
| Release unit | Container image plus a VM image built from it | Size and start time of a trial image |
| Licence | Owner's call | None needed; decide before public launch |

**Exit gate:** taxonomy runs on plain PostgreSQL with all tests green on both backends, a Better Auth login works, and the phase 1 estimate is updated from measured numbers.

### Phase 0 results (22 November 2026)

The engineering work ran in a separate session on branch `sroy/phase-0-407bed`. After a code review (10 findings, all fixed: among them the direct-path audit logger, public sign-up switched off, and a non-superuser owner role in the dev database) it was merged to `main` on 23 November 2026 as [PR #17](https://github.com/Polynovea/OSS1/pull/17) (`62ecc9f`). Most of the exit gate is met; four items carry over.

| Item | Status | Notes |
| --- | --- | --- |
| `lib/db/`: pool, TLS, timeouts, `withTransaction`, `callFunction`, backend switch | Done | `callFunction` is checked against the real list of SQL functions |
| Kysely types | Done | 140 tables and 49 SQL functions; `npm run db:types` regenerates them |
| Dual-backend tests | Done | `npm run test:dual`; refuses to start without both databases |
| Local databases | Done | `npm run db:dev`: PostgreSQL 16 on 127.0.0.1:25432 and a Supabase-compatible stack (PostgREST and GoTrue) on 25433/25480; all 69 migrations, rebuilt in 23 s |
| Neutral `Session` and `User` types | Done | 9 files updated |
| Taxonomy on the direct path | Done | 24 calls, 6 routes; 26 dual-backend tests pass, including a check that both backends return identical data |
| Better Auth spike | Partly done | Works behind the interface, pinned at 1.7.27, revoked sessions rejected; sign-in through the admin UI waits for the interface change below |
| First Playwright test | Done | `npm run test:e2e`: an owner signs in and reaches the Command Center on a production build |
| PostgreSQL 15 and 17 runs | Carried over | Only 16 tested so far |
| Taxonomy certification script | Carried over | Not run |
| pgroll test | Carried over | Decide before week 16 |
| Trial release image | Carried over | Not measured |

Checks on the branch: type-check and lint pass, 789 unit tests pass (re-run and confirmed in the main session), 26 dual-backend and 2 browser tests pass, the build passes, `npm audit` and gitleaks are clean, and Semgrep has 0 open findings (one real nginx finding in the test gateway fixed, one false positive annotated).

**Decisions after Phase 0**

| Decision | Outcome |
| --- | --- |
| Data layer | Kysely, confirmed |
| Auth library | Better Auth, pinned at 1.7.27; fits our interface without forking, with two adjustments (phase 1, auth) |
| Migration engine | pgroll not yet tested; decide before week 16 |
| Release unit | Container plus VM image kept; the password hashing needs Node 24.7 or later in the base image |
| Licence | Owner's call, still open |

**Findings that changed this plan:** row-level security with no policies, a missing `postgres` role, audit events lost without Supabase, and Better Auth being cookie-based. Each is now a task in the phase 1 sections below.

**Measured pace.** The whole scope took an AI agent about 45 minutes, and taxonomy itself about 6 minutes. That is not an engineer's rate, so it cannot set the dates on its own. The working assumption changes: agents write the conversions, and engineers review them, run the dual tests and the staging soak. The phase 1 dates are fixed after one wave 1 area is timed end to end with a named engineer (see Team and effort).

## Phase 1: plain PostgreSQL, the data layer (weeks 3–12)

The 12 code areas move in five waves, smallest and least connected first, so the patterns are settled before the two big areas. Call counts are `.from()` plus `.rpc()` calls measured on `main`.

| Wave | Weeks | Areas (calls) | Owner |
| --- | --- | --- | --- |
| 1 | 3–4 | the shared audit logger first, then navigation (14), routing (17), schema (9), platform (8), operations (8) | Engineer A |
| 2 | 4–6 | admin (14), media (24), developer (35) | Engineer B |
| 3 | 6–9 | content (173): entries and versions, then releases and scheduling, then workflow and comments, then search | Engineer A |
| 4 | 6–10 | intelligence (172): split by its sub-services | Engineer B |
| 5 | 9–11 | infrastructure (101), the 33 calls made directly in API routes, and the `bootstrap-admin`, `seed-starter` and `run-migrations` scripts | Both |
| Clean-up | 12 | Remove the switch, the Supabase data path and server-side supabase-js | Both |

Taxonomy (24 calls) moved in phase 0. The delivery worker already uses `pg` directly and needs only the new connection settings.

### Phase 1 progress (23 November 2026)

| Merged | PRs | Notes |
| --- | --- | --- |
| Roles migration 0067: owner and app roles, a row-level security policy per table for `polynovea_app`, the `postgres` role, mirrored grants, `REVOKE CREATE` | #18 | Review found four defects to fix in migration 0068: role setup fails on RDS and Azure (non-superuser admin), the default revoke of `EXECUTE` has no effect, and Supabase's `anon` and `authenticated` still execute some functions. Tests will bootstrap as a non-superuser admin. |
| `auth.jwt()` shim removed from database provisioning | #19 | |
| Shared audit logger dispatches to the direct path | #20 | Follow-up: the Supabase path still skips failed audit inserts silently; a check that moved areas use `recordPlatformEvent` |
| Wave 1 areas: navigation, routing (routes and redirects), schema, platform | #21, #22, #24, #26, #28 | #28 also fixes roles from another workspace leaking into a member's role keys on the Supabase path; follow-up adds a database constraint on `member_roles` |

All merged at `cb5aece`. On the stack tip: the type-check and lint pass, 802 unit tests and 133 dual-backend tests pass, and the build passes. `npm audit` and Semgrep are clean. Next: the review fix-up PR (migration 0068), then operations, which closes wave 1, then wave 2.

The shared audit logger goes first because every area writes through it. Phase 0 found that it still uses Supabase, so on a database without Supabase the audit events of moved areas are silently dropped. No area counts as moved until its audit events land. The direct-path logger now exists (`lib/platform/audit.postgres.ts`, merged in PR #17: audit row, webhook deliveries and delivery jobs in the caller's transaction) and taxonomy uses it; wave 1 makes every other area call it.

**How each area moves**

1. Write the area's queries in Kysely next to the old ones, behind the switch.
2. Turn `.rpc('fn', args)` into `callFunction('fn', args)`: the 56 SQL functions stay as they are.
3. Keep return shapes identical, so routes and the admin UI do not change.
4. Run the area's tests on both backends, then its certification script, then switch it on in a staging install for at least two days.
5. Delete the old path for that area once the whole phase is done.

**Things that differ from supabase-js and need care**

- supabase-js returns `{ data, error }`; Kysely throws. Each converted call keeps the `clientErrorMessage` handling from the October audit, so internals still never reach the browser.
- PostgREST capped rows by default; direct queries do not. Every list query gets an explicit limit.
- `.select('*, relation(*)')` embeds become explicit joins or a second query. These are the slowest conversions; content and intelligence have the most.
- `.single()` and `.maybeSingle()` semantics move into helpers so the "exactly one row" checks stay strict.
- The old Supabase read paths often return empty data when the database fails. The direct path reports the failure as a safe error message instead. That is the intended behaviour, but the admin UI must show the error rather than an empty list, and the dual tests compare successful results only.
- Transactions become real: places that made several calls in a row (and relied on SQL functions for atomicity) can now use `withTransaction`.

**Exit gate (week 12):** every area runs on the direct path with the switch removed; the full test suite and all certification scripts pass on PostgreSQL 15, 16 and 17 with no Supabase services running.

## Phase 1: built-in auth (weeks 5–10)

One engineer-equivalent, running alongside the data waves. Existing users keep their accounts and passwords; they sign in once more at cutover and re-enrol MFA.

**Build**

- [ ] Better Auth on our PostgreSQL through its Kysely adapter, its tables in a separate `polynovea_auth` schema, pinned at the exact version tested in Phase 0 (1.7.27) or a later security release. Its own migration tool does not detect its tables outside the default schema, so its schema ships as one of our numbered migrations instead.
- [ ] Change the server side of our auth interface to take the whole request (cookies and headers) instead of a bearer token, because Better Auth is cookie-based. The Supabase provider adapts to the same signature.
- [ ] Plugins: two-factor (TOTP and recovery codes), passkey, admin. Our own `developer_api_tokens` already cover API keys, so the API key plugin is not needed; the design doc's "five plugins" becomes four.
- [ ] Argon2id hashing (19 MiB, 2 iterations, 1 lane) through a custom hasher; it also verifies the bcrypt hashes GoTrue stored, and rehashes them to Argon2id at the next successful sign-in.
- [ ] Password rules: 15 characters without MFA, 8 with; up to 64+ accepted; breached-password check against a bundled list, plus the Have I Been Pwned range API through `guardedFetch` when the install has internet access.
- [ ] Sessions in the database only, with the cookie cache switched off (Better Auth's November 2026 advisory: revoked sessions stayed valid with it on). `__Host-` cookie, HttpOnly, Secure, SameSite=Lax, 12-hour idle and 7-day absolute timeouts.
- [ ] Rate limits stored in the database, with the trusted proxy set explicitly so `X-Forwarded-For` cannot be spoofed, and IPv6 limited per /64.
- [ ] A step-up check (signed in within the last 10 minutes) on API token creation, role changes, sign-in and email settings, and exports.
- [ ] The `BetterAuthProvider` implementation of our interface, and the admin UI's API client switched from a bearer token to the session cookie, with CSRF protection on state-changing routes.
- [ ] Admin UI pages: sign-in, MFA enrolment, passkeys, recovery codes, active sessions with "sign out everywhere".
- [ ] Replace migration 0065's trigger on `auth.users` with a hook in our user-creation code.

**Moving existing users off GoTrue**

1. `polynovea-cms auth migrate` reads `auth.users` and creates Better Auth users with the **same UUID**, email, confirmed state and bcrypt hash. `admin_users.auth_user_id` keeps pointing at the right person with no data change.
2. TOTP secrets are not copied. Users re-enrol MFA on first sign-in, which also proves they still hold the device.
3. The command is idempotent and prints a before and after count; it refuses to run if any `admin_users.auth_user_id` would be left without a user.
4. Cutover: put the install in maintenance mode, run the command, switch `AUTH_PROVIDER=builtin`, everyone signs in again.

**Regression tests we write ourselves** (the bug classes Better Auth has had): a revoked session is rejected on the next request; an unverified OAuth email never links to an existing account; parallel wrong TOTP and recovery-code attempts cannot exceed the limit; rate limits hold behind a proxy and across an IPv6 /64; a passkey from the wrong origin is refused.

**Exit gate (week 10):** the admin UI and API run on built-in auth with no GoTrue, all the regression tests pass, and the migration command has been rehearsed on a copy of a real install.

## Phase 1: database roles, functions and storage (weeks 3–6)

The SQL side is smaller than feared: no migration reads JWT claims, the only extension is `pg_trgm` (in standard PostgreSQL), and no migration uses `pg_cron` or `pg_net`. Phase 0 found one real gap: all 140 tables have row-level security switched on with no policies. Supabase's service role bypasses that, but our limited app login does not, so its reads come back empty with no error and its writes fail.

**Roles and grants**

- [ ] Migration 0067 creates `polynovea_owner` (owns the schema, runs migrations) and `polynovea_app` (reads and writes rows, executes functions) when they do not exist.
- [ ] The same migration adds a row-level security policy on every table for `polynovea_app`, allowing its reads and writes. Permissions stay in our code as today; We use policies rather than a `BYPASSRLS` role, because managed databases may not let the admin login grant that attribute (to confirm on RDS and Azure) and explicit policies keep the rule visible. A test fails if any table with row-level security has no policy for the app role, so new tables cannot repeat the gap. The local dev setup from Phase 0 already does this.
- [ ] Create the `postgres` role when it does not exist: migrations from 0034 onward grant to it, and a plain database may not have it.
- [ ] It mirrors the 66 grants made to Supabase's `service_role` onto `polynovea_app`. On a Supabase install the old grants stay, so both paths work during phase 1.
- [ ] Default privileges, so tables created by later migrations are reachable by `polynovea_app` automatically.
- [ ] `REVOKE CREATE ON SCHEMA public FROM PUBLIC`.
- [ ] A test asserts `polynovea_app` cannot create, alter or drop anything.

**SQL functions**

- [ ] The 56 functions stay. Ownership moves to `polynovea_owner`; `EXECUTE` goes to `polynovea_app` only, revoked from `PUBLIC`.
- [ ] Audit every `SECURITY DEFINER` function for a fixed `search_path` (about 75 `SET search_path` lines exist; list any function missing one and fix it).
- [ ] Remove the `auth.jwt()` shim that `databaseProvisioning.ts` creates; nothing needs it once Supabase is gone.

**Storage**

The storage layer already supports S3, R2, MinIO and Supabase Storage through `storageProvider.ts`. Two adapters are missing for this design:

- [ ] **Azure Blob**, using the VM's managed identity and short-lived SAS URLs, with the same signed size and content-type rules as the S3 presigned uploads.
- [ ] **Local disk**, for the "on this server" option without a bucket: files on the data disk, served through signed, expiring app URLs, included in the pgBackRest backup set.
- [ ] Supabase Storage stays available as an optional connector for existing users.

**Exit gate (week 6):** a database created from scratch by the migrations, with no Supabase roles present, passes the full test suite as `polynovea_app`.

## Phase 2: setup wizard (weeks 11–15)

The wizard starts once auth is done (week 10) and while the last data wave finishes. It turns `bootstrap:admin`, `db:migrate` and `databaseProvisioning.ts` into browser steps.

**Setup mode**

- [ ] At start-up the app checks for a saved database configuration and an `installation` row. Missing either, it serves only `/setup` and `/api/setup/*`; every other route returns 503 with a link to `/setup`.
- [ ] The database configuration is saved to `/var/lib/polynovea/config.enc`, encrypted with the master key (root-only file, mode 0600), never to `.env`.
- [ ] Master key: generated at first boot if `CMS_MASTER_KEY` is not supplied, shown once in the wizard for the owner to store, and accepted later as a key ring for rotation. It also replaces `CMS_CONFIG_ENCRYPTION_KEY`, with a one-time re-encryption for existing installs.

**Setup code**

- [ ] 128-bit code generated at boot, printed with the setup URL to the log, stored as an Argon2id hash, 1-hour expiry, new code on restart.
- [ ] Accepted only in a POST body; five wrong attempts lock setup for 15 minutes; constant-time comparison.
- [ ] `POLYNOVEA_SETUP_CODE` supported for automated deploys.
- [ ] A log warning every 5 minutes while uninitialised on a public address.

**Database step**

- [ ] "On this server": start the bundled PostgreSQL on the data disk, create roles, run migrations, configure pgBackRest to the chosen bucket, take the first full backup and run `pgbackrest check`. Setup cannot continue until both pass.
- [ ] "Existing managed database": a form for endpoint, port, database, admin user and password; the five checks in order (DNS, TCP, TLS `verify-full`, login, version), each with a plain-language fix; then roles and migrations. The admin password never leaves the request.
- [ ] Host validation through `guardedNetwork`: private addresses only for `*.rds.amazonaws.com`, `*.postgres.database.azure.com` or an operator allowlist; metadata, loopback and link-local always refused; resolve once and connect to that IP.
- [ ] "Created for you": detect the database the template made (stack tags and its secret) and skip straight to roles and migrations.
- [ ] Live progress over server-sent events: each check and migration shows as it runs.

**Owner step**

- [ ] Create the owner and the `installation` row in one transaction (unique constraint), require MFA enrolment, show 10 recovery codes and require confirmation that they were saved.
- [ ] Organisation and first workspace; optional starter content through the existing `seed:starter` logic.

**Acceptance tests** (each automated, on a clean VM image):

1. Fresh install to signed-in owner using only the browser, for each database option.
2. Wrong setup code five times locks setup; the correct code afterwards still works after the lock.
3. Two browsers completing setup at once: exactly one owner exists.
4. After setup, `/setup` returns 404 and a restart does not reopen it.
5. The address field refuses `169.254.169.254`, `127.0.0.1`, `localhost`, a DNS name that resolves to a private IP, and an IPv4-mapped IPv6 address.
6. The admin password appears in no log, no file and no database row.

**Exit gate (week 15):** all six acceptance tests pass on AWS and Azure VMs.

## Phase 3: real tables (weeks 16–23)

Each model gets its own table for current content, while the immutable version history stays as JSONB snapshots. Queries, filters and indexes hit real columns; history keeps working without a schema change every time a model changes.

**Storage shape**

- User tables live in their own `content` schema, apart from the system tables, so a name a user picks can never collide with ours.
- One table per model, `content.<model_slug>`: `entry_id`, `variant` (draft or published), `locale`, then one typed column per field. Primary key `(entry_id, variant, locale)`.
- `content_entries` stays the registry (status, workflow, pointers); `content_entry_versions` keeps every saved version as a JSONB snapshot.
- Saving an entry writes the model table row and the history snapshot in one transaction. Publishing copies the draft row to the published row.

**Schema engine (weeks 16–19)**

- [ ] Extend the existing compiler contract's "PostgreSQL migration intent" into a real plan: field types to column types, required to `NOT NULL`, unique to a unique index, relations to foreign keys.
- [ ] Name rules: `^[a-z][a-z0-9_]{0,62}$`, PostgreSQL reserved words refused, identifiers always quoted; caps of 200 models, 150 fields per model and 50 indexes per model (adjustable by the operator).
- [ ] The plan in plain words for the UI, with the count of values a destructive step would delete, and a hash of the schema it was built from.
- [ ] Destructive steps require typing the model name and run as a separate, later step; a deleted field name is reserved for 30 days.
- [ ] Deleting a field removes its permission rows in the same transaction.

**Migration runner (weeks 17–20)**

- [ ] Runs as a worker job on a separate connection pool that uses `polynovea_owner`; the request that asked for it never holds owner rights.
- [ ] `lock_timeout` of 3 seconds with five retries and backoff; indexes built `CONCURRENTLY` outside the transaction; required fields added as `NOT VALID` checks, validated, then `SET NOT NULL`.
- [ ] Renames and type changes by expand and contract. Use pgroll if the phase 0 test passed; otherwise our own: new column, trigger to dual-write, batched backfill, switch, drop after one release.
- [ ] Every run recorded in the migration ledger with who asked, the plan hash, timings and the outcome.

**Moving existing content (weeks 20–23)**

- [ ] Per model: create the table, backfill current draft and published versions from the JSONB snapshots in batches of 1,000, compare row counts and a checksum of each field.
- [ ] Switch that model's reads to the table; keep writing the JSONB snapshot (as history) as before, so rolling back a model is just switching reads back.
- [ ] Search moves to `pg_trgm` indexes on each model's text columns.

**Tests:** random sequences of model changes applied and reverted on fixture data; a schema change while a 30-second query holds a lock (the change must wait and retry, never block other queries); a migration of a copy of a real install with every count and checksum matching.

**Exit gate (week 23):** every model on every test install reads from real tables with matching counts, and a rollback of one model has been rehearsed.

## Phase 4: generated API and typed SDK (weeks 22–27)

The existing `/api/v1` content routes and `/api/v1/openapi.json` become model-aware: one set of generic handlers that read each model's metadata, not code generated per model.

**API (weeks 22–25)**

- [ ] `GET/POST /api/v1/models/{model}/items` and `GET/PATCH/DELETE .../items/{id}`, reading the published variant by default and the draft with a preview token.
- [ ] A filter language with a fixed operator set (`eq`, `neq`, `in`, `lt`, `gt`, `contains`, `null`), sorting, cursor paging and relation expansion. Every field name is checked against the model's metadata before it reaches SQL.
- [ ] One permission function used for output fields, filters, sort, search and expansion. A field the caller cannot read cannot be filtered or sorted on either.
- [ ] Writes accept only fields the caller may write; unknown fields are rejected, not ignored.
- [ ] Limits per role: page size 100, filter depth 3, expansion depth 2, at most 5 joins, `statement_timeout` 5 seconds, plus rate limits per token.
- [ ] Webhooks, scheduled publishing, previews and the MCP server call the same permission function.

**SDK (weeks 24–27)**

- [ ] `/api/v1/openapi.json` generated from model metadata, plus `/api/v1/types.ts` with one TypeScript interface per model.
- [ ] `packages/cms-sdk` gets a typed client: `cms.items('article').list({ filter, sort })` returns `Article[]`.
- [ ] `polynovea-cms types pull` in `cms-cli` writes the types file; a `--check` flag fails CI when it is out of date.
- [ ] A schema hash on every response and request: the SDK warns when the server's models changed in a breaking way since the types were pulled.

**Tests:** a permission test matrix generated from fixture roles, checking that every restricted field is unreachable through each of the six channels (output, filter, sort, search, expansion, webhooks); the expensive-query limits each tested; SDK types compiled against a fixture schema in CI.

**Exit gate (week 27):** the permission matrix passes in full and a sample Next.js site builds against the generated types.

## Phase 5: one-click install and upgrades (weeks 20–27)

This runs in parallel with phases 3 and 4 because it only depends on the wizard (phase 2).

**Release package (weeks 20–22)**

- [ ] A container image with the Next.js standalone build, the worker and PostgreSQL 16 (used only by the "on this server" option), run as a non-root user. The base image needs Node 24.7 or later for the password hashing.
- [ ] A VM image built from it for AWS (AMI) and Azure (managed image), with IMDSv2 required, automatic security updates and the data disk mounted at `/var/lib/polynovea`.
- [ ] Images signed with cosign and published with an SBOM. Images are built and signed with a key from a local release machine by a script, not by GitHub Actions (owner's rule: no organisation Actions minutes). Keyless signing would need Actions' identity, so it is not used.

**Templates (weeks 21–24)**

- [ ] AWS CloudFormation template: VM, RDS PostgreSQL 16 (single zone, small burstable size, deletion protection, 7-day backups, RDS-managed master password), S3 bucket, an instance role that reads one secret and writes to one bucket, a security group allowing the VM to the database only, and an AWS Budgets alert. A quick-create link on the website and in the README.
- [ ] The same in Bicep for Azure, with a "Deploy to Azure" button: VM with managed identity, Azure Database for PostgreSQL Flexible Server, Blob container, Key Vault.
- [ ] Both templates have a "no managed database" option that uses "on this server" with a backup bucket.
- [ ] OpenTofu modules for the same resources, with state encryption required.

**Upgrades (weeks 23–27)**

- [ ] The System page checks for new signed releases and shows the changelog.
- [ ] Upgrade: backup, verify signature, pull by digest, run migrations, start the new version, check `/api/health` returns the new release ID, switch traffic; switch back automatically if the check fails within 2 minutes.
- [ ] The System Doctor checks: database, TLS and CA bundle age, disk, backup age, last restore test, pending migrations, worker heartbeat, and the auth library version against known advisories.
- [ ] A monthly restore test as a worker job.

**Exit gate (week 27):** each template installs on a clean AWS and Azure account from the link alone; an upgrade and a forced failed upgrade (which must roll back) are tested end to end.

## Testing and release

Today there are 775 unit tests in 47 files and a set of certification scripts, but no browser tests (audit finding TEST-002). Browser tests are added in phase 1, because the auth change is exactly what unit tests miss.

| Layer | What it covers | When it runs | Added in |
| --- | --- | --- | --- |
| Unit | Services, permission logic, schema compiler, name rules | Every commit, local CI | Exists; grows each phase |
| Dual-backend | Each moved area against Supabase and direct PostgreSQL | Every pull request during phase 1 | Phase 0 |
| Database | Migrations from empty, role rights, function grants, schema changes under lock | Every pull request, on PostgreSQL 15, 16 and 17 in Docker | Phase 0 |
| Certification | The existing per-area scripts against a running install | Before merging an area; before each release | Exists |
| Browser (Playwright) | Sign-in, MFA, passkey, setup wizard, editing, publishing, schema changes | Before merging auth, wizard or schema work; nightly | Phase 1 |
| Security | Semgrep, `npm audit`, secret scan, the auth regression tests, the SSRF test list | Every pull request | Exists; grows |
| Cloud | Template install, upgrade, failed-upgrade rollback, restore test on real AWS and Azure | Before each release | Phase 5 |

**Migration rehearsal.** Before each phase ships, take a copy of a real install (anonymised), run the upgrade on it, and compare row counts and checksums table by table. Phases 1 and 3 both change how data is reached; neither ships without a clean rehearsal.

**Cloud test cost.** Cloud tests create real resources. Each run tags them, tears them down at the end, and a separate clean-up job deletes anything older than 6 hours. A budget alert on the test accounts caps the monthly spend.

**Releases**

- 0.2 after phase 1: plain PostgreSQL and built-in auth, for existing users, with the migration guide.
- 0.3 after phase 2: the setup wizard; the first release a non-technical person can install.
- 0.4 after phases 3, 4 and 5: real tables, typed SDK, one-click templates and upgrades. This is the public beta.
- Each release gets a changelog entry, an upgrade guide and a signed image.

## Team and effort

The plan assumes three engineers for 28 weeks, about 80 engineer-weeks, with the owner making decisions and reviewing security-sensitive changes.

| Person | Weeks 1–2 | Weeks 3–12 | Weeks 13–19 | Weeks 20–27 |
| --- | --- | --- | --- | --- |
| Engineer A (backend) | Data layer foundations, taxonomy spike | Data waves 1, 3, 5 | Schema engine, migration runner | Content migration, then SDK |
| Engineer B (backend) | Test helpers, PostgreSQL matrix | Data waves 2, 4, 5 | Wizard database step, schema engine | Generated API |
| Engineer C (security and platform) | Better Auth spike | Roles and grants, storage adapters, built-in auth, browser tests | Setup wizard, security review of phase 3 | Release package, templates, upgrades |
| Owner | Phase 0 decisions | Reviews auth and SQL changes | Reviews wizard; telemetry decision | Licence; beta go/no-go |

**Effort by phase**

| Phase | Engineer-weeks |
| --- | --- |
| 0. Spike and foundations | 6 |
| 1. Plain PostgreSQL and built-in auth | 29 |
| 2. Setup wizard | 8 |
| 3. Real tables | 14 |
| 4. Generated API and SDK | 10 |
| 5. One-click install and upgrades | 8 |
| Security review, browser tests, docs across phases | 5 |

**With two engineers** the same work takes about 40 weeks: phase 5 can no longer run alongside phases 3 and 4. Phases 0–2 (a self-hostable CMS on plain PostgreSQL with the wizard) still land in about 20 weeks, which is the point to consider a first public release.

These numbers are estimates. Phase 0 could not measure an engineer's rate, because an AI agent did the work: about 45 minutes for the whole scope. Its guess for a human is about 24 calls a day for simple areas like taxonomy and 10–15 for content and intelligence, against the plan's assumption of about 6. If agents write the conversions and engineers review and test them, phase 1 is likely to shrink well below 10 weeks. The dates stay as they are until one wave 1 area has been timed end to end with a named engineer, including review, dual tests and the staging soak.

## Risks and rollback

Every phase can be undone without losing data; the table says how, and what would make us use it.

| Phase | Main risk | Early warning | Rollback |
| --- | --- | --- | --- |
| 0 | The spike shows the move is much slower than planned | Taxonomy takes more than 4 days | Re-plan phase 1 with the measured rate before committing to dates (Phase 0 ran far faster than planned, with an agent; an engineer timing is still due) |
| 1, row-level security | The app login reads empty tables because row-level security has no policy for it | Empty lists with no error; failed writes | Policy per table in migration 0067, and a test that fails on any table without one |
| 1, data | A converted area behaves differently (missing row cap, lost embed, error shape) | Dual-backend test differs; staging errors rise | Flip that area's switch back to Supabase; no deploy needed |
| 1, auth | Users locked out at cutover, or a Better Auth flaw | Failed sign-ins after migration; a new advisory | Set `AUTH_PROVIDER=supabase` again; GoTrue's data is untouched until the next release |
| 1, roles | A function or grant missed, breaking one feature | A test as `polynovea_app` fails | Fix forward with a grant migration; Supabase installs keep the old grants |
| 2 | Setup screen exposed or bypassed | Any failing acceptance test | Not releasable until all pass; installs can still use the command-line bootstrap |
| 3 | A schema change locks a busy table, or content counts mismatch | Lock retries exhausted; checksum mismatch | Switch that model's reads back to JSONB snapshots, which are still written |
| 4 | A field leaks through a filter or expansion | Permission matrix failure | Not releasable; the old `/api/v1` handlers stay until the matrix passes |
| 5 | A bad release upgrades installs | Health check fails after upgrade | Automatic switch back within 2 minutes; migrations are backward compatible for one release |

**Deliberate change from the original design.** The first version of the design said each model would get its own history table. This plan keeps version history as JSONB snapshots and puts only current content in real tables. History is written once and never queried by field, so JSONB suits it, and it removes a schema change on every model edit. The design document in this folder has been updated to match.

**Biggest schedule risk:** content (173 calls) and intelligence (172) are more than half of phase 1. If the spike rate is low, intelligence is the area to defer: it can stay on the Supabase path one release longer without blocking the wizard, as long as installs without Supabase hide its features until it moves.

## First two weeks

A checklist to start on Monday. Items marked (owner) need the owner; the rest are engineering. Status as of 23 November 2026: most engineering items were done by the Phase 0 session on branch `sroy/phase-0-407bed` (uncommitted, awaiting review).

**Day 1**

- [ ] (owner) Approve this plan and the design doc, or mark changes on them.
- [ ] (owner) Confirm the team: who is Engineer A, B and C, and whether it is three people or two.
- [ ] Create the `upgrade/phase-0` branch and an ADR for the plan. (Work exists on `sroy/phase-0-407bed`; the ADR is still to write.)
- [ ] Add the pre-push hook that runs local CI and Semgrep.

**Days 2–5**

- [x] `lib/db/` with Kysely, the pool singleton, TLS and timeouts.
- [x] Kysely types generated from the 69 migrations on PostgreSQL 16.
- [x] `callFunction` and `withTransaction` helpers.
- [x] The per-area backend switch and the dual-backend test helper.
- [ ] Docker setup for PostgreSQL 15, 16 and 17 in local CI. (16 done.)
- [x] Neutral `Session` and `User` types in `lib/auth/provider.ts`.

**Days 6–10**

- [x] Taxonomy moved: `lib/taxonomy` and its 6 routes on the direct path, tests green on both backends.
- [ ] Better Auth provider on a scratch branch: email, password, TOTP sign-in to the admin UI. (Provider done; admin UI sign-in waits for the request-based auth interface.)
- [ ] One-day pgroll test on a copy of `content_entries`.
- [x] First Playwright test: sign in and open the dashboard.
- [x] Time log for every task. (Agent times; an engineer timing is still needed.)

**Day 10 review**

- [ ] (owner) Review the Phase 0 branch and decide whether to commit it.
- [ ] (owner) Sign off the Phase 0 decisions (four settled, licence open).
- [ ] Time one wave 1 area with a named engineer, then re-estimate phase 1 and update the timeline in this plan.
