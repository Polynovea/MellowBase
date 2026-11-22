// Database roles for installs without Supabase (self-hosted upgrade, phase 1).
//
// Two steps happen before the numbered migrations can run on a plain PostgreSQL database:
//
// 1. Install roles (one-time, as the database's admin login: the RDS or Azure master user, or the
//    bundled server's superuser): polynovea_owner owns schema public and runs migrations,
//    polynovea_app is the runtime login. `bootstrapInstallRoles` does this; the setup wizard and the
//    local dev databases (scripts/dev-db/setup.mjs) call it.
// 2. Compatibility roles: migrations 0003-0065 grant to or revoke from Supabase's role names
//    (anon, authenticated, service_role, postgres). They must exist, as NOLOGIN roles with no
//    attributes, before those migrations run. `ensureCompatibilityRoles` creates any that are missing
//    when the connected login may create roles, and otherwise says exactly what an administrator must
//    run. scripts/run-migrations.mjs calls it before applying anything.
//
// Migration 0067 then gives polynovea_app its grants and a row-level security policy on every table.

/** Role names the historical migrations reference. NOLOGIN, no privileges of their own. */
export const COMPATIBILITY_ROLES = Object.freeze(["anon", "authenticated", "service_role", "postgres"]);

export const OWNER_ROLE = "polynovea_owner";
export const APP_ROLE = "polynovea_app";

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function quoteIdent(name) {
  if (!ROLE_NAME.test(name)) throw new Error(`Refusing unexpected role or database name: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** @param {import("pg").ClientBase} client */
export async function missingCompatibilityRoles(client) {
  const { rows } = await client.query(
    "select name from unnest($1::text[]) as name where not exists (select 1 from pg_roles where rolname = name)",
    [COMPATIBILITY_ROLES],
  );
  return rows.map((row) => row.name);
}

/**
 * Creates the missing compatibility roles as NOLOGIN, or throws with the statements an administrator
 * must run when the connected login cannot create roles (polynovea_owner never can).
 * @param {import("pg").ClientBase} client
 * @returns {Promise<string[]>} the roles it created
 */
export async function ensureCompatibilityRoles(client) {
  const missing = await missingCompatibilityRoles(client);
  if (missing.length === 0) return [];
  const { rows: [me] } = await client.query(
    "select rolsuper or rolcreaterole as can_create from pg_roles where rolname = current_user",
  );
  if (!me?.can_create) {
    const statements = missing.map((name) => `create role ${quoteIdent(name)} nologin;`).join(" ");
    throw new Error(
      `The database is missing role(s) ${missing.join(", ")} that the migrations grant to. `
      + `Ask the database administrator to run: ${statements}`,
    );
  }
  for (const name of missing) {
    // Re-checked inside the statement: another installer may have created it meanwhile.
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${name}') then create role ${quoteIdent(name)} nologin; end if;
    end $$`);
  }
  return missing;
}

/**
 * One-time install step, as the admin login: creates or updates polynovea_owner and polynovea_app
 * with their passwords, gives the owner schema public, and closes schema public to everyone else.
 * Also creates the compatibility roles. Neither role gets SUPERUSER, CREATEROLE or BYPASSRLS.
 *
 * @param {import("pg").ClientBase} client connected as the admin login to the target database
 * @param {{ database: string, ownerPassword: string, appPassword: string }} options
 */
export async function bootstrapInstallRoles(client, { database, ownerPassword, appPassword }) {
  if (!ownerPassword || !appPassword) throw new Error("Both role passwords are required");
  if (ownerPassword === appPassword) throw new Error("The owner and app roles must not share a password");
  const db = quoteIdent(database);
  for (const role of [OWNER_ROLE, APP_ROLE]) {
    await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${quoteIdent(role)} login; end if;
    end $$`);
  }
  // ALTER ROLE ... PASSWORD takes no bind parameters; escapeLiteral quotes the value safely.
  await client.query(`alter role ${quoteIdent(OWNER_ROLE)} with login nosuperuser nocreaterole nocreatedb nobypassrls password ${client.escapeLiteral(ownerPassword)}`);
  await client.query(`alter role ${quoteIdent(APP_ROLE)} with login nosuperuser nocreaterole nocreatedb nobypassrls password ${client.escapeLiteral(appPassword)}`);
  await client.query(`grant connect, create on database ${db} to ${quoteIdent(OWNER_ROLE)}`);
  await client.query(`grant connect on database ${db} to ${quoteIdent(APP_ROLE)}`);
  await client.query(`alter schema public owner to ${quoteIdent(OWNER_ROLE)}`);
  await client.query("revoke create on schema public from public");
  await ensureCompatibilityRoles(client);
}
