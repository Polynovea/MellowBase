# ADR-018: Admin Identity Resolution and First-Owner Bootstrap

**Status:** Accepted (current). Supersedes [ADR-013](ADR-013-cms-actor-vs-external-identity.md).
**Date:** 2026-11-22
**Phase:** Post-OSS V1 security hardening

## Context

[ADR-013](ADR-013-cms-actor-vs-external-identity.md) set up the chain
external identity -> `admin_users` -> workspace membership -> roles, and
also recorded a hardcoded master-email bypass. That bypass was removed on
2026-09-13 (see the amendments in ADR-013 and
[ADR-002](ADR-002-supabase-rls-security-model.md)), but ADR-013 still reads
as if parts of it might apply. Admin sessions also still matched an identity
to its `admin_users` profile by email. Email is mutable and some identity
providers allow unverified addresses, so email alone is not a safe key.

This ADR is the single current statement of how an authenticated identity
becomes a CMS admin.

## Decision

1. **`admin_users` stays the bridge.** ADR-013's core decision carries
   forward unchanged: `requireAdminRequest()` (`lib/admin/serverAccess.ts`)
   validates the session and resolves an `admin_users` profile;
   `resolveActor()` (`lib/platform/actor.ts`) maps that profile to workspace
   membership and role permissions. No separate `cms_users`/`actors` table.
2. **No bypass.** There is no hardcoded or email-based master account and no
   synthetic actor. Every admin, including the first owner, needs an active
   `admin_users` profile, an active `workspace_members` row and a role. The
   `master` role is an ordinary stored profile role (`isMasterUser()` in
   `lib/admin/access.ts` checks `role === "master"`).
3. **First owner via bootstrap command.** The first owner is created with the
   server-only `npm run bootstrap:admin` (`scripts/bootstrap-admin.mjs`). It
   creates or reuses the auth identity, writes the `admin_users` profile with
   that identity's `auth_user_id`, and creates the default-workspace
   membership and owner role. Browser clients cannot create or promote their
   own profiles (migration `0064_remove_identity_specific_master_bootstrap.sql`).
4. **Profiles resolve by immutable auth user ID.** `resolveAdminProfile()`
   (`lib/admin/profileResolution.ts`) looks up the active profile by
   `admin_users.auth_user_id = <auth user id>`. Email is used only once, to
   link a legacy profile created before `auth_user_id` was recorded, and only
   when:
   - the profile has no `auth_user_id`, and
   - the identity's email is confirmed (`email_confirmed_at` is set).

   The link is a compare-and-set (`update ... where auth_user_id is null`),
   so two identities cannot both claim the same legacy profile. After that,
   the profile resolves by ID only; changing the identity's email does not
   change which profile it gets.
5. **One identity, one profile.** Migration
   `0066_admin_users_auth_user_id_unique.sql` adds a partial unique index on
   `admin_users(auth_user_id)` where it is not null.

## Consequences

- An identity with no linked profile, or an unconfirmed email matching an
  unlinked legacy profile, gets `403 Access denied`.
- Migration `0066` fails if two profiles already share an `auth_user_id`; the
  migration file contains the query to find them. Clear `auth_user_id` on the
  wrong profile and re-run.
- ADR-013's "future identity adapter" note still applies: the seam for a
  second identity provider is `resolveActor()`'s input and the profile store
  interface (`AdminProfileStore`), not the rest of `lib/platform/*`.
