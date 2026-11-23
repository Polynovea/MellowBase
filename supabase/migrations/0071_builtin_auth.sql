-- Built-in auth (phase 1): Better Auth's tables in their own schema, polynovea_auth.
--
-- Better Auth's own migrator only introspects the default schema, so with polynovea_auth it would
-- try to create these tables on every run; we ship its schema as one of our numbered migrations
-- instead. The columns match Better Auth 1.7.27 with the two-factor, passkey and admin plugins, UUID
-- IDs (so admin_users.auth_user_id keeps pointing at the same person after `auth migrate`) and our
-- `metadata` field. lib/auth/betterAuth/schema.dual.test.ts fails if the library expects anything
-- this migration does not create.
--
-- Nothing here touches Supabase's auth schema: on a Supabase install the tables simply wait, empty,
-- until `polynovea-cms auth migrate` copies the users across and AUTH_PROVIDER=builtin is set.
-- PostgREST never exposes this schema, and anon, authenticated and service_role get no access to it.

create schema if not exists polynovea_auth;
revoke all on schema polynovea_auth from public;

create table if not exists polynovea_auth."user" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null,
  "twoFactorEnabled" boolean,
  "role" text,
  "banned" boolean,
  "banReason" text,
  "banExpires" timestamptz,
  "metadata" jsonb,
  -- Every address is stored lower-case, so the unique constraint is case-insensitive in practice.
  constraint user_email_lower check ("email" = lower("email"))
);

create table if not exists polynovea_auth."session" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid not null references polynovea_auth."user" ("id") on delete cascade,
  "impersonatedBy" text
);

create table if not exists polynovea_auth."account" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" uuid not null references polynovea_auth."user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null,
  -- One account per provider identity; `auth migrate` relies on it to stay idempotent.
  constraint account_provider_account unique ("providerId", "accountId")
);

create table if not exists polynovea_auth."verification" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null
);

create table if not exists polynovea_auth."twoFactor" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "secret" text not null,
  "backupCodes" text not null,
  "userId" uuid not null references polynovea_auth."user" ("id") on delete cascade,
  "verified" boolean,
  "failedVerificationCount" integer,
  "lockedUntil" timestamptz
);

create table if not exists polynovea_auth."passkey" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "name" text,
  "publicKey" text not null,
  "userId" uuid not null references polynovea_auth."user" ("id") on delete cascade,
  "credentialID" text not null,
  "counter" integer not null,
  "deviceType" text not null,
  "backedUp" boolean not null,
  "transports" text,
  "createdAt" timestamptz,
  "aaguid" text
);

create table if not exists polynovea_auth."rateLimit" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "key" text not null unique,
  "count" integer not null,
  "lastRequest" bigint not null
);

create index if not exists "session_userId_idx" on polynovea_auth."session" ("userId");
create index if not exists "session_expiresAt_idx" on polynovea_auth."session" ("expiresAt");
create index if not exists "account_userId_idx" on polynovea_auth."account" ("userId");
create index if not exists "verification_identifier_idx" on polynovea_auth."verification" ("identifier");
create index if not exists "twoFactor_secret_idx" on polynovea_auth."twoFactor" ("secret");
create index if not exists "twoFactor_userId_idx" on polynovea_auth."twoFactor" ("userId");
create index if not exists "passkey_userId_idx" on polynovea_auth."passkey" ("userId");
create unique index if not exists "passkey_credentialID_idx" on polynovea_auth."passkey" ("credentialID");

-- The app role reads and writes rows; it never changes the schema. No row-level security here:
-- the tables are reachable only by polynovea_app (and the owner), never through PostgREST.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'polynovea_app') then
    execute 'grant usage on schema polynovea_auth to polynovea_app';
    execute 'grant select, insert, update, delete on all tables in schema polynovea_auth to polynovea_app';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema polynovea_auth from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema polynovea_auth from authenticated';
  end if;
  -- Supabase's service key is not a way into the built-in auth either.
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on all tables in schema polynovea_auth from service_role';
    execute 'revoke all on schema polynovea_auth from service_role';
  end if;
end;
$$;

update public.cms_runtime_state
set schema_migration = '0071', updated_at = now() where singleton = true;
